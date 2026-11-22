import { describe, test as baseTest, vi } from "vitest";
import { sql, SyncEngine } from "./sync_engine";
import { Syncer } from "./syncer";
import { PullResponse } from "./sync_sqlite/sync_sqlite";
import {
  DBHandle,
  MigrationHandle,
  MutatorsConfig,
  Query,
  ValidatedConfig,
} from "./config";
import { createTestHub } from "./testing";

const it = baseTest.extend("hub", async () => {
  return createTestHub();
});

type Doc = { id: number; title: string; body: string };
type Mutation = PullResponse["mutations"][number];

/** `'delete'` command: the only way to remove a row from a table which does not store its content */
const DELETE_COMMAND = `INSERT INTO docs_fts(docs_fts, rowid, title, body)
  VALUES ('delete', old.id, old.title, old.body);`;
const DELETE_ROW = `DELETE FROM docs_fts WHERE rowid = old.id;`;

/** FTS5 tables indexing the `docs` table, kept up to date by triggers */
const variants = [
  {
    name: "external content table",
    options: ", content='docs', content_rowid='id'",
    remove: DELETE_COMMAND,
  },
  {
    name: "contentless table",
    options: ", content=''",
    remove: DELETE_COMMAND,
  },
  {
    name: "contentless-delete table",
    options: ", content='', contentless_delete=1",
    remove: DELETE_ROW,
  },
  {
    name: "table storing its own content",
    options: "",
    remove: DELETE_ROW,
  },
];

const schema = ({ options, remove }: (typeof variants)[number]) => `
  CREATE TABLE docs(id INTEGER PRIMARY KEY, title TEXT, body TEXT);
  CREATE VIRTUAL TABLE docs_fts USING fts5(title, body${options});
  CREATE TRIGGER docs_ai AFTER INSERT ON docs BEGIN
    INSERT INTO docs_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
  END;
  CREATE TRIGGER docs_ad AFTER DELETE ON docs BEGIN
    ${remove}
  END;
  CREATE TRIGGER docs_au AFTER UPDATE ON docs BEGIN
    ${remove}
    INSERT INTO docs_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
  END;
`;

const docMutators = {
  addDoc: async (db: DBHandle, doc: Doc) => {
    await db.sql(
      sql`INSERT INTO docs(id, title, body) VALUES (${doc.id}, ${doc.title}, ${doc.body})`,
    );
  },
  editDoc: async (db: DBHandle, doc: { id: number; body: string }) => {
    await db.sql(sql`UPDATE docs SET body = ${doc.body} WHERE id = ${doc.id}`);
  },
  removeDoc: async (db: DBHandle, id: number) => {
    await db.sql(sql`DELETE FROM docs WHERE id = ${id}`);
  },
};

type Hub = Awaited<ReturnType<typeof createTestHub>>;

async function setup<M extends MutatorsConfig>(
  hub: Hub,
  migration: string,
  mutators: M,
) {
  const pull = vi.fn<Syncer["pull"]>();
  const platform = hub.newTab();
  const engine = await SyncEngine.create(platform, {
    syncer: { pull, push: vi.fn<Syncer["push"]>() },
    mutators,
    autoSync: false,
    migrations: [{ version: 1, run: (db: MigrationHandle) => db.exec(migration) }],
  } as unknown as ValidatedConfig<M>);

  /** Runs a sync answered by `mutations`, `acked` being the last local mutation known by the server */
  let version = 0;
  const sync = async (acked: number, ...mutations: Mutation[]) => {
    pull.mockResolvedValueOnce({
      server_version: ++version,
      last_mutation_id: acked,
      mutations,
    });
    await engine.sync();
  };

  /** Writes outside any mutator, which `engine.sql` does not allow */
  const write = ({ sql, params = [] }: Query) =>
    platform.call("query", { sql, params, isReadonly: false });

  return { engine, sync, write };
}

const upsert = (...records: Doc[]): Mutation => ({
  op: "upsert",
  table: "docs",
  pks: ["id"],
  records,
});

const remove = (...ids: number[]): Mutation => ({
  op: "delete",
  table: "docs",
  pks: ["id"],
  records: ids.map((id) => ({ id })),
});

const words = (doc: Doc) => `${doc.title} ${doc.body}`.split(" ");

/**
 * The index must be a pure function of `docs`: every word ever written finds
 * exactly the rows which contain it now, and FTS5 reports no corruption.
 */
async function expectIndexInSync(
  engine: { sql: SyncEngine<any>["sql"] },
  write: (query: Query) => Promise<unknown>,
  expect: (typeof import("vitest"))["expect"],
  vocabulary: Iterable<string>,
) {
  const { rows: docs } = await engine.sql<Doc>(
    sql`SELECT id, title, body FROM docs ORDER BY id`,
  );

  const found: Record<string, number[]> = {};
  const expected: Record<string, number[]> = {};
  for (const word of vocabulary) {
    expected[word] = docs.filter((d) => words(d).includes(word)).map((d) => d.id);
    found[word] = (
      await engine.sql<number>(
        sql`SELECT rowid FROM docs_fts WHERE docs_fts MATCH ${word} ORDER BY rowid`,
      )
    ).rows;
  }
  expect(found).toEqual(expected);

  await expect(
    write(sql`INSERT INTO docs_fts(docs_fts, rank) VALUES ('integrity-check', 1)`),
  ).resolves.toBeDefined();
}

const alpha = { id: 1, title: "alpha", body: "red apple" };
const beta = { id: 2, title: "beta", body: "green pear" };
const gamma = { id: 3, title: "gamma", body: "yellow banana" };
const local = { id: 100, title: "local", body: "purple plum" };

const vocabulary = new Set(
  [
    alpha,
    beta,
    gamma,
    local,
    { id: 0, title: "delta", body: "blue cherry orange mango white grape" },
  ].flatMap(words),
);

describe.each(variants)("FTS5 $name kept in sync by triggers", (variant) => {
  const build = (hub: Hub) => setup(hub, schema(variant), docMutators);

  it("does not record the shadow tables of the index", async ({
    expect,
    hub,
  }) => {
    const { engine } = await build(hub);
    await engine.mutate.addDoc(local);
    await engine.mutate.editDoc({ id: local.id, body: "blue cherry" });

    const { rows } = await engine.sql(sql`
      SELECT count(*) FROM pending_mutations
      WHERE instr(changeset, CAST('docs_fts_' AS BLOB)) > 0`);
    expect(rows).toEqual([0]);
  });

  it("replays a pending insert on top of new server rows", async ({
    expect,
    hub,
  }) => {
    const { engine, sync, write } = await build(hub);
    const check = () => expectIndexInSync(engine, write, expect, vocabulary);

    await engine.mutate.addDoc(local);
    await check();

    // the server does not know the local mutation yet
    await sync(0, upsert(alpha, beta, gamma));
    await check();
    expect((await engine.sql(sql`SELECT id FROM docs ORDER BY id`)).rows).toEqual(
      [1, 2, 3, 100],
    );

    // the server has applied it, and changed the row on the way
    await sync(1, upsert({ ...local, body: "white grape" }));
    await check();
    expect(
      (await engine.sql(sql`SELECT body FROM docs WHERE id = 100`)).rows,
    ).toEqual(["white grape"]);
  });

  it("replays a pending update and a pending delete", async ({
    expect,
    hub,
  }) => {
    const { engine, sync, write } = await build(hub);
    const check = () => expectIndexInSync(engine, write, expect, vocabulary);

    await sync(0, upsert(alpha, beta, gamma));
    await check();

    await engine.mutate.editDoc({ id: alpha.id, body: "blue cherry" });
    await engine.mutate.removeDoc(beta.id);
    await check();

    await sync(0, upsert({ ...gamma, body: "orange mango" }));
    await check();
    expect(
      (await engine.sql(sql`SELECT body FROM docs ORDER BY id`)).rows,
    ).toEqual(["blue cherry", "orange mango"]);

    await sync(2, upsert({ ...alpha, body: "blue cherry" }), remove(beta.id));
    await check();
  });

  it("replays a pending mutation on a row changed by the server", async ({
    expect,
    hub,
  }) => {
    const { engine, sync, write } = await build(hub);
    const check = () => expectIndexInSync(engine, write, expect, vocabulary);

    await sync(0, upsert(alpha, beta, gamma));
    await engine.mutate.editDoc({ id: alpha.id, body: "blue cherry" });
    await engine.mutate.removeDoc(beta.id);

    await sync(
      0,
      upsert({ ...alpha, title: "delta" }, { ...beta, body: "white grape" }),
      remove(gamma.id),
    );
    await check();
    expect(
      (await engine.sql(sql`SELECT id, title, body FROM docs`)).rows,
    ).toEqual([{ id: 1, title: "delta", body: "blue cherry" }]);
  });

  it("stays consistent over many mutations and rebases", async ({
    expect,
    hub,
  }) => {
    const { engine, sync, write } = await build(hub);
    const fruits = [...vocabulary];
    const text = (n: number) =>
      [0, 1, 2].map((i) => fruits[(n * 7 + i * 3) % fruits.length]).join(" ");

    let mutationId = 0;
    for (let round = 0; round < 12; round++) {
      const base = 1000 + round * 10;
      for (let i = 0; i < 4; i++) {
        await engine.mutate.addDoc({
          id: base + i,
          title: text(base + i),
          body: text(base + i + 1),
        });
      }
      await engine.mutate.editDoc({ id: base, body: text(round) });
      await engine.mutate.removeDoc(base + 1);
      mutationId += 6;

      // the server lags 3 mutations behind and keeps writing its own rows
      await sync(
        mutationId - 3,
        upsert(
          { id: round, title: text(round + 1), body: text(round + 2) },
          { id: base + 2, title: "delta", body: text(round + 3) },
        ),
        remove(round - 2),
      );
      await expectIndexInSync(engine, write, expect, vocabulary);
    }
  });
});

/** Another module with shadow tables (`geo_node`, `geo_rowid`, `geo_parent`) */
describe("R*Tree index kept in sync by triggers", () => {
  type Place = { id: number; x: number; y: number };
  const migration = `
    CREATE TABLE places(id INTEGER PRIMARY KEY, x REAL NOT NULL, y REAL NOT NULL);
    CREATE VIRTUAL TABLE geo USING rtree(id, min_x, max_x, min_y, max_y);
    CREATE TRIGGER places_ai AFTER INSERT ON places BEGIN
      INSERT INTO geo VALUES (new.id, new.x, new.x, new.y, new.y);
    END;
    CREATE TRIGGER places_au AFTER UPDATE ON places BEGIN
      UPDATE geo SET min_x = new.x, max_x = new.x, min_y = new.y, max_y = new.y
      WHERE id = new.id;
    END;
    CREATE TRIGGER places_ad AFTER DELETE ON places BEGIN
      DELETE FROM geo WHERE id = old.id;
    END;
  `;
  const mutators = {
    addPlace: async (db: DBHandle, p: Place) => {
      await db.sql(
        sql`INSERT INTO places(id, x, y) VALUES (${p.id}, ${p.x}, ${p.y})`,
      );
    },
    movePlace: async (db: DBHandle, p: Place) => {
      await db.sql(sql`UPDATE places SET x = ${p.x}, y = ${p.y} WHERE id = ${p.id}`);
    },
    removePlace: async (db: DBHandle, id: number) => {
      await db.sql(sql`DELETE FROM places WHERE id = ${id}`);
    },
  };
  const places = (op: "upsert" | "delete", ...records: Partial<Place>[]): Mutation => ({
    op,
    table: "places",
    pks: ["id"],
    records,
  });

  async function expectIndexInSync(
    engine: { sql: SyncEngine<any>["sql"] },
    expect: (typeof import("vitest"))["expect"],
  ) {
    const { rows: expected } = await engine.sql(
      sql`SELECT id, x AS min_x, x AS max_x, y AS min_y, y AS max_y FROM places ORDER BY id`,
    );
    const { rows: found } = await engine.sql(
      sql`SELECT id, min_x, max_x, min_y, max_y FROM geo ORDER BY id`,
    );
    expect(found).toEqual(expected);
    expect((await engine.sql(sql`SELECT rtreecheck('geo')`)).rows).toEqual(["ok"]);
  }

  it("does not record the shadow tables of the index", async ({ expect, hub }) => {
    const { engine } = await setup(hub, migration, mutators);
    await engine.mutate.addPlace({ id: 1, x: 1, y: 1 });
    const { rows } = await engine.sql(sql`
      SELECT count(*) FROM pending_mutations
      WHERE instr(changeset, CAST('geo_' AS BLOB)) > 0`);
    expect(rows).toEqual([0]);
  });

  it("stays consistent over many mutations and rebases", async ({ expect, hub }) => {
    const { engine, sync } = await setup(hub, migration, mutators);
    let mutationId = 0;
    for (let round = 0; round < 12; round++) {
      const base = 1000 + round * 10;
      for (let i = 0; i < 4; i++) {
        await engine.mutate.addPlace({ id: base + i, x: round, y: i });
      }
      await engine.mutate.movePlace({ id: base, x: -round, y: -1 });
      await engine.mutate.removePlace(base + 1);
      mutationId += 6;

      await sync(
        mutationId - 3,
        places("upsert", { id: round, x: round * 2, y: 0 }, { id: base + 2, x: 0, y: 0 }),
        places("delete", { id: round - 2 }),
      );
      await expectIndexInSync(engine, expect);
    }
  });
});

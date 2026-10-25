import { describe, test as baseTest, vi } from "vitest";
import { sql, SyncEngine } from "./sync_engine";
import { Puller } from "./puller";
import { PullResponse } from "./sync_sqlite/sync_sqlite";
import {
  Config,
  DBHandle,
  MigrationHandle,
  MutatorFn,
  MutatorsConfig,
} from "./config";
import { Plateform } from "./plateform/plateform";
import { createTestHub } from "./testing.test";
import { SqliteDB } from "./core";

const it = baseTest.extend("hub", async () => {
  return createTestHub();
});

const stubPuller: Puller = {
  async pull(): Promise<PullResponse> {
    throw Error("no sync used");
  },
};

async function getUserVersion(core: SqliteDB): Promise<number> {
  const {
    rows: [version],
  } = await core.handle("query", {
    sql: "SELECT * FROM pragma_user_version",
    isReadonly: true,
    params: [],
  });

  return version as number;
}

type testMut = { addUser: MutatorFn<string> };

function buildEngine<M extends MutatorsConfig = testMut>(
  plateform: Plateform,
  opts?: Partial<Config<M>>,
): Promise<SyncEngine<M>> {
  return SyncEngine.create(plateform, {
    mutators: {
      addUser: async (handle, name: string) => {
        await handle.sql({
          sql: "INSERT INTO users(name) VALUES (?)",
          params: [name],
        });
      },
    },
    puller: stubPuller,
    migrations: [
      {
        version: 1,
        run: async (db) => {
          await db.exec(
            "CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT)",
          );
        },
      },
    ],
    ...opts,
  } as Config<M>);
}

describe("SyncEngine creation", () => {
  it("create a syncEngine", async ({ expect, hub }) => {
    await expect(
      SyncEngine.create(hub.newTab(), {
        puller: stubPuller,
        mutators: {},
      }),
    ).resolves.toBeDefined();
  });

  it("mutator function are callable", async ({ expect, hub }) => {
    const engine = await buildEngine(hub.newTab());
    await expect(engine.mutate.addUser("John Doe")).resolves.toBeUndefined();
  });

  it("apply 1 migration on create", async ({ expect, hub }) => {
    const engine = await SyncEngine.create(hub.newTab(), {
      puller: stubPuller,
      mutators: {},
      migrations: [
        {
          version: 1,
          run: async (db: MigrationHandle) => {
            await db.exec("CREATE TABLE migrations(version);");
          },
        },
      ],
    });

    await expect(
      engine.sql({ sql: "SELECT * FROM migrations" }),
    ).resolves.toBeDefined();
  });

  it("user_version is not updated after failed migration", async ({
    expect,
    hub,
  }) => {
    const initial = await getUserVersion(hub.core);

    await expect(
      buildEngine(hub.newTab(), {
        migrations: [
          {
            version: 1,
            run: async (db) => {
              // invalid SQL
              await db.exec("CRATE TABLE users(name text);");
            },
          },
        ],
      }),
    ).rejects.toThrow();
    const final = await getUserVersion(hub.core);
    expect(final).toEqual(initial);
  });

  it("user_version is updated after successful migration", async ({
    expect,
    hub,
  }) => {
    const initial = await getUserVersion(hub.core);

    await expect(buildEngine(hub.newTab())).resolves.toBeDefined();
    const final = await getUserVersion(hub.core);
    expect(final).toBeGreaterThan(initial);
  });

  it("mutators are queued", async ({ expect, hub }) => {
    const order: string[] = [];

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let signalStarted!: () => void;
    const slowStarted = new Promise<void>((r) => (signalStarted = r));

    const engine = await buildEngine(hub.newTab(), {
      mutators: {
        slowMutator: async () => {
          order.push("slow:start");
          signalStarted();
          await gate;
          order.push("slow:end");
        },
        addUser: async (h: DBHandle, name: string) => {
          order.push("add:start");
          await h.sql({
            sql: "INSERT INTO users(name) VALUES (?)",
            params: [name],
          });
        },
      },
    });

    const p = engine.mutate.slowMutator();
    const add = engine.mutate.addUser("John Doe");

    await slowStarted;
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual(["slow:start"]);

    release();
    await Promise.all([p, add]);

    expect(order).toEqual(["slow:start", "slow:end", "add:start"]);
    expect(
      (await engine.sql({ sql: "SELECT * FROM users" })).rows,
    ).toMatchObject([{ id: 1, name: "John Doe" }]);
  });

  it("rejection on mutator does not block queued mutators", async ({
    expect,
    hub,
  }) => {
    const engine = await buildEngine(hub.newTab(), {
      mutators: {
        throw: async (h: DBHandle) => {
          return new Promise<void>((_, reject) =>
            setTimeout(() => reject(new Error("invalid mutator")), 0),
          );
        },
        valid: async (h: DBHandle) => {
          await h.sql({
            sql: "INSERT INTO users(name) VALUES (?),(?)",
            params: ["John Doe", "Jane Doe"],
          });
        },
      },
    });

    const command1 = engine.mutate.throw();
    const command2 = engine.mutate.valid();

    const [r1, r2] = await Promise.allSettled([command1, command2]);
    expect(r1.status).toBe("rejected");
    expect(r2.status).toBe("fulfilled");

    expect(
      (await engine.sql({ sql: "SELECT COUNT(*) FROM users" })).rows[0],
    ).toBe(2);
  });

  it("mutator are atomic", async ({ expect, hub }) => {
    const engine = await buildEngine(hub.newTab(), {
      mutators: {
        atomicMutator: async (h: DBHandle) => {
          await h.sql({
            sql: "INSERT INTO users(name) VALUES (?)",
            params: ["John"],
          });

          throw new Error("error after insert");
        },
      },
    });

    try {
      await engine.mutate.atomicMutator().catch();
    } catch (_) {}

    expect(
      (await engine.sql({ sql: "SELECT COUNT(*) FROM users" })).rows[0],
    ).toBe(0);
  });
});

describe("handle multiple tabs", () => {
  it("migrations are run only once", async ({ expect, hub }) => {
    const tabA = hub.newTab();
    const tabB = hub.newTab();

    let called = 0;
    const opts: Partial<Config<testMut>> = {
      migrations: [
        {
          version: 1,
          run: async (db) => {
            called += 1;
            await db.exec(
              `CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT);
              INSERT INTO users(name) VALUES ('John Doe')`,
            );
          },
        },
      ],
    };

    const engineA = buildEngine(tabA, opts);
    const eningeB = buildEngine(tabB, opts);
    await Promise.all([engineA, eningeB]);

    expect(called).toBe(1);

    const {
      rows: [count],
    } = await (
      await engineA
    ).sql<number>({ sql: "SELECT COUNT(*) FROM users" });
    expect(count).toBe(1);
  });

  it("tabA notify tabB on insert", async ({ expect, hub }) => {
    const engineA = await buildEngine(hub.newTab());
    const tabB = hub.newTab();

    const onChange = vi.fn();
    tabB.onTablesChanged(onChange);

    await buildEngine(tabB);

    await engineA.mutate.addUser("John Doe");
    await hub.settle();
    expect(onChange).toHaveBeenCalled();
  });

  it("tabA notify tabB on update", async ({ expect, hub }) => {
    const engineA = await buildEngine(hub.newTab(), {
      mutators: {
        addUser: async (h: DBHandle, name: string) => {
          await h.sql({
            sql: "INSERT INTO users(name) VALUES (?)",
            params: [name],
          });
        },
        upperCase: async (h: DBHandle) => {
          await h.sql({ sql: "UPDATE users SET name = upper(name)" });
        },
      },
    });
    const tabB = hub.newTab();

    const onChange = vi.fn();
    tabB.onTablesChanged(onChange);

    await buildEngine(tabB);
    await engineA.mutate.addUser("John Doe");

    onChange.mockClear();
    await engineA.mutate.upperCase();
    await hub.settle();
    expect(onChange).toHaveBeenCalled();
  });

  it("tabA notify tabB with only 'users' table when adding user", async ({
    expect,
    hub,
  }) => {
    const engineA = await buildEngine(hub.newTab());
    const tabB = hub.newTab();

    const onChange = vi.fn();
    tabB.onTablesChanged(onChange);

    await buildEngine(tabB);
    await engineA.mutate.addUser("John Doe");
    await hub.settle();
    expect(onChange).toHaveBeenCalledWith(["users"]);
  });
});

describe("have reactive query", () => {
  it("query is notified when table change", async ({ expect, hub }) => {
    const engine = await buildEngine(hub.newTab());

    const onChange = vi.fn();
    const { data, unlisten } = await engine.reactiveQuery<number>(
      { sql: "SELECT COUNT(*) FROM users" },
      { onChange },
    );

    expect(data[0]).toBe(0);

    await engine.mutate.addUser("John Doe");
    await hub.settle();
    expect(onChange).toHaveBeenCalled();
    onChange.mockClear();
    unlisten();

    await engine.mutate.addUser("Jane Doe");
    await hub.settle();
    expect(onChange).not.toHaveBeenCalled();
  });

  it.for([
    ["CREATE TABLE tests(c)"],
    ["INSERT INTO users(name) VALUES ('Test')"],
    ["UPDATE users SET name = upper(name)"],
  ])("update %s", async ([sql], { expect, hub }) => {
    const engine = await buildEngine(hub.newTab());

    await expect(
      engine.reactiveQuery({ sql }, { onChange: vi.fn() }),
    ).rejects.toThrow("read only");
  });
});

describe("SyncEngine allow to sync", () => {
  it("adds data from the server", async ({ expect, hub }) => {
    const puller = {
      pull: vi.fn<Puller["pull"]>().mockResolvedValue({
        server_version: 1,
        last_mutation_id: 0,
        mutations: [
          {
            op: "upsert",
            table: "users",
            pks: ["id"],
            records: [
              { id: 1, name: "John Doe" },
              { id: 2, name: "Jane Doe" },
            ],
          },
        ],
      }),
    };

    const engine = await buildEngine(hub.newTab(), { puller });
    await engine.sync();

    const {
      rows: [count],
    } = await engine.sql<number>(sql`SELECT COUNT(*) FROM users`);
    expect(count).toBe(2);
  });

  it("deletes data when server says so", async ({ expect, hub }) => {
    const puller = {
      pull: vi.fn<Puller["pull"]>().mockResolvedValue({
        server_version: 1,
        last_mutation_id: 0,
        mutations: [
          {
            op: "delete",
            table: "users",
            pks: ["id"],
            records: [{ id: 1 }, { id: 2 }],
          },
        ],
      }),
    };

    const engine = await buildEngine(hub.newTab(), { puller });
    await engine.sql(
      sql`INSERT INTO users(id, name) VALUES (${1}, 'Jane'), (2, ${"John"}), (3, 'Not deleted')`,
      false,
    );

    await engine.sync();
    const { rows } = await engine.sql(sql`SELECT * FROM users`);
    expect(rows).toMatchObject([{ id: 3, name: "Not deleted" }]);
  });

  it("deletes table with multiple columns primary key", async ({
    expect,
    hub,
  }) => {
    const puller = {
      pull: vi.fn<Puller["pull"]>().mockResolvedValue({
        server_version: 1,
        last_mutation_id: 0,
        mutations: [
          {
            op: "delete",
            table: "users",
            pks: ["name", "age"],
            records: [
              { name: "John", age: 20 },
              { name: "Me", age: 32 },
            ],
          },
        ],
      }),
    };

    const engine = await buildEngine(hub.newTab(), {
      puller,
      migrations: [
        {
          version: 1,
          run: async (db: MigrationHandle) => {
            await db.exec(
              "CREATE TABLE users (name,age,friend, PRIMARY KEY (name,age))",
            );
          },
        },
      ],
    });
    await engine.sql(
      sql`INSERT INTO users(name,age) VALUES ('Jane', 20), (${"John"}, ${20}), ('Me', 32)`,
      false,
    );

    await engine.sync();
    const { rows } = await engine.sql(sql`SELECT * FROM users`);
    expect(rows).toMatchObject([{ name: "Jane", age: 20 }]);
  });

  it("replays mutations on server state", async ({ expect, hub }) => {
    const puller = {
      pull: vi.fn<Puller["pull"]>().mockResolvedValue({
        server_version: 1,
        last_mutation_id: 0,
        mutations: [
          {
            op: "upsert",
            table: "users",
            pks: ["id"],
            records: [
              { id: 1, name: "John" },
              { id: 2, name: "Me" },
            ],
          },
        ],
      }),
    };

    const engine = await buildEngine(hub.newTab(), {
      puller,
      mutators: {
        upperName: async (handle: DBHandle) => {
          handle.sql(sql`UPDATE users SET name = upper(name)`);
        },
      },
    });

    await engine.mutate.upperName(); // does nothing since no users
    const { rows } = await engine.sql(sql`SELECT * FROM users ORDER BY id`);
    expect(rows.length).toBe(0); // no users yet

    await engine.sync();
    const afterSync = await engine.sql(sql`SELECT * FROM users ORDER BY id`);
    expect(afterSync.rows).toMatchObject([
      { id: 1, name: "JOHN" },
      { id: 2, name: "ME" },
    ]); // mutation applied
  });
});

describe("sql function", () => {
  it.for([
    {
      query: () => sql`SELECT * FROM users WHERE name = ${"Jane"}`,
      params: ["Jane"],
      sql: "SELECT * FROM users WHERE name = ?",
    },
    {
      query: () => sql`INSERT INTO users (name, age) VALUES (${"John"}, ${30})`,
      params: ["John", 30],
      sql: "INSERT INTO users (name, age) VALUES (?, ?)",
    },
    {
      query: () =>
        sql`WITH adults AS (SELECT * FROM users WHERE age >= ${18}) SELECT name FROM adults`,
      params: [18],
      sql: "WITH adults AS (SELECT * FROM users WHERE age >= ?) SELECT name FROM adults",
    },
  ])("sql for %j", ({ query, params, sql }, { expect }) => {
    expect(query()).toMatchObject({ sql, params });
  });
});

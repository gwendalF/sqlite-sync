import { describe, test as baseTest, vi } from "vitest";
import { SyncEngine } from "./sync_engine";
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

const test = baseTest.extend("hub", async () => {
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

function buildEngine(plateform: Plateform): Promise<SyncEngine<testMut>>;
function buildEngine(
  plateform: Plateform,
  mutators: undefined,
  opts?: Partial<Config<testMut>>,
): Promise<SyncEngine<testMut>>;
function buildEngine<M extends MutatorsConfig>(
  Plateform: Plateform,
  mutators: M,
  opts?: Partial<Config<M>>,
): Promise<SyncEngine<M>>;
function buildEngine<M extends MutatorsConfig>(
  plateform: Plateform,
  mutators?: M,
  opts?: Partial<Config<M>>,
) {
  if (mutators) {
    return SyncEngine.create(plateform, {
      mutators,
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
    });
  }

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
  });
}

describe("SyncEngine", () => {
  test("create a syncEngine", async ({ expect, hub }) => {
    await expect(
      SyncEngine.create(hub.newTab(), {
        puller: stubPuller,
        mutators: {},
      }),
    ).resolves.toBeDefined();
  });

  test("mutator function are callable", async ({ expect, hub }) => {
    const engine = await buildEngine(hub.newTab());
    await expect(engine.mutate.addUser("John Doe")).resolves.toBeUndefined();
  });

  test("apply 1 migration on create", async ({ expect, hub }) => {
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

  test("user_version is not updated after failed migration", async ({
    expect,
    hub,
  }) => {
    const initial = await getUserVersion(hub.core);

    await expect(
      buildEngine(hub.newTab(), undefined, {
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

  test("user_version is updated after successful migration", async ({
    expect,
    hub,
  }) => {
    const initial = await getUserVersion(hub.core);

    await expect(buildEngine(hub.newTab())).resolves.toBeDefined();
    const final = await getUserVersion(hub.core);
    expect(final).toBeGreaterThan(initial);
  });

  test("mutators are queued", async ({ expect, hub }) => {
    const order: string[] = [];

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let signalStarted!: () => void;
    const slowStarted = new Promise<void>((r) => (signalStarted = r));

    const engine = await buildEngine(hub.newTab(), {
      slowMutator: async () => {
        order.push("slow:start");
        signalStarted();
        await gate;
        order.push("slow:end");
      },
      addUser: async (h, name: string) => {
        order.push("add:start");
        await h.sql({
          sql: "INSERT INTO users(name) VALUES (?)",
          params: [name],
        });
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

  test("rejection on mutator does not block queued mutators", async ({
    expect,
    hub,
  }) => {
    const engine = await buildEngine(hub.newTab(), {
      throw: async (h) => {
        return new Promise((_, reject) =>
          setTimeout(() => reject(new Error("invalid mutator")), 0),
        );
      },
      valid: async (h) => {
        await h.sql({
          sql: "INSERT INTO users(name) VALUES (?),(?)",
          params: ["John Doe", "Jane Doe"],
        });
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

  test("mutator are atomic", async ({ expect, hub }) => {
    const engine = await buildEngine(hub.newTab(), {
      atomicMutator: async (h) => {
        await h.sql({
          sql: "INSERT INTO users(name) VALUES (?)",
          params: ["John"],
        });

        throw new Error("error after insert");
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

describe("multiple tabs", () => {
  test("migrations are run only once", async ({ expect, hub }) => {
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

    const engineA = buildEngine(tabA, undefined, opts);
    const eningeB = buildEngine(tabB, undefined, opts);
    await Promise.all([engineA, eningeB]);

    expect(called).toBe(1);

    const {
      rows: [count],
    } = await (
      await engineA
    ).sql<number>({ sql: "SELECT COUNT(*) FROM users" });
    expect(count).toBe(1);
  });

  test("tabA notify tabB on insert", async ({ expect, hub }) => {
    const engineA = await buildEngine(hub.newTab());
    const tabB = hub.newTab();

    const onChange = vi.fn();
    tabB.onTablesChanged(onChange);

    await buildEngine(tabB);

    await engineA.mutate.addUser("John Doe");
    await hub.settle();
    expect(onChange).toHaveBeenCalled();
  });

  test("tabA notify tabB on update", async ({ expect, hub }) => {
    const engineA = await buildEngine(hub.newTab(), {
      addUser: async (h: DBHandle, name: string) => {
        await h.sql({
          sql: "INSERT INTO users(name) VALUES (?)",
          params: [name],
        });
      },
      upperCase: async (h: DBHandle) => {
        await h.sql({ sql: "UPDATE users SET name = upper(name)" });
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

  test("tabA notify tabB with only 'users' table when adding user", async ({
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

describe("reactive query", () => {
  test("query is notified when table change", async ({ expect, hub }) => {
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

  test.for([
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

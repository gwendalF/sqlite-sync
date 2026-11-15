import { describe, test as baseTest, vi } from "vitest";
import { sql, SyncEngine } from "./sync_engine";
import { Syncer } from "./syncer";
import { PullResponse } from "./sync_sqlite/sync_sqlite";
import {
  Config,
  DBHandle,
  MigrationHandle,
  MutatorFn,
  MutatorsConfig,
  ValidatedConfig,
} from "./config";
import { Platform } from "./platform/platform";
import { createTestHub } from "./testing";
import { SqliteDB } from "./core";

const it = baseTest.extend("hub", async () => {
  return createTestHub();
});

const stubSyncer: Syncer = {
  async pull(): Promise<PullResponse> {
    throw Error("no sync used");
  },
  async push(): Promise<void> {},
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
  platform: Platform,
  opts?: Partial<ValidatedConfig<M>>,
): Promise<SyncEngine<M>> {
  return SyncEngine.create(platform, {
    mutators: {
      addUser: async (handle: DBHandle, name: string) => {
        await handle.sql({
          sql: "INSERT INTO users(name) VALUES (?)",
          params: [name],
        });
      },
    },
    syncer: stubSyncer,
    autoSync: false,
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
  } as ValidatedConfig<M>);
}

describe("SyncEngine creation", () => {
  it("create a syncEngine", async ({ expect, hub }) => {
    await expect(
      SyncEngine.create(hub.newTab(), {
        syncer: stubSyncer,
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
      syncer: stubSyncer,
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
        slowMutator: async (_: DBHandle) => {
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
        throw: async (_: DBHandle) => {
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

  it("can pass a parser in the mutator", async ({ expect, hub }) => {
    const isUser = (p: unknown): p is { name: string; created_at: string } => {
      const anyP = p as any;
      return (
        typeof anyP === "object" &&
        typeof anyP.name === "string" &&
        typeof anyP.created_at === "string"
      );
    };
    const engine = await buildEngine(hub.newTab(), {
      mutators: {
        withDeserializer: {
          fn: async (
            h: DBHandle,
            payload: { name: string; created_at: Date },
          ) => {
            await h.sql(
              sql`INSERT INTO users(name, created_at) VALUES (${payload.name}, ${payload.created_at.toISOString()})`,
            );
          },
          deserialize: (payload: unknown) => {
            if (isUser(payload)) {
              return {
                name: payload.name,
                created_at: new Date(payload.created_at),
              };
            }
            throw new Error("invalid payload");
          },
        },
      },
      migrations: [
        {
          version: 1,
          run: async (db) => {
            await db.exec(
              "CREATE TABLE users(name TEXT PRIMARY KEY, created_at TEXT NOT NULL)",
            );
          },
        },
      ],
      syncer: {
        pull: vi.fn<Syncer["pull"]>().mockResolvedValue({
          server_version: 1,
          last_mutation_id: 0,
          mutations: [],
        }),
        push: vi.fn(),
      },
    });

    const now = new Date();
    await engine.mutate.withDeserializer({ name: "John", created_at: now });
    await expect(engine.sync()).resolves.not.toThrow();
  });

  it("does not call push if there is no pending mutations", async ({
    expect,
    hub,
  }) => {
    const syncer: Syncer = {
      push: vi.fn(),
      pull: vi.fn<Syncer["pull"]>().mockResolvedValue({
        last_mutation_id: 0,
        server_version: 0,
        mutations: [],
      }),
    };

    const engine = await buildEngine(hub.newTab(), {
      syncer,
    });
    await engine.sync();

    expect(syncer.push).not.toHaveBeenCalled();

    await engine.mutate.addUser("Gwendal");
    await engine.sync();
    expect(syncer.push).toHaveBeenCalled();
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

  it("query read from an index only is notified when its table change", async ({
    expect,
    hub,
  }) => {
    const engine = await buildEngine(hub.newTab(), {
      migrations: [
        {
          version: 1,
          run: async (db) => {
            await db.exec(`
              CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT);
              CREATE INDEX users_name ON users(name);`);
          },
        },
      ],
    });

    const onChange = vi.fn();
    await engine.reactiveQuery<string>(
      { sql: "SELECT name FROM users WHERE name > ''" },
      { onChange },
    );

    await engine.mutate.addUser("John Doe");
    await hub.settle();
    expect(onChange).toHaveBeenCalledWith(["John Doe"]);
  });

  it("query is notified when a pull writes its table", async ({
    expect,
    hub,
  }) => {
    const syncer = {
      pull: vi.fn<Syncer["pull"]>().mockResolvedValue({
        server_version: 1,
        last_mutation_id: 0,
        mutations: [
          {
            op: "upsert",
            table: "users",
            pks: ["id"],
            records: [{ id: 1, name: "John Doe" }],
          },
        ],
      }),
      push: vi.fn(),
    };
    const engine = await buildEngine(hub.newTab(), { syncer });

    const onChange = vi.fn();
    await engine.reactiveQuery<number>(
      { sql: "SELECT COUNT(*) FROM users" },
      { onChange },
    );

    await engine.sync();
    await hub.settle();
    expect(onChange).toHaveBeenCalledWith([1]);
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
    const syncer = {
      pull: vi.fn<Syncer["pull"]>().mockResolvedValue({
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
      push: vi.fn(),
    };

    const engine = await buildEngine(hub.newTab(), { syncer });
    await engine.sync();

    const {
      rows: [count],
    } = await engine.sql<number>(sql`SELECT COUNT(*) FROM users`);
    expect(count).toBe(2);
  });

  it("deletes data when server says so", async ({ expect, hub }) => {
    const syncer = {
      pull: vi.fn<Syncer["pull"]>().mockResolvedValue({
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
      push: vi.fn(),
    };

    const engine = await buildEngine(hub.newTab(), { syncer });
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
    const syncer = {
      pull: vi.fn<Syncer["pull"]>().mockResolvedValue({
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
      push: vi.fn(),
    };

    const engine = await buildEngine(hub.newTab(), {
      syncer,
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
    const syncer = {
      pull: vi.fn<Syncer["pull"]>().mockResolvedValue({
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
      push: vi.fn(),
    };

    const engine = await buildEngine(hub.newTab(), {
      syncer,
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

  it("replays the pending mutations in the order they were made", async ({
    expect,
    hub,
  }) => {
    const syncer = {
      // the server has applied none of the local mutations yet
      pull: vi.fn<Syncer["pull"]>().mockResolvedValue({
        server_version: 1,
        last_mutation_id: 0,
        mutations: [
          {
            op: "upsert",
            table: "users",
            pks: ["id"],
            records: [{ id: 1, name: "server" }],
          },
        ],
      }),
      push: vi.fn(),
    };

    const engine = await buildEngine(hub.newTab(), {
      syncer,
      mutators: {
        rename: async (handle: DBHandle, name: string) => {
          await handle.sql(sql`UPDATE users SET name = ${name} WHERE id = 1`);
        },
      },
    });

    await engine.mutate.rename("first");
    await engine.mutate.rename("second");
    await engine.sync();

    const { rows } = await engine.sql(sql`SELECT name FROM users`);
    expect(rows).toEqual(["second"]);
  });

  it("rolls back the rebase when a replayed mutation fails", async ({
    expect,
    hub,
  }) => {
    const syncer: Syncer = {
      push: vi.fn(),
      // the server already has a user with the id used by the local mutation
      pull: vi.fn<Syncer["pull"]>().mockResolvedValue({
        server_version: 1,
        last_mutation_id: 0,
        mutations: [
          {
            op: "upsert",
            table: "users",
            pks: ["id"],
            records: [{ id: 1, name: "server" }],
          },
        ],
      }),
    };

    const engine = await buildEngine(hub.newTab(), {
      syncer,
      mutators: {
        insertUser: async (
          handle: DBHandle,
          user: { id: number; name: string },
        ) => {
          await handle.sql(
            sql`INSERT INTO users(id, name) VALUES (${user.id}, ${user.name})`,
          );
        },
      },
    });

    await engine.mutate.insertUser({ id: 1, name: "local" });
    // replaying the INSERT on top of the server state violates the primary key
    await expect(engine.sync()).rejects.toThrow();

    // the engine is still usable and the local state is the one before the pull
    await expect(
      engine.mutate.insertUser({ id: 2, name: "other" }),
    ).resolves.toBeUndefined();
    const { rows } = await engine.sql(sql`SELECT * FROM users ORDER BY id`);
    expect(rows).toMatchObject([
      { id: 1, name: "local" },
      { id: 2, name: "other" },
    ]);
  });

  it("calls sync after a mutation when autoSync is enabled", async ({
    expect,
    hub,
  }) => {
    const syncer: Syncer = {
      push: vi.fn(),
      pull: vi.fn<Syncer["pull"]>().mockResolvedValue({
        last_mutation_id: 1,
        server_version: 1,
        mutations: [],
      }),
    };

    const engine = await buildEngine(hub.newTab(), { syncer, autoSync: true });
    expect(syncer.push).not.toHaveBeenCalled();

    await engine.mutate.addUser("Jane");
    // sync is fire-and-forget, so it may complete after mutate resolves
    await vi.waitFor(() => expect(syncer.pull).toHaveBeenCalled());
    expect(syncer.push).toHaveBeenCalledOnce();
  });

  it("does not sync after a mutation when autoSync is disabled", async ({
    expect,
    hub,
  }) => {
    const syncer: Syncer = { push: vi.fn(), pull: vi.fn() };

    const engine = await buildEngine(hub.newTab(), { syncer, autoSync: false });
    await engine.mutate.addUser("Jane");

    expect(syncer.push).not.toHaveBeenCalled();
    expect(syncer.pull).not.toHaveBeenCalled();
  });
});

describe("onSync", () => {
  const emptyPull: PullResponse = {
    server_version: 1,
    last_mutation_id: 0,
    mutations: [],
  };

  it("reports a successful sync", async ({ expect, hub }) => {
    const onSync = vi.fn();
    const syncer: Syncer = {
      push: vi.fn(),
      pull: vi.fn<Syncer["pull"]>().mockResolvedValue(emptyPull),
    };
    const engine = await buildEngine(hub.newTab(), { syncer, onSync });

    await engine.sync();

    expect(onSync).toHaveBeenCalledExactlyOnceWith({ ok: true });
  });

  it("reports a failed sync, which still rejects", async ({ expect, hub }) => {
    const onSync = vi.fn();
    const error = new Error("offline");
    const syncer: Syncer = {
      push: vi.fn(),
      pull: vi.fn<Syncer["pull"]>().mockRejectedValue(error),
    };
    const engine = await buildEngine(hub.newTab(), { syncer, onSync });

    await expect(engine.sync()).rejects.toBe(error);

    expect(onSync).toHaveBeenCalledExactlyOnceWith({ ok: false, error });
  });

  it("reports the failure of the sync started by a mutation", async ({
    expect,
    hub,
  }) => {
    const onSync = vi.fn();
    const error = new Error("session expired");
    const syncer: Syncer = {
      push: vi.fn<Syncer["push"]>().mockRejectedValue(error),
      pull: vi.fn<Syncer["pull"]>().mockResolvedValue(emptyPull),
    };
    const engine = await buildEngine(hub.newTab(), {
      syncer,
      onSync,
      autoSync: true,
    });

    await engine.mutate.addUser("Jane");

    await vi.waitFor(() =>
      expect(onSync).toHaveBeenCalledWith({ ok: false, error }),
    );
  });
});

describe("concurrent syncs", () => {
  const usersAt = (server_version: number, name: string): PullResponse => ({
    server_version,
    last_mutation_id: 0,
    mutations: [
      { op: "upsert", table: "users", pks: ["id"], records: [{ id: 1, name }] },
    ],
  });

  /** Syncer whose n-th pull is answered by calling `resolve[n]` */
  const deferredSyncer = () => {
    const resolve: ((response: PullResponse) => void)[] = [];
    const syncer: Syncer = {
      push: vi.fn(),
      pull: vi.fn<Syncer["pull"]>(
        () => new Promise((r) => void resolve.push(r)),
      ),
    };
    return { syncer, resolve };
  };

  it("ignores a stale pull response arriving after a newer one", async ({
    expect,
    hub,
  }) => {
    const { syncer, resolve } = deferredSyncer();

    const engine = await buildEngine(hub.newTab(), { syncer });
    const first = engine.sync();
    const second = engine.sync();
    await vi.waitFor(() => expect(syncer.pull).toHaveBeenCalledTimes(2));

    // the second request is answered first, with the newest state
    resolve[1](usersAt(2, "new"));
    await second;
    resolve[0](usersAt(1, "old"));
    await first;

    const { rows } = await engine.sql(sql`SELECT * FROM users`);
    expect(rows).toMatchObject([{ id: 1, name: "new" }]);
  });

  it("applies a newer pull response arriving after an older one", async ({
    expect,
    hub,
  }) => {
    const { syncer, resolve } = deferredSyncer();

    const engine = await buildEngine(hub.newTab(), { syncer });
    const first = engine.sync();
    const second = engine.sync();
    await vi.waitFor(() => expect(syncer.pull).toHaveBeenCalledTimes(2));

    resolve[0](usersAt(1, "old"));
    await first;
    resolve[1](usersAt(2, "new"));
    await second;

    const { rows } = await engine.sql(sql`SELECT * FROM users`);
    expect(rows).toMatchObject([{ id: 1, name: "new" }]);
  });

  it("two tabs can sync at the same time", async ({ expect, hub }) => {
    const syncer: Syncer = {
      push: vi.fn(),
      pull: vi.fn<Syncer["pull"]>().mockResolvedValue(usersAt(1, "John")),
    };

    const tabA = await buildEngine(hub.newTab(), { syncer });
    const tabB = await buildEngine(hub.newTab(), { syncer });

    await expect(
      Promise.all([tabA.sync(), tabB.sync()]),
    ).resolves.toBeDefined();
    const { rows } = await tabB.sql(sql`SELECT * FROM users`);
    expect(rows).toMatchObject([{ id: 1, name: "John" }]);
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

import { describe, test as baseTest } from "vitest";
import { SyncEngine } from "./sync_engine";
import { Puller } from "./puller";
import { PullResponse } from "./sync_sqlite/sync_sqlite";
import { DBHandle, MigrationHandle } from "./config";
import { System } from "./system";
import { SqliteDB } from "./core";
import { readFileSync } from "node:fs";

const wasm = await WebAssembly.compile(
  readFileSync(new URL("./sync_sqlite/sync_sqlite_bg.wasm", import.meta.url)),
);

const test = baseTest.extend("system", async () => {
  return createTestHub();
});

export async function createTestHub(name = ":memory:") {
  const core = await SqliteDB.create(name, { wasm });
  let tail: Promise<unknown> = Promise.resolve();
  const tabs = new Set<(tables: string[] | "*") => void>();

  const newTab = (): System => {
    let me: (tables: string[] | "*") => void;
    return {
      call: async (method, ...args) => {
        try {
          return await core.handle(method, ...args);
        } catch (e) {
          throw new Error(e instanceof Error ? e.message : String(e));
        }
      },
      lock: (fn) => {
        const run = tail.then(fn);
        tail = run.catch(() => {});
        return run;
      },
      onTablesChanged: (cb) => {
        me = cb;
        tabs.add(cb);
        return () => tabs.delete(cb);
      },
      notifyTablesChanged: (tables) =>
        tabs.forEach((t) => t !== me && t(tables)),
      close() {},
    };
  };

  return { core, newTab };
}

describe("can create SyncEngine", () => {
  const testPuller: Puller = {
    async pull(version: number): Promise<PullResponse> {
      return {
        server_version: version,
        last_mutation_id: 0,
        mutations: [],
      };
    },
  };

  test("create a syncEngine", async ({ expect, system }) => {
    expect(
      SyncEngine.create(system.newTab(), {
        db: ":memory:",
        puller: testPuller,
        mutators: {},
      }),
    ).resolves;
  });

  test("apply 1 migration on create", async ({ expect, system }) => {
    const engine = await SyncEngine.create(system.newTab(), {
      db: ":memory:",
      puller: testPuller,
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

    expect(engine.sql({ sql: "SELECT * FROM migrations" })).resolves;
  });

  test("user_version is updated after migrations", async ({
    expect,
    system,
  }) => {
    const engine = await SyncEngine.create(system.newTab(), {
      db: ":memory:",
      puller: testPuller,
      mutators: {},
      migrations: [
        {
          version: 1,
          run: async (db: MigrationHandle) => {
            await db.exec("CREATE TABLE migrations(version)");
          },
        },
        {
          version: 2,
          run: async (db: MigrationHandle) => {
            await db.exec("INSERT INTO migrations(version) VALUES ('testing')");
          },
        },
      ],
    });

    expect(
      (await engine.sql({ sql: "SELECT * FROM migrations" })).rows,
    ).toEqual(["testing"]);

    expect(
      (await engine.sql({ sql: "SELECT * FROM pragma_user_version" })).rows,
    ).toEqual([2]);
  });
});

describe("table change notifications", () => {
  test("");
});

import { describe, test } from "vitest";
import { SqliteDB } from "./core";
import { readFileSync } from "node:fs";

const wasm = await WebAssembly.compile(
  readFileSync(new URL("./sync_sqlite/sync_sqlite_bg.wasm", import.meta.url)),
);

describe("SqliteDb", () => {
  test("can launch a db in memory", async ({ expect }) => {
    const db = await SqliteDB.create(":memory:", { wasm });
    const response = await db.handle("query", {
      sql: "SELECT 2/2",
      params: [],
      isReadonly: true,
    });
    expect(response).toMatchObject({ rows: [1], isReadonly: true });
  });

  test("only 1 connexion with commit/rollback", async ({ expect }) => {
    const db = await SqliteDB.create(":memory:", { wasm });
    await db.handle("query", {
      sql: "CREATE TABLE test(v)",
      params: [],
      isReadonly: false,
    });

    const count = async () => {
      const { rows } = await db.handle("query", {
        sql: "SELECT COUNT(*) FROM test",
        params: [],
        isReadonly: true,
      });
      return rows[0];
    };

    await db.handle("begin");
    await db.handle("query", {
      sql: "INSERT INTO test(v) VALUES (?)",
      params: ["test_value"],
      isReadonly: false,
    });
    const duringTx = await count();
    expect(duringTx).toBe(1);
    await db.handle("rollback");
    const afterRollback = await count();
    expect(afterRollback).toEqual(0);
  });
});

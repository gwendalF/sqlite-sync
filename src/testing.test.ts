import { readFileSync } from "fs";
import { SqliteDB } from "./core";
import { Plateform } from "./plateform/plateform";
import { test } from "vitest";

const wasm = await WebAssembly.compile(
  readFileSync(new URL("./sync_sqlite/sync_sqlite_bg.wasm", import.meta.url)),
);

export async function createTestHub(name = ":memory:") {
  const core = await SqliteDB.create(name, { wasm });
  let tail: Promise<unknown> = Promise.resolve();
  const tabs = new Set<(tables: string[] | "*") => void>();
  const pending = new Set<Promise<void>>();

  const newTab = (): Plateform => {
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
      notifyTablesChanged(change) {
        const payload = structuredClone(change);
        for (const other of tabs) {
          if (other === me) continue;

          const delivery = new Promise<void>((resolve) =>
            setTimeout(() => {
              if (tabs.has(other)) other(structuredClone(payload));
              resolve();
            }, 0),
          );
          pending.add(delivery);
          delivery.finally(() => pending.delete(delivery));
        }
      },
      close() {},
    };
  };

  return {
    core,
    newTab,
    settle: async () => {
      while (true) {
        const before = tail;
        await Promise.allSettled([...pending]);
        await before;
        await new Promise((r) => setTimeout(r, 0));
        if (before === tail && pending.size === 0) return;
      }
    },
  };
}

test("has test in file", () => {});

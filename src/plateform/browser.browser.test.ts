import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserPlateform, type BrowserPlateformOptions } from "./browser";
import type { Plateform } from "./plateform";

const uid = () => crypto.randomUUID();
const worker = () => {
  const w = new Worker(new URL("../worker.ts", import.meta.url), {
    type: "module",
  });
  return w;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const sql = (
  p: Plateform,
  s: string,
  params: unknown[] = [],
  isReadonly = true,
) => p.call("query", { sql: s, params, isReadonly });

const opened: Plateform[] = [];

async function open(ns: string, o: Partial<BrowserPlateformOptions> = {}) {
  const plateform = new BrowserPlateform({
    dbName: ":memory:",
    namespace: ns,
    worker,
    ...o,
  });
  await plateform.start();
  opened.push(plateform);
  return plateform;
}

afterEach(() => {
  for (const p of opened.splice(0)) p.close();
});

describe("call", () => {
  it("call worker and get response", async () => {
    expect((await sql(await open(uid()), "SELECT 1")).rows).toEqual([1]);
  });

  it("invalid syntax", async () => {
    await expect(sql(await open(uid()), "SELEC 1")).rejects.toThrow(
      /syntax error/i,
    );
  });

  it("export: get database export", async () => {
    const p = await open(uid());
    await sql(p, "CREATE TABLE t (x)", [], false);
    const data = await p.call("export", undefined);
    expect(new TextDecoder().decode(data.slice(0, 15))).toBe("SQLite format 3");
  });
});

describe("leader", () => {
  it("2 plateforme : 1 leader, 1 DB", async () => {
    const ns = uid();
    const a = await open(ns);
    const b = await open(ns);
    await sql(a, "CREATE TABLE t (x)", [], false);
    await sql(a, "INSERT INTO t VALUES (1)", [], false);
    expect((await sql(b, "SELECT x FROM t")).rows).toEqual([1]);

    const { held } = await navigator.locks.query();
    expect(held?.filter((l) => l.name === `${ns}:leader`)).toHaveLength(1);
  });

  it("new tab don't break inflights request of other tab", async () => {
    const ns = uid();
    const a = await open(ns);
    const inflight = sql(
      a,
      "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 300000) SELECT COUNT(*) FROM c",
    );
    await open(ns);
    await expect(inflight).resolves.toBeDefined();
  });

  it("failover: leader leave place for another one", async () => {
    const ns = uid();
    const a = await open(ns);
    const b = await open(ns);
    a.close();

    await vi.waitFor(
      async () => expect((await sql(b, "SELECT 1")).rows).toEqual([1]),
      { timeout: 1_000, interval: 100 },
    );
  });

  it("OPFS data stay after leader close", async () => {
    const ns = uid();
    const dbName = `${ns}.db`;
    const a = await open(ns, { dbName });
    await sql(a, "CREATE TABLE t (x)", [], false);
    await sql(a, "INSERT INTO t VALUES (?)", [42], false);
    a.close();

    const b = await open(ns, { dbName });
    expect((await sql(b, "SELECT x FROM t")).rows).toEqual([42]);
  });
});

describe("lock", () => {
  it("exclusion between plateform and order", async () => {
    const ns = uid();
    const a = await open(ns);
    const b = await open(ns);
    const order: string[] = [];
    await Promise.all([
      a.lock(async () => {
        order.push("a:start");
        await sleep(50);
        order.push("a:end");
      }),
      b.lock(async () => {
        order.push("b");
      }),
    ]);
    expect(order).toEqual(["a:start", "a:end", "b"]);
  });

  it("error drop lock", async () => {
    const p = await open(uid());
    await expect(
      p.lock(async () => {
        throw new Error("x");
      }),
    ).rejects.toThrow("x");
    await expect(p.lock(async () => "ok")).resolves.toBe("ok");
  });
});

describe("notifications", () => {
  it("delivered to others not to sender", async () => {
    const ns = uid();
    const a = await open(ns);
    const b = await open(ns);
    const onA = vi.fn(),
      onB = vi.fn();
    a.onTablesChanged(onA);
    b.onTablesChanged(onB);
    a.notifyTablesChanged(["jobs"]);
    a.notifyTablesChanged("*");
    await vi.waitFor(() => expect(onB.mock.calls).toEqual([[["jobs"]], ["*"]]));
    await sleep(50);
    expect(onA).not.toHaveBeenCalled();
  });

  it("isolated by namespace", async () => {
    const a = await open(uid());
    const other = await open(uid());
    const onOther = vi.fn();
    other.onTablesChanged(onOther);
    a.notifyTablesChanged(["jobs"]);
    await sleep(50);
    expect(onOther).not.toHaveBeenCalled();
  });

  it("unsubscribe", async () => {
    const ns = uid();
    const a = await open(ns);
    const b = await open(ns);
    const onB = vi.fn();
    b.onTablesChanged(onB)();
    a.notifyTablesChanged(["jobs"]);
    await sleep(50);
    expect(onB).not.toHaveBeenCalled();
  });
});

describe("open and close", () => {
  it("tab1 close, tab2 get leader, tab3 inflights request are replayed", async () => {
    const ns = uid();
    const a = await open(ns);
    const b = await open(ns);
    const c = await open(ns);

    const inflight = sql(
      c,
      "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 300000) SELECT COUNT(*) FROM c",
    );
    a.close();

    await expect(inflight).resolves.toBeDefined();
  });
});

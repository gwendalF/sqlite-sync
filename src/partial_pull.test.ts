import { describe, test as baseTest, vi, ExpectStatic } from "vitest";
import { sql, SyncEngine } from "./sync_engine";
import { Syncer } from "./syncer";
import { DBHandle, Query, ValidatedConfig } from "./config";
import { createTestHub } from "./testing";
import { PagedServer, Row, ServerMutators } from "./test_support/paged_server";
import type { PullRequest, PullResponse } from "./sync_sqlite/sync_sqlite";
import type { SyncState } from "./messages";

type Hub = Awaited<ReturnType<typeof createTestHub>>;

const SCHEMA = `
  CREATE TABLE invoices(id INTEGER PRIMARY KEY, label TEXT, amount INTEGER);
  CREATE TABLE entries(id INTEGER PRIMARY KEY, invoice_id INTEGER, amount INTEGER);`;

type Invoice = { id: number; label: string; amount: number };

const mutators = {
  renameInvoice: async (db: DBHandle, p: { id: number; label: string }) => {
    await db.sql(
      sql`UPDATE invoices SET label = ${p.label} WHERE id = ${p.id}`,
    );
  },
  addInvoice: async (db: DBHandle, p: Invoice) => {
    await db.sql(
      sql`INSERT INTO invoices(id, label, amount) VALUES (${p.id}, ${p.label}, ${p.amount})`,
    );
  },
};

const serverMutators: ServerMutators = {
  renameInvoice: (s, p) => s.update("invoices", p.id, { label: p.label }),
  addInvoice: (s, p) => s.upsert("invoices", p),
};

/** 10 invoices then 20 entries: versions 1 to 30 */
function seededServer() {
  const server = new PagedServer(["invoices", "entries"], serverMutators);
  for (let id = 1; id <= 10; id++) {
    server.upsert("invoices", { id, label: `invoice ${id}`, amount: id * 100 });
  }
  for (let id = 1; id <= 20; id++) {
    server.upsert("entries", { id, invoice_id: (id % 10) + 1, amount: id });
  }
  return server;
}

type Hook = (n: number, request: PullRequest) => void | Promise<void>;

/**
 * Syncer talking to `server`. `before(n)` runs before the n-th pull (from 0) reaches
 * the server: the responses to the previous pulls have all been applied by then.
 */
function connect(server: PagedServer, before?: Hook) {
  let n = 0;
  const responses: PullResponse[] = [];
  const syncer: Syncer = {
    push: vi.fn(async (request) => server.push(request)),
    pull: vi.fn(async (request) => {
      await before?.(n++, request);
      const response = server.pull(request);
      responses.push(response);
      return response;
    }),
  };
  return { syncer, responses };
}

function buildEngine(
  hub: Hub,
  opts: Partial<ValidatedConfig<typeof mutators>> & { syncer: Syncer },
) {
  return SyncEngine.create(hub.newTab(), {
    mutators,
    autoSync: false,
    migrations: [{ version: 1, run: (db) => db.exec(SCHEMA) }],
    ...opts,
  } as ValidatedConfig<typeof mutators>);
}

async function localRows(engine: SyncEngine<any>, table: string) {
  const { rows } = await engine.sql<Row>({
    sql: `SELECT * FROM ${table} ORDER BY id`,
  });
  return rows;
}

async function expectSameAsServer(
  expect: ExpectStatic,
  engine: SyncEngine<any>,
  server: PagedServer,
) {
  for (const table of server.tableOrder) {
    expect(await localRows(engine, table)).toEqual(server.rows(table));
  }
}

/** Writes outside any mutator, which `engine.sql` does not allow */
function write(hub: Hub, { sql, params = [] }: Query) {
  return hub.core.handle("query", { sql, params, isReadonly: false });
}

async function pendingCount(hub: Hub) {
  const { rows } = await hub.core.handle("query", {
    sql: "SELECT count(*) FROM pending_mutations",
    params: [],
    isReadonly: true,
  });
  return rows[0] as number;
}

async function storedCursor(hub: Hub) {
  const { rows } = await hub.core.handle("query", {
    sql: "SELECT value FROM config WHERE key = 'pull_cursor'",
    params: [],
    isReadonly: true,
  });
  return rows[0] as string | undefined;
}

const label = async (engine: SyncEngine<any>, id: number) => {
  const { rows } = await engine.sql<string>(
    sql`SELECT label FROM invoices WHERE id = ${id}`,
  );
  return rows[0];
};

const it = baseTest
  .extend("hub", async () => {
    return createTestHub();
  })
  .extend("server", () => {
    return seededServer();
  });

describe("backend without cursor", () => {
  it("is pulled once, with the same request as before", async ({
    expect,
    hub,
    server,
  }) => {
    const { syncer } = connect(server);
    const engine = await buildEngine(hub, { syncer });

    await engine.mutate.addInvoice({ id: 100, label: "local", amount: 1 });
    await engine.sync();

    expect(syncer.pull).toHaveBeenCalledTimes(1);
    expect(server.pulls[0]).toStrictEqual({
      client_id: expect.any(String),
      version: null,
    });
    await expectSameAsServer(expect, engine, server);
    expect(await pendingCount(hub)).toBe(0);
    expect(await engine.syncState()).toStrictEqual({ isBootstrapping: false });
  });
});

describe("malformed response", () => {
  it("fails the sync on a response missing a field", async ({
    expect,
    hub,
  }) => {
    const syncer: Syncer = {
      push: vi.fn(),
      pull: vi
        .fn()
        .mockResolvedValue({ type: "changes", last_mutation_id: 0, mutations: [] }),
    };
    const engine = await buildEngine(hub, { syncer, onSync: () => {} });

    await expect(engine.sync()).rejects.toThrow("missing field `version`");
  });
});

describe("partial pull", () => {
  it("bootstraps an empty database in several pages, then catches up from V0", async ({
    expect,
    hub,
    server,
  }) => {
    const { syncer } = connect(server);
    const engine = await buildEngine(hub, { syncer, pullLimit: 4 });

    await engine.sync();

    await expectSameAsServer(expect, engine, server);
    // invoices: 4 + 4 + 2, entries: 5 × 4, then the incremental pull
    expect(server.pulls).toHaveLength(9);
    expect(server.pulls[0]).toStrictEqual({
      client_id: expect.any(String),
      version: null,
      limit: 4,
    });
    for (const request of server.pulls.slice(1, 8)) {
      expect(request.version).toBeNull();
      expect(request.cursor).toEqual(expect.any(String));
    }
    expect(server.pulls[8]).toMatchObject({ version: "v30" });
    expect(server.pulls[8].cursor).toBeUndefined();
    expect(await storedCursor(hub)).toBeUndefined();
  });

  it("sends the cursor back as received", async ({ expect, hub, server }) => {
    const { syncer, responses } = connect(server);
    const engine = await buildEngine(hub, { syncer, pullLimit: 4 });

    await engine.sync();

    for (let i = 1; i < server.pulls.length; i++) {
      const previous = responses[i - 1];
      expect(server.pulls[i].cursor).toBe(
        previous.type === "reset" ? undefined : previous.cursor,
      );
    }
  });

  it("corrects a row modified on the server after it was sent", async ({
    expect,
    hub,
    server,
  }) => {
    const { syncer } = connect(server, async (n) => {
      if (n === 1) server.update("invoices", 1, { label: "B" });
      if (n === 8) expect(await label(engine, 1)).toBe("invoice 1");
    });
    const engine = await buildEngine(hub, { syncer, pullLimit: 4 });

    await engine.sync();

    expect(await label(engine, 1)).toBe("B");
    // the version the bootstrap started from, not the current one (31)
    expect(server.pulls[8]).toMatchObject({ version: "v30" });
    await expectSameAsServer(expect, engine, server);
  });

  it("removes rows deleted on the server, already sent or not", async ({
    expect,
    hub,
    server,
  }) => {
    const { syncer } = connect(server, (n) => {
      if (n === 1) {
        server.delete("invoices", 1); // sent by the first page
        server.delete("invoices", 9); // not sent yet
      }
    });
    const engine = await buildEngine(hub, { syncer, pullLimit: 4 });

    await engine.sync();

    const ids = (await localRows(engine, "invoices")).map((r) => r.id);
    expect(ids).not.toContain(1);
    expect(ids).not.toContain(9);
    await expectSameAsServer(expect, engine, server);
  });

  it("keeps one row, with its last value, for a row created during the bootstrap and received twice", async ({
    expect,
    hub,
    server,
  }) => {
    const { syncer, responses } = connect(server, (n) => {
      if (n === 1)
        server.upsert("invoices", { id: 11, label: "new", amount: 1 });
      if (n === 5) server.update("invoices", 11, { label: "new v2" });
    });
    const engine = await buildEngine(hub, { syncer, pullLimit: 4 });

    await engine.sync();

    const sent = responses.flatMap((r) =>
      r.type === "changes"
        ? r.mutations.flatMap((m) =>
            m.records.filter((rec) => rec.id === 11 && m.table === "invoices"),
          )
        : [],
    );
    expect(sent).toHaveLength(2); // by the bootstrap, then by the incremental pull
    const { rows } = await engine.sql(
      sql`SELECT * FROM invoices WHERE id = 11`,
    );
    expect(rows).toEqual([{ id: 11, label: "new v2", amount: 1 }]);
    await expectSameAsServer(expect, engine, server);
  });

  it("keeps a pushed mutation visible after each page, and only purges it after the catch-up", async ({
    expect,
    hub,
    server,
  }) => {
    const seen: { label1: string; label9?: string; pending: number }[] = [];
    const { syncer, responses } = connect(server, async (n) => {
      if (n === 1) {
        // invoice 1 was sent by the first page, invoice 9 is not there yet
        await engine.mutate.renameInvoice({ id: 1, label: "mine" });
        await engine.mutate.renameInvoice({ id: 9, label: "mine too" });
        await syncer.push(await hub.core.handle("pushRequest"));
      }
      if (n >= 2) {
        seen.push({
          label1: await label(engine, 1),
          label9: await label(engine, 9),
          pending: await pendingCount(hub),
        });
      }
    });
    const engine = await buildEngine(hub, { syncer, pullLimit: 4 });

    await engine.sync();

    // every page after the push acknowledges both mutations
    expect(
      responses
        .slice(1)
        .every((r) => r.type === "changes" && r.last_mutation_id === 2),
    ).toBe(true);
    // a page holds the server state from V0: without the replay, invoice 1 would show its old label
    expect(seen.length).toBe(7);
    for (const s of seen) {
      expect(s.label1).toBe("mine");
      expect(s.pending).toBe(2);
    }
    expect(seen.at(-1)?.label9).toBe("mine too");

    expect(await pendingCount(hub)).toBe(0);
    expect(await label(engine, 1)).toBe("mine");
    expect(await label(engine, 9)).toBe("mine too");
    await expectSameAsServer(expect, engine, server);
  });

  it("keeps pushing during the bootstrap, and converges with the syncs mutations start", async ({
    expect,
    hub,
    server,
  }) => {
    const { syncer } = connect(server, async (n) => {
      if (n === 2) await engine.mutate.renameInvoice({ id: 2, label: "auto" });
      if (n === 5)
        await engine.mutate.addInvoice({ id: 50, label: "x", amount: 5 });
    });
    const engine = await buildEngine(hub, {
      syncer,
      pullLimit: 4,
      autoSync: true,
    });

    await engine.sync();
    await vi.waitFor(async () => expect(await pendingCount(hub)).toBe(0));
    await hub.settle();
    await engine.sync();

    expect(syncer.push).toHaveBeenCalled();
    expect(server.rows("invoices").find((r) => r.id === 2)?.label).toBe("auto");
    await expectSameAsServer(expect, engine, server);
    expect(await engine.syncState()).toStrictEqual({ isBootstrapping: false });
  });

  it("resumes from the stored cursor after an interruption", async ({
    expect,
    hub,
    server,
  }) => {
    const failing = connect(server, (n) => {
      if (n === 3) throw Error("network down");
    });
    const first = await buildEngine(hub, {
      syncer: failing.syncer,
      pullLimit: 4,
      onSync: () => {},
    });
    await expect(first.sync()).rejects.toThrow("network down");

    const last = failing.responses[2];
    const cursor = last.type === "reset" ? undefined : last.cursor;
    expect(cursor).toEqual(expect.any(String));
    expect(await storedCursor(hub)).toBe(cursor);
    expect(await first.syncState()).toMatchObject({
      isBootstrapping: true,
      progress: { done: 10 },
    });

    // another tab, as after a reload
    const resumed = connect(server);
    const engine = await buildEngine(hub, {
      syncer: resumed.syncer,
      pullLimit: 4,
    });
    await engine.sync();

    const firstRequest = vi.mocked(resumed.syncer.pull).mock.calls[0][0];
    expect(firstRequest.cursor).toBe(cursor);
    // the pages already applied are not pulled again: 5 pages of entries + catch-up
    expect(resumed.syncer.pull).toHaveBeenCalledTimes(6);
    await expectSameAsServer(expect, engine, server);
  });

  it("notifies the reactive queries after each page", async ({
    expect,
    hub,
    server,
  }) => {
    const { syncer } = connect(server);
    const engine = await buildEngine(hub, { syncer, pullLimit: 4 });

    const onInvoices = vi.fn();
    const onEntries = vi.fn();
    await engine.reactiveQuery(sql`SELECT count(*) FROM invoices`, {
      onChange: onInvoices,
    });
    await engine.reactiveQuery(sql`SELECT count(*) FROM entries`, {
      onChange: onEntries,
    });

    await engine.sync();
    await hub.settle();

    expect(onInvoices.mock.calls).toEqual([[[4]], [[8]], [[10]]]);
    expect(onEntries.mock.calls).toEqual([
      [[4]],
      [[8]],
      [[12]],
      [[16]],
      [[20]],
    ]);
  });

  it("reports the sync state after each page", async ({
    expect,
    hub,
    server,
  }) => {
    const { syncer } = connect(server);
    const engine = await buildEngine(hub, { syncer, pullLimit: 4 });

    const states: SyncState[] = [];
    engine.onSyncStateChange((s) => states.push(s));
    expect(await engine.syncState()).toStrictEqual({ isBootstrapping: false });

    await engine.sync();

    expect(states.slice(0, 3)).toEqual([
      { isBootstrapping: true, progress: { done: 4 } },
      { isBootstrapping: true, progress: { done: 8 } },
      { isBootstrapping: true, progress: { done: 10 } },
    ]);
    // the last page has no progress nor cursor, but the catch-up is still to come
    expect(states.at(-2)).toMatchObject({ isBootstrapping: true });
    expect(states.at(-1)).toStrictEqual({ isBootstrapping: false });
    expect(states).toHaveLength(9);
  });

  it("pages a large incremental pull, then catches up", async ({
    expect,
    hub,
  }) => {
    const upsert = (id: number, label: string): Extract<PullResponse, { type: "changes" }> => ({
      type: "changes",
      version: "v50", // ignored on a page
      last_mutation_id: 0,
      mutations: [
        {
          op: "upsert",
          table: "invoices",
          pks: ["id"],
          records: [{ id, label, amount: 0 }],
        },
      ],
    });
    const pull = vi
      .fn<Syncer["pull"]>()
      .mockResolvedValueOnce({ ...upsert(1, "a"), version: "v10" })
      // offline for a while: the server pages its answer
      .mockResolvedValueOnce({ ...upsert(2, "b"), cursor: "c1" })
      .mockResolvedValueOnce({ ...upsert(3, "c"), cursor: "c2" })
      .mockResolvedValueOnce({ ...upsert(4, "d"), version: "v40" })
      .mockResolvedValueOnce({
        type: "changes",
        version: "v41",
        last_mutation_id: 0,
        mutations: [],
      });
    const engine = await buildEngine(hub, {
      syncer: { pull, push: vi.fn() },
      pullLimit: 1,
    });

    await engine.sync();
    await engine.sync();

    const requests = pull.mock.calls.map(([r]) => [r.version, r.cursor]);
    expect(requests).toEqual([
      [null, undefined],
      ["v10", undefined],
      ["v10", "c1"],
      ["v10", "c2"],
      ["v40", undefined], // the catch-up after the last page
    ]);
    expect((await localRows(engine, "invoices")).map((r) => r.label)).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
  });

  it("ignores a page answering a cursor that is no longer the current one", async ({
    expect,
    hub,
    server,
  }) => {
    const { syncer } = connect(server);
    const engine = await buildEngine(hub, { syncer, pullLimit: 4 });

    await Promise.all([engine.sync(), engine.sync(), engine.sync()]);

    await expectSameAsServer(expect, engine, server);
    expect(await engine.syncState()).toStrictEqual({ isBootstrapping: false });
  });
});

describe("reset", () => {
  it("drops the replicated data, keeps the pending mutations and bootstraps again", async ({
    expect,
    hub,
    server,
  }) => {
    const { syncer } = connect(server);
    const engine = await buildEngine(hub, {
      syncer,
      pullLimit: 4,
      onSync: () => {},
    });
    await engine.sync();

    // a row the server never sent: only a reset removes it
    await write(
      hub,
      sql`INSERT INTO invoices(id, label, amount) VALUES (999, 'stray', 0)`,
    );
    // pending, never acknowledged: its push fails
    vi.mocked(syncer.push).mockRejectedValue(Error("push failed"));
    await engine.mutate.renameInvoice({ id: 1, label: "mine" });

    server.delete("invoices", 2);
    server.forgetHistory();

    const onChange = vi.fn();
    await engine.reactiveQuery(sql`SELECT count(*) FROM entries`, { onChange });
    const before = server.pulls.length;
    await expect(engine.sync()).rejects.toThrow("push failed");

    const requests = server.pulls.slice(before);
    expect(requests[0]).toMatchObject({ version: "v30" });
    expect(requests[1]).toStrictEqual({
      client_id: expect.any(String),
      version: null,
      limit: 4,
      priority: ["entries"],
    });

    expect(await pendingCount(hub)).toBe(1);
    expect(await label(engine, 1)).toBe("mine");
    const ids = (await localRows(engine, "invoices")).map((r) => r.id);
    expect(ids).not.toContain(2);
    expect(ids).not.toContain(999);
    expect(await localRows(engine, "entries")).toEqual(server.rows("entries"));
    await hub.settle();
    expect(onChange).toHaveBeenCalledWith([0]); // every table, emptied by the reset

    // the mutation goes through once the push works again
    vi.mocked(syncer.push).mockImplementation(async (r) => server.push(r));
    await engine.sync();
    expect(await pendingCount(hub)).toBe(0);
    await expectSameAsServer(expect, engine, server);
  });

  it("keeps the local-only tables", async ({ expect, hub, server }) => {
    const { syncer } = connect(server);
    const engine = await buildEngine(hub, {
      syncer,
      migrations: [
        {
          version: 1,
          run: (db) =>
            db.exec(
              `${SCHEMA} CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT);`,
            ),
        },
      ],
    });
    await engine.sync();
    await write(hub, sql`INSERT INTO settings VALUES ('theme', 'dark')`);

    server.update("invoices", 1, { label: "B" });
    server.forgetHistory();
    await engine.sync();

    // 30 is older than the history: reset, then everything again
    expect(server.pulls.map((r) => r.version)).toEqual([null, "v30", null]);
    const { rows } = await engine.sql(sql`SELECT value FROM settings`);
    expect(rows).toEqual(["dark"]);
    await expectSameAsServer(expect, engine, server);
  });

  it("is ignored when it answers a stale request", async ({
    expect,
    hub,
    server,
  }) => {
    const { syncer } = connect(server);
    const engine = await buildEngine(hub, { syncer });
    await engine.sync();

    let release!: (r: PullResponse) => void;
    vi.mocked(syncer.pull).mockImplementationOnce(
      () => new Promise((r) => (release = r)),
    );
    const stale = engine.sync();
    await vi.waitFor(() => expect(release).toBeDefined());

    server.update("invoices", 1, { label: "newer" });
    await engine.sync(); // the version moves from v30 to v31
    release({ type: "reset" });
    await stale;

    expect(await localRows(engine, "invoices")).toHaveLength(10);
    await expectSameAsServer(expect, engine, server);
  });
});

describe("foreign keys", () => {
  it("accepts a page holding a row before the row it references", async ({
    expect,
    hub,
  }) => {
    const syncer: Syncer = {
      push: vi.fn(),
      pull: vi.fn<Syncer["pull"]>().mockResolvedValue({
        type: "changes",
        version: "v1",
        last_mutation_id: 0,
        mutations: [
          {
            op: "upsert",
            table: "lines",
            pks: ["id"],
            records: [{ id: 1, invoice_id: 1 }],
          },
          {
            op: "upsert",
            table: "invoices",
            pks: ["id"],
            records: [{ id: 1 }],
          },
        ],
      }),
    };
    const engine = await SyncEngine.create(hub.newTab(), {
      syncer,
      mutators: {},
      autoSync: false,
      migrations: [
        {
          version: 1,
          run: (db) =>
            db.exec(`CREATE TABLE invoices(id INTEGER PRIMARY KEY);
              CREATE TABLE lines(id INTEGER PRIMARY KEY, invoice_id INTEGER NOT NULL REFERENCES invoices(id));`),
        },
      ],
    });
    await write(hub, sql`PRAGMA foreign_keys = ON`);

    await engine.sync();

    const { rows } = await engine.sql(sql`SELECT * FROM lines`);
    expect(rows).toEqual([{ id: 1, invoice_id: 1 }]);
  });
});

describe("priority", () => {
  /** every row sent by the pages of the bootstrap, as `table#id` */
  const scanned = (responses: PullResponse[]) =>
    responses.flatMap((r) =>
      r.type === "changes" && (r.cursor !== undefined || r.version === "v30")
        ? r.mutations.flatMap((m) =>
            m.records.map((rec) => `${m.table}#${rec.id}`),
          )
        : [],
    );

  it("asks first for the tables of the mounted reactive queries, latest first", async ({
    expect,
    hub,
    server,
  }) => {
    const { syncer, responses } = connect(server);
    const engine = await buildEngine(hub, { syncer, pullLimit: 4 });

    await engine.reactiveQuery(sql`SELECT count(*) FROM invoices`, {
      onChange: () => {},
    });
    await engine.reactiveQuery(
      sql`SELECT * FROM entries LEFT JOIN invoices ON invoices.id = invoice_id`,
      { onChange: () => {} },
    );
    await engine.sync();

    expect(server.pulls[0].priority).toEqual(["entries", "invoices"]);
    const first = responses[0];
    expect(first.type === "changes" && first.mutations[0].table).toBe("entries");
    await expectSameAsServer(expect, engine, server);
  });

  it("does not send a priority on incremental pulls", async ({
    expect,
    hub,
    server,
  }) => {
    const { syncer } = connect(server);
    const engine = await buildEngine(hub, { syncer });
    await engine.reactiveQuery(sql`SELECT count(*) FROM invoices`, {
      onChange: () => {},
    });

    await engine.sync();
    server.update("invoices", 1, { label: "B" });
    await engine.sync();

    expect(server.pulls[0].priority).toEqual(["invoices"]);
    expect(server.pulls[1]).toStrictEqual({
      client_id: expect.any(String),
      version: "v30",
    });
  });

  it("loses and repeats no row when the mounted queries change during the bootstrap", async ({
    expect,
    hub,
    server,
  }) => {
    let unlisten = () => {};
    const { syncer, responses } = connect(server, async (n) => {
      // a hook runs once the n-th request is built: it changes the next one
      if (n === 1) {
        // the user opens the entries screen after two pages of invoices
        ({ unlisten } = await engine.reactiveQuery(sql`SELECT * FROM entries`, {
          onChange: () => {},
        }));
      }
      if (n === 3) unlisten(); // and leaves it
    });
    const engine = await buildEngine(hub, { syncer, pullLimit: 4 });
    await engine.reactiveQuery(sql`SELECT * FROM invoices`, {
      onChange: () => {},
    });

    await engine.sync();

    expect(server.pulls.slice(0, 5).map((r) => r.priority)).toEqual([
      ["invoices"],
      ["invoices"],
      ["entries", "invoices"],
      ["entries", "invoices"],
      ["invoices"],
    ]);
    const tables = responses
      .slice(0, 5)
      .map((r) => (r.type === "reset" ? null : r.mutations[0].table));
    expect(tables).toEqual([
      "invoices",
      "invoices",
      "entries",
      "entries",
      "invoices",
    ]);

    const rows = scanned(responses);
    expect(new Set(rows).size).toBe(rows.length);
    expect(rows).toHaveLength(30);
    await expectSameAsServer(expect, engine, server);
  });
});

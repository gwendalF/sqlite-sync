import type {
  PullRequest,
  PullResponse,
  PushRequest,
  TableMutation,
} from "../sync_sqlite/sync_sqlite.js";

/**
 * Fake backend for the tests. Single writer: the number of the last write is the version.
 *
 * - `known_version: 0` with a `limit`: bootstrap by pages, table by table, by id. The
 *   cursor holds V0 and one position per table; the last page answers V0.
 * - `known_version: 0` without `limit`: everything in one response, as before.
 * - otherwise: what changed since `known_version` (tombstones included), in one
 *   response, or `reset` when the tombstones no longer go back that far.
 */
export type Row = { id: number } & Record<string, unknown>;

export type ServerMutators = Record<string, (server: PagedServer, args: any) => void>;

/** last id sent for each table, `null` once the table is done */
type Cursor = { v0: number; pos: Record<string, number | null>; done: number };

export class PagedServer {
  version = 0;
  private tables = new Map<string, Map<number, { row: Row; version: number }>>();
  private tombstones: { table: string; id: number; version: number }[] = [];
  private historyStart = 0;
  private clients = new Map<string, number>();
  readonly pulls: PullRequest[] = [];

  constructor(
    readonly tableOrder: string[],
    private mutators: ServerMutators = {},
  ) {
    for (const table of tableOrder) this.tables.set(table, new Map());
  }

  upsert = (table: string, row: Row) => {
    this.version++;
    this.tables.get(table)!.set(row.id, { row: { ...row }, version: this.version });
  };

  update = (table: string, id: number, patch: Record<string, unknown>) => {
    const current = this.tables.get(table)!.get(id)!.row;
    this.upsert(table, { ...current, ...patch, id });
  };

  delete = (table: string, id: number) => {
    if (!this.tables.get(table)!.delete(id)) return;
    this.version++;
    this.tombstones.push({ table, id, version: this.version });
  };

  /** Drops the tombstones: older clients get `reset`. */
  forgetHistory = () => {
    this.tombstones = [];
    this.historyStart = this.version;
  };

  rows = (table: string): Row[] =>
    [...this.tables.get(table)!.values()]
      .map((s) => s.row)
      .sort((a, b) => a.id - b.id);

  push = (request: PushRequest) => {
    let last = this.clients.get(request.client_id) ?? 0;
    for (const mutation of request.mutations) {
      // pushed again until a pull acknowledges it: apply it once
      if (mutation.id <= last) continue;
      this.mutators[mutation.name](this, mutation.args);
      last = mutation.id;
    }
    this.clients.set(request.client_id, last);
  };

  pull = (request: PullRequest): PullResponse => {
    this.pulls.push(structuredClone(request));
    return structuredClone(this.answer(request));
  };

  private answer = (request: PullRequest): PullResponse => {
    if (request.cursor !== undefined) {
      return this.page(JSON.parse(request.cursor), request);
    }
    if (request.known_version === 0 && request.limit !== undefined) {
      const pos = Object.fromEntries(this.tableOrder.map((t) => [t, 0]));
      return this.page({ v0: this.version, pos, done: 0 }, request);
    }
    if (request.known_version > 0 && request.known_version < this.historyStart) {
      return { reset: true };
    }

    const since = request.known_version;
    const mutations: TableMutation[] = this.tombstones
      .filter((t) => t.version > since)
      .map(({ table, id }) => ({ op: "delete", table, pks: ["id"], records: [{ id }] }));
    for (const [table, rows] of this.tables) {
      const changed = [...rows.values()].filter((s) => s.version > since);
      if (changed.length) mutations.push(upserts(table, changed.map((s) => s.row)));
    }
    return this.response(this.version, request, mutations);
  };

  /** Rows of one table after its position: the first table of `priority` not done. */
  private page = (cursor: Cursor, request: PullRequest): PullResponse => {
    const notDone = (t: string) => cursor.pos[t] != null;
    const table = request.priority?.find(notDone) ?? this.tableOrder.find(notDone)!;

    const remaining = this.rows(table).filter((r) => r.id > cursor.pos[table]!);
    const page = remaining.slice(0, request.limit);
    const pos = { ...cursor.pos };
    pos[table] = page.length === remaining.length ? null : page.at(-1)!.id;
    const done = cursor.done + page.length;

    const response = this.response(cursor.v0, request, page.length ? [upserts(table, page)] : []);
    if (Object.values(pos).every((p) => p === null)) {
      return response; // last page: V0, never the current version
    }
    return { ...response, cursor: JSON.stringify({ ...cursor, pos, done }), progress: { done } };
  };

  private response = (version: number, request: PullRequest, mutations: TableMutation[]) => ({
    server_version: version,
    last_mutation_id: this.clients.get(request.client_id) ?? 0,
    mutations,
  });
}

const upserts = (table: string, rows: Row[]): TableMutation => ({
  op: "upsert",
  table,
  pks: ["id"],
  records: rows.map((r) => ({ ...r })),
});

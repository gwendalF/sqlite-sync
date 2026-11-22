import {
  Config,
  DBHandle,
  LocalMutatorsArgs,
  Migration,
  MigrationHandle,
  MutatorsConfig,
  PublicMutators,
  PublicLocalMutators,
  Syncer,
  Query,
  MutatorFn,
  SyncResult,
  ValidatedConfig,
} from "./config";
import { Method, RpcArgs, SyncState } from "./messages.ts";
import { Platform } from "./platform/platform.ts";
import type { PullRequest, PullResponse } from "./sync_sqlite/sync_sqlite.js";

export type ReactiveHandlers<T> = {
  onChange: (data: T[]) => void;
  onError?: (err: Error) => void;
};

type Listener = { tables: Set<string>; onChange(): void };

/** Every table: sent after a reset, which empties them all. */
type Changes = string[] | "*";

/**
 * The server broke the pull protocol in a way that would lose data or never end.
 * The response is not applied and the sync fails.
 */
export class ProtocolError extends Error {
  override name = "ProtocolError";
}

export function sql(
  strings: TemplateStringsArray,
  ...params: unknown[]
): Query {
  let query = "";
  for (let i = 0; i < params.length; i++) {
    query += strings[i] + "?";
  }

  query += strings[strings.length - 1];
  return {
    sql: query,
    params,
  };
}

export class SyncEngine<
  M extends MutatorsConfig,
  L extends LocalMutatorsArgs = {},
> {
  private tablesCache = new Map<string, string[]>();
  private listeners = new Set<Listener>();
  private syncer: Syncer;
  private onSync: (result: SyncResult) => void;
  private pullLimit: number | undefined;
  private syncStateListeners = new Set<(state: SyncState) => void>();
  /** The last page this engine applied: the pages that follow it must answer its version. */
  private lastPage: { cursor: string; version: string } | undefined;

  private rawMutators: Record<
    string,
    {
      fn: (tables: Set<string>, payload: unknown) => Promise<void>;
      deserialize?: (payload: unknown) => unknown;
    }
  >;
  mutate: PublicMutators<M>;
  /** Writes to local-only tables: never pushed, reverted or replayed. */
  local: PublicLocalMutators<L>;

  private constructor(
    private platform: Platform,
    {
      autoSync = true,
      mutators,
      localMutators,
      syncer,
      pullLimit,
      onSync = (result) => {
        if (!result.ok) {
          console.error("syncFailed", result.error);
        }
      },
    }: Config<M, L>,
  ) {
    const publicMutators: Record<string, (payload: unknown) => Promise<void>> =
      {};
    const rawMutators: Record<
      string,
      {
        fn: (tables: Set<string>, payload: unknown) => Promise<void>;
        deserialize?: (payload: unknown) => unknown;
      }
    > = {};

    this.syncer = syncer;
    this.onSync = onSync;
    this.pullLimit = pullLimit;

    for (const [name, mut] of Object.entries(mutators)) {
      let deserialize: ((payload: unknown) => unknown) | undefined = undefined;
      let fn: MutatorFn<any>;
      if (typeof mut === "object" && mut !== null) {
        fn = mut.fn;
        deserialize = mut.deserialize;
      } else {
        fn = mut;
      }

      publicMutators[name] = async (payload) => {
        await this.platform.lock(async () => {
          const written = new Set<string>();
          try {
            await this.call("startMutate");
            await fn(this.trackingHandle(written), payload);
            await this.call("endMutate", { args: payload, name });
            const tables = [...written.keys()];
            this.notify(tables);
          } catch (e) {
            await this.call("rollback");
            throw e;
          }
        });
        if (autoSync) {
          // nobody awaits this sync: its failure is already reported to onSync
          this.sync().catch(() => {});
        }
      };

      rawMutators[name] = {
        fn: async (tables, payload) => {
          await fn(this.trackingHandle(tables), payload);
        },
        deserialize,
      };
    }

    this.mutate = publicMutators as unknown as PublicMutators<M>;
    this.rawMutators = rawMutators;

    const local: Record<string, (...args: unknown[]) => Promise<void>> = {};
    for (const [name, fn] of Object.entries(localMutators ?? {})) {
      // Same as a mutation, without the session: nothing is recorded for push.
      local[name] = (...args) =>
        this.platform.lock(async () => {
          const written = new Set<string>();
          try {
            await this.call("begin");
            await fn(this.trackingHandle(written), ...args);
            await this.call("commit");
          } catch (e) {
            await this.call("rollback");
            throw e;
          }
          this.notify([...written.keys()]);
        });
    }
    this.local = local as unknown as PublicLocalMutators<L>;
  }

  static create = async <
    M extends MutatorsConfig,
    L extends LocalMutatorsArgs = {},
  >(
    platform: Platform,
    config: ValidatedConfig<M, L>,
  ) => {
    const engine = new SyncEngine<M, L>(platform, config);
    if (config.migrations?.length) {
      await engine.applyMigrations(config.migrations);
    }

    return engine;
  };

  /**
   * Read-only: writes go through mutators, so they run under the lock and are captured.
   *
   * By default it does not wait for a running mutation or rebase, so it may see changes
   * rolled back afterwards. `committed: true` waits for them and only sees committed data.
   * Takes the task lock: calling it from code that already holds the lock (e.g. through a
   * closure in a mutator) never resolves.
   */
  sql = async <T = unknown>(
    query: Query,
    { committed = false }: { committed?: boolean } = {},
  ) => {
    const read = () => this.exec<T>(query, true);
    return committed ? this.platform.lock(read) : read();
  };

  private exec = async <T = unknown>(
    { sql, params = [] }: Query,
    isReadonly: boolean,
  ) => {
    return this.call("query", {
      sql,
      params,
      isReadonly,
    }) as Promise<{ rows: T[]; isReadonly: boolean }>;
  };

  reactiveQuery = async <T = unknown>(
    query: Query,
    handler: ReactiveHandlers<T>,
  ) => {
    const onError =
      handler.onError ??
      function (e) {
        throw e;
      };

    const read = async () => {
      const { rows: out } = await this.sql(query);
      return out as T[];
    };

    let callNumber = 0;
    let active = true;
    const refresh = async () => {
      const currentCall = ++callNumber;
      try {
        const rows = await this.platform.lock(read);
        if (active && currentCall === callNumber) {
          handler.onChange(rows);
        }
      } catch (e) {
        if (active) onError(e instanceof Error ? e : Error(`${e}`));
      }
    };

    const listener: Listener = {
      tables: new Set(),
      onChange: () => void refresh(),
    };

    const data = await this.platform.lock(async () => {
      const tables = await this.tablesOf(query.sql);
      const rows = await read();
      listener.tables = new Set(tables);
      this.listeners.add(listener);
      return rows;
    });

    return {
      data,
      unlisten: () => {
        active = false;
        this.listeners.delete(listener);
      },
    };
  };

  private push = async () => {
    const request = await this.call("pushRequest");
    if (request.mutations.length > 0) {
      await this.syncer.push(request);
    }
  };

  sync = async () => {
    try {
      await this.pushThenPull();
    } catch (error) {
      this.onSync({ ok: false, error });
      throw error;
    }
    this.onSync({ ok: true });
  };

  private pushThenPull = async () => {
    try {
      await this.push();
    } finally {
      // a partial response is followed by the next page, and the last page by an
      // incremental pull catching up with the changes made since the first one
      while (await this.pullOnce()) {}
    }
  };

  /** Pulls and applies one response. Resolves to `true` when another pull must follow. */
  private pullOnce = async (): Promise<boolean> => {
    const request = await this.call("beginPull");
    if (this.pullLimit !== undefined) {
      request.limit = this.pullLimit;
    }
    // only where a server pages by table: incremental pulls are left unchanged
    if (request.cursor !== undefined || request.version === null) {
      const priority = this.priority();
      if (priority.length) {
        request.priority = priority;
      }
    }
    const response = await this.syncer.pull(request);
    this.checkResponse(request, response);

    return this.platform.lock(async () => {
      const mutations = await this.call("startRebase", { request, response });
      if (!mutations) {
        return false;
      }
      this.lastPage =
        response.type === "changes" && response.cursor !== undefined
          ? { cursor: response.cursor, version: response.version }
          : undefined;

      let changes: Changes;
      try {
        const updated = new Set(
          response.type === "reset"
            ? []
            : response.mutations.map((m) => m.table),
        );
        for (const mutation of mutations) {
          const { fn, deserialize } = this.rawMutators[mutation.name];
          // Recapture the changeset: the replay runs on a new base, so the stored
          // one would no longer revert what is actually in the DB on the next rebase.
          await this.call("startCapture");
          await fn(
            updated,
            deserialize ? deserialize(mutation.args) : mutation.args,
          );
          await this.call("endReplay", mutation.id);
        }
        await this.call("endRebase");
        changes = response.type === "reset" ? "*" : [...updated.keys()];
      } catch (e) {
        await this.call("rollback");
        throw e;
      }

      this.notify(changes);
      await this.emitSyncState();
      const pullAgain =
        response.type === "reset" ||
        request.cursor !== undefined ||
        response.cursor !== undefined;
      return pullAgain;
    });
  };

  /**
   * Best effort: only catches the mistakes visible from this engine. The version is
   * only checked between pages this engine applied one after the other.
   */
  private checkResponse = (request: PullRequest, response: PullResponse) => {
    if (response.type === "reset") {
      if (request.version === null && request.cursor === undefined) {
        throw new ProtocolError(
          "the server answered reset to a pull without version: the client would bootstrap again forever",
        );
      }
      return;
    }

    if (response.cursor !== undefined && response.cursor === request.cursor) {
      throw new ProtocolError(
        "the server answered the cursor it was sent: the pull would never end",
      );
    }

    const page = this.lastPage;
    if (page && request.cursor === page.cursor && response.version !== page.version) {
      throw new ProtocolError(
        `the server answered version ${JSON.stringify(response.version)} to a page of a pull ` +
          `that answered ${JSON.stringify(page.version)}: every page, the last one included, ` +
          "must answer the version taken on the first page",
      );
    }
  };

  /**
   * Tables read by the mounted reactive queries, those of the latest mounted first:
   * what the screen shows now is wanted first during a partial pull.
   */
  private priority = (): string[] => {
    const tables = new Set<string>();
    for (const listener of [...this.listeners].reverse()) {
      for (const table of listener.tables) tables.add(table);
    }
    return [...tables];
  };

  /** Whether the local data is still being bootstrapped, see `SyncState`. */
  syncState = (): Promise<SyncState> => {
    return this.platform.lock(() => this.call("syncState"));
  };

  /**
   * Calls `cb` after each pull response this engine applies (each page of a partial
   * pull included). Returns the function that removes it.
   */
  onSyncStateChange = (cb: (state: SyncState) => void): (() => void) => {
    this.syncStateListeners.add(cb);
    return () => this.syncStateListeners.delete(cb);
  };

  private emitSyncState = async () => {
    if (this.syncStateListeners.size === 0) return;
    const state = await this.call("syncState");
    for (const cb of this.syncStateListeners) {
      try {
        cb(state);
      } catch (e) {
        // the page is committed: a failing listener must not fail the sync
        console.error("onSyncStateChange listener failed", e);
      }
    }
  };

  exportDatabase = async (): Promise<Uint8Array<ArrayBuffer>> => {
    const data = await this.call("export");
    return data;
  };

  close = () => {
    this.listeners.clear();
    this.syncStateListeners.clear();
  };

  private dispatch = (changes: Changes) => {
    for (const l of this.listeners) {
      if (changes === "*" || changes.some((table) => l.tables.has(table))) {
        l.onChange();
      }
    }
  };

  private notify = (changes: Changes) => {
    this.dispatch(changes);
    this.platform.notifyTablesChanged(changes);
  };

  private trackingHandle = (written: Set<string>): DBHandle => {
    return {
      sql: async (query) => {
        const tables = await this.tablesOf(query.sql);
        const { rows, isReadonly } = await this.exec(query, false);
        if (!isReadonly && tables.length) {
          tables.forEach((t) => written.add(t));
        }

        return rows;
      },
    };
  };

  private call = async <M extends Method>(
    method: M,
    ...args: [...RpcArgs<M>]
  ) => {
    return this.platform.call(method, ...args);
  };

  private applyMigrations = async (migrations: Migration[]) => {
    migrations.sort((a, b) => a.version - b.version);
    return this.platform.lock(async () => {
      let {
        rows: [version],
      } = await this.sql<number>({
        sql: "SELECT * FROM pragma_user_version",
      });

      for (const migration of migrations) {
        if (migration.version > version) {
          const dbHandle: MigrationHandle = {
            exec: async (query) => {
              await this.call("execMigration", {
                userVersion: version + 1,
                batch: query,
              });
            },
          };

          await migration.run(dbHandle);
          version += 1;
        }
      }
    });
  };

  private tablesOf = async (sql: string): Promise<string[]> => {
    const hit = this.tablesCache.get(sql);
    if (hit) return hit;

    // a query answered by a covering index only reports the index, not its table
    const { rows } = await this.sql<string>({
      sql: `SELECT name FROM tables_used(?1) WHERE type = 'table'
        UNION
        SELECT s.tbl_name FROM tables_used(?1) AS t
        JOIN sqlite_schema AS s ON s.type = 'index' AND s.name = t.name
        WHERE t.type = 'index'`,
      params: [sql],
    });
    this.tablesCache.set(sql, rows);
    return rows;
  };

  listDatabases = (): Promise<string[]> => {
    return this.call("listDatabases");
  };

  deleteDatabases = (databases: string[]) => {
    return this.call("deleteDatabases", databases);
  };
}

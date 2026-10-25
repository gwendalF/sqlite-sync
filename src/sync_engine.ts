import {
  Config,
  DBHandle,
  Migration,
  MigrationHandle,
  MutatorsConfig,
  PublicMutators,
  Puller,
  Query,
} from "./config";
import { Method, RpcArgs, RustQuery } from "./messages";
import { Plateform } from "./plateform/plateform";

export type ReactiveHandlers<T> = {
  onChange: (data: T[]) => void;
  onError?: (err: Error) => void;
};

type Listener = { tables: Set<string>; onChange(): void };

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

export class SyncEngine<M extends MutatorsConfig> {
  private tablesCache = new Map<string, string[]>();
  private listeners = new Set<Listener>();
  private puller: Puller;

  private rawMutators: Record<
    string,
    (tables: Set<string>, payload: unknown) => Promise<void>
  >;
  mutate: PublicMutators<M>;

  private constructor(
    private plateform: Plateform,
    config: Config<M>,
  ) {
    const publicMutators: Record<string, (payload: unknown) => Promise<void>> =
      {};
    const rawMutators: Record<
      string,
      (tables: Set<string>, payload: unknown) => Promise<void>
    > = {};

    this.puller = config.puller;

    for (const [name, fn] of Object.entries(config.mutators)) {
      publicMutators[name] = async (payload) => {
        await this.plateform.lock(async () => {
          const written = new Set<string>();
          try {
            await this.call("startMutate", undefined);
            await fn(this.trackingHandle(written), payload);
            await this.call("endMutate", { args: payload, name });
            const tables = [...written.keys()];
            this.notify(tables);
          } catch (e) {
            await this.call("rollback", undefined);
            throw e;
          }
        });
      };

      rawMutators[name] = async (tables, payload) => {
        await fn(this.trackingHandle(tables), payload);
      };
    }

    this.mutate = publicMutators as PublicMutators<M>;
    this.rawMutators = rawMutators;
  }

  static async create<M extends MutatorsConfig>(
    plateform: Plateform,
    config: Config<M>,
  ) {
    const engine = new SyncEngine(plateform, config);
    if (config.migrations?.length) {
      await engine.applyMigrations(config.migrations);
    }

    return engine;
  }

  async sql<T = unknown>({ sql, params = [] }: Query, isReadonly = true) {
    return this.plateform.call("query", {
      sql,
      params,
      isReadonly,
    }) as Promise<{ rows: T[]; isReadonly: boolean }>;
  }

  async reactiveQuery<T = unknown>(query: Query, handler: ReactiveHandlers<T>) {
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
        const rows = await this.plateform.lock(read);
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

    const data = await this.plateform.lock(async () => {
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
  }

  async sync() {
    const request = await this.call("beginPull", undefined);
    const response = await this.puller.pull(request.server_version);
    const endVersion = response.server_version;

    await this.plateform.lock(async () => {
      const mutations = await this.call("startRebase", response);
      const updated = new Set<string>();
      for (const mutation of mutations) {
        await this.rawMutators[mutation.name](updated, mutation.args);
      }
      await this.call("endRebase", endVersion);
      this.notify([...updated.keys()]);
    });
  }

  close() {
    this.listeners.clear();
  }

  private dispatch(changes: string[]) {
    for (const l of this.listeners) {
      for (const table of changes) {
        if (l.tables.has(table)) {
          l.onChange();
        }
      }
    }
  }

  private notify(changes: string[]) {
    this.dispatch(changes);
    this.plateform.notifyTablesChanged(changes);
  }

  private trackingHandle(written: Set<string>): DBHandle {
    return {
      sql: async (query) => {
        const tables = await this.tablesOf(query.sql);
        const { rows, isReadonly } = await this.sql(query, false);
        if (!isReadonly && tables.length) {
          tables.forEach((t) => written.add(t));
        }

        return rows;
      },
    };
  }

  private async call<M extends Method>(method: M, args: RpcArgs<M>) {
    return this.plateform.call(method, args);
  }

  private async applyMigrations(migrations: Migration[]) {
    migrations.sort((a, b) => a.version - b.version);
    return this.plateform.lock(async () => {
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
  }

  private async tablesOf(sql: string): Promise<string[]> {
    const hit = this.tablesCache.get(sql);
    if (hit) return hit;
    const { rows } = await this.sql<string>({
      sql: "SELECT name FROM tables_used(?) WHERE type = 'table'",
      params: [sql],
    });

    this.tablesCache.set(sql, rows);
    return rows;
  }
}

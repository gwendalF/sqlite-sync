import {
  Config,
  DBHandle,
  Migration,
  MigrationHandle,
  MutatorsConfig,
  PublicMutators,
  Syncer,
  Query,
  MutatorFn,
  SyncResult,
  ValidatedConfig,
} from "./config";
import { Method, RpcArgs } from "./messages.ts";
import { Plateform } from "./plateform/plateform.ts";

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
  private syncer: Syncer;
  private onSync: (result: SyncResult) => void;

  private rawMutators: Record<
    string,
    {
      fn: (tables: Set<string>, payload: unknown) => Promise<void>;
      deserialize?: (payload: unknown) => unknown;
    }
  >;
  mutate: PublicMutators<M>;

  private constructor(
    private plateform: Plateform,
    {
      autoSync = true,
      mutators,
      syncer,
      onSync = (result) => {
        if (!result.ok) {
          console.error("syncFailed", result.error);
        }
      },
    }: Config<M>,
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
        await this.plateform.lock(async () => {
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
  }

  static create = async <M extends MutatorsConfig>(
    plateform: Plateform,
    config: ValidatedConfig<M>,
  ) => {
    const engine = new SyncEngine<M>(plateform, config);
    if (config.migrations?.length) {
      await engine.applyMigrations(config.migrations);
    }

    return engine;
  };

  sql = async <T = unknown>({ sql, params = [] }: Query, isReadonly = true) => {
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
      const request = await this.call("beginPull");
      const response = await this.syncer.pull(request);

      const endVersion = response.server_version;

      await this.plateform.lock(async () => {
        const mutations = await this.call("startRebase", response);
        if (!mutations) {
          return;
        }

        try {
          const updated = new Set<string>();
          for (const mutation of mutations) {
            const { fn, deserialize } = this.rawMutators[mutation.name];
            await fn(
              updated,
              deserialize ? deserialize(mutation.args) : mutation.args,
            );
          }
          await this.call("endRebase", endVersion);
          this.notify([...updated.keys()]);
        } catch (e) {
          await this.call("rollback");
          throw e;
        }
      });
    }
  };

  exportDatabase = async (): Promise<Uint8Array<ArrayBuffer>> => {
    const data = await this.call("export");
    return data;
  };

  close = () => {
    this.listeners.clear();
  };

  private dispatch = (changes: string[]) => {
    for (const l of this.listeners) {
      for (const table of changes) {
        if (l.tables.has(table)) {
          l.onChange();
        }
      }
    }
  };

  private notify = (changes: string[]) => {
    this.dispatch(changes);
    this.plateform.notifyTablesChanged(changes);
  };

  private trackingHandle = (written: Set<string>): DBHandle => {
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
  };

  private call = async <M extends Method>(
    method: M,
    ...args: [...RpcArgs<M>]
  ) => {
    return this.plateform.call(method, ...args);
  };

  private applyMigrations = async (migrations: Migration[]) => {
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
  };

  private tablesOf = async (sql: string): Promise<string[]> => {
    const hit = this.tablesCache.get(sql);
    if (hit) return hit;

    const { rows } = await this.sql<string>({
      sql: "SELECT name FROM tables_used(?) WHERE type = 'table'",
      params: [sql],
    });
    this.tablesCache.set(sql, rows);
    return rows;
  };

  listDababases = (): Promise<string[]> => {
    return this.call("listDatabases");
  };

  deleteDatabases = (databases: string[]) => {
    return this.call("deleteDatabases", databases);
  };
}

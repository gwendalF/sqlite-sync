import {
  Config,
  DBHandle,
  Migration,
  MutatorsConfig,
  PublicMutators,
} from "./config";
import type {
  ChannelMessage,
  ChannelRequest,
  Method,
  Query,
  UpdateMessage,
  RpcMethods,
  WorkerRequest,
  WorkerResponse,
} from "./messages";
import { Puller } from "./puller";

const WORKER_CHANNEL = "rpc-channel";
const LOCK = "task-lock";

export class SyncEngine<M extends MutatorsConfig> {
  private reactiveChannel = new BroadcastChannel("reactive-query");
  private rpcChannel: BroadcastChannel;

  private listeners = new Set<{
    onChange: () => void;
    tables: string[];
  }>();
  private inflights = new Map<
    string,
    {
      resolve: (value: any) => void;
      reject: (e: Error) => void;
    }
  >();
  private puller: Puller;
  private rawMutators: PublicMutators<M>;
  mutate: PublicMutators<M>;

  private async applyMigrations(migrations: Migration[]) {
    const dbHandle: DBHandle = {
      sql: async (query) => {
        const { rows } = await this.sql(query);
        return rows;
      },
    };

    let {
      rows: [version],
    } = await this.sql<number>({
      sql: "SELECT * FROM pragma_user_version",
      params: [],
    });

    this.call("begin", undefined);
    try {
      for (const migration of migrations) {
        if (migration.version <= version) {
          continue;
        }

        version += 1;
        await migration.run(dbHandle);
        await this.call("updateUserVersion", version);
      }
    } catch (e) {
      this.call("rollback", undefined);
      console.warn(e);
    }

    this.call("commit", undefined);
  }

  private constructor(channel: BroadcastChannel, config: Config<M>) {
    this.puller = config.puller;

    const mutators = {} as PublicMutators<M>;
    const rawMutators = {} as PublicMutators<M>;

    const makeDbHandle = (updatedTables: Set<string>): DBHandle => {
      return {
        sql: async (query: Query): Promise<unknown[]> => {
          const { rows, tables, isReadonly } = await this.sql(query, true);
          if (!isReadonly && tables?.length) {
            tables.forEach((table) => updatedTables.add(table));
          }
          return rows;
        },
      };
    };

    for (const [key, fn] of Object.entries(config.mutators)) {
      (rawMutators as any)[key] = async (payload: any) => {
        const updatedTables = new Set<string>();
        await fn(makeDbHandle(updatedTables), payload);
        this.dispatchListeners(updatedTables);
      };
      (mutators as any)[key] = async (payload: any) => {
        await this.task(async () => {
          const updatedTables = new Set<string>();
          await this.call("startMutate", undefined);
          try {
            await fn(makeDbHandle(updatedTables), payload);
          } catch (e) {
            await this.call("rollback", undefined);
            return;
          }

          await this.call("endMutate", { name: key, args: payload });
          this.dispatchListeners(updatedTables);
        });
      };
    }

    this.mutate = mutators;
    this.rawMutators = rawMutators;

    channel.onmessage = (e: MessageEvent<ChannelMessage>) => {
      const message = e.data;
      if (message.type === "response") {
        const pending = this.inflights.get(message.id);
        if (pending && message.ok) {
          pending.resolve(message.value);
        } else if (pending && !message.ok) {
          pending.reject(new Error(message.error.message));
        }
      }
    };
    this.rpcChannel = channel;
  }

  private dispatchListeners(updatedTables: Set<string>) {
    if (updatedTables.size) {
      this.listeners.forEach(({ onChange, tables }) => {
        if (tables.some((t) => updatedTables.has(t))) {
          onChange();
        }
      });
    }
  }

  static async create<M extends MutatorsConfig>(config: Config<M>) {
    const channel = new BroadcastChannel(WORKER_CHANNEL);
    SyncEngine.claimLeaderShip(config.db);

    await new Promise((resolve) => {
      const on = (e: MessageEvent<ChannelMessage>) => {
        if (e.data.type === "leader-up") {
          channel.removeEventListener("message", on);
          resolve(undefined);
        }
      };
      channel.addEventListener("message", on);
      channel.postMessage({ type: "hello" } satisfies ChannelMessage);
    });

    const engine = new SyncEngine(channel, config);
    if (config.migrations) {
      await engine.applyMigrations(config.migrations);
    }

    return engine;
  }

  private static async claimLeaderShip(dbConfig: string) {
    await navigator.locks.request("leader-lock", async () => {
      const worker = new Worker(new URL("./worker.js", import.meta.url), {
        type: "module",
      });

      await new Promise((resolve, reject) => {
        worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
          if (e.data.type === "ready") {
            resolve(undefined);
          } else if (e.data.type === "init-error") {
            reject(new Error(e.data.error.message));
          }
        };
        worker.postMessage({
          type: "init",
          dbName: dbConfig,
        } satisfies WorkerRequest);
      });

      const broadcast = new BroadcastChannel(WORKER_CHANNEL);

      worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
        if (e.data.type === "response") {
          broadcast.postMessage(e.data);
        }
      };

      broadcast.onmessage = (e: MessageEvent<ChannelMessage>) => {
        if (e.data.type === "hello") {
          broadcast.postMessage({ type: "leader-up" } satisfies ChannelMessage);
        } else if (e.data.type === "request") {
          worker.postMessage(e.data);
        }
      };

      broadcast.postMessage({ type: "leader-up" });
      await new Promise(() => {});
    });
  }

  private async task<T>(fn: () => Promise<T>, signal?: AbortSignal) {
    return navigator.locks.request(LOCK, { signal }, fn);
  }

  private async call<M extends Method>(
    method: M,
    args: RpcMethods[M]["args"],
  ): Promise<RpcMethods[M]["result"]> {
    return new Promise((resolve, reject) => {
      const requestId = crypto.randomUUID();
      this.inflights.set(requestId, { resolve, reject });
      this.rpcChannel.postMessage({
        type: "request",
        id: requestId,
        method,
        args,
      } as ChannelRequest);
    });
  }

  private async sql<T>(
    query: Query,
    withTable?: boolean,
  ): Promise<{ rows: T[]; isReadonly: boolean; tables?: string[] }> {
    let tables: string[] | undefined;
    if (withTable) {
      tables = await this.tables(query);
    }

    const result = await this.call("query", query);
    return {
      rows: result.rows as T[],
      isReadonly: result.isReadonly,
      tables,
    };
  }

  private async tables(query: Query): Promise<string[]> {
    const { rows: tables } = await this.sql<string>({
      sql: `SELECT name FROM tables_used(?) WHERE type = 'table'`,
      params: [query.sql],
    });

    return tables;
  }

  async reactiveQuery<T>(
    query: Query,
    reactive: { onData: (data: T[]) => void; onError: (e: Error) => void },
  ): Promise<{
    data: T[];
    unlisten: () => void;
  }> {
    let onError = (e: Error): void => {
      throw e;
    };
    if (reactive.onError) {
      onError = reactive.onError;
    }

    let data: T[] = [];
    let tables: string[] = [];

    const onEffect = (e: MessageEvent<UpdateMessage>) => {
      if (tables.some((t) => e.data.tables.some((updated) => updated === t))) {
        runStatement();
      }
    };

    let first = true;
    const runStatement = async (): Promise<T[] | undefined> => {
      let data: T[] = [];
      try {
        await this.task(async () => {
          const out = await this.sql<T>(query);
          if (!out.isReadonly) {
            onError(
              new Error("can only use reactive query on read only query"),
            );
            return;
          }
          data = out.rows;
        });
        if (first) {
          first = false;
          return data;
        }

        reactive.onData(data);
      } catch (e) {
        onError(e as Error);
      }
    };

    const listener = {
      onChange: runStatement,
      tables,
    };

    await this.task(async () => {
      const updatedTables = await this.tables(query);
      tables.push(...updatedTables);
      this.listeners.add(listener);
    });

    const firstData = await runStatement();
    if (firstData) {
      data = firstData;
    }

    this.reactiveChannel.addEventListener("message", onEffect);

    return {
      data,
      unlisten: () => {
        this.reactiveChannel.removeEventListener("message", onEffect);
        this.listeners.delete(listener);
      },
    };
  }

  async exportDb(): Promise<Uint8Array<ArrayBuffer>> {
    const data = await this.call("export", undefined);
    return data;
  }

  async sync() {
    const request = await this.call("beginPull", undefined);
    const response = await this.puller.pull(request.server_version);
    const endVersion = response.server_version;
    await this.task(async () => {
      try {
        console.log("Before startrebase", response);
        const mutations = await this.call("startRebase", response);
        console.log({ mutations });
        for (const mutation of mutations) {
          await this.rawMutators[mutation.name](mutation.args);
        }

        await this.call("endRebase", endVersion);
      } catch (e) {
        console.warn("error during sync", e);
      }
    });
  }

  async untracked<T>(query: Query) {
    return this.task(() => this.sql(query));
  }

  async close() {
    return this.call("close", undefined);
  }
}

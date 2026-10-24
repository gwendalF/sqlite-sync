import {
  Method,
  Query,
  RpcArgs,
  RpcHandlers,
  RpcMethods,
  RustQuery,
} from "./messages";
import init, { PullResponse, SqliteEngine } from "./sync_sqlite/sync_sqlite";

const makeHandlers = (engine: SqliteEngine): RpcHandlers => ({
  startMutate: () => engine.start_mutate(),
  endMutate: ({ name, args: payload }) =>
    engine.end_mutate(name, JSON.stringify(payload)),
  beginPull: () => engine.begin_pull(),
  endRebase: (version: number) => engine.end_rebasing(version),
  startRebase: (response: PullResponse) => engine.start_rebasing(response),
  query: (query: RustQuery) => {
    const { rows, is_readonly } = engine.sql_exec({
      sql: query.sql,
      params: query.params,
      is_readonly: query.isReadonly,
    });
    return { rows, isReadonly: is_readonly };
  },
  execMigration: ({ userVersion, batch }) =>
    engine.exec_migration(batch, userVersion),
  begin: () => engine.begin(),
  commit: () => engine.commit(),
  rollback: () => engine.rollback(),
  export: () => {
    const data = engine.export_db();
    if (data.buffer instanceof ArrayBuffer) {
      return data as Uint8Array<ArrayBuffer>;
    }

    return new Uint8Array(data);
  },
  close: () => engine.free(),
});

export type WasmSource = Parameters<typeof init>[0];

export class SqliteDB {
  private constructor(private readonly handlers: RpcHandlers) {}

  static async create(
    name: string,
    opts?: { wasm?: WasmSource },
  ): Promise<SqliteDB> {
    await init(opts?.wasm ? { module_or_path: opts.wasm } : undefined);

    const rust = await SqliteEngine.create(name);
    return new SqliteDB(makeHandlers(rust));
  }

  async handle<M extends Method>(
    method: M,
    args: RpcArgs<M>,
  ): Promise<RpcMethods[M]["result"]> {
    return this.handlers[method](args);
  }
}

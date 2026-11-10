import {
  Method,
  RpcArgs,
  RpcHandlers,
  RpcMethods,
  RustQuery,
} from "./messages.ts";
import init, { PullResponse, SqliteEngine } from "./sync_sqlite/sync_sqlite.js";

const makeHandlers = (engine: SqliteEngine): RpcHandlers => ({
  startMutate: () => engine.start_mutate(),
  endMutate: ({ name, args: payload }) =>
    engine.end_mutate(name, JSON.stringify(payload)),
  beginPull: () => engine.begin_pull(),
  cancelPull: () => engine.cancel_pull(),
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
  listDatabases: () => engine.list_databases(),
  deleteDatabases: (databases) => engine.delete_databases(databases),
  pushRequest: () => engine.push_request(),
  rekey: (key) => engine.rekey(key),
});

export type WasmSource = Parameters<typeof init>[0];

export class SqliteDB {
  private constructor(private readonly handlers: RpcHandlers) {}

  static create = async (
    name: string,
    opts?: { wasm?: WasmSource; encryptionKey?: string },
  ): Promise<SqliteDB> => {
    await init(opts?.wasm ? { module_or_path: opts.wasm } : undefined);

    const rust = await SqliteEngine.create(name, opts?.encryptionKey);
    return new SqliteDB(makeHandlers(rust));
  };

  handle = async <M extends Method>(
    method: M,
    ...args: RpcArgs<M>
  ): Promise<RpcMethods[M]["result"]> => {
    return this.handlers[method](args[0]);
  };
}

import { Method, Query, RpcHandlers, RpcMethods } from "./messages";
import init, { PullResponse, SqliteEngine } from "./sync_sqlite/sync_sqlite";

const makeHandlers = (engine: SqliteEngine): RpcHandlers => ({
  startMutate: () => engine.start_mutate(),
  endMutate: ({ name, args: payload }) =>
    engine.end_mutate(name, JSON.stringify(payload)),
  beginPull: () => engine.begin_pull(),
  endRebase: (version: number) => engine.end_rebasing(version),
  startRebase: (response: PullResponse) => engine.start_rebasing(response),
  query: (query: Query) => {
    const params = query.params ?? [];
    const { rows, is_readonly } = engine.sql_exec({ sql: query.sql, params });
    return { rows, isReadonly: is_readonly };
  },
  begin: () => engine.begin(),
  commit: () => engine.commit(),
  rollback: () => engine.rollback(),
  updateUserVersion: (version: number) => engine.update_user_version(version),
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

type MethodWithArgs = {
  [K in Method]: RpcMethods[K]["args"] extends void | undefined ? never : K;
}[Method];

type MethodWithoutArgs = {
  [K in Method]: RpcMethods[K]["args"] extends void | undefined ? K : never;
}[Method];

export class SqliteDB {
  private constructor(private readonly handlers: RpcHandlers) {}

  static async create(
    name: string,
    opts?: { wasm?: WasmSource },
  ): Promise<SqliteDB> {
    await init(opts?.wasm);

    const rust = await SqliteEngine.create(name);
    return new SqliteDB(makeHandlers(rust));
  }

  async handle<M extends MethodWithArgs>(
    method: M,
    args: RpcMethods[M]["args"],
  ): Promise<RpcMethods[M]["result"]>;
  async handle<M extends MethodWithoutArgs>(
    method: M,
  ): Promise<RpcMethods[M]["result"]>;
  async handle<M extends Method>(
    method: M,
    args?: RpcMethods[M]["args"],
  ): Promise<RpcMethods[M]["result"]> {
    return this.handlers[method](args);
  }
}

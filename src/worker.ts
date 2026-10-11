import init, * as wasm from "./sync_sqlite/sync_sqlite";

import type {
  Query,
  WorkerHandlers,
  WorkerRequest,
  WorkerResponse,
} from "./messages";

const makeHandlers = (engine: SqliteEngine): WorkerHandlers => ({
  startMutate: () => engine.startMutation(),
  endMutate: ({ name, args: payload }) =>
    engine.completeMutation(name, payload),
  beginPull: () => engine.beginPull(),
  endRebase: (version: number) => engine.endRebasing(version),
  startRebase: (response: wasm.PullResponse) => engine.startRebasing(response),
  query: (query: Query) => engine.rawQuery(query.sql, query.params),
  begin: () => engine.begin(),
  commit: () => engine.commit(),
  rollback: () => engine.rollback(),
});

class SqliteEngine {
  private constructor(private readonly rustEngine: wasm.SqliteEngine) {}

  static async create(name: string): Promise<SqliteEngine> {
    await init();

    const rustEngine = await wasm.SqliteEngine.create(name);
    console.log({ rustEngine });
    const engine = new SqliteEngine(rustEngine);
    return engine;
  }

  rawQuery(
    sql: string,
    params: unknown[] = [],
  ): { rows: Record<string, unknown>[]; isReadonly: boolean } {
    const { rows, is_readonly } = this.rustEngine.sql_exec({ sql, params });
    return { rows, isReadonly: is_readonly };
  }

  beginPull(): wasm.PullRequest {
    return this.rustEngine.begin_pull();
  }

  startRebasing(pullResponse: wasm.PullResponse): wasm.LocalMutation[] {
    return this.rustEngine.start_rebasing(pullResponse);
  }

  endRebasing(serverVersion: number) {
    return this.rustEngine.end_rebasing(serverVersion);
  }

  startMutation() {
    return this.rustEngine.start_mutate();
  }

  completeMutation(name: string, args: unknown) {
    this.rustEngine.end_mutate(name, JSON.stringify(args));
  }

  rollback() {
    return this.rustEngine.rollback();
  }

  begin() {
    return this.rustEngine.begin();
  }

  commit() {
    return this.rustEngine.commit();
  }
}

let handlers: WorkerHandlers | undefined;

const post = (m: WorkerResponse) => self.postMessage(m);

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  if (event.data.type === "init") {
    try {
      const { dbName } = event.data;
      const engine = await SqliteEngine.create(dbName);
      handlers = makeHandlers(engine);
      post({ type: "ready" });
    } catch (_) {
      post({
        type: "init-error",
        error: {
          code: "INITIALISATION_NOT_DONE",
          message: "Error during WASM init",
        },
      });
    }

    return;
  }

  const { id, method, args } = event.data;
  if (!handlers) {
    post({
      type: "response",
      id,
      ok: false,
      error: {
        code: "INITIALISATION_NOT_DONE",
        message: "handlers are not ready yet. Call 'init' first",
      },
    });

    return;
  }

  try {
    // we known it's correct if the sender respect the type
    const handler = handlers[method] as (arg: unknown) => unknown;
    const response = await handler(args);
    post({ type: "response", ok: true, id, value: response });
  } catch (e) {
    post({
      type: "response",
      ok: false,
      id,
      error: {
        code: "RUNTIME_ERROR",
        message:
          e?.toString() ?? `error running handler ${method} with ${args}`,
      },
    });
  }
};

self.onerror = (e) => {
  console.warn(e);
};

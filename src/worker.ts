import { SqliteDB } from "./core";
import { WorkerRequest, WorkerResponse } from "./messages";

let sqlDb: SqliteDB | undefined;
const post = (m: WorkerResponse) => self.postMessage(m);
const postBytes = (id: string, data: Uint8Array) =>
  self.postMessage({ type: "response", id, value: data, ok: true }, [
    data.buffer,
  ]);

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  if (event.data.type === "init") {
    try {
      const { dbName } = event.data;
      sqlDb = await SqliteDB.create(dbName);
      post({ type: "ready" });
    } catch (e) {
      post({
        type: "init-error",
        error: {
          code: "INITIALISATION_NOT_DONE",
          message: `Error during wasm init: ${e}`,
        },
      });
    }

    return;
  }

  if (!sqlDb) {
    post({
      type: "init-error",
      error: {
        code: "INITIALISATION_NOT_DONE",
        message: "db not ready: call init first",
      },
    });

    return;
  }

  const { id, method, args } = event.data;
  try {
    if (method === "export") {
      const result = await sqlDb.handle(method);
      postBytes(id, result);
      return;
    }

    const result = await sqlDb.handle(method, args);
    post({ type: "response", id, ok: true, value: result });
  } catch (e) {
    const err = e instanceof Error ? e : new Error(`${e}`);
    post({
      type: "response",
      ok: false,
      id,
      error: {
        code: "RUNTIME_ERROR",
        stack: err.stack,
        message: err.message ?? `error running handler ${method} with ${args}`,
      },
    });
  }
  return;
};

self.onerror = (e) => {
  console.warn(e);
};

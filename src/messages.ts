import type {
  LocalMutations,
  PullRequest,
  PullResponse,
  PushRequest,
  SyncState as RustSyncState,
} from "./sync_sqlite/sync_sqlite.js";

export type ErrorCode = "INITIALISATION_NOT_DONE" | "RUNTIME_ERROR";

export type Query = {
  sql: string;
  params?: unknown[];
};

export type RustQuery = {
  sql: string;
  params: unknown[];
  isReadonly: boolean;
};

export type RpcMethods = {
  startMutate: { args: undefined; result: void };
  endMutate: { args: { name: string; args: unknown }; result: void };
  beginPull: { args: undefined; result: PullRequest };
  /** `undefined` when the response is stale and must be ignored */
  startRebase: {
    args: { request: PullRequest; response: PullResponse };
    result: LocalMutations | undefined;
  };
  endRebase: { args: undefined; result: void };
  syncState: { args: undefined; result: SyncState };
  startCapture: { args: undefined; result: void };
  endReplay: { args: number; result: void };
  query: {
    args: RustQuery;
    result: { rows: unknown[]; isReadonly: boolean };
  };
  execMigration: {
    args: { userVersion: number; batch: string };
    result: void;
  };
  begin: { args: undefined; result: void };
  commit: { args: undefined; result: void };
  rollback: { args: undefined; result: void };
  export: { args: undefined; result: Uint8Array<ArrayBuffer> };
  close: { args: undefined; result: void };
  listDatabases: { args: undefined; result: string[] };
  deleteDatabases: { args: string[]; result: void };
  pushRequest: { args: undefined; result: PushRequest };
  rekey: { args: string | null; result: void };
};
export type Method = keyof RpcMethods;

export type SyncState = {
  /**
   * A partial pull is in progress, or its last page was applied but not yet the
   * incremental pull that catches up with the changes made meanwhile: the local data
   * is incomplete and may be behind the server (aggregates are provisional).
   */
  isBootstrapping: boolean;
  /** As last reported by the server, if it does. */
  progress?: RustSyncState["progress"];
};

export type RpcHandlers = {
  [M in Method]: (
    args: RpcMethods[M]["args"],
  ) => RpcMethods[M]["result"] | Promise<RpcMethods[M]["result"]>;
};

export type RpcArgs<M extends Method> = RpcMethods[M]["args"] extends
  | void
  | undefined
  ? [args?: undefined]
  : [RpcMethods[M]["args"]];

export type SerializedError = {
  message: string;
  stack?: string;
  code: ErrorCode;
};

export type WorkerRequest =
  | { type: "init"; dbName: string; encryptionKey?: string }
  | {
      [M in Method]: {
        type: "request";
        id: string;
        method: M;
        args: RpcMethods[M]["args"];
      };
    }[Method];

export type WorkerResponse =
  | { type: "ready" }
  | { type: "init-error"; error: SerializedError }
  | { type: "response"; id: string; ok: true; value: unknown }
  | { type: "response"; id: string; ok: false; error: SerializedError };

export type RequestFor<M extends Method> = {
  type: "request";
  id: string;
  method: M;
  args: RpcMethods[M]["args"];
};

export type ChannelRequest = {
  [M in Method]: RequestFor<M>;
}[Method];

export type ChannelMessage =
  | { type: "hello" }
  | {
      type: "leader-up";
      leaderId: string;
      keyCheck: string | null;
    }
  | ChannelRequest
  | { type: "response"; id: string; ok: true; value: unknown }
  | {
      type: "response";
      id: string;
      ok: false;
      error: SerializedError;
    };

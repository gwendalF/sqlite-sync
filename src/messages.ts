import type {
  LocalMutations,
  PullRequest,
  PullResponse,
} from "./sync_sqlite/sync_sqlite";

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
  startRebase: { args: PullResponse; result: LocalMutations };
  endRebase: { args: number; result: void };
  query: {
    args: RustQuery;
    result: { rows: unknown[]; isReadonly: boolean };
  };
  execMigration: {
    args: { userVersion: number; batch: string };
    result: void;
  };
  cancelPull: {
    args: undefined;
    result: void;
  };
  begin: { args: undefined; result: void };
  commit: { args: undefined; result: void };
  rollback: { args: undefined; result: void };
  export: { args: undefined; result: Uint8Array<ArrayBuffer> };
  close: { args: undefined; result: void };
};
export type Method = keyof RpcMethods;

export type RpcHandlers = {
  [M in Method]: (
    args: RpcMethods[M]["args"],
  ) => RpcMethods[M]["result"] | Promise<RpcMethods[M]["result"]>;
};

export type RpcArgs<M extends Method> = RpcMethods[M]["args"];

export type SerializedError = {
  message: string;
  stack?: string;
  code: ErrorCode;
};

export type WorkerRequest =
  | { type: "init"; dbName: string }
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
  args: RpcArgs<M>;
};

export type ChannelRequest = {
  [M in Method]: RequestFor<M>;
}[Method];

export type ChannelMessage =
  | { type: "hello" }
  | { type: "leader-up"; leaderId: string }
  | ChannelRequest
  | { type: "response"; id: string; ok: true; value: unknown }
  | {
      type: "response";
      id: string;
      ok: false;
      error: SerializedError;
    };

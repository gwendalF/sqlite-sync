import type {
  LocalMutations,
  PullRequest,
  PullResponse,
} from "./sync_sqlite/sync_sqlite";

export type ErrorCode = "INITIALISATION_NOT_DONE" | "RUNTIME_ERROR";

export type Query = {
  sql: string;
  params: unknown[];
};

export type WorkerMethods = {
  startMutate: { args: void; result: void };
  endMutate: { args: { name: string; args: unknown }; result: void };
  beginPull: { args: void; result: PullRequest };
  startRebase: { args: PullResponse; result: LocalMutations };
  endRebase: { args: number; result: void };
  query: {
    args: Query;
    result: { rows: unknown[]; isReadonly: boolean };
  };
  rollback: { args: void; result: void };
};
export type Method = keyof WorkerMethods;

export type WorkerHandlers = {
  [M in Method]: (
    args: WorkerMethods[M]["args"],
  ) => WorkerMethods[M]["result"] | Promise<WorkerMethods[M]["result"]>;
};

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
        args: WorkerMethods[M]["args"];
      };
    }[Method];

export type WorkerResponse =
  | { type: "ready" }
  | { type: "init-error"; error: SerializedError }
  | { type: "response"; id: string; ok: true; value: unknown }
  | { type: "response"; id: string; ok: false; error: SerializedError };

export type ChannelRequest = {
  [M in Method]: {
    type: "request";
    id: string;
    method: M;
    args: WorkerMethods[M]["args"];
  };
}[Method];

export type ChannelMessage =
  | { type: "hello" }
  | { type: "leader-up" }
  | ChannelRequest
  | { type: "response"; id: string; ok: true; value: unknown }
  | {
      type: "response";
      id: string;
      ok: false;
      error: SerializedError;
    };

export type UpdateMessage = {
  tables: string[];
};

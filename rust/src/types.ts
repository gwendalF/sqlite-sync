type SqlQuery = {
  sql: string;
  params: unknown[];
  is_readonly: boolean;
};

type SqlResult<T = Record<string, unknown>> = {
  rows: T[];
  is_readonly: boolean;
};

type PullRequest = {
  client_id: string;
  known_version: number;
  /** Set while a partial pull is in progress: the `cursor` of the last page, as received. */
  cursor?: string;
  /** Maximum number of rows the client wants in one response. A hint, see `Config.pullLimit`. */
  limit?: number;
  /** Tables the client wants first during a partial pull. A hint the server may ignore. */
  priority?: string[];
};

type PullProgress = { done: number; total?: number };

type PullResponse =
  | {
      server_version: number;
      last_mutation_id: number;
      mutations: TableMutation[];
      /**
       * Makes the response partial: the client applies `mutations`, keeps its
       * `known_version` and pulls again with this cursor. Opaque to the client.
       */
      cursor?: string;
      progress?: PullProgress;
    }
  | {
      /**
       * The server cannot tell what changed since `known_version` (history purged):
       * the client drops its replicated data, keeps its pending mutations and pulls
       * everything again from `known_version: 0`.
       */
      reset: true;
    };

type TableMutation = {
  op: "upsert" | "delete";
  table: string;
  pks: string[];
  records: Record<string, unknown>[];
};

type LocalMutation = {
  id: number;
  name: string;
  args: unknown;
};

type LocalMutations = LocalMutation[];

type PendingMutation = LocalMutation & { id: number };

type PushRequest = {
  mutations: PendingMutation[];
  client_id: string;
};

type SyncState = {
  is_bootstrapping: boolean;
  progress?: PullProgress;
};

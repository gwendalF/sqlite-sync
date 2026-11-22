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
  /** `version` of the last complete pull, as received. `null`: the client has nothing yet. */
  version: string | null;
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
      type: "changes";
      /** Opaque to the client: stored, sent back as is in the next request, never compared. */
      version: string;
      last_mutation_id: number;
      mutations: TableMutation[];
      /**
       * Makes the response partial: the client applies `mutations`, keeps its
       * `version` and pulls again with this cursor. Opaque to the client.
       */
      cursor?: string;
      progress?: PullProgress;
    }
  | {
      /**
       * The server cannot tell what changed since `version` (history purged):
       * the client drops its replicated data, keeps its pending mutations and pulls
       * everything again from `version: null`.
       */
      type: "reset";
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

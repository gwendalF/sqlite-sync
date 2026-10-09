type SqlQuery = {
  sql: string;
  params: unknown[];
};

type SqlResult<T = Record<string, unknown>> = {
  rows: T[];
  is_readonly: boolean;
};

type PullRequest = {
  client_id: string;
  server_version: number;
};

type PullResponse = {
  server_version: number;
  last_mutation_id: number;
  mutations: TableMutation[];
};

type TableMutation = {
  op: "upsert" | "delete";
  table: string;
  pks: string[];
  records: Record<string, unknown>[];
};

type LocalMutation = {
  name: string;
  args: unknown;
};

type LocalMutations = LocalMutation[];

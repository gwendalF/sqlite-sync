import { Query } from "./messages";
import { Puller } from "./puller";

export type DBHandle = {
  sql: (query: Query) => Promise<unknown[]>;
};

export type MigrationHandle = {
  exec: (migration: string) => Promise<void>;
};

export type MutatorFn<P = any> = (db: DBHandle, payload: P) => Promise<void>;
export type MutatorsConfig = Record<string, MutatorFn<any>>;

export type PublicMutators<M extends MutatorsConfig> = {
  [K in keyof M]: M[K] extends (db: DBHandle) => unknown
    ? () => Promise<void>
    : M[K] extends (db: DBHandle, payload: infer P) => unknown
      ? (payload: P) => Promise<void>
      : never;
};

export type Config<M extends MutatorsConfig = MutatorsConfig> = {
  db: string;
  puller: Puller;
  mutators: M;
  migrations?: Migration[];
};

export type Migration = {
  version: number;
  run: (db: MigrationHandle) => Promise<void>;
};

export { Puller, Query };

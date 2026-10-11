import { Query } from "./messages";
import { Puller } from "./puller";

export type DBHandle = {
  sql: (query: Query) => Promise<unknown[]>;
};

export type MutatorFn<P = any> = (db: DBHandle, payload: P) => Promise<void>;
export type MutatorsConfig = Record<string, MutatorFn<any>>;

export type PublicMutators<M extends MutatorsConfig> = {
  [K in keyof M]: M[K] extends (db: DBHandle, payload: infer P) => void
    ? (payload: P) => Promise<void>
    : M[K] extends (db: DBHandle) => Promise<void>
      ? () => Promise<void>
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
  run: (db: DBHandle) => Promise<void>;
};

import { Query } from "./messages.ts";
import { Syncer } from "./syncer.ts";

export type DBHandle = {
  sql: (query: Query) => Promise<unknown[]>;
};

export type MigrationHandle = {
  exec: (migration: string) => Promise<void>;
};

export type MutatorFn<P = any> = (db: DBHandle, payload: P) => Promise<void>;

export type DeserMutator<P = any> = {
  fn: MutatorFn<P>;
  deserialize: (payload: unknown) => P;
};

export type MutatorConfig = MutatorFn<any> | DeserMutator<any>;

export type MutatorsConfig = Record<string, MutatorConfig>;

type PayloadArgs<C> = C extends { fn: infer F }
  ? PayloadArgs<F>
  : C extends (db: DBHandle, ...rest: infer R) => Promise<void>
    ? R
    : never;

type JSONPrimitive = string | number | boolean | null;
type JsonSafe<T> = T extends JSONPrimitive
  ? T
  : T extends Function
    ? never
    : T extends readonly (infer U)[]
      ? readonly JsonSafe<U>[]
      : T extends object
        ? { [K in keyof T]: JsonSafe<T[K]> }
        : never;

export type ValidateMutators<M extends MutatorsConfig> = {
  [K in keyof M]: M[K] extends MutatorFn<infer P>
    ? P extends JsonSafe<P>
      ? M[K]
      : MutatorFn<JsonSafe<P>>
    : M[K] extends { fn: MutatorFn<infer P> }
      ? DeserMutator<P>
      : never;
};

export type PublicMutators<M extends MutatorsConfig> = {
  [K in keyof M]: (...args: PayloadArgs<M[K]>) => Promise<void>;
};

export type Config<M extends MutatorsConfig = MutatorsConfig> = {
  syncer: Syncer;
  mutators: M;
  migrations?: Migration[];
  autoSync?: boolean;
};

export type ValidatedConfig<M extends MutatorsConfig> = Config<M> & {
  mutators: NoInfer<ValidateMutators<M>>;
};

export type Migration = {
  version: number;
  run: (db: MigrationHandle) => Promise<void>;
};

export { Syncer, Query };

export const defineMutators = <M extends MutatorsConfig>(
  mutators: ValidatedConfig<M>["mutators"],
) => mutators;

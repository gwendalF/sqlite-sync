export { SyncEngine, ProtocolError, sql } from "./sync_engine.ts";
export type {
  Config,
  PublicMutators,
  MutatorFn,
  MutatorsConfig,
  LocalMutatorsConfig,
  LocalMutatorsArgs,
  PublicLocalMutators,
  Syncer,
  DBHandle,
  Migration,
  Query,
  SyncResult,
  ValidatedConfig,
} from "./config.ts";

export { defineMutators } from "./config.ts";

export {
  BrowserPlatform,
  type BrowserPlatformOptions,
} from "./platform/browser.ts";

export type { Platform } from "./platform/platform.ts";
export type { SyncState } from "./messages.ts";
export type {
  PullResponse,
  PushRequest,
  PullRequest,
  PullProgress,
  TableMutation,
} from "./sync_sqlite/sync_sqlite.js";

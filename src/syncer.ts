import type {
  PullRequest,
  PullResponse,
  PushRequest,
} from "./sync_sqlite/sync_sqlite.js";

export interface Syncer {
  pull(request: PullRequest): Promise<PullResponse>;
  push(request: PushRequest): Promise<void>;
}

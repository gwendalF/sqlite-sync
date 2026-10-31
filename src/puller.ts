import type { PullResponse } from "./sync_sqlite/sync_sqlite.js";

export interface Puller {
  pull(serverVersion: number): Promise<PullResponse>;
}

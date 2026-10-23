import { Method, RpcMethods } from "./messages";

export interface System {
  call<K extends Method>(
    method: K,
    args: RpcMethods[K]["args"],
  ): Promise<RpcMethods[K]["result"]>;

  /** Mutal exclusion between ALL tabs (navigator.locks in prod). */
  lock<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T>;

  /** notifications from other tabs */
  onTablesChanged(cb: (tables: string[] | "*") => void): () => void;

  /** notifications to other tabs */
  notifyTablesChanged(change: string[] | "*"): void;

  close(): void;
}

import type {
  ChannelMessage,
  Method,
  RpcArgs,
  RpcMethods,
  WorkerRequest,
  WorkerResponse,
  RequestFor,
} from "../messages";
import { Plateform } from "./plateform";

export type BrowserPlateformOptions = {
  dbName: string;
  namespace?: string;
  worker?: () => Worker;
  /**
   * Encrypts the database file with SQLite3MultipleCiphers (ChaCha20 by default).
   * Omitted: the database is stored in plain text. Fetched once by start() and
   * only sent to the worker of this tab, never broadcast: tabs compare a
   * fingerprint of it, and start() fails when it differs from the leader's.
   */
  encryptionKey?: string | (() => string | Promise<string>);
  /**
   * After start(): this tab took the lead and could not open the database.
   * Calls are rejected from then on.
   */
  onError?: (err: Error) => void;
};

const CLOSE_TIMEOUT_MS = 2_000;
const KEY_MISMATCH =
  "cannot read database: it is encrypted and the key is missing or invalid";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const toHex = (bytes: Uint8Array) =>
  typeof bytes.toHex === "function"
    ? bytes.toHex()
    : Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

const keyFingerprint = async (key?: string) => {
  if (!key) {
    return null;
  }

  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`sync-sqlite:key-check:${key}`),
  );

  return toHex(new Uint8Array(digest));
};

type Pending = {
  resolve(v: unknown): void;
  reject(e: Error): void;
};

export class BrowserPlateform implements Plateform {
  private inflights = new Map<
    string,
    { message: RequestFor<Method> } & Pending
  >();
  private lastLeaderId = "";
  private rpc;
  private reactive;
  private release: undefined | (() => void);
  /** Settles once this tab no longer holds (nor waits for) leadership. */
  private leadership: Promise<void> = Promise.resolve();
  private closed = false;
  /** Why calls are rejected, when the database could not be opened. */
  private failure: Error | undefined;
  private failStart: undefined | ((err: Error) => void);
  private key: string | undefined;
  private keyCheck: string | null = null;
  private namespaces: {
    task: string;
    rpc: string;
    leader: string;
    reactive: string;
  };

  constructor(private opts: BrowserPlateformOptions) {
    if (!navigator.locks) {
      throw new Error("no navigator.locks");
    }
    const prefix = opts.namespace ?? opts.dbName;
    this.namespaces = {
      task: `${prefix}:task`,
      rpc: `${prefix}:rpc`,
      leader: `${prefix}:leader`,
      reactive: `${prefix}:reactive`,
    };

    this.rpc = new BroadcastChannel(this.namespaces.rpc);
    this.reactive = new BroadcastChannel(this.namespaces.reactive);
  }

  start = async () => {
    try {
      const { encryptionKey } = this.opts;
      this.key =
        (typeof encryptionKey === "function"
          ? await encryptionKey()
          : encryptionKey) || undefined;
      this.keyCheck = await keyFingerprint(this.key);
      await this.waitLeader();
    } catch (err) {
      this.closed = true;
      this.release?.();
      this.reactive.close();
      this.rpc.close();
      throw err;
    } finally {
      this.failStart = undefined;
    }
  };

  private waitLeader = () =>
    new Promise<void>((resolve, reject) => {
      this.failStart = reject;
      const { release, done } = this.claimLeaderShip();
      this.release = release;
      this.leadership = done;
      this.rpc.addEventListener(
        "message",
        (e: MessageEvent<ChannelMessage>) => {
          const { type } = e.data;
          if (type === "leader-up") {
            if (this.failStart && e.data.keyCheck !== this.keyCheck) {
              reject(new Error(KEY_MISMATCH));
              return;
            }
            if (this.lastLeaderId !== e.data.leaderId) {
              this.lastLeaderId = e.data.leaderId;
              this.replayInflights();
            }
            resolve();
          } else if (type === "response") {
            const message = e.data;
            const pending = this.inflights.get(message.id);
            if (pending && message.ok) {
              pending.resolve(message.value);
            } else if (pending && !message.ok) {
              pending.reject(new Error(message.error.message));
            }
          }
        },
      );
      this.rpc.postMessage({ type: "hello" } satisfies ChannelMessage);
    });

  private claimLeaderShip = () => {
    const abort = new AbortController();
    const done = navigator.locks
      .request(this.namespaces.leader, { signal: abort.signal }, async () => {
        const leaderId = crypto.randomUUID();
        const leaderUp = {
          type: "leader-up",
          leaderId,
          keyCheck: this.keyCheck,
        } satisfies ChannelMessage;
        const broadcast = new BroadcastChannel(this.namespaces.rpc);
        let worker: Worker | undefined;

        try {
          // Until the db is open, hello and requests stay unanswered: other
          // tabs wait for the leader-up below, then replay their requests.
          worker = await this.openWorker();
          const opened = worker;

          const closeId = crypto.randomUUID();
          let resolveDbClosed: () => void;
          const dbClosed = new Promise<void>((r) => (resolveDbClosed = r));

          opened.onmessage = (e: MessageEvent<WorkerResponse>) => {
            if (e.data.type === "response" && e.data.id === closeId) {
              resolveDbClosed();
            } else if (e.data.type === "response") {
              broadcast.postMessage(e.data);
            }
          };

          broadcast.onmessage = (e: MessageEvent<ChannelMessage>) => {
            if (e.data.type === "hello") {
              broadcast.postMessage(leaderUp);
            } else if (e.data.type === "request" && e.data.method === "close") {
              // closing the shared database is the leader's job, see close()
              broadcast.postMessage({
                type: "response",
                id: e.data.id,
                ok: false,
                error: {
                  code: "RUNTIME_ERROR",
                  message:
                    "close is not callable over rpc, use plateform.close()",
                },
              } satisfies ChannelMessage);
            } else if (e.data.type === "request") {
              opened.postMessage(e.data);
            }
          };

          if (!abort.signal.aborted) {
            broadcast.postMessage(leaderUp);
          }

          await new Promise((resolve) => {
            if (abort.signal.aborted) {
              resolve(undefined);
            }

            abort.signal.addEventListener(
              "abort",
              () => {
                resolve(undefined);
              },
              {
                once: true,
              },
            );
          });

          // Leaving: stop taking requests (other tabs replay them on the next
          // leader), let already forwarded ones answer, then close the DB.
          broadcast.onmessage = null;
          opened.postMessage({
            type: "request",
            id: closeId,
            method: "close",
            args: undefined,
          } satisfies WorkerRequest);
          await Promise.race([dbClosed, sleep(CLOSE_TIMEOUT_MS)]);
        } finally {
          worker?.terminate();
          broadcast.close();
        }
      })
      .catch((err) => {
        if (err instanceof DOMException && err.name === "AbortError") {
          // abort signal
          return;
        }
        const error = err instanceof Error ? err : new Error(`${err}`);
        if (this.failStart) {
          this.failStart(error);
          return;
        }
        // took the lead after start(): nobody awaits it, fail the calls
        this.fail(error);
      });

    return { release: () => abort.abort(), done };
  };

  /** A worker with the database open. */
  private openWorker = async (): Promise<Worker> => {
    const worker = new Worker(new URL("../worker.js", import.meta.url), {
      type: "module",
    });
    try {
      await new Promise<void>((resolve, reject) => {
        worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
          if (e.data.type === "ready") {
            resolve();
          } else if (e.data.type === "init-error") {
            reject(new Error(e.data.error.message));
          }
        };
        worker.onerror = (e) => reject(new Error(`worker error: ${e.message}`));
        worker.postMessage({
          type: "init",
          dbName: this.opts.dbName,
          encryptionKey: this.key,
        } satisfies WorkerRequest);
      });
      worker.onerror = null;
      return worker;
    } catch (err) {
      worker.terminate();
      throw err;
    }
  };

  /** The database cannot be opened anymore: reject every call with why. */
  private fail = (err: Error) => {
    if (this.closed) return;
    this.closed = true;
    this.failure = err;
    this.reactive.close();
    this.rpc.close();
    for (const { reject } of this.inflights.values()) {
      reject(err);
    }
    this.inflights.clear();
    this.opts.onError?.(err);
  };

  private replayInflights = () => {
    for (const [id, { message, reject }] of this.inflights) {
      try {
        this.sendRpc(message);
      } catch (err) {
        this.inflights.delete(id);
        reject(err instanceof Error ? err : new Error(`${err}`));
      }
    }
  };

  call = async <M extends Method>(
    method: M,
    ...args: RpcArgs<M>
  ): Promise<RpcMethods[M]["result"]> => {
    if (this.closed) {
      throw this.failure ?? new Error("plateform closed");
    }
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const message: RequestFor<M> = {
        type: "request",
        id,
        method,
        args: args[0],
      };
      this.inflights.set(id, { message, resolve, reject });
      this.sendRpc(message);
    });
  };

  private sendRpc = <M extends Method>(message: RequestFor<M>) => {
    this.rpc.postMessage(message);
  };

  lock = <T>(fn: () => Promise<T>, signal?: AbortSignal) => {
    return navigator.locks.request(this.namespaces.task, { signal }, fn);
  };

  onTablesChanged = (cb: (tables: string[] | "*") => void): (() => void) => {
    const on = (e: MessageEvent<string[] | "*">) => cb(e.data);

    this.reactive.addEventListener("message", on);
    return () => {
      this.reactive.removeEventListener("message", on);
    };
  };

  notifyTablesChanged = (tables: string[] | "*") => {
    this.reactive.postMessage(tables);
  };

  /**
   * Leaves the group. Only the leader closes the database (in its own worker),
   * other tabs keep using it through the next leader. Idempotent.
   */
  close = async () => {
    if (this.closed) return;
    this.closed = true;

    this.release?.();
    await this.leadership;
    this.reactive.close();
    this.rpc.close();

    for (const { reject } of this.inflights.values()) {
      reject(new Error("plateform closed"));
    }
    this.inflights.clear();
  };
}

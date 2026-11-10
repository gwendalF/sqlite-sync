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
   * Omitted: the database is stored in plain text. Only fetched by the tab that
   * becomes leader, and sent straight to its worker (never broadcast).
   */
  encryptionKey?: string | (() => string | Promise<string>);
};

const CLOSE_TIMEOUT_MS = 2_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  private failStart: undefined | ((err: Error) => void);
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
      const { release, done } = this.claimLeaderShip(
        this.namespaces,
        this.opts.dbName,
      );
      this.release = release;
      this.leadership = done;
      this.rpc.addEventListener(
        "message",
        (e: MessageEvent<ChannelMessage>) => {
          const { type } = e.data;
          if (type === "leader-up") {
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

  private claimLeaderShip = (
    namespaces: { task: string; rpc: string; leader: string },
    dbConfig: string,
  ) => {
    const abort = new AbortController();
    const done = navigator.locks
      .request(namespaces.leader, { signal: abort.signal }, async () => {
        const leaderId = crypto.randomUUID();
        const worker = new Worker(new URL("../worker.js", import.meta.url), {
          type: "module",
        });
        const broadcast = new BroadcastChannel(namespaces.rpc);

        try {
          let resolveInit: () => void;
          let rejectInit: (err: Error) => void;
          const initPromise = new Promise<void>((resolve, reject) => {
            resolveInit = resolve;
            rejectInit = reject;
          });

          broadcast.onmessage = (e: MessageEvent<ChannelMessage>) => {
            if (e.data.type === "hello") {
              broadcast.postMessage({
                type: "leader-up",
                leaderId,
              } satisfies ChannelMessage);
            } else if (e.data.type === "request" && e.data.method === "close") {
              // closing the shared database is the leader's job, see close()
              broadcast.postMessage({
                type: "response",
                id: e.data.id,
                ok: false,
                error: {
                  code: "RUNTIME_ERROR",
                  message: "close is not callable over rpc, use plateform.close()",
                },
              } satisfies ChannelMessage);
            } else if (e.data.type === "request") {
              worker.postMessage(e.data);
            }
          };

          const closeId = crypto.randomUUID();
          let resolveDbClosed: () => void;
          const dbClosed = new Promise<void>((r) => (resolveDbClosed = r));

          worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
            if (e.data.type === "response" && e.data.id === closeId) {
              resolveDbClosed();
            } else if (e.data.type === "response") {
              broadcast.postMessage(e.data);
            } else if (e.data.type === "ready") {
              resolveInit();
            } else if (e.data.type === "init-error") {
              rejectInit(new Error(e.data.error.message));
            }
          };

          const { encryptionKey } = this.opts;
          worker.postMessage({
            type: "init",
            dbName: dbConfig,
            encryptionKey:
              typeof encryptionKey === "function"
                ? await encryptionKey()
                : encryptionKey,
          } satisfies WorkerRequest);
          await initPromise;

          broadcast.postMessage({
            type: "leader-up",
            leaderId,
          } satisfies ChannelMessage);

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
          worker.postMessage({
            type: "request",
            id: closeId,
            method: "close",
            args: undefined,
          } satisfies WorkerRequest);
          await Promise.race([dbClosed, sleep(CLOSE_TIMEOUT_MS)]);
        } finally {
          worker.terminate();
          broadcast.close();
        }
      })
      .catch((err) => {
        if (err instanceof DOMException && err.name === "AbortError") {
          // abort signal
          return;
        }
        if (this.failStart) {
          this.failStart(err instanceof Error ? err : new Error(`${err}`));
          return;
        }
        console.error(err);
      });

    return { release: () => abort.abort(), done };
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
      throw new Error("plateform closed");
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

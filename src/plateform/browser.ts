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
  private worker: Worker | null = null;
  private release: undefined | (() => void);
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

  async start() {
    this.release = this.claimLeaderShip(this.namespaces, this.opts.dbName);

    await new Promise<void>((resolve) => {
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
  }

  private claimLeaderShip(
    namespaces: { task: string; rpc: string; leader: string },
    dbConfig: string,
  ) {
    const abort = new AbortController();
    navigator.locks
      .request(namespaces.leader, { signal: abort.signal }, async () => {
        const leaderId = crypto.randomUUID();
        const worker = new Worker(new URL("../worker.js", import.meta.url), {
          type: "module",
        });
        const broadcast = new BroadcastChannel(namespaces.rpc);

        this.worker = worker;
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
            } else if (e.data.type === "request") {
              worker.postMessage(e.data);
            }
          };

          worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
            if (e.data.type === "response") {
              broadcast.postMessage(e.data);
            } else if (e.data.type === "ready") {
              resolveInit();
            } else if (e.data.type === "init-error") {
              rejectInit(new Error(e.data.error.message));
            }
          };

          worker.postMessage({
            type: "init",
            dbName: dbConfig,
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
        } finally {
          this.worker = null;
          worker.terminate();
          broadcast.close();
        }
      })
      .catch((err) => {
        if (err instanceof DOMException && err.name === "AbortError") {
          // abort signal
          return;
        }
        throw err;
      });

    return () => abort.abort();
  }

  private replayInflights() {
    for (const [id, { message, reject }] of this.inflights) {
      try {
        this.sendRpc(message);
      } catch (err) {
        this.inflights.delete(id);
        reject(err instanceof Error ? err : new Error(`${err}`));
      }
    }
  }

  async call<M extends Method>(
    method: M,
    args: RpcArgs<M>,
  ): Promise<RpcMethods[M]["result"]> {
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const message: RequestFor<M> = {
        type: "request",
        id,
        method,
        args,
      };
      this.inflights.set(id, { message, resolve, reject });
      this.sendRpc(message);
    });
  }

  private sendRpc<M extends Method>(message: RequestFor<M>) {
    this.rpc.postMessage(message);
  }

  lock<T>(fn: () => Promise<T>, signal?: AbortSignal) {
    return navigator.locks.request(this.namespaces.task, { signal }, fn);
  }

  onTablesChanged(cb: (tables: string[] | "*") => void): () => void {
    const on = (e: MessageEvent<string[] | "*">) => cb(e.data);

    this.reactive.addEventListener("message", on);
    return () => {
      this.reactive.removeEventListener("message", on);
    };
  }

  notifyTablesChanged(tables: string[] | "*") {
    this.reactive.postMessage(tables);
  }

  close() {
    this.release?.();
    this.reactive.close();
    this.rpc.close();
    this.worker?.terminate();
  }
}

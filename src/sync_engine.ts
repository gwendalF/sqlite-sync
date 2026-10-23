import { Config, DBHandle, Migration, MutatorsConfig, Query } from "./config";
import { Method, RpcMethods } from "./messages";
import { System } from "./system";

export class SyncEngine<M extends MutatorsConfig> {
  private tablesCache = new Map<string, string[]>();

  private constructor(
    private system: System,
    private config: Config<M>,
  ) {}

  static async create<M extends MutatorsConfig>(
    system: System,
    config: Config<M>,
  ) {
    const engine = new SyncEngine(system, config);

    return engine;
  }

  private async sql<T = unknown>(query: Query) {
    return this.system.call("query", query) as Promise<{
      rows: T[];
      isReadonly: boolean;
    }>;
  }

  private async call<M extends Method>(
    method: M,
    args: RpcMethods[M]["args"],
  ) {}

  private async applyMigrations(migrations: Migration[]) {
    const dbHandle: DBHandle = {
      sql: async (query) => {
        const { rows } = await this.sql(query);
        return rows;
      },
    };
  }

  private async tablesOf(sql: string): Promise<string[]> {
    const hit = this.tablesCache.get(sql);
    if (hit) return hit;
    const { rows } = await this.sql<string>({
      sql: "SELECT name FROM tables_used(?) WHERE type = 'table'",
      params: [sql],
    });

    this.tablesCache.set(sql, rows);
    return rows;
  }
}

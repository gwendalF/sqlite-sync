import {
  Config,
  DBHandle,
  Migration,
  MigrationHandle,
  MutatorsConfig,
  Query,
} from "./config";
import { Method, RpcArgs, RpcMethods } from "./messages";
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
    if (config.migrations?.length) {
      await engine.applyMigrations(config.migrations);
    }

    return engine;
  }

  async sql<T = unknown>(query: Query) {
    return this.system.call("query", query) as Promise<{
      rows: T[];
      isReadonly: boolean;
    }>;
  }

  private async call<M extends Method>(method: M, ...args: RpcArgs<M>) {
    return this.system.call(method, ...args);
  }

  private async applyMigrations(migrations: Migration[]) {
    migrations.sort((a, b) => a.version - b.version);
    return this.system.lock(async () => {
      let {
        rows: [version],
      } = await this.sql<number>({
        sql: "SELECT * FROM pragma_user_version",
      });

      for (const migration of migrations) {
        if (migration.version > version) {
          const dbHandle: MigrationHandle = {
            exec: async (query) => {
              await this.call("execMigration", {
                userVersion: version + 1,
                batch: query,
              });
            },
          };

          await migration.run(dbHandle);
          version += 1;
        }
      }
    });
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

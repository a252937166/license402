import { DatabaseSync } from "node:sqlite";

/**
 * Thin wrapper over Node's built-in node:sqlite exposing the small slice of the
 * better-sqlite3 interface this project uses (prepare/exec/transaction), so the
 * server has ZERO native dependencies and deploys on any Node 22+ host (the
 * CentOS 7 target cannot compile better-sqlite3). Named `@params` bind from
 * plain-keyed objects, which node:sqlite allows by default.
 */

export interface Statement {
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface Database {
  prepare(sql: string): Statement;
  exec(sql: string): void;
  transaction<T>(fn: () => T): () => T;
  close(): void;
}

class NodeSqliteDatabase implements Database {
  constructor(private readonly db: DatabaseSync) {}

  prepare(sql: string): Statement {
    const stmt = this.db.prepare(sql);
    return {
      run: (...params: unknown[]) => stmt.run(...(params as never[])) as { changes: number | bigint; lastInsertRowid: number | bigint },
      get: (...params: unknown[]) => stmt.get(...(params as never[])) as unknown,
      all: (...params: unknown[]) => stmt.all(...(params as never[])) as unknown[]
    };
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  /** better-sqlite3-style transaction wrapper: returns a callable that runs fn in BEGIN/COMMIT. */
  transaction<T>(fn: () => T): () => T {
    return () => {
      this.db.exec("BEGIN");
      try {
        const result = fn();
        this.db.exec("COMMIT");
        return result;
      } catch (error) {
        try {
          this.db.exec("ROLLBACK");
        } catch {
          // ignore rollback failure; surface the original error
        }
        throw error;
      }
    };
  }

  close(): void {
    this.db.close();
  }
}

export function openSqlite(filePath: string): Database {
  return new NodeSqliteDatabase(new DatabaseSync(filePath));
}

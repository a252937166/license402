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

  private txDepth = 0;

  /**
   * better-sqlite3-style transaction wrapper: returns a callable that runs fn
   * atomically. Nestable — the outermost level uses BEGIN/COMMIT, inner levels
   * use savepoints, so composed repo methods that are individually transactional
   * can also be wrapped in one larger transaction.
   */
  transaction<T>(fn: () => T): () => T {
    return () => {
      const depth = this.txDepth;
      const begin = depth === 0 ? "BEGIN" : `SAVEPOINT sp_${depth}`;
      const commit = depth === 0 ? "COMMIT" : `RELEASE sp_${depth}`;
      const rollback = depth === 0 ? "ROLLBACK" : `ROLLBACK TO sp_${depth}; RELEASE sp_${depth}`;
      this.db.exec(begin);
      this.txDepth = depth + 1;
      try {
        const result = fn();
        this.db.exec(commit);
        return result;
      } catch (error) {
        try {
          this.db.exec(rollback);
        } catch {
          // ignore rollback failure; surface the original error
        }
        throw error;
      } finally {
        this.txDepth = depth;
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

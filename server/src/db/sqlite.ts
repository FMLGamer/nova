/**
 * The database driver. better-sqlite3 everywhere it can load; Node's built-in `node:sqlite` where it can't
 * (Nova for Android ships a Node without native add-ons). Both are driven through the same small API:
 * prepare().get/all/run, exec, pragma, transaction and backup.
 */
import { createRequire } from 'node:module';
import type BetterSqlite3 from 'better-sqlite3';

const require = createRequire(import.meta.url);

type Params = unknown[];

interface NodeStatement {
  get(...p: unknown[]): unknown;
  all(...p: unknown[]): unknown[];
  run(...p: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
}
interface NodeDatabase {
  prepare(sql: string): NodeStatement;
  exec(sql: string): void;
  close(): void;
}

/** better-sqlite3 binds booleans and undefined loosely in places; node:sqlite refuses them. */
const value = (v: unknown): unknown => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);

class Statement {
  /** Named parameters the SQL uses: node:sqlite refuses values for any other name, better-sqlite3 ignores them. */
  private readonly names: Set<string>;
  constructor(
    private readonly s: NodeStatement,
    sql: string,
  ) {
    this.names = new Set([...sql.matchAll(/[@:$]([A-Za-z_]\w*)/g)].map((m) => m[1]!));
  }
  private bind(p: Params): unknown[] {
    return p.map((v) =>
      v && typeof v === 'object' && !ArrayBuffer.isView(v) && !Array.isArray(v)
        ? Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([k]) => this.names.has(k)).map(([k, x]) => [k, value(x)]))
        : value(v),
    );
  }
  get(...p: Params): unknown {
    return this.s.get(...this.bind(p));
  }
  all(...p: Params): unknown[] {
    return this.s.all(...this.bind(p));
  }
  run(...p: Params): { changes: number; lastInsertRowid: number | bigint } {
    const r = this.s.run(...this.bind(p));
    return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid };
  }
}

class NodeSqlite {
  private depth = 0;
  constructor(private readonly raw: NodeDatabase) {}

  prepare(sql: string): Statement {
    return new Statement(this.raw.prepare(sql), sql);
  }

  exec(sql: string): this {
    this.raw.exec(sql);
    return this;
  }

  pragma(source: string, opts: { simple?: boolean } = {}): unknown {
    const rows = this.raw.prepare(`PRAGMA ${source}`).all() as Record<string, unknown>[];
    return opts.simple ? (rows[0] ? Object.values(rows[0])[0] : undefined) : rows;
  }

  /** Like better-sqlite3: a function that runs `fn` in a transaction (a savepoint when nested). */
  transaction<F extends (...args: never[]) => unknown>(fn: F): F {
    const run = (...args: Parameters<F>): ReturnType<F> => {
      const nested = this.depth > 0;
      const name = `nova_${this.depth}`;
      this.raw.exec(nested ? `SAVEPOINT ${name}` : 'BEGIN');
      this.depth++;
      try {
        const result = fn(...args) as ReturnType<F>;
        this.raw.exec(nested ? `RELEASE ${name}` : 'COMMIT');
        return result;
      } catch (err) {
        this.raw.exec(nested ? `ROLLBACK TO ${name}; RELEASE ${name}` : 'ROLLBACK');
        throw err;
      } finally {
        this.depth--;
      }
    };
    return run as unknown as F;
  }

  async backup(destination: string): Promise<void> {
    this.raw.exec(`VACUUM INTO '${destination.replace(/'/g, "''")}'`);
  }

  close(): void {
    this.raw.close();
  }
}

export type Database = BetterSqlite3.Database;

export function openDatabase(file: string): Database {
  if (process.env.NOVA_SQLITE !== 'node') {
    try {
      const Better = require('better-sqlite3') as typeof BetterSqlite3;
      return new Better(file);
    } catch (err) {
      console.warn('[db] better-sqlite3 is not available here, using node:sqlite:', (err as Error).message.split('\n')[0]);
    }
  }
  const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: new (path: string) => NodeDatabase };
  return new NodeSqlite(new DatabaseSync(file)) as unknown as Database;
}

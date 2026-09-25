import { Kysely, SqliteAdapter, SqliteIntrospector, SqliteQueryCompiler, CompiledQuery } from 'kysely';
export function native(message: Record<string, unknown>): Promise<any> {
  return (globalThis as any).webkit.messageHandlers.barOneStore.postMessage(message);
}
// A single connection lease spans BEGIN through COMMIT/ROLLBACK. Queries from
// other requests must never interleave with another request's transaction.
export class NativeDriver {
  private busy?: Promise<void>;
  private release?: () => void;
  private connection = {
    async executeQuery(query: any) {
      const result = await native({ action: 'query', sql: query.sql, parameters: query.parameters });
      return { rows: result.rows, numAffectedRows: BigInt(result.changes), insertId: BigInt(result.insertId) };
    },
    async *streamQuery(query: any) { yield await this.executeQuery(query); },
  };
  async init() {}
  async acquireConnection() {
    while (this.busy) await this.busy;
    this.busy = new Promise(resolve => { this.release = resolve; });
    return this.connection;
  }
  async releaseConnection() { const release = this.release; this.busy = undefined; this.release = undefined; release?.(); }
  async beginTransaction(connection: any) { await connection.executeQuery(CompiledQuery.raw('begin immediate')); }
  async commitTransaction(connection: any) { await connection.executeQuery(CompiledQuery.raw('commit')); }
  async rollbackTransaction(connection: any) { await connection.executeQuery(CompiledQuery.raw('rollback')); }
  async destroy() {}
}
export function createNativeDatabase() {
  return new Kysely<any>({ dialect: {
    createAdapter: () => new SqliteAdapter(),
    createDriver: () => new NativeDriver(),
    createIntrospector: db => new SqliteIntrospector(db),
    createQueryCompiler: () => new SqliteQueryCompiler(),
  }});
}

import { sql } from 'kysely';
export function buildHealthProbes({ db }: any) {
  return [{ name: 'ipad_database', critical: 1 as const, run: async () => {
    const result = await sql`pragma quick_check`.execute(db);
    const ok = (result.rows[0] as any)?.quick_check === 'ok';
    return { ok, detail: { storage: 'iPad', integrity: ok } };
  }}];
}

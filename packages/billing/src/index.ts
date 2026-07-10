/**
 * @blacklabel/billing — scaffold placeholder.
 *
 * Read /CONVENTIONS.md BEFORE writing any code here. Required file layout:
 *   src/schema.ts      row types; extend CoreDatabase
 *   src/migrations.ts  export const billingMigrations: Migration[]
 *   src/service.ts     tenant-scoped business logic (audit every mutation)
 *   src/router.ts      export function billingRouter(deps: ModuleDeps<...>): Hono<TenantEnv>
 *   src/seed.ts        demo/seed data (optional)
 *   src/index.ts       re-export migrations + router + public types ONLY
 *   test/              vitest tests incl. tenant-isolation denial tests
 */
export const MODULE_KEY = 'billing' as const;

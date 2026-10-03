# @blacklabel/files — File/Document Vault

Multi-tenant file **metadata** vault with pluggable **storage adapters**:
nested folders, two-step upload sessions, polymorphic entity links, per-file
permissions, tags, and metadata search. Content bytes live behind a
`StorageProvider`; the database stores metadata only.

Built on `@blacklabel/core` (tenancy, audit, event bus, errors, query helpers)
and `@blacklabel/db`. See `/CONVENTIONS.md` for platform-wide rules.

## Security model (enforced + tested)

- **Storage keys are secrets.** Keys are server-generated random ids
  (`newStorageKey()`, 42 chars of the nanoid alphabet) — never derived from
  filenames or any user input. They never appear in API responses or URLs;
  downloads are id-based (`GET /files/:id/content`).
- **No user-controlled paths.** Every adapter validates keys against
  `STORAGE_KEY_PATTERN` (`/^[A-Za-z0-9_-]{32,128}$/`) *before* touching the
  backend, so `../`, separators, dotfiles and absolute paths are rejected
  outright. The local-disk adapter additionally proves the resolved path is a
  direct child of its root. Path-traversal is covered by tests.
- **Filenames are display metadata only** — validated (no separators, no
  control chars, max 255) and never used as storage paths.
- **Tenancy:** every table carries `tenant_id`, every query filters by it;
  tenant comes exclusively from core's `tenantMiddleware` (`x-tenant-id`).

## Storage adapters

| Adapter | Kind | Notes |
|---|---|---|
| `LocalDiskStorageProvider` | `local-disk` | Default. Writes `<root>/<key>` under `.storage/files` (repo-local). |
| `MemoryStorageProvider` | `memory` | For tests/ephemeral use — tests never write to disk. |
| `S3StorageProvider` | `s3` | **Intentional stub (per spec).** Documents the S3/R2 contract (put→PutObject, get→GetObject, exists→HeadObject, delete→DeleteObject, private buckets only); every method throws `StorageError('not_implemented')` until the integrator wires a real client. |

Implement `StorageProvider` (`put/get/exists/delete` + key validation) to add
a backend. `delete` must be idempotent; `get` throws
`StorageError('not_found')` for missing keys.

## Actors & permissions

The acting user is read from the optional `x-user-id` header:

- **absent** → trusted `system` actor (integration/back-office): full access
- **unknown id** (in the tenant) → `401`
- **owner / admin** → full access to every file
- **uploader** → full access to their own files
- **anyone else** → needs a `FilePermission` grant (`grantee_type: 'role' |
  'user'`; `can_write` for mutations). `visibility: 'tenant' | 'public'`
  opens **read** to all tenant users; `private` requires a grant.

`GET /files` list results are scoped the same way for plain members.
Permission checks run in the `requireFileAccess(mode)` middleware on every
`/files/:id...` route (`403` on denial, `404` for other tenants' files).

## Endpoints (mounted at `/api/files` by apps/api)

Folders: `GET /folders` · `GET /folders/tree` · `POST /folders` ·
`PATCH /folders/:id` · `DELETE /folders/:id` (409 if non-empty; cycle-safe moves)

Uploads (init → complete): `POST /uploads` · `GET /uploads/:id` ·
`POST /uploads/:id/complete` (`{ content_base64 }`) · `POST /uploads/:id/abort`

Files have a 10 MiB decoded limit and require canonical base64. Empty files are
supported. The composition-root API admits at most 15 MiB of streamed JSON for
completion, with a 30-second body-read deadline; declared lengths never replace
the actual byte count. Rejected uploads leave the session pending and write no
file content. Service-level completion also enforces the decoded size limit.

Files: `GET /files` (search: `name`, `mime`, `tag`, `folder_id`, `visibility`,
`entity_type`+`entity_id`; `sort` whitelist; paginated) · `GET /files/:id` ·
`GET /files/:id/content` · `GET /files/:id/audit` · `PATCH /files/:id`
(rename/move/visibility/tags) · `DELETE /files/:id`

Links: `GET /files/:id/links` · `POST /files/:id/links`
(`{ entity_type, entity_id }` — id-string references only, e.g.
`crm.customer`, `quoting.quote`, `billing.invoice`, `messaging.message`) ·
`DELETE /files/:id/links/:linkId` · `GET /links?entity_type=&entity_id=`

Permissions: `GET/POST /files/:id/permissions` ·
`DELETE /files/:id/permissions/:permId`

Envelopes follow the platform standard: `{ data }` / `{ data, limit, offset }`
and `{ error: { message, code, details } }`.

## Events

`files.file.uploaded|updated|deleted|linked|unlinked`,
`files.folder.created|updated|deleted`,
`files.permission.granted|revoked` — payloads in `src/index.ts`. Every
mutation is also written to the core audit log
(`files.file`, `files.folder`, `files.link`, `files.permission`,
`files.upload_session` entity types).

## Wiring

```ts
import { filesMigrations, filesRouter, LocalDiskStorageProvider } from '@blacklabel/files';

app.route('/api/files', filesRouter({
  db, events, contracts,
  storage: new LocalDiskStorageProvider('.storage/files'), // or your adapter
}));
```

Seed demo data with `seedFiles(db, tenantId, { storage, events })`.

## Tests

`npx vitest run packages/files` — migrations (idempotent), the full upload
flow, path-traversal rejection on every adapter, secret-leak checks
(storage keys never in responses; keys never filename-derived), folder-tree +
cycle safety, link attach/detach/query, metadata search, permission
grant/deny/revoke, upload-session hijack denial, audit trail, seed, and
tenant-isolation denial tests.

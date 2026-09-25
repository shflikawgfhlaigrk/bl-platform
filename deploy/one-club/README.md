# Bar One connection

The installed iPad uses `https://bar-one-pos.michael-070.workers.dev`.
The Worker forwards requests over an authenticated outbound WebSocket to the
venue Mac. No temporary tunnel URL or inbound LAN port is required. The Mac,
its internet connection and the venue server must remain running.

The database is `.storage/bar-one-venue/platform.db`. The Worker holds only
requests in flight; business records stay in the venue database. An interrupted
write is not automatically resent. The register retains its action key for
explicit recovery against the server's idempotency ledger.

## Installed services

- `com.blacklabel.bar-one-venue`: `apps/api/src/bar-server.ts`, loopback port 8480.
- `com.blacklabel.bar-one-relay`: `scripts/relay-bar-one.mjs`, outbound WSS.
- Both LaunchAgents are in `~/Library/LaunchAgents/` with KeepAlive enabled.
- Both logs are in `.storage/bar-one-venue/`. Avoid publishing that directory.
- These are user login services. Hosting independent of this Mac and operation
  before login still require an always-on venue host or managed server.

The relay secret is stored in `.storage/bar-one-venue/relay.key` with mode 0600
and as the Worker's `VENUE_RELAY_SECRET`. It is used only during the server
WebSocket handshake; the iPad continues to use its ordinary staff session.
Never place the relay credential in the app or public code.

## Deployment and recovery

Use the already installed Wrangler executable with `deploy --config
deploy/one-club/wrangler.jsonc`. After first deployment, upload the private
relay key using `wrangler secret put VENUE_RELAY_SECRET` with file input.
The Durable Object binding and SQLite class migration are in that config.

The relay reconnects with exponential backoff capped at ten seconds and checks
heartbeats every ten seconds. A missing peer returns HTTP 503 with Retry-After.
Restarting the relay preserves the iPad's address and all saved database rows.
The September 6 recovery check observed 503 then 200 after 0.62 seconds when
launchd automatically replaced the stopped relay process.

Each request body is limited to 512 KiB; response bodies stream in 48 KiB
frames with a 16 MiB cap and a 45 second request deadline. Larger imports
should be split or administered locally. Private responses are never cached.

The existing HQ tunnel and its access rules are unchanged. The three temporary
POS tunnels and the temporary LAN bridge were retired after fixed-address
verification. Do not restart them as the normal service path.

For a database backup, run from the repository root:

```sh
ONECLUB_STORAGE_DIR=.storage/bar-one-venue node --import tsx scripts/backup-one-club.ts
```

The local backup command verifies integrity and saves database/key hashes.
An off-device backup schedule and full venue cutover remain separate work.

import type { Kysely } from 'kysely';
import { DateTime } from 'luxon';
import { id, nowIso } from '@blacklabel/core';
import { LOGIN_TOKEN_TTL_MINUTES, SESSION_TTL_DAYS } from './service';
import type { PortalCustomerAccountRow, PortalCustomerDatabase } from './schema';

export interface PortalCustomerSeedResult {
  accounts: PortalCustomerAccountRow[];
  /** Valid, unused magic login token for accounts[0]. */
  loginToken: string;
  /** Live bearer session token for accounts[0]. */
  sessionToken: string;
}

/**
 * Demo data: two portal accounts (industry-neutral), one ready-to-exchange
 * login token and one live session for the first account, plus a message and
 * an upload. Writes fixture rows directly — no events are emitted.
 */
export async function seedPortalCustomer(
  db: Kysely<PortalCustomerDatabase>,
  tenantId: string,
): Promise<PortalCustomerSeedResult> {
  const now = nowIso();

  const accounts: PortalCustomerAccountRow[] = [
    {
      id: id(),
      tenant_id: tenantId,
      customer_id: id(),
      email: 'ada@example.com',
      name: 'Ada Alvarez',
      phone: '+1 555 0100',
      created_at: now,
      updated_at: now,
    },
    {
      id: id(),
      tenant_id: tenantId,
      customer_id: id(),
      email: 'sam@example.com',
      name: 'Sam Okafor',
      phone: null,
      created_at: now,
      updated_at: now,
    },
  ];
  await db.insertInto('portal_customer_accounts').values(accounts).execute();

  const loginToken = `${id()}${id()}`;
  await db
    .insertInto('portal_customer_login_tokens')
    .values({
      id: id(),
      tenant_id: tenantId,
      account_id: accounts[0].id,
      token: loginToken,
      expires_at: DateTime.utc().plus({ minutes: LOGIN_TOKEN_TTL_MINUTES }).toISO()!,
      used_at: null,
      created_at: now,
    })
    .execute();

  const sessionToken = `${id()}${id()}`;
  await db
    .insertInto('portal_customer_sessions')
    .values({
      id: id(),
      tenant_id: tenantId,
      account_id: accounts[0].id,
      token: sessionToken,
      expires_at: DateTime.utc().plus({ days: SESSION_TTL_DAYS }).toISO()!,
      revoked: 0,
      created_at: now,
    })
    .execute();

  await db
    .insertInto('portal_customer_messages')
    .values({
      id: id(),
      tenant_id: tenantId,
      account_id: accounts[0].id,
      customer_id: accounts[0].customer_id,
      subject: 'Gate code',
      body: 'The side gate code is 4321 — please use it on your next visit.',
      relayed_message_id: null,
      created_at: now,
    })
    .execute();

  await db
    .insertInto('portal_customer_uploads')
    .values({
      id: id(),
      tenant_id: tenantId,
      account_id: accounts[0].id,
      customer_id: accounts[0].customer_id,
      file_id: null,
      file_name: 'site-photo.jpg',
      content_type: 'image/jpeg',
      size_bytes: 204800,
      kind: 'photo',
      related_entity_type: null,
      related_entity_id: null,
      created_at: now,
    })
    .execute();

  return { accounts, loginToken, sessionToken };
}

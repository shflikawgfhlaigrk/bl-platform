import { describe, expect, it } from 'vitest';
import { EventBus, asCoreDb, coreMigrations, createTenant } from '@blacklabel/core';
import { createTestDb, runMigrations } from '@blacklabel/db';
import {
  MessagingService,
  messagingMigrations,
  seedMessaging,
  type MessagingDatabase,
} from '@blacklabel/messaging';

describe('seedMessaging', () => {
  it('seeds channels, templates and threaded conversations scoped to one tenant', async () => {
    const db = createTestDb<MessagingDatabase>();
    await runMigrations(db, [...coreMigrations, ...messagingMigrations]);
    const tenantA = await createTenant(asCoreDb(db), { name: 'Seeded' });
    const tenantB = await createTenant(asCoreDb(db), { name: 'Empty' });

    const result = await seedMessaging(db, tenantA.id);
    expect(result.channelIds).toHaveLength(2);
    expect(result.conversationIds).toHaveLength(2);
    expect(result.messageIds).toHaveLength(3);
    expect(result.templateIds).toHaveLength(2);

    const service = new MessagingService(db, new EventBus());
    const conversations = await service.listConversations(tenantA.id);
    expect(conversations).toHaveLength(2);
    expect(conversations.every((c) => c.tenant_id === tenantA.id)).toBe(true);

    const detail = await service.getConversation(tenantA.id, result.conversationIds[0]);
    expect(detail.messages.length).toBeGreaterThan(0);
    expect(detail.participants.length).toBeGreaterThan(0);

    // seeded templates render
    const templates = await service.listTemplates(tenantA.id);
    expect(templates.map((t) => t.name).sort()).toEqual(['follow_up', 'welcome']);

    // the other tenant sees nothing
    expect(await service.listConversations(tenantB.id)).toEqual([]);
    expect(await service.listTemplates(tenantB.id)).toEqual([]);
    expect(await service.listChannels(tenantB.id)).toEqual([]);
  });

  it('can seed multiple tenants independently (unique names are per-tenant)', async () => {
    const db = createTestDb<MessagingDatabase>();
    await runMigrations(db, [...coreMigrations, ...messagingMigrations]);
    const t1 = await createTenant(asCoreDb(db), { name: 'One' });
    const t2 = await createTenant(asCoreDb(db), { name: 'Two' });
    await seedMessaging(db, t1.id);
    await seedMessaging(db, t2.id);
    const service = new MessagingService(db, new EventBus());
    expect(await service.listConversations(t1.id)).toHaveLength(2);
    expect(await service.listConversations(t2.id)).toHaveLength(2);
  });
});

import { describe, expect, it } from 'vitest';
import {
  EventBus,
  asCoreDb,
  coreMigrations,
  createTenant,
  type PlatformEvent,
} from '@blacklabel/core';
import { createTestDb, runMigrations } from '@blacklabel/db';
import {
  messagingMigrations,
  messagingRouter,
  type MessagingDatabase,
} from '@blacklabel/messaging';

async function setup() {
  const db = createTestDb<MessagingDatabase>();
  await runMigrations(db, [...coreMigrations, ...messagingMigrations]);
  const tenantA = await createTenant(asCoreDb(db), { name: 'Tenant A' });
  const tenantB = await createTenant(asCoreDb(db), { name: 'Tenant B' });
  const events = new EventBus();
  const app = messagingRouter({ db, events, contracts: {} });
  return { db, events, app, a: tenantA.id, b: tenantB.id };
}

function json(method: string, body: unknown, tenantId: string): RequestInit {
  return {
    method,
    headers: { 'content-type': 'application/json', 'x-tenant-id': tenantId },
    body: JSON.stringify(body),
  };
}

const get = (tenantId: string): RequestInit => ({ headers: { 'x-tenant-id': tenantId } });

describe('tenant middleware wiring', () => {
  it('rejects requests without x-tenant-id (400) and unknown tenants (404)', async () => {
    const { app } = await setup();
    expect((await app.request('/conversations')).status).toBe(400);
    expect((await app.request('/conversations', get('nope'))).status).toBe(404);
  });
});

describe('channels CRUD', () => {
  it('creates, lists, reads, updates and deletes channels', async () => {
    const { app, a } = await setup();
    const created = await app.request(
      '/channels',
      json('POST', { type: 'email', name: 'Support', address: 'help@a.test' }, a),
    );
    expect(created.status).toBe(201);
    const channel = ((await created.json()) as any).data;
    expect(channel.is_active).toBe(true);

    const list = (await (await app.request('/channels', get(a))).json()) as any;
    expect(list.data).toHaveLength(1);
    expect(list.limit).toBe(50);
    expect(list.offset).toBe(0);

    const patched = await app.request(
      `/channels/${channel.id}`,
      json('PATCH', { isActive: false, name: 'Support 2' }, a),
    );
    expect(((await patched.json()) as any).data).toMatchObject({
      name: 'Support 2',
      is_active: false,
    });

    const del = await app.request(`/channels/${channel.id}`, { ...get(a), method: 'DELETE' });
    expect(del.status).toBe(204);
    expect((await app.request(`/channels/${channel.id}`, get(a))).status).toBe(404);
  });

  it('rejects invalid channel types with 400', async () => {
    const { app, a } = await setup();
    const res = await app.request(
      '/channels',
      json('POST', { type: 'carrier_pigeon', name: 'x', address: 'y' }, a),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error.code).toBe('validation_error');
  });
});

describe('conversations & messages over HTTP', () => {
  it('runs the full flow: create -> inbound -> reply -> assign -> close', async () => {
    const { app, events, a } = await setup();
    const seen: PlatformEvent[] = [];
    events.on('messaging.message.received', (e) => {
      seen.push(e);
    });

    const inbound = await app.request(
      '/inbound',
      json('POST', { channel: 'email', from: 'pat@a.test', subject: 'Hi there', body: 'Hello!' }, a),
    );
    expect(inbound.status).toBe(201);
    const { conversation, message } = ((await inbound.json()) as any).data;
    expect(conversation.status).toBe('open');
    expect(message.direction).toBe('in');
    expect(seen).toHaveLength(1);

    const reply = await app.request(
      `/conversations/${conversation.id}/messages`,
      json('POST', { body: 'Thanks for reaching out' }, a),
    );
    expect(reply.status).toBe(201);
    expect(((await reply.json()) as any).data).toMatchObject({
      direction: 'out',
      status: 'sent',
      to_address: 'pat@a.test',
    });

    const assign = await app.request(
      `/conversations/${conversation.id}/assign`,
      { ...json('POST', { userId: 'agent-1', note: 'take this' }, a), headers: { 'content-type': 'application/json', 'x-tenant-id': a, 'x-user-id': 'manager-1' } },
    );
    expect(assign.status).toBe(201);
    expect(((await assign.json()) as any).data).toMatchObject({
      user_id: 'agent-1',
      assigned_by: 'manager-1',
    });

    const closed = await app.request(
      `/conversations/${conversation.id}/status`,
      json('POST', { status: 'closed' }, a),
    );
    expect(((await closed.json()) as any).data.status).toBe('closed');

    const detail = (await (await app.request(`/conversations/${conversation.id}`, get(a))).json()) as any;
    expect(detail.data.messages).toHaveLength(2);
    expect(detail.data.participants).toHaveLength(1);
    expect(detail.data.assignments).toHaveLength(1);
    expect(detail.data.assigned_user_id).toBe('agent-1');
  });

  it('lists conversations with filters and rejects non-whitelisted sorts', async () => {
    const { app, a } = await setup();
    await app.request('/conversations', json('POST', { subject: 'One', channel: 'email' }, a));
    const conv2 = ((await (
      await app.request('/conversations', json('POST', { subject: 'Two', channel: 'sms' }, a))
    ).json()) as any).data;
    await app.request(`/conversations/${conv2.id}/status`, json('POST', { status: 'pending' }, a));

    const pending = (await (
      await app.request('/conversations?status=pending', get(a))
    ).json()) as any;
    expect(pending.data).toHaveLength(1);
    expect(pending.data[0].subject).toBe('Two');

    const byChannel = (await (
      await app.request('/conversations?channel=email', get(a))
    ).json()) as any;
    expect(byChannel.data).toHaveLength(1);

    const badSort = await app.request('/conversations?sort=evil_column', get(a));
    expect(badSort.status).toBe(400);
  });

  it('returns 409 for invalid status transitions over HTTP', async () => {
    const { app, a } = await setup();
    const conv = ((await (
      await app.request('/conversations', json('POST', { subject: 'S', channel: 'email' }, a))
    ).json()) as any).data;
    await app.request(`/conversations/${conv.id}/status`, json('POST', { status: 'closed' }, a));
    const res = await app.request(
      `/conversations/${conv.id}/status`,
      json('POST', { status: 'pending' }, a),
    );
    expect(res.status).toBe(409);
  });

  it('adds participants to an existing conversation (and enables threading to them)', async () => {
    const { app, a, b } = await setup();
    const conv = ((await (
      await app.request('/conversations', json('POST', { subject: 'Party', channel: 'email' }, a))
    ).json()) as any).data;
    const added = await app.request(
      `/conversations/${conv.id}/participants`,
      json('POST', { kind: 'external', address: 'new@x.test', displayName: 'Newbie' }, a),
    );
    expect(added.status).toBe(201);
    expect(((await added.json()) as any).data).toMatchObject({
      kind: 'external',
      address: 'new@x.test',
      conversation_id: conv.id,
    });
    // tenant B cannot add participants to A's conversation
    expect(
      (await app.request(`/conversations/${conv.id}/participants`, json('POST', { kind: 'external', address: 'spy@x.test' }, b))).status,
    ).toBe(404);
    // an inbound message from the new address now threads onto this conversation
    const inbound = ((await (
      await app.request('/inbound', json('POST', { channel: 'email', from: 'new@x.test', body: 'threaded' }, a))
    ).json()) as any).data;
    expect(inbound.conversation.id).toBe(conv.id);
  });

  it('links a conversation to CRM ids via PATCH', async () => {
    const { app, a } = await setup();
    const conv = ((await (
      await app.request('/conversations', json('POST', { subject: 'Link me', channel: 'email' }, a))
    ).json()) as any).data;
    const res = await app.request(
      `/conversations/${conv.id}`,
      json('PATCH', { customerId: 'cust-1', contactId: 'contact-2' }, a),
    );
    expect(((await res.json()) as any).data).toMatchObject({
      customer_id: 'cust-1',
      contact_id: 'contact-2',
    });
  });
});

describe('templates over HTTP', () => {
  it('creates, renders, updates, deletes templates and 409s on duplicate names', async () => {
    const { app, a } = await setup();
    const created = await app.request(
      '/templates',
      json('POST', { name: 'welcome', subject: 'Hi {{name}}', body: 'Welcome {{name}}!' }, a),
    );
    expect(created.status).toBe(201);
    const template = ((await created.json()) as any).data;

    const dup = await app.request('/templates', json('POST', { name: 'welcome', body: 'x' }, a));
    expect(dup.status).toBe(409);

    const rendered = await app.request(
      `/templates/${template.id}/render`,
      json('POST', { variables: { name: 'Sam' } }, a),
    );
    expect(((await rendered.json()) as any).data).toEqual({
      subject: 'Hi Sam',
      body: 'Welcome Sam!',
    });

    const missing = await app.request(`/templates/${template.id}/render`, json('POST', {}, a));
    expect(missing.status).toBe(400);

    const patched = await app.request(
      `/templates/${template.id}`,
      json('PATCH', { body: 'Hello {{name}}.' }, a),
    );
    expect(((await patched.json()) as any).data.body).toBe('Hello {{name}}.');

    expect(
      (await app.request(`/templates/${template.id}`, { ...get(a), method: 'DELETE' })).status,
    ).toBe(204);
    expect((await app.request(`/templates/${template.id}`, get(a))).status).toBe(404);
  });
});

describe('search over HTTP', () => {
  it('searches messages and conversations; requires q', async () => {
    const { app, a } = await setup();
    await app.request(
      '/inbound',
      json('POST', { channel: 'email', from: 'pat@a.test', subject: 'Invoice question', body: 'Where is invoice 55?' }, a),
    );
    const res = (await (await app.request('/search?q=invoice', get(a))).json()) as any;
    expect(res.data.conversations).toHaveLength(1);
    expect(res.data.messages).toHaveLength(1);

    expect((await app.request('/search', get(a))).status).toBe(400);
  });
});

describe('inbox HTML page', () => {
  it('renders the conversation list and a selected thread, HTML-escaped', async () => {
    const { app, a } = await setup();
    const inbound = await app.request(
      '/inbound',
      json(
        'POST',
        {
          channel: 'website',
          from: 'visitor-1',
          subject: 'Question about <script>alert(1)</script>',
          body: 'Is this <b>safe</b>?',
        },
        a,
      ),
    );
    const { conversation } = ((await inbound.json()) as any).data;

    const listPage = await app.request('/inbox', get(a));
    expect(listPage.status).toBe(200);
    expect(listPage.headers.get('content-type')).toContain('text/html');
    const listHtml = await listPage.text();
    expect(listHtml).toContain('Question about &lt;script&gt;alert(1)&lt;/script&gt;');
    expect(listHtml).not.toContain('<script>alert(1)</script>');
    expect(listHtml).toContain('Select a conversation.');

    const threadPage = await app.request(`/inbox?conversation=${conversation.id}`, get(a));
    const threadHtml = await threadPage.text();
    expect(threadHtml).toContain('Is this &lt;b&gt;safe&lt;/b&gt;?');
    expect(threadHtml).toContain('visitor-1');
  });
});

describe('tenant isolation (denial tests)', () => {
  it('conversations: tenant B cannot read, update, close, assign, or message tenant A\'s conversation', async () => {
    const { app, a, b } = await setup();
    const conv = ((await (
      await app.request('/conversations', json('POST', { subject: 'A private', channel: 'email' }, a))
    ).json()) as any).data;

    expect((await app.request(`/conversations/${conv.id}`, get(b))).status).toBe(404);
    expect(
      (await app.request(`/conversations/${conv.id}`, json('PATCH', { subject: 'stolen' }, b))).status,
    ).toBe(404);
    expect(
      (await app.request(`/conversations/${conv.id}/status`, json('POST', { status: 'closed' }, b))).status,
    ).toBe(404);
    expect(
      (await app.request(`/conversations/${conv.id}/assign`, json('POST', { userId: 'spy' }, b))).status,
    ).toBe(404);
    expect(
      (await app.request(`/conversations/${conv.id}/messages`, json('POST', { to: 'x', body: 'hi' }, b))).status,
    ).toBe(404);
    expect((await app.request(`/conversations/${conv.id}/messages`, get(b))).status).toBe(404);

    const bList = (await (await app.request('/conversations', get(b))).json()) as any;
    expect(bList.data).toEqual([]);

    // A's data untouched
    const fresh = (await (await app.request(`/conversations/${conv.id}`, get(a))).json()) as any;
    expect(fresh.data.subject).toBe('A private');
    expect(fresh.data.status).toBe('open');
    expect(fresh.data.assigned_user_id).toBeNull();
    expect(fresh.data.messages).toEqual([]);
  });

  it('channels: tenant B gets 404/empty on A\'s channels and cannot delete them', async () => {
    const { app, a, b } = await setup();
    const channel = ((await (
      await app.request('/channels', json('POST', { type: 'sms', name: 'A line', address: '+1555' }, a))
    ).json()) as any).data;

    expect((await app.request(`/channels/${channel.id}`, get(b))).status).toBe(404);
    expect(
      (await app.request(`/channels/${channel.id}`, json('PATCH', { name: 'hacked' }, b))).status,
    ).toBe(404);
    expect(
      (await app.request(`/channels/${channel.id}`, { ...get(b), method: 'DELETE' })).status,
    ).toBe(404);
    expect(((await (await app.request('/channels', get(b))).json()) as any).data).toEqual([]);

    const fresh = (await (await app.request(`/channels/${channel.id}`, get(a))).json()) as any;
    expect(fresh.data.name).toBe('A line');
  });

  it('templates: tenant B gets 404/empty on A\'s templates', async () => {
    const { app, a, b } = await setup();
    const template = ((await (
      await app.request('/templates', json('POST', { name: 'a_only', body: 'secret {{x}}' }, a))
    ).json()) as any).data;

    expect((await app.request(`/templates/${template.id}`, get(b))).status).toBe(404);
    expect(
      (await app.request(`/templates/${template.id}`, json('PATCH', { body: 'x' }, b))).status,
    ).toBe(404);
    expect(
      (await app.request(`/templates/${template.id}`, { ...get(b), method: 'DELETE' })).status,
    ).toBe(404);
    expect(
      (await app.request(`/templates/${template.id}/render`, json('POST', { variables: { x: '1' } }, b))).status,
    ).toBe(404);
    expect(((await (await app.request('/templates', get(b))).json()) as any).data).toEqual([]);

    const fresh = (await (await app.request(`/templates/${template.id}`, get(a))).json()) as any;
    expect(fresh.data.body).toBe('secret {{x}}');
  });

  it('inbound threading never crosses tenants even with identical sender addresses', async () => {
    const { app, a, b } = await setup();
    const inA = ((await (
      await app.request('/inbound', json('POST', { channel: 'email', from: 'same@x.test', body: 'for A' }, a))
    ).json()) as any).data;
    const inB = ((await (
      await app.request('/inbound', json('POST', { channel: 'email', from: 'same@x.test', body: 'for B' }, b))
    ).json()) as any).data;
    expect(inA.conversation.id).not.toBe(inB.conversation.id);
    expect(inA.conversation.tenant_id).toBe(a);
    expect(inB.conversation.tenant_id).toBe(b);

    const aMsgs = (await (
      await app.request(`/conversations/${inA.conversation.id}/messages`, get(a))
    ).json()) as any;
    expect(aMsgs.data.map((m: any) => m.body)).toEqual(['for A']);
  });

  it('assignments & inbound: tenant B cannot read A\'s assignment history or append inbound via an explicit conversationId', async () => {
    const { app, a, b } = await setup();
    const conv = ((await (
      await app.request('/conversations', json('POST', { subject: 'A only', channel: 'email' }, a))
    ).json()) as any).data;
    await app.request(`/conversations/${conv.id}/assign`, json('POST', { userId: 'agent-1' }, a));

    // B cannot read A's assignment history
    expect((await app.request(`/conversations/${conv.id}/assignments`, get(b))).status).toBe(404);

    // B cannot append an inbound message to A's conversation by passing its id
    const sneak = await app.request(
      '/inbound',
      json('POST', { channel: 'email', from: 'spy@x.test', body: 'sneaky', conversationId: conv.id }, b),
    );
    expect(sneak.status).toBe(404);

    // A's thread is untouched and A can still read its history
    const msgs = (await (await app.request(`/conversations/${conv.id}/messages`, get(a))).json()) as any;
    expect(msgs.data).toEqual([]);
    const history = (await (await app.request(`/conversations/${conv.id}/assignments`, get(a))).json()) as any;
    expect(history.data).toHaveLength(1);
  });

  it('the inbox page only shows the requesting tenant\'s conversations', async () => {
    const { app, a, b } = await setup();
    await app.request('/inbound', json('POST', { channel: 'email', from: 'p@x.test', subject: 'Visible to A', body: 'x' }, a));
    const html = await (await app.request('/inbox', get(b))).text();
    expect(html).not.toContain('Visible to A');
  });
});

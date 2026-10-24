import { Hono } from 'hono';
import { z } from 'zod';
import {
  asCoreDb,
  errorHandler,
  parseFilters,
  parsePagination,
  parseSort,
  tenantMiddleware,
  type ModuleDeps,
  type TenantEnv,
} from '@blacklabel/core';
import { CHANNEL_TYPES, CONVERSATION_STATUSES, PARTICIPANT_KINDS } from './schema';
import type { MessagingDatabase } from './schema';
import { MessagingService, renderTemplate, type MessagingServiceOptions } from './service';

/* ------------------------------- zod bodies ------------------------------ */

const channelCreateSchema = z.object({
  type: z.enum(CHANNEL_TYPES),
  name: z.string().min(1),
  address: z.string().min(1),
  isActive: z.boolean().optional(),
});

const channelPatchSchema = z.object({
  name: z.string().optional(),
  address: z.string().optional(),
  isActive: z.boolean().optional(),
});

const participantSchema = z.object({
  kind: z.enum(PARTICIPANT_KINDS),
  refId: z.string().optional(),
  address: z.string().optional(),
  displayName: z.string().optional(),
});

const conversationCreateSchema = z.object({
  subject: z.string().min(1),
  channel: z.enum(CHANNEL_TYPES),
  customerId: z.string().optional(),
  contactId: z.string().optional(),
  participants: z.array(participantSchema).optional(),
});

const conversationPatchSchema = z.object({
  subject: z.string().optional(),
  customerId: z.string().nullable().optional(),
  contactId: z.string().nullable().optional(),
});

const statusSchema = z.object({
  status: z.enum(CONVERSATION_STATUSES),
});

const assignSchema = z.object({
  userId: z.string().min(1),
  note: z.string().optional(),
  expectedRevision: z.number().int().min(0).optional(),
});

const outboundSchema = z.object({
  idempotencyKey: z.string().min(1).max(200).optional(),
  to: z.string().optional(),
  subject: z.string().optional(),
  body: z.string().optional(),
  templateId: z.string().optional(),
  variables: z.record(z.string()).optional(),
  expectedRevision: z.number().int().min(0).optional(),
});

const inboundSchema = z.object({
  provider: z.string().min(1).max(200).optional(),
  providerEventId: z.string().min(1).max(255).optional(),
  channel: z.enum(CHANNEL_TYPES),
  from: z.string().min(1),
  to: z.string().optional(),
  subject: z.string().optional(),
  body: z.string().min(1),
  conversationId: z.string().optional(),
  customerId: z.string().optional(),
  contactId: z.string().optional(),
  // 'call' channel metadata (ignored/no-op on other channels).
  recordingUrl: z.string().optional(),
  transcript: z.string().optional(),
  durationSeconds: z.number().int().min(0).optional(),
});

const templateCreateSchema = z.object({
  name: z.string().min(1),
  body: z.string().min(1),
  channel: z.enum(CHANNEL_TYPES).optional(),
  subject: z.string().optional(),
});

const templatePatchSchema = z.object({
  name: z.string().optional(),
  body: z.string().optional(),
  channel: z.enum(CHANNEL_TYPES).nullable().optional(),
  subject: z.string().nullable().optional(),
});

const renderSchema = z.object({
  variables: z.record(z.string()).default({}),
});

/* --------------------------------- router -------------------------------- */

export interface MessagingRouterOptions extends MessagingServiceOptions {}

const CONVERSATION_SORT_COLUMNS = ['created_at', 'updated_at', 'last_message_at', 'status'] as const;

/**
 * Messaging router factory. Mounted by apps/api at /api/messaging.
 * `options.providers` connects the deployment's channel adapters;
 * `options.timeline` wires the CRM timeline writer contract.
 */
export function messagingRouter(
  deps: ModuleDeps<MessagingDatabase>,
  options: MessagingRouterOptions = {},
): Hono<TenantEnv> {
  const service = new MessagingService(deps.db, deps.events, options);
  const app = new Hono<TenantEnv>();
  app.onError(errorHandler);
  app.use('*', tenantMiddleware(asCoreDb(deps.db)));

  const actorOf = (c: { req: { header(name: string): string | undefined } }): string =>
    c.req.header('x-user-id') ?? 'system';

  /* ------------------------------- channels ------------------------------ */

  app.post('/channels', async (c) => {
    const body = channelCreateSchema.parse(await c.req.json());
    const channel = await service.createChannel(c.get('tenantId'), actorOf(c), body);
    return c.json({ data: channel }, 201);
  });

  app.get('/channels', async (c) => {
    const page = parsePagination(c.req.query());
    const data = await service.listChannels(c.get('tenantId'), page);
    return c.json({ data, limit: page.limit, offset: page.offset });
  });

  app.get('/channels/:id', async (c) => {
    const channel = await service.getChannel(c.get('tenantId'), c.req.param('id'));
    return c.json({ data: channel });
  });

  app.patch('/channels/:id', async (c) => {
    const body = channelPatchSchema.parse(await c.req.json());
    const channel = await service.updateChannel(c.get('tenantId'), actorOf(c), c.req.param('id'), body);
    return c.json({ data: channel });
  });

  app.delete('/channels/:id', async (c) => {
    await service.deleteChannel(c.get('tenantId'), actorOf(c), c.req.param('id'));
    return c.body(null, 204);
  });

  /* ---------------------------- conversations ---------------------------- */

  app.post('/conversations', async (c) => {
    const body = conversationCreateSchema.parse(await c.req.json());
    const conversation = await service.createConversation(c.get('tenantId'), actorOf(c), body);
    return c.json({ data: conversation }, 201);
  });

  app.get('/conversations', async (c) => {
    const query = c.req.query();
    const page = parsePagination(query);
    const sort = parseSort(query, CONVERSATION_SORT_COLUMNS, {
      column: 'last_message_at',
      direction: 'desc',
    })!;
    const filters = parseFilters(query, ['status', 'channel', 'assigned_user_id', 'customer_id']);
    const data = await service.listConversations(c.get('tenantId'), filters, page, sort);
    return c.json({ data, limit: page.limit, offset: page.offset });
  });

  app.get('/conversations/:id', async (c) => {
    const detail = await service.getConversation(c.get('tenantId'), c.req.param('id'));
    return c.json({ data: detail });
  });

  app.patch('/conversations/:id', async (c) => {
    const body = conversationPatchSchema.parse(await c.req.json());
    const conversation = await service.updateConversation(
      c.get('tenantId'), actorOf(c), c.req.param('id'), body,
    );
    return c.json({ data: conversation });
  });

  app.post('/conversations/:id/status', async (c) => {
    const body = statusSchema.parse(await c.req.json());
    const conversation = await service.setStatus(
      c.get('tenantId'), actorOf(c), c.req.param('id'), body.status,
    );
    return c.json({ data: conversation });
  });

  app.post('/conversations/:id/assign', async (c) => {
    const body = assignSchema.parse(await c.req.json());
    const assignment = await service.assignConversation(
      c.get('tenantId'), actorOf(c), c.req.param('id'), body,
    );
    return c.json({ data: assignment }, 201);
  });

  app.post('/conversations/:id/participants', async (c) => {
    const body = participantSchema.parse(await c.req.json());
    const participant = await service.addConversationParticipant(
      c.get('tenantId'), actorOf(c), c.req.param('id'), body,
    );
    return c.json({ data: participant }, 201);
  });

  app.get('/conversations/:id/assignments', async (c) => {
    // 404 for unknown/foreign conversations rather than an empty list
    await service.getConversationRow(c.get('tenantId'), c.req.param('id'));
    const data = await service.listAssignments(c.get('tenantId'), c.req.param('id'));
    return c.json({ data });
  });

  /* ------------------------------- messages ------------------------------ */

  app.get('/conversations/:id/messages', async (c) => {
    await service.getConversationRow(c.get('tenantId'), c.req.param('id'));
    const page = parsePagination(c.req.query());
    const data = await service.listMessages(c.get('tenantId'), c.req.param('id'), page);
    return c.json({ data, limit: page.limit, offset: page.offset });
  });

  app.post('/conversations/:id/messages', async (c) => {
    const body = outboundSchema.parse(await c.req.json());
    const message = await service.sendOutbound(c.get('tenantId'), actorOf(c), {
      ...body,
      conversationId: c.req.param('id'),
    });
    return c.json({ data: message }, 201);
  });

  /** Authenticated adapter ingestion; transport authentication is owned by composition. */
  app.post('/inbound', async (c) => {
    const body = inboundSchema.parse(await c.req.json());
    const result = await service.recordInbound(c.get('tenantId'), actorOf(c), body);
    return c.json({ data: { message: result.message, conversation: result.conversation } }, 201);
  });

  app.get('/inbound-receipts', async c => {
    const page = parsePagination(c.req.query());
    return c.json({ data: await service.listInboundReceipts(c.get('tenantId'), page), limit: page.limit, offset: page.offset });
  });

  app.get('/messages/:id', async (c) => c.json({ data: await service.getMessage(c.get('tenantId'), c.req.param('id')) }));
  app.post('/messages/:id/reconcile', async (c) => {
    const body = z.object({ providerMessageId: z.string().min(1).max(255).optional() }).parse(await c.req.json());
    return c.json({ data: await service.reconcileMessage(c.get('tenantId'), actorOf(c), c.req.param('id'), body.providerMessageId) });
  });

  /* ------------------------------- templates ----------------------------- */

  app.post('/templates', async (c) => {
    const body = templateCreateSchema.parse(await c.req.json());
    const template = await service.createTemplate(c.get('tenantId'), actorOf(c), body);
    return c.json({ data: template }, 201);
  });

  app.get('/templates', async (c) => {
    const page = parsePagination(c.req.query());
    const data = await service.listTemplates(c.get('tenantId'), page);
    return c.json({ data, limit: page.limit, offset: page.offset });
  });

  app.get('/templates/:id', async (c) => {
    const template = await service.getTemplate(c.get('tenantId'), c.req.param('id'));
    return c.json({ data: template });
  });

  app.patch('/templates/:id', async (c) => {
    const body = templatePatchSchema.parse(await c.req.json());
    const template = await service.updateTemplate(c.get('tenantId'), actorOf(c), c.req.param('id'), body);
    return c.json({ data: template });
  });

  app.delete('/templates/:id', async (c) => {
    await service.deleteTemplate(c.get('tenantId'), actorOf(c), c.req.param('id'));
    return c.body(null, 204);
  });

  /** Preview a template render without sending anything. */
  app.post('/templates/:id/render', async (c) => {
    const body = renderSchema.parse(await c.req.json());
    const template = await service.getTemplate(c.get('tenantId'), c.req.param('id'));
    const rendered = {
      subject: template.subject === null ? null : renderTemplate(template.subject, body.variables),
      body: renderTemplate(template.body, body.variables),
    };
    return c.json({ data: rendered });
  });

  /* -------------------------------- search ------------------------------- */

  app.get('/search', async (c) => {
    const query = c.req.query();
    const page = parsePagination(query);
    const result = await service.search(c.get('tenantId'), query.q ?? '', page);
    return c.json({ data: result, limit: page.limit, offset: page.offset });
  });

  /* ------------------------------ inbox (HTML) --------------------------- */

  app.get('/inbox', async (c) => {
    const tenantId = c.get('tenantId');
    const selectedId = c.req.query('conversation');
    const conversations = await service.listConversations(tenantId, {}, { limit: 50, offset: 0 });
    const selected = selectedId ? await service.getConversation(tenantId, selectedId) : null;

    const listHtml = conversations
      .map((conv) => {
        const active = selected && conv.id === selected.id ? ' class="active"' : '';
        return `<li${active}><a href="?conversation=${esc(conv.id)}">` +
          `<span class="subject">${esc(conv.subject)}</span> ` +
          `<span class="meta">[${esc(conv.channel)} · ${esc(conv.status)}]</span>` +
          `</a></li>`;
      })
      .join('\n');

    const threadHtml = selected
      ? `<h2>${esc(selected.subject)}</h2>
<p class="meta">channel: ${esc(selected.channel)} · status: ${esc(selected.status)}${
          selected.assigned_user_id ? ` · assigned: ${esc(selected.assigned_user_id)}` : ''
        }</p>
<ol class="thread">
${selected.messages
  .map(
    (m) =>
      `<li class="msg ${m.direction === 'in' ? 'inbound' : 'outbound'}">` +
      `<span class="who">${esc(m.direction === 'in' ? m.from_address ?? 'unknown' : m.to_address ?? 'unknown')}</span>` +
      `<span class="when">${esc(m.created_at)}</span>` +
      `<p class="body">${esc(m.body)}</p></li>`,
  )
  .join('\n')}
</ol>`
      : '<p class="empty">Select a conversation.</p>';

    return c.html(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Inbox</title>
<style>
body{font-family:system-ui,sans-serif;margin:0;display:flex;min-height:100vh}
nav{width:320px;border-right:1px solid #ddd;padding:1rem;overflow:auto}
main{flex:1;padding:1rem;overflow:auto}
ul{list-style:none;padding:0;margin:0}
li{padding:.4rem 0;border-bottom:1px solid #eee}
li.active{background:#f2f6ff}
a{text-decoration:none;color:inherit;display:block}
.meta{color:#777;font-size:.85em}
.thread{padding-left:0}
.msg{margin:.5rem 0;padding:.5rem;border-radius:6px}
.msg.inbound{background:#f4f4f4}
.msg.outbound{background:#e8f1ff;text-align:right}
.who{font-weight:600;margin-right:.5rem}
.when{color:#999;font-size:.8em}
.body{margin:.25rem 0 0;white-space:pre-wrap}
.empty{color:#777}
</style>
</head>
<body>
<nav>
<h1>Inbox</h1>
<ul>
${listHtml}
</ul>
</nav>
<main>
${threadHtml}
</main>
</body>
</html>`);
  });

  return app;
}

/** Minimal HTML escaping for server-rendered content. */
function esc(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

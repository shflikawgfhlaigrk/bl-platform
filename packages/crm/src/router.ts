/**
 * CRM REST router. Mounted by apps/api at /api/crm.
 * Tenant comes ONLY from the core tenant middleware (x-tenant-id header).
 * Optional x-user-id header identifies the acting user for audit; defaults
 * to "system".
 */
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import {
  ApiError,
  asCoreDb,
  audit,
  defineCustomField,
  deleteCustomField,
  errorHandler,
  listCustomFields,
  parseFilters,
  parsePagination,
  parseSort,
  tenantMiddleware,
  CUSTOM_FIELD_KINDS,
  type CustomFieldKind,
  type ModuleDeps,
  type TenantEnv,
} from '@blacklabel/core';
import type { CrmDatabase } from './schema';
import { CRM_ENTITY_TYPES } from './schema';
import * as svc from './service';

/* ------------------------------------------------------------------ *
 * Zod schemas (API shapes use snake_case column names)
 * ------------------------------------------------------------------ */

const customFields = z.record(z.unknown()).optional();
const entityTypeSchema = z.enum(CRM_ENTITY_TYPES);

const companyCreate = z
  .object({
    name: z.string().min(1),
    domain: z.string().nullish(),
    email: z.string().nullish(),
    phone: z.string().nullish(),
    address: z.string().nullish(),
    owner_user_id: z.string().nullish(),
    custom_fields: customFields,
  })
  .strict();
const companyUpdate = companyCreate.partial();

const customerCreate = z
  .object({
    name: z.string().min(1),
    email: z.string().nullish(),
    phone: z.string().nullish(),
    address: z.string().nullish(),
    status: z.enum(['active', 'inactive', 'archived']).optional(),
    company_id: z.string().nullish(),
    owner_user_id: z.string().nullish(),
    custom_fields: customFields,
  })
  .strict();
const customerUpdate = customerCreate.partial();

const contactCreate = z
  .object({
    first_name: z.string().min(1),
    last_name: z.string().nullish(),
    email: z.string().nullish(),
    phone: z.string().nullish(),
    title: z.string().nullish(),
    customer_id: z.string().nullish(),
    company_id: z.string().nullish(),
    owner_user_id: z.string().nullish(),
    custom_fields: customFields,
  })
  .strict();
const contactUpdate = contactCreate.partial();

const leadCreate = z
  .object({
    name: z.string().min(1),
    email: z.string().nullish(),
    phone: z.string().nullish(),
    source: z.string().nullish(),
    stage: z.string().optional(),
    value_cents: z.number().int().min(0).nullish(),
    customer_id: z.string().nullish(),
    contact_id: z.string().nullish(),
    company_id: z.string().nullish(),
    owner_user_id: z.string().nullish(),
    custom_fields: customFields,
  })
  .strict();
const leadUpdate = leadCreate.partial();

const leadStageChange = z.object({ stage: z.string().min(1) }).strict();

const leadStagesPut = z
  .object({
    stages: z
      .array(
        z
          .object({
            key: z.string().min(1),
            label: z.string().optional(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

const dealCreate = z
  .object({
    title: z.string().min(1),
    status: z.enum(svc.DEAL_STATUSES).optional(),
    value_cents: z.number().int().min(0).optional(),
    customer_id: z.string().nullish(),
    lead_id: z.string().nullish(),
    company_id: z.string().nullish(),
    owner_user_id: z.string().nullish(),
    expected_close_at: z.string().nullish(),
    custom_fields: customFields,
  })
  .strict();
const dealUpdate = dealCreate.partial();

const jobCreate = z
  .object({
    title: z.string().min(1),
    description: z.string().nullish(),
    status: z.enum(['planned', 'in_progress', 'completed', 'canceled']).optional(),
    customer_id: z.string().nullish(),
    deal_id: z.string().nullish(),
    owner_user_id: z.string().nullish(),
    starts_at: z.string().nullish(),
    ends_at: z.string().nullish(),
    custom_fields: customFields,
  })
  .strict();
const jobUpdate = jobCreate.partial();

const noteCreate = z
  .object({
    entity_type: entityTypeSchema,
    entity_id: z.string().min(1),
    body: z.string().min(1),
    author_user_id: z.string().nullish(),
  })
  .strict();
const noteUpdate = z.object({ body: z.string().min(1) }).strict();

const taskCreate = z
  .object({
    title: z.string().min(1),
    description: z.string().nullish(),
    due_at: z.string().nullish(),
    assignee_user_id: z.string().nullish(),
    entity_type: entityTypeSchema.nullish(),
    entity_id: z.string().nullish(),
  })
  .strict();
const taskUpdate = taskCreate.partial().omit({ entity_type: true, entity_id: true });

const tagCreate = z.object({ name: z.string().min(1), color: z.string().nullish() }).strict();
const tagUpdate = tagCreate.partial();
const tagAttach = z
  .object({ entity_type: entityTypeSchema, entity_id: z.string().min(1) })
  .strict();

const attachmentCreate = z
  .object({
    entity_type: entityTypeSchema,
    entity_id: z.string().min(1),
    file_id: z.string().min(1),
    filename: z.string().min(1),
    mime_type: z.string().nullish(),
    size_bytes: z.number().int().min(0).nullish(),
  })
  .strict();
const attachmentUpdate = z.object({ filename: z.string().min(1) }).strict();

const attributionCreate = z
  .object({
    entity_type: entityTypeSchema,
    entity_id: z.string().min(1),
    source: z.string().min(1),
    medium: z.string().nullish(),
    campaign: z.string().nullish(),
    detail: z.string().nullish(),
  })
  .strict();
const attributionUpdate = attributionCreate
  .partial()
  .omit({ entity_type: true, entity_id: true });

const customFieldCreate = z
  .object({
    entity_type: entityTypeSchema,
    key: z.string().min(1),
    label: z.string().min(1),
    kind: z.enum(CUSTOM_FIELD_KINDS as readonly [CustomFieldKind, ...CustomFieldKind[]]),
  })
  .strict();

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function actorOf(c: Context<TenantEnv>): string {
  return c.req.header('x-user-id') ?? 'system';
}

async function jsonBody(c: Context<TenantEnv>): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw ApiError.badRequest('invalid JSON body');
  }
}

/** Parse custom_fields JSON column back to an object for API responses. */
function present<T extends { custom_fields?: string | null }>(row: T): Omit<T, 'custom_fields'> & {
  custom_fields: Record<string, unknown> | null;
} {
  const { custom_fields, ...rest } = row;
  return {
    ...rest,
    custom_fields: custom_fields ? (JSON.parse(custom_fields) as Record<string, unknown>) : null,
  } as Omit<T, 'custom_fields'> & { custom_fields: Record<string, unknown> | null };
}

/* ------------------------------------------------------------------ *
 * Router factory
 * ------------------------------------------------------------------ */

export function crmRouter(deps: ModuleDeps<CrmDatabase>): Hono<TenantEnv> {
  const { db, events } = deps;
  const app = new Hono<TenantEnv>();
  app.onError(errorHandler);
  app.use('*', tenantMiddleware(asCoreDb(db)));

  const listParams = (c: Context<TenantEnv>, def: svc.CrmEntityDef): svc.ListParams => {
    const query = c.req.query();
    return {
      page: parsePagination(query),
      sort: parseSort(query, def.sortColumns, { column: 'created_at', direction: 'desc' }),
      filters: parseFilters(query, def.filterColumns),
      q: query.q,
    };
  };

  /* ---------------- lead stages ---------------- */

  app.get('/lead-stages', async (c) => {
    const stages = await svc.listLeadStages(db, c.get('tenantId'));
    return c.json({ data: stages });
  });

  app.put('/lead-stages', async (c) => {
    const body = leadStagesPut.parse(await jsonBody(c));
    const stages = await svc.setLeadStages(db, c.get('tenantId'), actorOf(c), body.stages);
    return c.json({ data: stages });
  });

  /* ---------------- CSV (register before /:id routes) ---------------- */

  const csvRoutes: { path: string; kind: svc.CsvKind }[] = [
    { path: '/customers', kind: 'customers' },
    { path: '/contacts', kind: 'contacts' },
    { path: '/leads', kind: 'leads' },
  ];
  for (const { path, kind } of csvRoutes) {
    app.get(`${path}/export.csv`, async (c) => {
      const csv = await svc.exportCsv(db, c.get('tenantId'), kind);
      return c.text(csv, 200, { 'content-type': 'text/csv; charset=utf-8' });
    });
    app.post(`${path}/import.csv`, async (c) => {
      const text = await c.req.text();
      if (!text.trim()) throw ApiError.badRequest('empty CSV body');
      const result = await svc.importCsv(db, events, c.get('tenantId'), actorOf(c), kind, text);
      return c.json({ data: result });
    });
  }

  /* ---------------- companies ---------------- */

  app.post('/companies', async (c) => {
    const input = companyCreate.parse(await jsonBody(c));
    const row = await svc.createCompany(db, events, c.get('tenantId'), actorOf(c), input);
    return c.json({ data: present(row) }, 201);
  });
  app.get('/companies', async (c) => {
    const params = listParams(c, svc.ENTITY_DEFS.company);
    const rows = await svc.listEntities(db, c.get('tenantId'), svc.ENTITY_DEFS.company, params);
    return c.json({
      data: (rows as { custom_fields?: string | null }[]).map(present),
      limit: params.page.limit,
      offset: params.page.offset,
    });
  });
  app.get('/companies/:id', async (c) => {
    const row = await svc.mustGetEntity(db, c.get('tenantId'), svc.ENTITY_DEFS.company, c.req.param('id'));
    return c.json({ data: present(row as { custom_fields?: string | null }) });
  });
  app.patch('/companies/:id', async (c) => {
    const patch = companyUpdate.parse(await jsonBody(c));
    const row = await svc.updateCompany(db, c.get('tenantId'), actorOf(c), c.req.param('id'), patch);
    return c.json({ data: present(row) });
  });
  app.delete('/companies/:id', async (c) => {
    await svc.deleteEntity(db, c.get('tenantId'), actorOf(c), svc.ENTITY_DEFS.company, c.req.param('id'));
    return c.json({ data: { deleted: true } });
  });

  /* ---------------- customers ---------------- */

  app.post('/customers', async (c) => {
    const input = customerCreate.parse(await jsonBody(c));
    const row = await svc.createCustomer(db, events, c.get('tenantId'), actorOf(c), input);
    return c.json({ data: present(row) }, 201);
  });
  app.get('/customers', async (c) => {
    const params = listParams(c, svc.ENTITY_DEFS.customer);
    const rows = await svc.listEntities(db, c.get('tenantId'), svc.ENTITY_DEFS.customer, params);
    return c.json({
      data: (rows as { custom_fields?: string | null }[]).map(present),
      limit: params.page.limit,
      offset: params.page.offset,
    });
  });
  app.get('/customers/:id', async (c) => {
    const row = await svc.mustGetEntity(db, c.get('tenantId'), svc.ENTITY_DEFS.customer, c.req.param('id'));
    return c.json({ data: present(row as { custom_fields?: string | null }) });
  });
  app.patch('/customers/:id', async (c) => {
    const patch = customerUpdate.parse(await jsonBody(c));
    const row = await svc.updateCustomer(db, c.get('tenantId'), actorOf(c), c.req.param('id'), patch);
    return c.json({ data: present(row) });
  });
  app.delete('/customers/:id', async (c) => {
    await svc.deleteEntity(db, c.get('tenantId'), actorOf(c), svc.ENTITY_DEFS.customer, c.req.param('id'));
    return c.json({ data: { deleted: true } });
  });
  app.get('/customers/:id/timeline', async (c) => {
    const tenantId = c.get('tenantId');
    await svc.mustGetEntity(db, tenantId, svc.ENTITY_DEFS.customer, c.req.param('id'));
    const page = parsePagination(c.req.query());
    const rows = await svc.listTimeline(db, tenantId, 'crm.customer', c.req.param('id'), page);
    return c.json({ data: rows, limit: page.limit, offset: page.offset });
  });

  /* ---------------- contacts ---------------- */

  app.post('/contacts', async (c) => {
    const input = contactCreate.parse(await jsonBody(c));
    const row = await svc.createContact(db, events, c.get('tenantId'), actorOf(c), input);
    return c.json({ data: present(row) }, 201);
  });
  app.get('/contacts', async (c) => {
    const params = listParams(c, svc.ENTITY_DEFS.contact);
    const rows = await svc.listEntities(db, c.get('tenantId'), svc.ENTITY_DEFS.contact, params);
    return c.json({
      data: (rows as { custom_fields?: string | null }[]).map(present),
      limit: params.page.limit,
      offset: params.page.offset,
    });
  });
  app.get('/contacts/:id', async (c) => {
    const row = await svc.mustGetEntity(db, c.get('tenantId'), svc.ENTITY_DEFS.contact, c.req.param('id'));
    return c.json({ data: present(row as { custom_fields?: string | null }) });
  });
  app.patch('/contacts/:id', async (c) => {
    const patch = contactUpdate.parse(await jsonBody(c));
    const row = await svc.updateContact(db, c.get('tenantId'), actorOf(c), c.req.param('id'), patch);
    return c.json({ data: present(row) });
  });
  app.delete('/contacts/:id', async (c) => {
    await svc.deleteEntity(db, c.get('tenantId'), actorOf(c), svc.ENTITY_DEFS.contact, c.req.param('id'));
    return c.json({ data: { deleted: true } });
  });

  /* ---------------- leads ---------------- */

  app.post('/leads', async (c) => {
    const input = leadCreate.parse(await jsonBody(c));
    const row = await svc.createLead(db, events, c.get('tenantId'), actorOf(c), input);
    return c.json({ data: present(row) }, 201);
  });
  app.get('/leads', async (c) => {
    const params = listParams(c, svc.ENTITY_DEFS.lead);
    const rows = await svc.listEntities(db, c.get('tenantId'), svc.ENTITY_DEFS.lead, params);
    return c.json({
      data: (rows as { custom_fields?: string | null }[]).map(present),
      limit: params.page.limit,
      offset: params.page.offset,
    });
  });
  app.get('/leads/:id', async (c) => {
    const row = await svc.mustGetEntity(db, c.get('tenantId'), svc.ENTITY_DEFS.lead, c.req.param('id'));
    return c.json({ data: present(row as { custom_fields?: string | null }) });
  });
  app.patch('/leads/:id', async (c) => {
    const patch = leadUpdate.parse(await jsonBody(c));
    const row = await svc.updateLead(db, events, c.get('tenantId'), actorOf(c), c.req.param('id'), patch);
    return c.json({ data: present(row) });
  });
  app.delete('/leads/:id', async (c) => {
    await svc.deleteEntity(db, c.get('tenantId'), actorOf(c), svc.ENTITY_DEFS.lead, c.req.param('id'));
    return c.json({ data: { deleted: true } });
  });
  app.post('/leads/:id/stage', async (c) => {
    const { stage } = leadStageChange.parse(await jsonBody(c));
    const row = await svc.changeLeadStage(db, events, c.get('tenantId'), actorOf(c), c.req.param('id'), stage);
    return c.json({ data: present(row) });
  });
  app.get('/leads/:id/timeline', async (c) => {
    const tenantId = c.get('tenantId');
    await svc.mustGetEntity(db, tenantId, svc.ENTITY_DEFS.lead, c.req.param('id'));
    const page = parsePagination(c.req.query());
    const rows = await svc.listTimeline(db, tenantId, 'crm.lead', c.req.param('id'), page);
    return c.json({ data: rows, limit: page.limit, offset: page.offset });
  });

  /* ---------------- deals ---------------- */

  app.post('/deals', async (c) => {
    const input = dealCreate.parse(await jsonBody(c));
    const row = await svc.createDeal(db, events, c.get('tenantId'), actorOf(c), input);
    return c.json({ data: present(row) }, 201);
  });
  app.get('/deals', async (c) => {
    const params = listParams(c, svc.ENTITY_DEFS.deal);
    const rows = await svc.listEntities(db, c.get('tenantId'), svc.ENTITY_DEFS.deal, params);
    return c.json({
      data: (rows as { custom_fields?: string | null }[]).map(present),
      limit: params.page.limit,
      offset: params.page.offset,
    });
  });
  app.get('/deals/:id', async (c) => {
    const row = await svc.mustGetEntity(db, c.get('tenantId'), svc.ENTITY_DEFS.deal, c.req.param('id'));
    return c.json({ data: present(row as { custom_fields?: string | null }) });
  });
  app.patch('/deals/:id', async (c) => {
    const patch = dealUpdate.parse(await jsonBody(c));
    const row = await svc.updateDeal(db, events, c.get('tenantId'), actorOf(c), c.req.param('id'), patch);
    return c.json({ data: present(row) });
  });
  app.delete('/deals/:id', async (c) => {
    await svc.deleteEntity(db, c.get('tenantId'), actorOf(c), svc.ENTITY_DEFS.deal, c.req.param('id'));
    return c.json({ data: { deleted: true } });
  });

  /* ---------------- jobs ---------------- */

  app.post('/jobs', async (c) => {
    const input = jobCreate.parse(await jsonBody(c));
    const row = await svc.createJob(db, events, c.get('tenantId'), actorOf(c), input);
    return c.json({ data: present(row) }, 201);
  });
  app.get('/jobs', async (c) => {
    const params = listParams(c, svc.ENTITY_DEFS.job);
    const rows = await svc.listEntities(db, c.get('tenantId'), svc.ENTITY_DEFS.job, params);
    return c.json({
      data: (rows as { custom_fields?: string | null }[]).map(present),
      limit: params.page.limit,
      offset: params.page.offset,
    });
  });
  app.get('/jobs/:id', async (c) => {
    const row = await svc.mustGetEntity(db, c.get('tenantId'), svc.ENTITY_DEFS.job, c.req.param('id'));
    return c.json({ data: present(row as { custom_fields?: string | null }) });
  });
  app.patch('/jobs/:id', async (c) => {
    const patch = jobUpdate.parse(await jsonBody(c));
    const row = await svc.updateJob(db, c.get('tenantId'), actorOf(c), c.req.param('id'), patch);
    return c.json({ data: present(row) });
  });
  app.delete('/jobs/:id', async (c) => {
    await svc.deleteEntity(db, c.get('tenantId'), actorOf(c), svc.ENTITY_DEFS.job, c.req.param('id'));
    return c.json({ data: { deleted: true } });
  });

  /* ---------------- notes ---------------- */

  app.post('/notes', async (c) => {
    const input = noteCreate.parse(await jsonBody(c));
    const row = await svc.createNote(db, c.get('tenantId'), actorOf(c), input);
    return c.json({ data: row }, 201);
  });
  app.get('/notes', async (c) => {
    const query = c.req.query();
    const page = parsePagination(query);
    const sort = parseSort(query, ['created_at', 'updated_at'], {
      column: 'created_at',
      direction: 'desc',
    });
    const filters = parseFilters(query, ['entity_type', 'entity_id', 'author_user_id']);
    const rows = await svc.listNotes(db, c.get('tenantId'), { page, sort, filters, q: query.q });
    return c.json({ data: rows, limit: page.limit, offset: page.offset });
  });
  app.get('/notes/:id', async (c) => {
    const row = await svc.getNote(db, c.get('tenantId'), c.req.param('id'));
    if (!row) throw ApiError.notFound(`crm.note not found: ${c.req.param('id')}`);
    return c.json({ data: row });
  });
  app.patch('/notes/:id', async (c) => {
    const patch = noteUpdate.parse(await jsonBody(c));
    const row = await svc.updateNote(db, c.get('tenantId'), actorOf(c), c.req.param('id'), patch);
    return c.json({ data: row });
  });
  app.delete('/notes/:id', async (c) => {
    await svc.deleteNote(db, c.get('tenantId'), actorOf(c), c.req.param('id'));
    return c.json({ data: { deleted: true } });
  });

  /* ---------------- tasks ---------------- */

  app.post('/tasks', async (c) => {
    const input = taskCreate.parse(await jsonBody(c));
    const row = await svc.createTask(db, c.get('tenantId'), actorOf(c), input);
    return c.json({ data: row }, 201);
  });
  app.get('/tasks', async (c) => {
    const query = c.req.query();
    const page = parsePagination(query);
    const sort = parseSort(query, ['title', 'status', 'due_at', 'created_at', 'updated_at'], {
      column: 'created_at',
      direction: 'desc',
    });
    const filters = parseFilters(query, ['status', 'assignee_user_id', 'entity_type', 'entity_id']);
    const rows = await svc.listTasks(db, c.get('tenantId'), { page, sort, filters, q: query.q });
    return c.json({ data: rows, limit: page.limit, offset: page.offset });
  });
  app.get('/tasks/:id', async (c) => {
    const row = await svc.getTask(db, c.get('tenantId'), c.req.param('id'));
    if (!row) throw ApiError.notFound(`crm.task not found: ${c.req.param('id')}`);
    return c.json({ data: row });
  });
  app.patch('/tasks/:id', async (c) => {
    const patch = taskUpdate.parse(await jsonBody(c));
    const row = await svc.updateTask(db, c.get('tenantId'), actorOf(c), c.req.param('id'), patch);
    return c.json({ data: row });
  });
  app.post('/tasks/:id/complete', async (c) => {
    const row = await svc.completeTask(db, events, c.get('tenantId'), actorOf(c), c.req.param('id'));
    return c.json({ data: row });
  });
  app.delete('/tasks/:id', async (c) => {
    await svc.deleteTask(db, c.get('tenantId'), actorOf(c), c.req.param('id'));
    return c.json({ data: { deleted: true } });
  });

  /* ---------------- tags + taggables ---------------- */

  app.post('/tags', async (c) => {
    const input = tagCreate.parse(await jsonBody(c));
    const row = await svc.createTag(db, c.get('tenantId'), actorOf(c), input);
    return c.json({ data: row }, 201);
  });
  app.get('/tags', async (c) => {
    const query = c.req.query();
    const page = parsePagination(query);
    const sort = parseSort(query, ['name', 'created_at'], { column: 'name', direction: 'asc' });
    const rows = await svc.listTags(db, c.get('tenantId'), { page, sort, q: query.q });
    return c.json({ data: rows, limit: page.limit, offset: page.offset });
  });
  app.get('/tags/:id', async (c) => {
    const row = await svc.getTag(db, c.get('tenantId'), c.req.param('id'));
    if (!row) throw ApiError.notFound(`crm.tag not found: ${c.req.param('id')}`);
    return c.json({ data: row });
  });
  app.patch('/tags/:id', async (c) => {
    const patch = tagUpdate.parse(await jsonBody(c));
    const row = await svc.updateTag(db, c.get('tenantId'), actorOf(c), c.req.param('id'), patch);
    return c.json({ data: row });
  });
  app.delete('/tags/:id', async (c) => {
    await svc.deleteTag(db, c.get('tenantId'), actorOf(c), c.req.param('id'));
    return c.json({ data: { deleted: true } });
  });
  app.post('/tags/:id/attach', async (c) => {
    const input = tagAttach.parse(await jsonBody(c));
    const row = await svc.attachTag(
      db,
      c.get('tenantId'),
      actorOf(c),
      c.req.param('id'),
      input.entity_type,
      input.entity_id,
    );
    return c.json({ data: row }, 201);
  });
  app.post('/tags/:id/detach', async (c) => {
    const input = tagAttach.parse(await jsonBody(c));
    await svc.detachTag(
      db,
      c.get('tenantId'),
      actorOf(c),
      c.req.param('id'),
      input.entity_type,
      input.entity_id,
    );
    return c.json({ data: { detached: true } });
  });
  app.get('/taggings', async (c) => {
    const query = c.req.query();
    const entityType = query.entity_type;
    const entityId = query.entity_id;
    if (!entityType || !entityId) {
      throw ApiError.badRequest('entity_type and entity_id query params are required');
    }
    const rows = await svc.listEntityTags(db, c.get('tenantId'), entityType, entityId);
    return c.json({ data: rows });
  });

  /* ---------------- attachment references ---------------- */

  app.post('/attachments', async (c) => {
    const input = attachmentCreate.parse(await jsonBody(c));
    const row = await svc.createAttachment(db, c.get('tenantId'), actorOf(c), input);
    return c.json({ data: row }, 201);
  });
  app.get('/attachments', async (c) => {
    const query = c.req.query();
    const page = parsePagination(query);
    const sort = parseSort(query, ['filename', 'created_at'], {
      column: 'created_at',
      direction: 'desc',
    });
    const filters = parseFilters(query, ['entity_type', 'entity_id']);
    const rows = await svc.listAttachments(db, c.get('tenantId'), { page, sort, filters, q: query.q });
    return c.json({ data: rows, limit: page.limit, offset: page.offset });
  });
  app.get('/attachments/:id', async (c) => {
    const row = await svc.getAttachment(db, c.get('tenantId'), c.req.param('id'));
    if (!row) throw ApiError.notFound(`crm.attachment not found: ${c.req.param('id')}`);
    return c.json({ data: row });
  });
  app.patch('/attachments/:id', async (c) => {
    const patch = attachmentUpdate.parse(await jsonBody(c));
    const row = await svc.updateAttachment(db, c.get('tenantId'), actorOf(c), c.req.param('id'), patch);
    return c.json({ data: row });
  });
  app.delete('/attachments/:id', async (c) => {
    await svc.deleteAttachment(db, c.get('tenantId'), actorOf(c), c.req.param('id'));
    return c.json({ data: { deleted: true } });
  });

  /* ---------------- source attributions ---------------- */

  app.post('/source-attributions', async (c) => {
    const input = attributionCreate.parse(await jsonBody(c));
    const row = await svc.createSourceAttribution(db, c.get('tenantId'), actorOf(c), input);
    return c.json({ data: row }, 201);
  });
  app.get('/source-attributions', async (c) => {
    const query = c.req.query();
    const page = parsePagination(query);
    const sort = parseSort(query, ['source', 'created_at'], {
      column: 'created_at',
      direction: 'desc',
    });
    const filters = parseFilters(query, ['entity_type', 'entity_id', 'source']);
    const rows = await svc.listSourceAttributions(db, c.get('tenantId'), { page, sort, filters, q: query.q });
    return c.json({ data: rows, limit: page.limit, offset: page.offset });
  });
  app.get('/source-attributions/:id', async (c) => {
    const row = await svc.getSourceAttribution(db, c.get('tenantId'), c.req.param('id'));
    if (!row) throw ApiError.notFound(`crm.source_attribution not found: ${c.req.param('id')}`);
    return c.json({ data: row });
  });
  app.patch('/source-attributions/:id', async (c) => {
    const patch = attributionUpdate.parse(await jsonBody(c));
    const row = await svc.updateSourceAttribution(db, c.get('tenantId'), actorOf(c), c.req.param('id'), patch);
    return c.json({ data: row });
  });
  app.delete('/source-attributions/:id', async (c) => {
    await svc.deleteSourceAttribution(db, c.get('tenantId'), actorOf(c), c.req.param('id'));
    return c.json({ data: { deleted: true } });
  });

  /* ---------------- timeline (generic) ---------------- */

  app.get('/timeline', async (c) => {
    const query = c.req.query();
    const entityType = query.entity_type;
    const entityId = query.entity_id;
    if (!entityType || !entityId) {
      throw ApiError.badRequest('entity_type and entity_id query params are required');
    }
    if (!svc.isCrmEntityType(entityType)) {
      throw ApiError.badRequest(`unknown entity_type "${entityType}"`, { allowed: CRM_ENTITY_TYPES });
    }
    const page = parsePagination(query);
    const rows = await svc.listTimeline(db, c.get('tenantId'), entityType, entityId, page);
    return c.json({ data: rows, limit: page.limit, offset: page.offset });
  });

  /* ---------------- custom field definitions (core-backed) ---------------- */

  app.get('/custom-fields', async (c) => {
    const entityType = c.req.query('entity_type');
    if (entityType !== undefined && !svc.isCrmEntityType(entityType)) {
      throw ApiError.badRequest(`unknown entity_type "${entityType}"`, { allowed: CRM_ENTITY_TYPES });
    }
    const rows = await listCustomFields(asCoreDb(db), c.get('tenantId'), entityType);
    const crmRows = rows.filter((r) => r.entity_type.startsWith('crm.'));
    return c.json({ data: crmRows });
  });
  app.post('/custom-fields', async (c) => {
    const input = customFieldCreate.parse(await jsonBody(c));
    const tenantId = c.get('tenantId');
    const row = await defineCustomField(asCoreDb(db), tenantId, {
      entityType: input.entity_type,
      key: input.key,
      label: input.label,
      kind: input.kind,
    });
    await audit(asCoreDb(db), tenantId, actorOf(c), 'crm.custom_field.defined', 'crm.custom_field', row.id, {
      after: input,
    });
    return c.json({ data: row }, 201);
  });
  app.delete('/custom-fields/:id', async (c) => {
    const tenantId = c.get('tenantId');
    const fieldId = c.req.param('id');
    // Scope guard: the CRM router may only delete crm.* definitions —
    // other modules own their own entity types (definitions are shared in core).
    const defs = await listCustomFields(asCoreDb(db), tenantId);
    const def = defs.find((d) => d.id === fieldId);
    if (!def || !def.entity_type.startsWith('crm.')) {
      throw ApiError.notFound(`custom field not found: ${fieldId}`);
    }
    await deleteCustomField(asCoreDb(db), tenantId, fieldId);
    await audit(asCoreDb(db), tenantId, actorOf(c), 'crm.custom_field.deleted', 'crm.custom_field', fieldId, {
      before: def,
    });
    return c.json({ data: { deleted: true } });
  });

  return app;
}

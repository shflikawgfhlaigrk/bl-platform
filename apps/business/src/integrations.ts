import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ApiError, EventBus, audit, asCoreDb, id, nowIso, type PlatformEvent } from '@blacklabel/core';
import { createCustomer, updateCustomer, getEntity, ENTITY_DEFS, type CrmDatabase } from '@blacklabel/crm';
import type { Kysely, Migration } from '@blacklabel/db';

/** This adapter consumes an export; it never logs in to or writes to the source system. */
export const customerImportSchema = z.object({
  source: z.string().trim().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/),
  records: z.array(z.object({ externalId: z.string().trim().min(1).max(200), localId: z.string().min(1).max(200).optional(),
    resolution: z.enum(['keep-local','use-source']).optional(), name: z.string().trim().min(1).max(200), email: z.string().email().max(320).nullable().optional(),
    phone: z.string().max(100).nullable().optional(), address: z.string().max(2000).nullable().optional() }).strict()).min(1).max(500),
}).strict();
type Import = z.infer<typeof customerImportSchema>;
type Customer = { name: string; email: string | null; phone: string | null; address: string | null };
interface Link { id: string; tenant_id: string; source: string; external_id: string; customer_id: string; local_hash: string; source_hash: string | null; created_at: string; updated_at: string }
interface Receipt { id: string; tenant_id: string; source: string; idempotency_key: string; request_hash: string; result_json: string; created_at: string }
interface IntegrationDb extends CrmDatabase { business_customer_links: Link; business_import_receipts: Receipt }
const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().filter(key=>value[key]!==undefined).map(key=>[key,canonical(value[key])])) : value;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const customer = (row: any): Customer => ({ name: row.name, email: row.email ?? null, phone: row.phone ?? null, address: row.address ?? null });
export const businessIntegrationMigrations: Migration[] = [{ name: 'business.0001_customer_import_receipts', up: async db => {
  await db.schema.createTable('business_customer_links').addColumn('id','text',c=>c.primaryKey())
    .addColumn('tenant_id','text',c=>c.notNull()).addColumn('source','text',c=>c.notNull()).addColumn('external_id','text',c=>c.notNull())
    .addColumn('customer_id','text',c=>c.notNull()).addColumn('local_hash','text',c=>c.notNull())
    .addColumn('created_at','text',c=>c.notNull()).addColumn('updated_at','text',c=>c.notNull()).execute();
  await db.schema.createIndex('business_customer_links_identity').on('business_customer_links').columns(['tenant_id','source','external_id']).unique().execute();
  await db.schema.createTable('business_import_receipts').addColumn('id','text',c=>c.primaryKey())
    .addColumn('tenant_id','text',c=>c.notNull()).addColumn('source','text',c=>c.notNull()).addColumn('idempotency_key','text',c=>c.notNull())
    .addColumn('request_hash','text',c=>c.notNull()).addColumn('result_json','text',c=>c.notNull()).addColumn('created_at','text',c=>c.notNull()).execute();
  await db.schema.createIndex('business_import_receipts_identity').on('business_import_receipts').columns(['tenant_id','idempotency_key']).unique().execute();
} }, { name:'business.0002_customer_source_baseline',up:async db=>{
  await db.schema.alterTable('business_customer_links').addColumn('source_hash','text').execute();
} }];

async function plan(db: Kysely<IntegrationDb>, tenantId: string, input: Import) {
  if (new Set(input.records.map(row=>row.externalId)).size !== input.records.length) throw ApiError.badRequest('Each source record needs a unique externalId.');
  const seen = new Set<string>();
  const rows = [];
  for (const record of input.records) {
    const link = await db.selectFrom('business_customer_links').selectAll().where('tenant_id','=',tenantId)
      .where('source','=',input.source).where('external_id','=',record.externalId).executeTakeFirst();
    if (link && record.localId && link.customer_id !== record.localId) throw ApiError.conflict('This source record is already linked to another customer.');
    const localId = link?.customer_id ?? record.localId;
    if (localId && seen.has(localId)) throw ApiError.conflict('Two source records cannot update the same customer in one import.');
    if (localId) seen.add(localId);
    const local = localId ? await getEntity(db as unknown as Kysely<CrmDatabase>,tenantId,ENTITY_DEFS.customer,localId) : undefined;
    if (localId && !local) throw ApiError.notFound('A linked customer is missing from this company.');
    const before = local ? customer(local) : null;
    let after = { ...(before ?? { email:null,phone:null,address:null }), name:record.name,
      ...(record.email === undefined ? {} : { email:record.email }), ...(record.phone === undefined ? {} : { phone:record.phone }),
      ...(record.address === undefined ? {} : { address:record.address }) } as Customer;
    const {localId:_local,resolution:_resolution,...sourceRecord}=record;
    const sourceHash=hash(sourceRecord),sourceUnchanged=!!link?.source_hash&&sourceHash===link.source_hash;
    if(before&&(record.resolution==='keep-local'||sourceUnchanged&&record.resolution!=='use-source'))after=before;
    let conflict: string | null = link && hash(before) !== link.local_hash && !sourceUnchanged && !record.resolution ? 'Customer and source changed. Review both versions, then choose keep-local or use-source.' : null;
    if (!localId && record.email) {
      const matches = await db.selectFrom('crm_customers').select('id').where('tenant_id','=',tenantId).where('email','=',record.email).limit(2).execute();
      if (matches.length) conflict = 'This email already exists. Provide its localId after checking the customer; automatic merging is disabled.';
    }
    rows.push({ externalId:record.externalId, sourceHash, resolution:record.resolution??null, localId:localId??null, before, after,
      action:conflict?'conflict':before?hash(before)===hash(after)?'unchanged':'update':'create', conflict });
  }
  return { adapter:'customer-records-json-v1', source:input.source, direction:'import-only', sourceWrites:false,
    rows, previewHash:hash({ input,rows }), canApply:rows.every(row=>!row.conflict), limit:500 };
}

export function customerRecordIntegration(database: Kysely<any>, events: EventBus, tenantId: string, actor: string) {
  const db = database as Kysely<IntegrationDb>;
  return {
    preview: (raw:unknown) => plan(db,tenantId,customerImportSchema.parse(raw)),
    receipts: () => db.selectFrom('business_import_receipts').select(['id','source','created_at','result_json'])
      .where('tenant_id','=',tenantId).orderBy('created_at','desc').orderBy('id').limit(100).execute()
      .then(rows=>rows.map(({result_json,...row})=>({...row,result:JSON.parse(result_json)}))),
    apply: async (raw:unknown) => {
      const {previewHash,idempotencyKey,...value} = z.object({ ...customerImportSchema.shape,
        previewHash:z.string().regex(/^[a-f0-9]{64}$/),idempotencyKey:z.string().min(8).max(200) }).strict().parse(raw);
      const input = customerImportSchema.parse(value), requestHash = hash(input);
      const pending:PlatformEvent[] = [];
      const result = await db.transaction().execute(async tx => {
        const saved = await tx.selectFrom('business_import_receipts').selectAll().where('tenant_id','=',tenantId)
          .where('idempotency_key','=',idempotencyKey).executeTakeFirst();
        if (saved) {
          if (saved.request_hash !== requestHash) throw ApiError.conflict('This import key was already used for different records.');
          return { ...JSON.parse(saved.result_json), replayed:true };
        }
        const preview = await plan(tx,tenantId,input);
        if (preview.previewHash !== previewHash) throw ApiError.conflict('Records changed after preview. Preview again before importing.');
        if (!preview.canApply) throw ApiError.conflict('Resolve the preview conflicts before importing.');
        const deferred = new EventBus(); deferred.on('*',event=>{ pending.push(event); });
        const imported = [];
        for (const row of preview.rows) {
          const local = row.localId ? row.action === 'update' ? await updateCustomer(tx as unknown as Kysely<CrmDatabase>,tenantId,actor,row.localId,row.after)
            : await getEntity(tx as unknown as Kysely<CrmDatabase>,tenantId,ENTITY_DEFS.customer,row.localId) : await createCustomer(tx as unknown as Kysely<CrmDatabase>,deferred,tenantId,actor,row.after);
          if (!local || hash(customer(local)) !== hash(row.after)) throw ApiError.conflict('Imported customer readback did not match.');
          const now=nowIso(), existing=await tx.selectFrom('business_customer_links').select('id').where('tenant_id','=',tenantId)
            .where('source','=',input.source).where('external_id','=',row.externalId).executeTakeFirst();
          if (existing) await tx.updateTable('business_customer_links').set({local_hash:hash(row.after),source_hash:row.sourceHash,updated_at:now})
            .where('tenant_id','=',tenantId).where('id','=',existing.id).execute();
          else await tx.insertInto('business_customer_links').values({id:id(),tenant_id:tenantId,source:input.source,external_id:row.externalId,
            customer_id:String(local.id),local_hash:hash(row.after),source_hash:row.sourceHash,created_at:now,updated_at:now}).execute();
          imported.push({externalId:row.externalId,customerId:local.id,action:row.action});
        }
        const receipt={id:id(),adapter:'customer-records-json-v1',source:input.source,sourceWrites:false,imported,createdAt:nowIso(),replayed:false,
          followUpEvents:'pending'};
        await tx.insertInto('business_import_receipts').values({id:receipt.id,tenant_id:tenantId,source:input.source,idempotency_key:idempotencyKey,
          request_hash:requestHash,result_json:JSON.stringify(receipt),created_at:receipt.createdAt}).execute();
        await audit(asCoreDb(tx),tenantId,actor,'business.import.applied','business.import',receipt.id,{source:input.source,count:imported.length});
        return receipt;
      });
      const eventDeliveryNeedsReview = [];
      for (const event of pending) if ((await events.emit(event.tenantId,event.type,event.payload)).errors.length) eventDeliveryNeedsReview.push(event.type);
      if(result.replayed)return result;
      const completed={...result,followUpEvents:eventDeliveryNeedsReview.length?'needs_review':'processed',
        ...(eventDeliveryNeedsReview.length?{eventDeliveryNeedsReview}:{})};
      await db.updateTable('business_import_receipts').set({result_json:JSON.stringify(completed)})
        .where('tenant_id','=',tenantId).where('id','=',result.id).execute();
      return completed;
    },
  };
}

import { asCoreDb, audit, id, nowIso } from '@blacklabel/core';
import type { Kysely } from '@blacklabel/db';
import type { IndustriesDatabase } from './schema';
import type { IndustryConfig } from './config';

export type IndustryRuntimeStatus = 'installed' | 'preserved' | 'needs_configuration' | 'unsupported' | 'missing' | 'failed' | 'installing';
export interface IndustryRuntimeReceipt {
  key: string; targetType: string; targetId: string | null; href: string;
  status: IndustryRuntimeStatus; detail: string; snapshot: unknown; checkedAt: string;
}
export interface IndustryRuntimeReport { available: boolean; checkedAt: string | null; items: IndustryRuntimeReceipt[] }
/** Composed by apps/api; modules never import each other's services. */
export type IndustryRuntimeInstaller = (input: { tenantId: string; actor: string; config: IndustryConfig; previousIndustryKey?: string }) => Promise<void>;

export async function getIndustryRuntimeReceipt(db: Kysely<IndustriesDatabase>, tenantId: string, industryKey: string, key: string): Promise<IndustryRuntimeReceipt | undefined> {
  const row=await db.selectFrom('industries_runtime_receipts').selectAll()
    .where('tenant_id','=',tenantId).where('industry_key','=',industryKey).where('component_key','=',key).executeTakeFirst();
  return row ? {key:row.component_key,targetType:row.target_type,targetId:row.target_id,href:row.href,status:row.status as IndustryRuntimeStatus,detail:row.detail,snapshot:row.snapshot_json?JSON.parse(row.snapshot_json):null,checkedAt:row.updated_at} : undefined;
}

export async function saveIndustryRuntimeReceipt(db: Kysely<IndustriesDatabase>, tenantId: string, industryKey: string, actor: string, receipt: Omit<IndustryRuntimeReceipt,'checkedAt'>): Promise<void> {
  const existing=await db.selectFrom('industries_runtime_receipts').select('id')
    .where('tenant_id','=',tenantId).where('industry_key','=',industryKey).where('component_key','=',receipt.key).executeTakeFirst();
  const updatedAt=nowIso();
  const values={target_type:receipt.targetType,target_id:receipt.targetId,href:receipt.href,status:receipt.status,detail:receipt.detail,snapshot_json:JSON.stringify(receipt.snapshot),updated_at:updatedAt};
  const receiptId=existing?.id??id();
  if(existing)await db.updateTable('industries_runtime_receipts').set(values).where('tenant_id','=',tenantId).where('id','=',existing.id).execute();
  else await db.insertInto('industries_runtime_receipts').values({id:receiptId,tenant_id:tenantId,industry_key:industryKey,component_key:receipt.key,...values,created_at:updatedAt}).execute();
  // Detached definitions are never described as runnable workflows.
  if(receipt.targetType==='workflows.workflow')await db.updateTable('industries_workflow_definitions')
    .set({enabled:['installed','preserved'].includes(receipt.status)?1:0})
    .where('tenant_id','=',tenantId).where('key','=',receipt.key.replace(/^workflow:/,'')).execute();
  await audit(asCoreDb(db),tenantId,actor,'industries.runtime.checked','industries.runtime',receiptId,{industryKey,componentKey:receipt.key,status:receipt.status,targetId:receipt.targetId});
}

export async function industryRuntimeReport(db: Kysely<IndustriesDatabase>, tenantId: string, industryKey: string): Promise<IndustryRuntimeReport> {
  const rows=await db.selectFrom('industries_runtime_receipts').selectAll().where('tenant_id','=',tenantId)
    .where('industry_key','=',industryKey).orderBy('component_key').orderBy('id').execute();
  return {available:rows.length>0,checkedAt:rows.length?rows.map(row=>row.updated_at).sort()[0]:null,
    items:rows.map(row=>({key:row.component_key,targetType:row.target_type,targetId:row.target_id,href:row.href,status:row.status as IndustryRuntimeStatus,detail:row.detail,snapshot:row.snapshot_json?JSON.parse(row.snapshot_json):null,checkedAt:row.updated_at}))};
}

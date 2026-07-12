/**
 * Industry-neutral demo data for one tenant. Goes through the service layer
 * so audit entries, timeline events, and domain events all fire like real
 * traffic would.
 */
import type { Kysely } from 'kysely';
import { EventBus } from '@blacklabel/core';
import type { CrmDatabase } from './schema';
import {
  attachTag,
  changeLeadStage,
  completeTask,
  createAttachment,
  createCompany,
  createContact,
  createCustomer,
  createDeal,
  createJob,
  createLead,
  createNote,
  createSourceAttribution,
  createTag,
  createTask,
  DEFAULT_LEAD_STAGES,
  setLeadStages,
} from './service';

export interface CrmSeedSummary {
  companies: number;
  customers: number;
  contacts: number;
  leads: number;
  deals: number;
  jobs: number;
  notes: number;
  tasks: number;
  tags: number;
}

const ACTOR = 'system';

/**
 * Seed realistic, industry-neutral CRM sample data for a tenant.
 * The tenant must already exist (core `createTenant`).
 */
export async function seedCrm(
  db: Kysely<CrmDatabase>,
  tenantId: string,
  events: EventBus = new EventBus(),
): Promise<CrmSeedSummary> {
  // Materialize the default stage list so it is visible/editable per tenant.
  await setLeadStages(
    db,
    tenantId,
    ACTOR,
    DEFAULT_LEAD_STAGES.map((key) => ({ key, label: key.charAt(0).toUpperCase() + key.slice(1) })),
  );

  const northside = await createCompany(db, events, tenantId, ACTOR, {
    name: 'Northside Property Group',
    domain: 'northsidepg.example',
    email: 'office@northsidepg.example',
    phone: '+1-555-0101',
    address: '410 Commerce Way, Springfield',
  });
  const harbor = await createCompany(db, events, tenantId, ACTOR, {
    name: 'Harbor & Main LLC',
    domain: 'harbormain.example',
    email: 'hello@harbormain.example',
    phone: '+1-555-0102',
  });

  const avery = await createCustomer(db, events, tenantId, ACTOR, {
    name: 'Avery Collins',
    email: 'avery.collins@example.com',
    phone: '+1-555-0201',
    address: '12 Elm Street, Springfield',
    company_id: northside.id,
  });
  const jordan = await createCustomer(db, events, tenantId, ACTOR, {
    name: 'Jordan Blake',
    email: 'jordan.blake@example.com',
    phone: '+1-555-0202',
    address: '88 Lakeview Drive, Springfield',
  });
  const riverbend = await createCustomer(db, events, tenantId, ACTOR, {
    name: 'Riverbend Facilities',
    email: 'ops@riverbend.example',
    phone: '+1-555-0203',
    company_id: harbor.id,
    status: 'active',
  });

  await createContact(db, events, tenantId, ACTOR, {
    first_name: 'Avery',
    last_name: 'Collins',
    email: 'avery.collins@example.com',
    phone: '+1-555-0201',
    title: 'Owner',
    customer_id: avery.id,
    company_id: northside.id,
  });
  await createContact(db, events, tenantId, ACTOR, {
    first_name: 'Sam',
    last_name: 'Reyes',
    email: 'sam.reyes@riverbend.example',
    title: 'Operations Manager',
    customer_id: riverbend.id,
    company_id: harbor.id,
  });
  await createContact(db, events, tenantId, ACTOR, {
    first_name: 'Dana',
    last_name: 'Whitfield',
    email: 'dana.w@harbormain.example',
    title: 'Office Manager',
    company_id: harbor.id,
  });

  const leadWebsite = await createLead(db, events, tenantId, ACTOR, {
    name: 'Morgan Ellis',
    email: 'morgan.ellis@example.com',
    phone: '+1-555-0301',
    source: 'website',
    value_cents: 45_000,
  });
  const leadReferral = await createLead(db, events, tenantId, ACTOR, {
    name: 'Priya Nair',
    email: 'priya.nair@example.com',
    source: 'referral',
    value_cents: 120_000,
    customer_id: avery.id,
  });
  const leadAds = await createLead(db, events, tenantId, ACTOR, {
    name: 'Casey Donovan',
    phone: '+1-555-0303',
    source: 'search_ads',
    value_cents: 30_000,
  });
  const leadWon = await createLead(db, events, tenantId, ACTOR, {
    name: 'Riverbend Facilities — annual service',
    email: 'ops@riverbend.example',
    source: 'repeat',
    value_cents: 480_000,
    customer_id: riverbend.id,
  });

  // Walk leads through the pipeline (generates stage_changed timeline + events).
  await changeLeadStage(db, events, tenantId, ACTOR, leadReferral.id, 'contacted');
  await changeLeadStage(db, events, tenantId, ACTOR, leadReferral.id, 'qualified');
  await changeLeadStage(db, events, tenantId, ACTOR, leadAds.id, 'contacted');
  await changeLeadStage(db, events, tenantId, ACTOR, leadWon.id, 'contacted');
  await changeLeadStage(db, events, tenantId, ACTOR, leadWon.id, 'qualified');
  await changeLeadStage(db, events, tenantId, ACTOR, leadWon.id, 'quoted');
  await changeLeadStage(db, events, tenantId, ACTOR, leadWon.id, 'won');

  const dealOpen = await createDeal(db, events, tenantId, ACTOR, {
    title: 'Quarterly service plan — Collins residence',
    value_cents: 89_900,
    customer_id: avery.id,
    lead_id: leadReferral.id,
  });
  await createDeal(db, events, tenantId, ACTOR, {
    title: 'Annual service contract — Riverbend',
    status: 'won',
    value_cents: 480_000,
    customer_id: riverbend.id,
    lead_id: leadWon.id,
    company_id: harbor.id,
  });

  await createJob(db, events, tenantId, ACTOR, {
    title: 'Initial site visit',
    description: 'Walkthrough and estimate for quarterly plan.',
    status: 'completed',
    customer_id: avery.id,
    deal_id: dealOpen.id,
  });
  await createJob(db, events, tenantId, ACTOR, {
    title: 'First scheduled service — Riverbend',
    status: 'planned',
    customer_id: riverbend.id,
  });

  await createNote(db, tenantId, ACTOR, {
    entity_type: 'crm.customer',
    entity_id: avery.id,
    body: 'Prefers morning appointments; gate code 4412.',
  });
  await createNote(db, tenantId, ACTOR, {
    entity_type: 'crm.lead',
    entity_id: leadWebsite.id,
    body: 'Filled the website form twice — follow up by phone.',
  });

  const followUp = await createTask(db, tenantId, ACTOR, {
    title: 'Call Morgan Ellis back',
    description: 'Website lead, asked for a quote.',
    entity_type: 'crm.lead',
    entity_id: leadWebsite.id,
  });
  await createTask(db, tenantId, ACTOR, {
    title: 'Send onboarding packet to Riverbend',
    entity_type: 'crm.customer',
    entity_id: riverbend.id,
  });
  await completeTask(db, events, tenantId, ACTOR, followUp.id);

  const vip = await createTag(db, tenantId, ACTOR, { name: 'vip', color: '#d4af37' });
  const followUpTag = await createTag(db, tenantId, ACTOR, { name: 'follow-up', color: '#3b82f6' });
  await attachTag(db, tenantId, ACTOR, vip.id, 'crm.customer', riverbend.id);
  await attachTag(db, tenantId, ACTOR, followUpTag.id, 'crm.lead', leadWebsite.id);

  await createAttachment(db, tenantId, ACTOR, {
    entity_type: 'crm.deal',
    entity_id: dealOpen.id,
    file_id: 'file_demo_estimate_001',
    filename: 'estimate-collins.pdf',
    mime_type: 'application/pdf',
    size_bytes: 48_213,
  });

  await createSourceAttribution(db, tenantId, ACTOR, {
    entity_type: 'crm.lead',
    entity_id: leadWebsite.id,
    source: 'website',
    medium: 'organic',
    campaign: null,
    detail: 'contact form',
  });
  await createSourceAttribution(db, tenantId, ACTOR, {
    entity_type: 'crm.lead',
    entity_id: leadAds.id,
    source: 'search_ads',
    medium: 'cpc',
    campaign: 'spring-promo',
  });

  return {
    companies: 2,
    customers: 3,
    contacts: 3,
    leads: 4,
    deals: 2,
    jobs: 2,
    notes: 2,
    tasks: 2,
    tags: 2,
  };
}

/** Spec-named alias: `seed(db, tenantId)`. */
export const seed = seedCrm;

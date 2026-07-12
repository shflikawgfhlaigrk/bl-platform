import type { Kysely } from 'kysely';
import { EventBus, type Contracts } from '@blacklabel/core';
import type { QuotingDatabase } from './schema';
import {
  createDiscount,
  createPricingRule,
  createServiceTemplate,
  createTax,
  type QuotingCtx,
} from './service';

export interface QuotingSeedResult {
  templates: {
    windowExterior: string;
    windowInterior: string;
    windowFullPackage: string;
    spaMassage: string;
    spaFacial: string;
    spaDayPackage: string;
  };
  pricingRules: { volumeDiscount: string; highQuantityLineRate: string };
  discounts: { newCustomer: string };
  taxes: { standard: string };
}

/**
 * Example seed data for one tenant: window-cleaning and spa service
 * templates (including bundle templates composed of templates), two pricing
 * rules, a reusable discount and a tax rate.
 *
 * This is DATA ONLY — the quoting engine itself is industry-neutral.
 */
export async function seedQuoting(
  db: Kysely<QuotingDatabase>,
  tenantId: string,
  options: { events?: EventBus; contracts?: Contracts; actor?: string } = {},
): Promise<QuotingSeedResult> {
  const ctx: QuotingCtx = {
    db,
    events: options.events ?? new EventBus(),
    contracts: options.contracts ?? {},
    tenantId,
    actor: options.actor ?? 'system',
  };

  /* -------- window cleaning -------- */

  const windowExterior = await createServiceTemplate(ctx, {
    name: 'Standard Exterior Window Cleaning',
    description: 'Exterior panes, screens and sills for a typical home.',
    lineItems: [
      { description: 'Exterior window pane', quantity: 20, unitPriceCents: 650, unitCostCents: 200 },
      { description: 'Screen cleaning', quantity: 20, unitPriceCents: 200, unitCostCents: 50 },
      { description: 'High-reach ladder work', quantity: 1, unitPriceCents: 4500, unitCostCents: 1500 },
    ],
  });

  const windowInterior = await createServiceTemplate(ctx, {
    name: 'Interior Window Add-On',
    description: 'Interior panes and tracks.',
    lineItems: [
      { description: 'Interior window pane', quantity: 20, unitPriceCents: 450, unitCostCents: 150 },
      { description: 'Track and sill detail', quantity: 20, unitPriceCents: 100, unitCostCents: 25 },
    ],
  });

  const windowFullPackage = await createServiceTemplate(ctx, {
    name: 'Full-Service Window Package',
    description: 'Bundle: exterior + interior service in one visit.',
    lineItems: [],
    childTemplateIds: [windowExterior.id, windowInterior.id],
  });

  /* -------- spa -------- */

  const spaMassage = await createServiceTemplate(ctx, {
    name: 'Signature Massage Session',
    description: '60-minute full-body massage with optional aromatherapy.',
    lineItems: [
      { description: '60-minute massage', quantity: 1, unitPriceCents: 9500, unitCostCents: 4000 },
      { description: 'Aromatherapy upgrade', quantity: 1, unitPriceCents: 1500, unitCostCents: 300 },
    ],
  });

  const spaFacial = await createServiceTemplate(ctx, {
    name: 'Classic Facial Treatment',
    lineItems: [
      { description: 'Classic facial', quantity: 1, unitPriceCents: 8000, unitCostCents: 3000 },
    ],
  });

  const spaDayPackage = await createServiceTemplate(ctx, {
    name: 'Deluxe Spa Day Package',
    description: 'Bundle: massage + facial + lounge access.',
    lineItems: [
      { description: 'Relaxation lounge access', quantity: 1, unitPriceCents: 2500, unitCostCents: 500 },
    ],
    childTemplateIds: [spaMassage.id, spaFacial.id],
  });

  /* -------- pricing rules -------- */

  const volumeDiscount = await createPricingRule(ctx, {
    name: '5% off quotes over $500',
    scope: 'quote',
    conditions: [{ field: 'subtotal_cents', op: 'gte', value: 50000 }],
    action: { type: 'percent_discount', amount: 500 },
    priority: 10,
  });

  const highQuantityLineRate = await createPricingRule(ctx, {
    name: '10% off high-quantity lines (40+ units)',
    scope: 'line',
    conditions: [{ field: 'quantity', op: 'gte', value: 40 }],
    action: { type: 'percent_adjust', amount: -1000 },
    priority: 10,
  });

  /* -------- discount & tax -------- */

  const newCustomer = await createDiscount(ctx, { name: 'New customer 10%', bps: 1000 });
  const standard = await createTax(ctx, { name: 'Standard sales tax', rateBps: 725 });

  return {
    templates: {
      windowExterior: windowExterior.id,
      windowInterior: windowInterior.id,
      windowFullPackage: windowFullPackage.id,
      spaMassage: spaMassage.id,
      spaFacial: spaFacial.id,
      spaDayPackage: spaDayPackage.id,
    },
    pricingRules: { volumeDiscount: volumeDiscount.id, highQuantityLineRate: highQuantityLineRate.id },
    discounts: { newCustomer: newCustomer.id },
    taxes: { standard: standard.id },
  };
}

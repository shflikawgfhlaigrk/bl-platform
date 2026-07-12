import type { IndustryConfig } from '../config';

/**
 * Equestrian tack retail — mobile tack shop working the horse-show circuit
 * (first real tenant: Mags Tack). Quote-template products and prices are
 * REAL top sellers pulled from the tenant's own sales ledger, not invented.
 */
export const tackRetailConfig = {
  key: 'tack-retail',
  label: 'Tack Retail',
  description: 'Equestrian tack and rider apparel retail, in-store and on the horse-show circuit.',
  terminology: {
    lead: 'Prospect',
    customer: 'Customer',
    quote: 'Quote',
    job: 'Order',
    appointment: 'Show Booking',
    invoice: 'Invoice',
    team_member: 'Staff',
  },
  leadStages: [
    { key: 'new', label: 'New Contact' },
    { key: 'contacted', label: 'Contacted' },
    { key: 'fitted', label: 'Fitted / Sized' },
    { key: 'won', label: 'Customer' },
    { key: 'lost', label: 'Lost' },
  ],
  quoteTemplates: [
    {
      key: 'show_ring_apparel',
      name: 'Show Ring Apparel Package',
      description: 'Complete show-ring outfit: coat, breeches, gloves, and belt.',
      lines: [
        { description: 'KL Adult Show Coat', quantity: 1, unitPriceCents: 19000 },
        { description: 'KL Select Gabrielle Full-Seat Breech', quantity: 1, unitPriceCents: 19900 },
        { description: 'Kunkle Black Mesh Show Gloves', quantity: 1, unitPriceCents: 4500 },
        { description: "Ellany Women's Elastic Belt", quantity: 1, unitPriceCents: 5000 },
      ],
    },
    {
      key: 'safety_and_schooling',
      name: 'Helmet + Schooling Setup',
      description: 'MIPS helmet with a close-contact schooling pad.',
      lines: [
        { description: 'One K MIPS CCS Helmet', quantity: 1, unitPriceCents: 38500 },
        { description: 'LeMieux Loire Close Contact Square Pad', quantity: 1, unitPriceCents: 10500 },
      ],
    },
  ],
  appointmentTypes: [
    { key: 'show_weekend', label: 'Horse Show Weekend (trailer on site)', durationMinutes: 480 },
    { key: 'fitting', label: 'Fitting / Sizing Session', durationMinutes: 30 },
    { key: 'special_order_pickup', label: 'Special Order Pickup', durationMinutes: 15 },
  ],
  dashboardWidgets: [
    { key: 'sales_week', title: 'Sales This Week', type: 'metric', config: { source: 'retail', metric: 'weekly_gross' } },
    { key: 'best_days', title: 'Best Days', type: 'list', config: { source: 'retail', metric: 'day_of_week_mix' } },
    { key: 'top_sellers', title: 'Top Sellers', type: 'list', config: { source: 'retail', metric: 'top_items' } },
    { key: 'email_coverage', title: 'Customers With Email', type: 'metric', config: { source: 'crm', metric: 'email_coverage' } },
  ],
  workflows: [
    {
      key: 'prospect_followup',
      name: 'Follow up with new prospects',
      trigger: 'crm.lead.created',
      actions: [
        { type: 'create_task', params: { title: 'Follow up with new prospect', dueInHours: 48 } },
      ],
    },
  ],
} satisfies IndustryConfig;

import type { IndustryConfig } from '../config';

export const lawFirmConfig = {
  key: 'law-firm',
  label: 'Law Firm',
  description: 'Legal practices managing matters, consultations, and retainers.',
  terminology: {
    lead: 'Prospect',
    customer: 'Client',
    quote: 'Engagement Proposal',
    job: 'Matter',
    appointment: 'Consultation',
    invoice: 'Invoice',
    team_member: 'Attorney',
  },
  leadStages: [
    { key: 'new', label: 'New Prospect' },
    { key: 'conflict_check', label: 'Conflict Check' },
    { key: 'consultation', label: 'Consultation Held' },
    { key: 'retained', label: 'Retained' },
    { key: 'declined', label: 'Declined' },
  ],
  quoteTemplates: [
    {
      key: 'flat_fee_retainer',
      name: 'Flat-Fee Engagement',
      description: 'Fixed-fee scope of work.',
      lines: [
        { description: 'Flat-fee engagement', quantity: 1, unitPriceCents: 250000 },
        { description: 'Filing fees (estimated)', quantity: 1, unitPriceCents: 40000 },
      ],
    },
    {
      key: 'hourly_engagement',
      name: 'Hourly Engagement',
      description: 'Hourly billing with an initial retainer.',
      lines: [
        { description: 'Attorney time (per hour)', quantity: 10, unitPriceCents: 35000 },
        { description: 'Paralegal time (per hour)', quantity: 5, unitPriceCents: 12500 },
      ],
    },
  ],
  appointmentTypes: [
    { key: 'initial_consultation', label: 'Initial Consultation', durationMinutes: 60 },
    { key: 'client_meeting', label: 'Client Meeting', durationMinutes: 45 },
    { key: 'deposition', label: 'Deposition', durationMinutes: 180 },
  ],
  dashboardWidgets: [
    { key: 'active_matters', title: 'Active Matters', type: 'metric', config: { source: 'jobs', status: 'active' } },
    { key: 'consultations_week', title: 'Consultations This Week', type: 'list', config: { source: 'appointments', range: 'week' } },
    { key: 'unbilled_work', title: 'Outstanding Invoices', type: 'metric', config: { source: 'invoices', status: 'unpaid' } },
    { key: 'prospect_pipeline', title: 'Prospect Pipeline', type: 'chart', config: { source: 'leads', groupBy: 'stage' } },
  ],
  workflows: [
    {
      key: 'conflict_check_task',
      name: 'Run conflict check on new prospects',
      trigger: 'crm.lead.created',
      actions: [
        { type: 'create_task', params: { title: 'Run conflict check', dueInHours: 24 } },
      ],
    },
    {
      key: 'engagement_signed',
      name: 'Open matter when engagement approved',
      trigger: 'quoting.quote.approved',
      actions: [
        { type: 'create_task', params: { title: 'Open matter file and send welcome letter', dueInHours: 24 } },
        { type: 'send_message', params: { channel: 'email', template: 'engagement_welcome' } },
      ],
    },
  ],
} satisfies IndustryConfig;

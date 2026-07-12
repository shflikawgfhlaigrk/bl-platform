import type { IndustryConfig } from '../config';

export const realEstateConfig = {
  key: 'real-estate',
  label: 'Real Estate',
  description: 'Real estate brokerages managing listings, showings, and transactions.',
  terminology: {
    lead: 'Lead',
    customer: 'Client',
    quote: 'Listing Proposal',
    job: 'Transaction',
    appointment: 'Showing',
    invoice: 'Commission Invoice',
    team_member: 'Agent',
  },
  leadStages: [
    { key: 'new', label: 'New Lead' },
    { key: 'qualified', label: 'Qualified' },
    { key: 'touring', label: 'Touring' },
    { key: 'under_contract', label: 'Under Contract' },
    { key: 'closed', label: 'Closed' },
    { key: 'lost', label: 'Lost' },
  ],
  quoteTemplates: [
    {
      key: 'listing_standard',
      name: 'Standard Listing Package',
      description: 'Full-service listing engagement.',
      lines: [
        { description: 'Professional photography', quantity: 1, unitPriceCents: 35000 },
        { description: 'Staging consultation', quantity: 1, unitPriceCents: 25000 },
        { description: 'Marketing package', quantity: 1, unitPriceCents: 50000 },
      ],
    },
    {
      key: 'buyer_representation',
      name: 'Buyer Representation',
      description: 'Buyer-side representation agreement.',
      lines: [
        { description: 'Buyer representation retainer', quantity: 1, unitPriceCents: 50000 },
      ],
    },
  ],
  appointmentTypes: [
    { key: 'showing', label: 'Property Showing', durationMinutes: 30 },
    { key: 'listing_presentation', label: 'Listing Presentation', durationMinutes: 60 },
    { key: 'open_house', label: 'Open House', durationMinutes: 180 },
  ],
  dashboardWidgets: [
    { key: 'showings_week', title: 'Showings This Week', type: 'list', config: { source: 'appointments', range: 'week' } },
    { key: 'pipeline_by_stage', title: 'Pipeline by Stage', type: 'chart', config: { source: 'leads', groupBy: 'stage' } },
    { key: 'commissions_mtd', title: 'Commissions (Month to Date)', type: 'metric', config: { source: 'invoices', metric: 'paid_total' } },
    { key: 'active_transactions', title: 'Active Transactions', type: 'metric', config: { source: 'jobs', status: 'active' } },
  ],
  workflows: [
    {
      key: 'speed_to_lead',
      name: 'Respond to new leads immediately',
      trigger: 'crm.lead.created',
      actions: [
        { type: 'send_message', params: { channel: 'sms', template: 'lead_instant_reply' } },
        { type: 'create_task', params: { title: 'Qualify lead and book showing', dueInHours: 4 } },
      ],
    },
    {
      key: 'showing_feedback',
      name: 'Collect feedback after showings',
      trigger: 'scheduling.appointment.completed',
      actions: [
        { type: 'send_message', params: { channel: 'email', template: 'showing_feedback' } },
      ],
    },
  ],
} satisfies IndustryConfig;

import type { IndustryConfig } from '../config';

export const windowCleaningConfig = {
  key: 'window-cleaning',
  label: 'Window Cleaning',
  description: 'Residential and commercial window cleaning services.',
  terminology: {
    lead: 'Lead',
    customer: 'Customer',
    quote: 'Quote',
    job: 'Job',
    appointment: 'Job Visit',
    invoice: 'Invoice',
    team_member: 'Technician',
  },
  leadStages: [
    { key: 'new', label: 'New Inquiry' },
    { key: 'contacted', label: 'Contacted' },
    { key: 'quoted', label: 'Quoted' },
    { key: 'won', label: 'Won' },
    { key: 'lost', label: 'Lost' },
  ],
  quoteTemplates: [
    {
      key: 'residential_standard',
      name: 'Residential Standard Clean',
      description: 'Interior + exterior windows for a standard home.',
      lines: [
        { description: 'Exterior windows (per pane)', quantity: 20, unitPriceCents: 450 },
        { description: 'Interior windows (per pane)', quantity: 20, unitPriceCents: 350 },
        { description: 'Screen cleaning (per screen)', quantity: 10, unitPriceCents: 200 },
      ],
    },
    {
      key: 'commercial_storefront',
      name: 'Commercial Storefront',
      description: 'Recurring storefront glass service.',
      lines: [
        { description: 'Storefront glass (per panel)', quantity: 12, unitPriceCents: 600 },
        { description: 'Entry door glass', quantity: 2, unitPriceCents: 500 },
      ],
    },
  ],
  appointmentTypes: [
    { key: 'estimate', label: 'On-site Estimate', durationMinutes: 30 },
    { key: 'residential_service', label: 'Residential Service', durationMinutes: 120 },
    { key: 'commercial_service', label: 'Commercial Service', durationMinutes: 240 },
  ],
  dashboardWidgets: [
    { key: 'jobs_this_week', title: 'Jobs This Week', type: 'list', config: { source: 'appointments', range: 'week' } },
    { key: 'revenue_mtd', title: 'Revenue (Month to Date)', type: 'metric', config: { source: 'invoices', metric: 'paid_total' } },
    { key: 'open_quotes', title: 'Open Quotes', type: 'metric', config: { source: 'quotes', status: 'open' } },
    { key: 'review_feed', title: 'Latest Reviews', type: 'feed', config: { source: 'reviews' } },
  ],
  workflows: [
    {
      key: 'lead_followup',
      name: 'Follow up on new leads',
      trigger: 'crm.lead.created',
      actions: [
        { type: 'create_task', params: { title: 'Call new lead', dueInHours: 24 } },
      ],
    },
    {
      key: 'review_request',
      name: 'Request a review after each job',
      trigger: 'scheduling.appointment.completed',
      actions: [
        { type: 'send_message', params: { channel: 'email', template: 'review_request' } },
      ],
    },
  ],
} satisfies IndustryConfig;

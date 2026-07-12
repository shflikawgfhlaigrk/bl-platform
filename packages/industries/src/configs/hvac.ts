import type { IndustryConfig } from '../config';

export const hvacConfig = {
  key: 'hvac',
  label: 'HVAC',
  description: 'Heating, ventilation, and air conditioning contractors.',
  terminology: {
    lead: 'Lead',
    customer: 'Customer',
    quote: 'Estimate',
    job: 'Job',
    appointment: 'Service Call',
    invoice: 'Invoice',
    team_member: 'Technician',
  },
  leadStages: [
    { key: 'new', label: 'New Lead' },
    { key: 'contacted', label: 'Contacted' },
    { key: 'estimate_sent', label: 'Estimate Sent' },
    { key: 'won', label: 'Won' },
    { key: 'lost', label: 'Lost' },
  ],
  quoteTemplates: [
    {
      key: 'seasonal_tuneup',
      name: 'Seasonal Tune-Up',
      description: 'Annual system inspection and maintenance.',
      lines: [
        { description: 'System inspection & tune-up', quantity: 1, unitPriceCents: 14900 },
        { description: 'Filter replacement', quantity: 2, unitPriceCents: 2500 },
      ],
    },
    {
      key: 'system_install',
      name: 'System Installation',
      description: 'Full HVAC system replacement.',
      lines: [
        { description: 'HVAC unit (equipment)', quantity: 1, unitPriceCents: 450000 },
        { description: 'Installation labor (per hour)', quantity: 16, unitPriceCents: 12500 },
        { description: 'Ductwork modification', quantity: 1, unitPriceCents: 80000 },
      ],
    },
  ],
  appointmentTypes: [
    { key: 'diagnostic', label: 'Diagnostic Visit', durationMinutes: 60 },
    { key: 'maintenance', label: 'Maintenance Visit', durationMinutes: 90 },
    { key: 'installation', label: 'Installation', durationMinutes: 480 },
  ],
  dashboardWidgets: [
    { key: 'calls_today', title: 'Service Calls Today', type: 'list', config: { source: 'appointments', range: 'day' } },
    { key: 'open_estimates', title: 'Open Estimates', type: 'metric', config: { source: 'quotes', status: 'open' } },
    { key: 'revenue_mtd', title: 'Revenue (Month to Date)', type: 'metric', config: { source: 'invoices', metric: 'paid_total' } },
    { key: 'unpaid_invoices', title: 'Unpaid Invoices', type: 'list', config: { source: 'invoices', status: 'unpaid' } },
  ],
  workflows: [
    {
      key: 'lead_dispatch',
      name: 'Dispatch follow-up for new leads',
      trigger: 'crm.lead.created',
      actions: [
        { type: 'create_task', params: { title: 'Schedule diagnostic visit', dueInHours: 4 } },
      ],
    },
    {
      key: 'estimate_to_schedule',
      name: 'Schedule work when estimate approved',
      trigger: 'quoting.quote.approved',
      actions: [
        { type: 'create_task', params: { title: 'Schedule approved job', dueInHours: 24 } },
        { type: 'send_message', params: { channel: 'email', template: 'estimate_approved_next_steps' } },
      ],
    },
  ],
} satisfies IndustryConfig;

import type { IndustryConfig } from '../config';

export const constructionConfig = {
  key: 'construction',
  label: 'Construction',
  description: 'General contractors and construction firms bidding and building projects.',
  terminology: {
    lead: 'Lead',
    customer: 'Client',
    quote: 'Bid',
    job: 'Project',
    appointment: 'Site Visit',
    invoice: 'Progress Invoice',
    team_member: 'Crew Member',
  },
  leadStages: [
    { key: 'new', label: 'New Lead' },
    { key: 'site_visit', label: 'Site Visit Scheduled' },
    { key: 'bid_sent', label: 'Bid Submitted' },
    { key: 'awarded', label: 'Awarded' },
    { key: 'lost', label: 'Lost' },
  ],
  quoteTemplates: [
    {
      key: 'kitchen_remodel',
      name: 'Kitchen Remodel',
      description: 'Standard kitchen remodel bid.',
      lines: [
        { description: 'Demolition & disposal', quantity: 1, unitPriceCents: 350000 },
        { description: 'Cabinetry & installation', quantity: 1, unitPriceCents: 1200000 },
        { description: 'Labor (per hour)', quantity: 120, unitPriceCents: 8500 },
      ],
    },
    {
      key: 'deck_build',
      name: 'Deck Build',
      description: 'Composite deck construction.',
      lines: [
        { description: 'Materials (per sq ft)', quantity: 300, unitPriceCents: 1800 },
        { description: 'Labor (per sq ft)', quantity: 300, unitPriceCents: 1500 },
      ],
    },
  ],
  appointmentTypes: [
    { key: 'site_visit', label: 'Site Visit', durationMinutes: 60 },
    { key: 'walkthrough', label: 'Client Walkthrough', durationMinutes: 45 },
    { key: 'inspection', label: 'Inspection', durationMinutes: 90 },
  ],
  dashboardWidgets: [
    { key: 'active_projects', title: 'Active Projects', type: 'metric', config: { source: 'jobs', status: 'active' } },
    { key: 'bid_pipeline', title: 'Bid Pipeline', type: 'chart', config: { source: 'leads', groupBy: 'stage' } },
    { key: 'progress_billing', title: 'Outstanding Progress Invoices', type: 'metric', config: { source: 'invoices', status: 'unpaid' } },
    { key: 'site_visits_week', title: 'Site Visits This Week', type: 'list', config: { source: 'appointments', range: 'week' } },
  ],
  workflows: [
    {
      key: 'lead_site_visit',
      name: 'Book a site visit for new leads',
      trigger: 'crm.lead.created',
      actions: [
        { type: 'create_task', params: { title: 'Schedule site visit', dueInHours: 48 } },
      ],
    },
    {
      key: 'bid_awarded_kickoff',
      name: 'Kick off project when bid approved',
      trigger: 'quoting.quote.approved',
      actions: [
        { type: 'create_task', params: { title: 'Schedule project kickoff', dueInHours: 72 } },
        { type: 'send_message', params: { channel: 'email', template: 'project_kickoff_welcome' } },
      ],
    },
  ],
} satisfies IndustryConfig;

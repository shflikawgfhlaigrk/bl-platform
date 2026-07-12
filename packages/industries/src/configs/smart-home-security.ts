import type { IndustryConfig } from '../config';

export const smartHomeSecurityConfig = {
  key: 'smart-home-security',
  label: 'Smart Home & Security',
  description: 'Smart home automation and security system installers.',
  terminology: {
    lead: 'Lead',
    customer: 'Customer',
    quote: 'System Proposal',
    job: 'Installation',
    appointment: 'Site Assessment',
    invoice: 'Invoice',
    team_member: 'Installer',
  },
  leadStages: [
    { key: 'new', label: 'New Lead' },
    { key: 'assessment_scheduled', label: 'Assessment Scheduled' },
    { key: 'proposal_sent', label: 'Proposal Sent' },
    { key: 'won', label: 'Won' },
    { key: 'lost', label: 'Lost' },
  ],
  quoteTemplates: [
    {
      key: 'security_starter',
      name: 'Security Starter System',
      description: 'Entry-level monitored security package.',
      lines: [
        { description: 'Control panel & hub', quantity: 1, unitPriceCents: 29900 },
        { description: 'Door/window sensors', quantity: 6, unitPriceCents: 3500 },
        { description: 'Installation labor (per hour)', quantity: 4, unitPriceCents: 9500 },
      ],
    },
    {
      key: 'whole_home_automation',
      name: 'Whole-Home Automation',
      description: 'Lighting, climate, cameras, and access control.',
      lines: [
        { description: 'Automation hub & controllers', quantity: 1, unitPriceCents: 120000 },
        { description: 'Smart cameras', quantity: 4, unitPriceCents: 22500 },
        { description: 'Installation labor (per hour)', quantity: 16, unitPriceCents: 9500 },
      ],
    },
  ],
  appointmentTypes: [
    { key: 'site_assessment', label: 'Site Assessment', durationMinutes: 60 },
    { key: 'installation', label: 'Installation', durationMinutes: 360 },
    { key: 'service_visit', label: 'Service Visit', durationMinutes: 90 },
  ],
  dashboardWidgets: [
    { key: 'installs_week', title: 'Installations This Week', type: 'list', config: { source: 'appointments', range: 'week' } },
    { key: 'open_proposals', title: 'Open Proposals', type: 'metric', config: { source: 'quotes', status: 'open' } },
    { key: 'revenue_mtd', title: 'Revenue (Month to Date)', type: 'metric', config: { source: 'invoices', metric: 'paid_total' } },
    { key: 'lead_pipeline', title: 'Lead Pipeline', type: 'chart', config: { source: 'leads', groupBy: 'stage' } },
  ],
  workflows: [
    {
      key: 'lead_assessment',
      name: 'Book assessments for new leads',
      trigger: 'crm.lead.created',
      actions: [
        { type: 'create_task', params: { title: 'Schedule site assessment', dueInHours: 24 } },
      ],
    },
    {
      key: 'proposal_won_install',
      name: 'Schedule install when proposal approved',
      trigger: 'quoting.quote.approved',
      actions: [
        { type: 'create_task', params: { title: 'Schedule installation crew', dueInHours: 48 } },
        { type: 'send_message', params: { channel: 'email', template: 'install_scheduling' } },
      ],
    },
  ],
} satisfies IndustryConfig;

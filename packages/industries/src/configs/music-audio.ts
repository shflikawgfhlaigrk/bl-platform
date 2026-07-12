import type { IndustryConfig } from '../config';

export const musicAudioConfig = {
  key: 'music-audio',
  label: 'Music & Audio',
  description: 'Recording studios and audio production businesses.',
  terminology: {
    lead: 'Inquiry',
    customer: 'Artist',
    quote: 'Session Quote',
    job: 'Session',
    appointment: 'Studio Booking',
    invoice: 'Invoice',
    team_member: 'Engineer',
  },
  leadStages: [
    { key: 'new', label: 'New Inquiry' },
    { key: 'demo_review', label: 'Demo Review' },
    { key: 'quoted', label: 'Quoted' },
    { key: 'booked', label: 'Booked' },
    { key: 'lost', label: 'Lost' },
  ],
  quoteTemplates: [
    {
      key: 'tracking_session',
      name: 'Tracking Session',
      description: 'Studio tracking with an engineer.',
      lines: [
        { description: 'Studio time (per hour)', quantity: 8, unitPriceCents: 7500 },
        { description: 'Engineer (per hour)', quantity: 8, unitPriceCents: 5000 },
      ],
    },
    {
      key: 'mix_master_ep',
      name: 'Mix & Master (EP)',
      description: 'Mixing and mastering for a 5-track EP.',
      lines: [
        { description: 'Mixing (per track)', quantity: 5, unitPriceCents: 30000 },
        { description: 'Mastering (per track)', quantity: 5, unitPriceCents: 10000 },
      ],
    },
  ],
  appointmentTypes: [
    { key: 'studio_tour', label: 'Studio Tour', durationMinutes: 30 },
    { key: 'tracking', label: 'Tracking Session', durationMinutes: 240 },
    { key: 'mix_review', label: 'Mix Review', durationMinutes: 60 },
  ],
  dashboardWidgets: [
    { key: 'bookings_week', title: 'Bookings This Week', type: 'list', config: { source: 'appointments', range: 'week' } },
    { key: 'studio_utilization', title: 'Studio Utilization', type: 'chart', config: { source: 'appointments', metric: 'utilization' } },
    { key: 'open_quotes', title: 'Open Session Quotes', type: 'metric', config: { source: 'quotes', status: 'open' } },
    { key: 'revenue_mtd', title: 'Revenue (Month to Date)', type: 'metric', config: { source: 'invoices', metric: 'paid_total' } },
  ],
  workflows: [
    {
      key: 'inquiry_demo_review',
      name: 'Review demos from new inquiries',
      trigger: 'crm.lead.created',
      actions: [
        { type: 'create_task', params: { title: 'Review demo and reply with availability', dueInHours: 48 } },
      ],
    },
    {
      key: 'session_deliverables',
      name: 'Send deliverables after each session',
      trigger: 'scheduling.appointment.completed',
      actions: [
        { type: 'create_task', params: { title: 'Upload session files and share link', dueInHours: 24 } },
        { type: 'send_message', params: { channel: 'email', template: 'session_wrap_up' } },
      ],
    },
  ],
} satisfies IndustryConfig;

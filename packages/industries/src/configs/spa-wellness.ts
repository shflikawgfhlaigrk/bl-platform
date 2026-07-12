import type { IndustryConfig } from '../config';

export const spaWellnessConfig = {
  key: 'spa-wellness',
  label: 'Spa & Wellness',
  description: 'Spas, massage studios, and wellness practices.',
  terminology: {
    lead: 'Inquiry',
    customer: 'Client',
    quote: 'Package Proposal',
    job: 'Session',
    appointment: 'Booking',
    invoice: 'Invoice',
    team_member: 'Practitioner',
  },
  leadStages: [
    { key: 'new', label: 'New Inquiry' },
    { key: 'consult_booked', label: 'Consultation Booked' },
    { key: 'proposal_sent', label: 'Package Proposed' },
    { key: 'member', label: 'Active Client' },
    { key: 'lapsed', label: 'Lapsed' },
  ],
  quoteTemplates: [
    {
      key: 'relaxation_package',
      name: 'Relaxation Package',
      description: 'Massage + facial bundle.',
      lines: [
        { description: '60-minute massage', quantity: 1, unitPriceCents: 9500 },
        { description: 'Signature facial', quantity: 1, unitPriceCents: 8500 },
      ],
    },
    {
      key: 'monthly_membership',
      name: 'Monthly Wellness Membership',
      description: 'Recurring monthly wellness plan.',
      lines: [
        { description: 'Monthly membership (per month)', quantity: 1, unitPriceCents: 12900 },
        { description: 'Enrollment fee', quantity: 1, unitPriceCents: 2500 },
      ],
    },
  ],
  appointmentTypes: [
    { key: 'consultation', label: 'Wellness Consultation', durationMinutes: 30 },
    { key: 'massage_60', label: '60-Minute Massage', durationMinutes: 60 },
    { key: 'facial', label: 'Facial Treatment', durationMinutes: 75 },
  ],
  dashboardWidgets: [
    { key: 'bookings_today', title: 'Bookings Today', type: 'list', config: { source: 'appointments', range: 'day' } },
    { key: 'revenue_mtd', title: 'Revenue (Month to Date)', type: 'metric', config: { source: 'invoices', metric: 'paid_total' } },
    { key: 'new_inquiries', title: 'New Inquiries', type: 'metric', config: { source: 'leads', stage: 'new' } },
    { key: 'rating_trend', title: 'Client Rating Trend', type: 'chart', config: { source: 'reviews', metric: 'rating_avg' } },
  ],
  workflows: [
    {
      key: 'inquiry_followup',
      name: 'Follow up on new inquiries',
      trigger: 'crm.lead.created',
      actions: [
        { type: 'send_message', params: { channel: 'email', template: 'welcome_inquiry' } },
        { type: 'create_task', params: { title: 'Call inquiry to book consultation', dueInHours: 24 } },
      ],
    },
    {
      key: 'rebooking_nudge',
      name: 'Invite rebooking after each session',
      trigger: 'scheduling.appointment.completed',
      actions: [
        { type: 'send_message', params: { channel: 'sms', template: 'rebooking_offer' } },
      ],
    },
  ],
} satisfies IndustryConfig;

import type { IndustryConfig } from '../config';

export const restaurantConfig = {
  key: 'restaurant',
  label: 'Restaurant',
  description: 'Restaurants with reservations, private events, and catering.',
  terminology: {
    lead: 'Inquiry',
    customer: 'Guest',
    quote: 'Event Proposal',
    job: 'Event',
    appointment: 'Reservation',
    invoice: 'Bill',
    team_member: 'Staff Member',
  },
  leadStages: [
    { key: 'new', label: 'New Inquiry' },
    { key: 'tasting_scheduled', label: 'Tasting Scheduled' },
    { key: 'proposal_sent', label: 'Proposal Sent' },
    { key: 'booked', label: 'Booked' },
    { key: 'lost', label: 'Lost' },
  ],
  quoteTemplates: [
    {
      key: 'catering_buffet',
      name: 'Catering Buffet Package',
      description: 'Off-site buffet catering per guest.',
      lines: [
        { description: 'Buffet service (per guest)', quantity: 50, unitPriceCents: 3500 },
        { description: 'Service staff (per hour)', quantity: 8, unitPriceCents: 4500 },
        { description: 'Delivery & setup', quantity: 1, unitPriceCents: 15000 },
      ],
    },
    {
      key: 'private_dining',
      name: 'Private Dining Room',
      description: 'In-house private event package.',
      lines: [
        { description: 'Room hire (per evening)', quantity: 1, unitPriceCents: 50000 },
        { description: 'Tasting menu (per guest)', quantity: 20, unitPriceCents: 8500 },
      ],
    },
  ],
  appointmentTypes: [
    { key: 'reservation', label: 'Table Reservation', durationMinutes: 90 },
    { key: 'tasting', label: 'Menu Tasting', durationMinutes: 60 },
    { key: 'private_event', label: 'Private Event', durationMinutes: 240 },
  ],
  dashboardWidgets: [
    { key: 'reservations_today', title: 'Reservations Today', type: 'list', config: { source: 'appointments', range: 'day' } },
    { key: 'event_pipeline', title: 'Event Pipeline', type: 'chart', config: { source: 'leads', groupBy: 'stage' } },
    { key: 'revenue_mtd', title: 'Revenue (Month to Date)', type: 'metric', config: { source: 'invoices', metric: 'paid_total' } },
    { key: 'review_feed', title: 'Latest Reviews', type: 'feed', config: { source: 'reviews' } },
  ],
  workflows: [
    {
      key: 'inquiry_response',
      name: 'Respond to event inquiries fast',
      trigger: 'crm.lead.created',
      actions: [
        { type: 'send_message', params: { channel: 'email', template: 'event_inquiry_ack' } },
        { type: 'create_task', params: { title: 'Call to schedule tasting', dueInHours: 12 } },
      ],
    },
    {
      key: 'post_event_review',
      name: 'Thank guests and ask for a review',
      trigger: 'scheduling.appointment.completed',
      actions: [
        { type: 'send_message', params: { channel: 'email', template: 'post_event_thanks' } },
      ],
    },
  ],
} satisfies IndustryConfig;

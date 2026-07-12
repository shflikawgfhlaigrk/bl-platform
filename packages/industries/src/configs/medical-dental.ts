import type { IndustryConfig } from '../config';

export const medicalDentalConfig = {
  key: 'medical-dental',
  label: 'Medical & Dental',
  description: 'Medical and dental practices managing patients and treatment plans.',
  terminology: {
    lead: 'Referral',
    customer: 'Patient',
    quote: 'Treatment Plan',
    job: 'Treatment',
    appointment: 'Appointment',
    invoice: 'Statement',
    team_member: 'Provider',
  },
  leadStages: [
    { key: 'new', label: 'New Referral' },
    { key: 'insurance_verified', label: 'Insurance Verified' },
    { key: 'treatment_planned', label: 'Treatment Planned' },
    { key: 'active', label: 'Active Patient' },
    { key: 'inactive', label: 'Inactive' },
  ],
  quoteTemplates: [
    {
      key: 'new_patient_exam',
      name: 'New Patient Exam',
      description: 'Comprehensive exam with imaging.',
      lines: [
        { description: 'Comprehensive examination', quantity: 1, unitPriceCents: 12500 },
        { description: 'Full-mouth X-rays', quantity: 1, unitPriceCents: 15000 },
        { description: 'Cleaning', quantity: 1, unitPriceCents: 11000 },
      ],
    },
    {
      key: 'restorative_plan',
      name: 'Restorative Treatment Plan',
      description: 'Typical restorative course of treatment.',
      lines: [
        { description: 'Composite filling (per tooth)', quantity: 2, unitPriceCents: 22500 },
        { description: 'Crown (per tooth)', quantity: 1, unitPriceCents: 120000 },
      ],
    },
  ],
  appointmentTypes: [
    { key: 'new_patient_visit', label: 'New Patient Visit', durationMinutes: 90 },
    { key: 'checkup', label: 'Checkup & Cleaning', durationMinutes: 45 },
    { key: 'procedure', label: 'Procedure', durationMinutes: 120 },
  ],
  dashboardWidgets: [
    { key: 'appointments_today', title: 'Appointments Today', type: 'list', config: { source: 'appointments', range: 'day' } },
    { key: 'pending_plans', title: 'Pending Treatment Plans', type: 'metric', config: { source: 'quotes', status: 'open' } },
    { key: 'collections_mtd', title: 'Collections (Month to Date)', type: 'metric', config: { source: 'invoices', metric: 'paid_total' } },
    { key: 'recall_due', title: 'Recall Due', type: 'list', config: { source: 'customers', filter: 'recall_due' } },
  ],
  workflows: [
    {
      key: 'referral_intake',
      name: 'Intake new referrals',
      trigger: 'crm.lead.created',
      actions: [
        { type: 'create_task', params: { title: 'Verify insurance and schedule intake', dueInHours: 24 } },
        { type: 'send_message', params: { channel: 'email', template: 'new_patient_forms' } },
      ],
    },
    {
      key: 'recall_reminder',
      name: 'Schedule recall after each visit',
      trigger: 'scheduling.appointment.completed',
      actions: [
        { type: 'create_task', params: { title: 'Schedule 6-month recall', dueInDays: 150 } },
      ],
    },
  ],
} satisfies IndustryConfig;

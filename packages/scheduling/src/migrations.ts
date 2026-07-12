import type { Migration } from '@blacklabel/db';

/**
 * Scheduling module migrations. Append-only — never edit or reorder an
 * existing entry; new schema change = new migration pushed to the end.
 */
export const schedulingMigrations: Migration[] = [
  {
    name: 'scheduling.0001_calendars_locations_staff_resources',
    up: async (db) => {
      await db.schema
        .createTable('scheduling_calendars')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('name', 'text', (c) => c.notNull())
        .addColumn('timezone', 'text', (c) => c.notNull())
        .addColumn('description', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('scheduling_calendars_tenant_id_idx')
        .on('scheduling_calendars')
        .column('tenant_id')
        .execute();

      await db.schema
        .createTable('scheduling_locations')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('name', 'text', (c) => c.notNull())
        .addColumn('address', 'text')
        .addColumn('timezone', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('scheduling_locations_tenant_id_idx')
        .on('scheduling_locations')
        .column('tenant_id')
        .execute();

      await db.schema
        .createTable('scheduling_staff_members')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('name', 'text', (c) => c.notNull())
        .addColumn('email', 'text')
        .addColumn('user_id', 'text')
        .addColumn('active', 'integer', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('scheduling_staff_members_tenant_id_idx')
        .on('scheduling_staff_members')
        .column('tenant_id')
        .execute();

      await db.schema
        .createTable('scheduling_resources')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('name', 'text', (c) => c.notNull())
        .addColumn('kind', 'text')
        .addColumn('location_id', 'text')
        .addColumn('active', 'integer', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('scheduling_resources_tenant_id_idx')
        .on('scheduling_resources')
        .column('tenant_id')
        .execute();
    },
  },
  {
    name: 'scheduling.0002_appointment_types_availability',
    up: async (db) => {
      await db.schema
        .createTable('scheduling_appointment_types')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('name', 'text', (c) => c.notNull())
        .addColumn('duration_minutes', 'integer', (c) => c.notNull())
        .addColumn('buffer_before_minutes', 'integer', (c) => c.notNull())
        .addColumn('buffer_after_minutes', 'integer', (c) => c.notNull())
        .addColumn('active', 'integer', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('scheduling_appointment_types_tenant_id_idx')
        .on('scheduling_appointment_types')
        .column('tenant_id')
        .execute();

      await db.schema
        .createTable('scheduling_availability_windows')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('owner_type', 'text', (c) => c.notNull())
        .addColumn('owner_id', 'text', (c) => c.notNull())
        .addColumn('weekday', 'integer', (c) => c.notNull())
        .addColumn('start_time', 'text', (c) => c.notNull())
        .addColumn('end_time', 'text', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('scheduling_availability_windows_owner_idx')
        .on('scheduling_availability_windows')
        .columns(['tenant_id', 'owner_type', 'owner_id'])
        .execute();

      await db.schema
        .createTable('scheduling_availability_exceptions')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('owner_type', 'text', (c) => c.notNull())
        .addColumn('owner_id', 'text', (c) => c.notNull())
        .addColumn('date', 'text', (c) => c.notNull())
        .addColumn('available', 'integer', (c) => c.notNull())
        .addColumn('start_time', 'text')
        .addColumn('end_time', 'text')
        .addColumn('reason', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('scheduling_availability_exceptions_owner_idx')
        .on('scheduling_availability_exceptions')
        .columns(['tenant_id', 'owner_type', 'owner_id', 'date'])
        .execute();
    },
  },
  {
    name: 'scheduling.0003_appointments_rules_assignments',
    up: async (db) => {
      await db.schema
        .createTable('scheduling_schedule_rules')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('frequency', 'text', (c) => c.notNull())
        .addColumn('interval', 'integer', (c) => c.notNull())
        .addColumn('count', 'integer')
        .addColumn('until', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('scheduling_schedule_rules_tenant_id_idx')
        .on('scheduling_schedule_rules')
        .column('tenant_id')
        .execute();

      await db.schema
        .createTable('scheduling_appointments')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('calendar_id', 'text', (c) => c.notNull())
        .addColumn('appointment_type_id', 'text')
        .addColumn('customer_id', 'text')
        .addColumn('location_id', 'text')
        .addColumn('title', 'text', (c) => c.notNull())
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('starts_at', 'text', (c) => c.notNull())
        .addColumn('ends_at', 'text', (c) => c.notNull())
        .addColumn('notes', 'text')
        .addColumn('canceled_reason', 'text')
        .addColumn('schedule_rule_id', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('scheduling_appointments_tenant_id_idx')
        .on('scheduling_appointments')
        .column('tenant_id')
        .execute();
      await db.schema
        .createIndex('scheduling_appointments_calendar_time_idx')
        .on('scheduling_appointments')
        .columns(['tenant_id', 'calendar_id', 'starts_at'])
        .execute();

      await db.schema
        .createTable('scheduling_appointment_staff')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('appointment_id', 'text', (c) => c.notNull())
        .addColumn('staff_id', 'text', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('scheduling_appointment_staff_appt_idx')
        .on('scheduling_appointment_staff')
        .columns(['tenant_id', 'appointment_id'])
        .execute();
      await db.schema
        .createIndex('scheduling_appointment_staff_staff_idx')
        .on('scheduling_appointment_staff')
        .columns(['tenant_id', 'staff_id'])
        .execute();

      await db.schema
        .createTable('scheduling_appointment_resources')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('appointment_id', 'text', (c) => c.notNull())
        .addColumn('resource_id', 'text', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('scheduling_appointment_resources_appt_idx')
        .on('scheduling_appointment_resources')
        .columns(['tenant_id', 'appointment_id'])
        .execute();
      await db.schema
        .createIndex('scheduling_appointment_resources_resource_idx')
        .on('scheduling_appointment_resources')
        .columns(['tenant_id', 'resource_id'])
        .execute();
    },
  },
  {
    name: 'scheduling.0004_reminders',
    up: async (db) => {
      await db.schema
        .createTable('scheduling_reminders')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('appointment_id', 'text', (c) => c.notNull())
        .addColumn('send_at', 'text', (c) => c.notNull())
        .addColumn('channel', 'text', (c) => c.notNull())
        .addColumn('recipient', 'text', (c) => c.notNull())
        .addColumn('message', 'text')
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('sent_at', 'text')
        .addColumn('provider', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('scheduling_reminders_tenant_id_idx')
        .on('scheduling_reminders')
        .column('tenant_id')
        .execute();
      await db.schema
        .createIndex('scheduling_reminders_pending_idx')
        .on('scheduling_reminders')
        .columns(['tenant_id', 'status', 'send_at'])
        .execute();
    },
  },
];

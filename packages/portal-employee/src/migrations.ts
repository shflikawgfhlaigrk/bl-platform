import type { Migration } from '@blacklabel/db';

/**
 * portal-employee migrations. Append-only — never edit or reorder a shipped
 * migration; new change = new entry appended to this array.
 */
export const portalEmployeeMigrations: Migration[] = [
  {
    name: 'portal_employee.0001_tables',
    up: async (db) => {
      await db.schema
        .createTable('portal_employee_employees')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('user_id', 'text')
        .addColumn('name', 'text', (c) => c.notNull())
        .addColumn('email', 'text', (c) => c.notNull())
        .addColumn('phone', 'text')
        .addColumn('role', 'text', (c) => c.notNull())
        .addColumn('title', 'text')
        .addColumn('active', 'integer', (c) => c.notNull())
        .addColumn('custom', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('portal_employee_employees_tenant_id_idx')
        .on('portal_employee_employees')
        .column('tenant_id')
        .execute();

      await db.schema
        .createTable('portal_employee_tokens')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('employee_id', 'text', (c) => c.notNull())
        .addColumn('token', 'text', (c) => c.notNull())
        .addColumn('expires_at', 'text')
        .addColumn('revoked', 'integer', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('portal_employee_tokens_tenant_id_token_idx')
        .on('portal_employee_tokens')
        .columns(['tenant_id', 'token'])
        .execute();

      await db.schema
        .createTable('portal_employee_assignments')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('employee_id', 'text', (c) => c.notNull())
        .addColumn('kind', 'text', (c) => c.notNull())
        .addColumn('title', 'text', (c) => c.notNull())
        .addColumn('description', 'text')
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('scheduled_at', 'text')
        .addColumn('related_entity_type', 'text')
        .addColumn('related_entity_id', 'text')
        .addColumn('custom', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('portal_employee_assignments_tenant_id_employee_id_idx')
        .on('portal_employee_assignments')
        .columns(['tenant_id', 'employee_id'])
        .execute();

      await db.schema
        .createTable('portal_employee_shifts')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('employee_id', 'text', (c) => c.notNull())
        .addColumn('starts_at', 'text', (c) => c.notNull())
        .addColumn('ends_at', 'text', (c) => c.notNull())
        .addColumn('notes', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('portal_employee_shifts_tenant_id_employee_id_idx')
        .on('portal_employee_shifts')
        .columns(['tenant_id', 'employee_id'])
        .execute();

      await db.schema
        .createTable('portal_employee_time_entries')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('employee_id', 'text', (c) => c.notNull())
        .addColumn('shift_id', 'text')
        .addColumn('clock_in_at', 'text', (c) => c.notNull())
        .addColumn('clock_out_at', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('portal_employee_time_entries_tenant_id_employee_id_idx')
        .on('portal_employee_time_entries')
        .columns(['tenant_id', 'employee_id'])
        .execute();

      await db.schema
        .createTable('portal_employee_checklist_templates')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('name', 'text', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('portal_employee_checklist_templates_tenant_id_idx')
        .on('portal_employee_checklist_templates')
        .column('tenant_id')
        .execute();

      await db.schema
        .createTable('portal_employee_checklist_template_items')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('template_id', 'text', (c) => c.notNull())
        .addColumn('label', 'text', (c) => c.notNull())
        .addColumn('position', 'integer', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('portal_employee_checklist_template_items_tenant_id_idx')
        .on('portal_employee_checklist_template_items')
        .columns(['tenant_id', 'template_id'])
        .execute();

      await db.schema
        .createTable('portal_employee_checklists')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('assignment_id', 'text', (c) => c.notNull())
        .addColumn('template_id', 'text')
        .addColumn('name', 'text', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('portal_employee_checklists_tenant_id_assignment_id_idx')
        .on('portal_employee_checklists')
        .columns(['tenant_id', 'assignment_id'])
        .execute();

      await db.schema
        .createTable('portal_employee_checklist_items')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('checklist_id', 'text', (c) => c.notNull())
        .addColumn('label', 'text', (c) => c.notNull())
        .addColumn('position', 'integer', (c) => c.notNull())
        .addColumn('checked', 'integer', (c) => c.notNull())
        .addColumn('checked_at', 'text')
        .addColumn('checked_by', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('portal_employee_checklist_items_tenant_id_checklist_id_idx')
        .on('portal_employee_checklist_items')
        .columns(['tenant_id', 'checklist_id'])
        .execute();

      await db.schema
        .createTable('portal_employee_work_logs')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('assignment_id', 'text', (c) => c.notNull())
        .addColumn('employee_id', 'text', (c) => c.notNull())
        .addColumn('kind', 'text', (c) => c.notNull())
        .addColumn('body', 'text', (c) => c.notNull())
        .addColumn('status', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('portal_employee_work_logs_tenant_id_assignment_id_idx')
        .on('portal_employee_work_logs')
        .columns(['tenant_id', 'assignment_id'])
        .execute();

      await db.schema
        .createTable('portal_employee_job_photos')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('assignment_id', 'text', (c) => c.notNull())
        .addColumn('employee_id', 'text', (c) => c.notNull())
        .addColumn('file_id', 'text', (c) => c.notNull())
        .addColumn('caption', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('portal_employee_job_photos_tenant_id_assignment_id_idx')
        .on('portal_employee_job_photos')
        .columns(['tenant_id', 'assignment_id'])
        .execute();
    },
  },
  {
    // Work logs are a chronological timeline, but created_at has millisecond
    // resolution: two logs written in the same ms collide, and the random
    // nanoid `id` tiebreaker then orders them nondeterministically. `seq` is
    // a per-assignment insertion counter that keeps the timeline stable.
    name: 'portal_employee.0002_work_logs_seq',
    up: async (db) => {
      await db.schema
        .alterTable('portal_employee_work_logs')
        .addColumn('seq', 'integer', (c) => c.notNull().defaultTo(0))
        .execute();
    },
  },
];

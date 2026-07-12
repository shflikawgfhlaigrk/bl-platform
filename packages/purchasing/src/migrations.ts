import type { Migration } from '@blacklabel/db';

export const purchasingMigrations: Migration[] = [
  {
    name: 'purchasing.0001_reorder_policies',
    up: async (db) => {
      await db.schema
        .createTable('purchasing_reorder_policies')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('variation_id', 'text', (c) => c.notNull())
        .addColumn('vendor_id', 'text', (c) => c.notNull())
        .addColumn('reorder_point', 'integer', (c) => c.notNull())
        .addColumn('safety_stock', 'integer', (c) => c.notNull())
        .addColumn('target_days_of_supply', 'integer')
        .addColumn('order_multiple', 'integer', (c) => c.notNull())
        .addColumn('min_qty', 'integer', (c) => c.notNull())
        .addColumn('enabled', 'integer', (c) => c.notNull())
        .addColumn('owner_override_qty', 'integer')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('purchasing_reorder_policies_tenant_variation_idx')
        .on('purchasing_reorder_policies')
        .columns(['tenant_id', 'variation_id'])
        .execute();
    },
  },
  {
    name: 'purchasing.0002_suggestions',
    up: async (db) => {
      await db.schema
        .createTable('purchasing_suggestions')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('variation_id', 'text', (c) => c.notNull())
        .addColumn('vendor_id', 'text', (c) => c.notNull())
        .addColumn('inputs', 'text', (c) => c.notNull())
        .addColumn('suggested_qty', 'integer', (c) => c.notNull())
        .addColumn('formula_trace', 'text', (c) => c.notNull())
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('purchase_order_id', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('purchasing_suggestions_tenant_status_idx')
        .on('purchasing_suggestions')
        .columns(['tenant_id', 'status'])
        .execute();
      await db.schema
        .createIndex('purchasing_suggestions_tenant_vendor_idx')
        .on('purchasing_suggestions')
        .columns(['tenant_id', 'vendor_id'])
        .execute();
    },
  },
  {
    name: 'purchasing.0003_purchase_orders',
    up: async (db) => {
      await db.schema
        .createTable('purchasing_purchase_orders')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('vendor_id', 'text', (c) => c.notNull())
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('expected_at', 'text')
        .addColumn('ship_to', 'text', (c) => c.notNull())
        .addColumn('subtotal_cents', 'integer', (c) => c.notNull())
        .addColumn('freight_cents', 'integer', (c) => c.notNull())
        .addColumn('total_cents', 'integer', (c) => c.notNull())
        .addColumn('approval_policy_snapshot', 'text')
        .addColumn('approver', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('purchasing_purchase_orders_tenant_vendor_idx')
        .on('purchasing_purchase_orders')
        .columns(['tenant_id', 'vendor_id'])
        .execute();
      await db.schema
        .createIndex('purchasing_purchase_orders_tenant_status_idx')
        .on('purchasing_purchase_orders')
        .columns(['tenant_id', 'status'])
        .execute();
    },
  },
  {
    name: 'purchasing.0004_po_lines',
    up: async (db) => {
      await db.schema
        .createTable('purchasing_po_lines')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('purchase_order_id', 'text', (c) => c.notNull())
        .addColumn('variation_id', 'text', (c) => c.notNull())
        .addColumn('vendor_sku', 'text')
        .addColumn('qty_ordered', 'integer', (c) => c.notNull())
        .addColumn('unit_cost_cents', 'integer', (c) => c.notNull())
        .addColumn('qty_received', 'integer', (c) => c.notNull())
        .addColumn('qty_backordered', 'integer', (c) => c.notNull())
        .addColumn('line_state', 'text', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('purchasing_po_lines_tenant_po_idx')
        .on('purchasing_po_lines')
        .columns(['tenant_id', 'purchase_order_id'])
        .execute();
    },
  },
  {
    name: 'purchasing.0005_po_events',
    up: async (db) => {
      await db.schema
        .createTable('purchasing_po_events')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('purchase_order_id', 'text', (c) => c.notNull())
        .addColumn('kind', 'text', (c) => c.notNull())
        .addColumn('from_status', 'text')
        .addColumn('to_status', 'text')
        .addColumn('diff', 'text')
        .addColumn('actor', 'text', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('purchasing_po_events_tenant_po_idx')
        .on('purchasing_po_events')
        .columns(['tenant_id', 'purchase_order_id'])
        .execute();
    },
  },
  {
    name: 'purchasing.0006_po_documents',
    up: async (db) => {
      await db.schema
        .createTable('purchasing_po_documents')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('purchase_order_id', 'text', (c) => c.notNull())
        .addColumn('payload', 'text', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('purchasing_po_documents_tenant_po_idx')
        .on('purchasing_po_documents')
        .columns(['tenant_id', 'purchase_order_id'])
        .execute();
    },
  },
  {
    name: 'purchasing.0007_receipts',
    up: async (db) => {
      await db.schema
        .createTable('purchasing_receipts')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('purchase_order_id', 'text', (c) => c.notNull())
        .addColumn('note', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('purchasing_receipts_tenant_po_idx')
        .on('purchasing_receipts')
        .columns(['tenant_id', 'purchase_order_id'])
        .execute();
    },
  },
  {
    name: 'purchasing.0008_receipt_lines',
    up: async (db) => {
      await db.schema
        .createTable('purchasing_receipt_lines')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('receipt_id', 'text', (c) => c.notNull())
        .addColumn('po_line_id', 'text', (c) => c.notNull())
        .addColumn('qty_received', 'integer', (c) => c.notNull())
        .addColumn('condition', 'text', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('purchasing_receipt_lines_tenant_receipt_idx')
        .on('purchasing_receipt_lines')
        .columns(['tenant_id', 'receipt_id'])
        .execute();
    },
  },
  {
    name: 'purchasing.0009_discrepancies',
    up: async (db) => {
      await db.schema
        .createTable('purchasing_discrepancies')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('receipt_id', 'text', (c) => c.notNull())
        .addColumn('po_line_id', 'text', (c) => c.notNull())
        .addColumn('purchase_order_id', 'text', (c) => c.notNull())
        .addColumn('kind', 'text', (c) => c.notNull())
        .addColumn('expected_qty', 'integer', (c) => c.notNull())
        .addColumn('received_qty', 'integer', (c) => c.notNull())
        .addColumn('delta_qty', 'integer', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('purchasing_discrepancies_tenant_po_idx')
        .on('purchasing_discrepancies')
        .columns(['tenant_id', 'purchase_order_id'])
        .execute();
    },
  },
  {
    name: 'purchasing.0010_vendor_bills',
    up: async (db) => {
      await db.schema
        .createTable('purchasing_vendor_bills')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('vendor_id', 'text', (c) => c.notNull())
        .addColumn('bill_number', 'text', (c) => c.notNull())
        .addColumn('amount_cents', 'integer', (c) => c.notNull())
        .addColumn('lines', 'text', (c) => c.notNull())
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('purchasing_vendor_bills_tenant_vendor_number_idx')
        .on('purchasing_vendor_bills')
        .columns(['tenant_id', 'vendor_id', 'bill_number'])
        .unique()
        .execute();
    },
  },
  {
    name: 'purchasing.0011_bill_exceptions',
    up: async (db) => {
      await db.schema
        .createTable('purchasing_bill_exceptions')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('bill_id', 'text', (c) => c.notNull())
        .addColumn('purchase_order_id', 'text')
        .addColumn('receipt_id', 'text')
        .addColumn('po_line_id', 'text')
        .addColumn('variation_id', 'text', (c) => c.notNull())
        .addColumn('kind', 'text', (c) => c.notNull())
        .addColumn('expected', 'integer', (c) => c.notNull())
        .addColumn('actual', 'integer', (c) => c.notNull())
        .addColumn('delta', 'integer', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('purchasing_bill_exceptions_tenant_bill_idx')
        .on('purchasing_bill_exceptions')
        .columns(['tenant_id', 'bill_id'])
        .execute();
    },
  },
];

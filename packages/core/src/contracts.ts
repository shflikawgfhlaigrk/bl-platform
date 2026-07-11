import type { Kysely } from 'kysely';
import type { EventBus } from './events';

/**
 * Cross-module action contracts. Modules NEVER import each other's services
 * or tables — they implement/accept these plain interfaces via injection.
 * apps/api wires the concrete implementations into each router factory.
 *
 * All timestamps ISO-8601 UTC text; all money integer cents; all references
 * are id strings.
 */

export interface CreateTaskInput {
  tenantId: string;
  title: string;
  description?: string;
  assigneeUserId?: string;
  /** ISO-8601 UTC. */
  dueAt?: string;
  relatedEntityType?: string;
  relatedEntityId?: string;
}

/** Implemented by the workflows module. */
export interface CreateTaskContract {
  createTask(input: CreateTaskInput): Promise<{ id: string }>;
}

export interface CreateAppointmentInput {
  tenantId: string;
  customerId: string;
  /** ISO-8601 UTC. */
  startsAt: string;
  /** ISO-8601 UTC. */
  endsAt: string;
  assigneeUserId?: string;
  serviceKey?: string;
  notes?: string;
}

/** Implemented by the scheduling module. */
export interface CreateAppointmentContract {
  createAppointment(input: CreateAppointmentInput): Promise<{ id: string }>;
}

export interface InvoiceLineInput {
  description: string;
  quantity: number;
  unitPriceCents: number;
  /** Line-level discount (see core money helpers). */
  discountBps?: number;
  discountFixedCents?: number;
}

export interface CreateInvoiceInput {
  tenantId: string;
  customerId: string;
  lines: InvoiceLineInput[];
  /** Invoice-level discount, applied after line discounts. */
  discountBps?: number;
  discountFixedCents?: number;
  /** Tax in basis points, applied after all discounts. */
  taxBps?: number;
  /** ISO-8601 UTC. */
  dueAt?: string;
  memo?: string;
  /** e.g. "quoting.quote" + quote id when converting a quote. */
  sourceEntityType?: string;
  sourceEntityId?: string;
}

/** Implemented by the billing module. */
export interface CreateInvoiceContract {
  createInvoice(input: CreateInvoiceInput): Promise<{ id: string }>;
}

export type MessageChannel = 'email' | 'sms' | 'portal';

export interface SendMessageInput {
  tenantId: string;
  channel: MessageChannel;
  /** Address for the channel: email address, phone, or portal user/customer id. */
  to: string;
  subject?: string;
  body: string;
  relatedEntityType?: string;
  relatedEntityId?: string;
}

/** Implemented by the messaging module. */
export interface SendMessageContract {
  sendMessage(input: SendMessageInput): Promise<{ id: string }>;
}

export interface CreateAppointmentTypeInput {
  tenantId: string;
  name: string;
  durationMinutes: number;
  bufferBeforeMinutes?: number;
  bufferAfterMinutes?: number;
}

/**
 * Implemented by the scheduling module. Idempotent per (tenant, name): a
 * repeat call for a name that already exists returns the existing type id with
 * created=false. Lets other modules (e.g. industries) provision bookable
 * appointment types without importing scheduling.
 */
export interface CreateAppointmentTypeContract {
  createAppointmentType(input: CreateAppointmentTypeInput): Promise<{ id: string; created: boolean }>;
}

/**
 * The injection bag passed to router factories. Every entry is optional so
 * modules can be developed/tested in isolation — always handle absence with
 * a 501/skip, never import the other module directly.
 */
export interface Contracts {
  createTask?: CreateTaskContract;
  createAppointment?: CreateAppointmentContract;
  createAppointmentType?: CreateAppointmentTypeContract;
  createInvoice?: CreateInvoiceContract;
  sendMessage?: SendMessageContract;
}

/**
 * Standard dependencies for a module router factory:
 *   export function crmRouter(deps: ModuleDeps<CrmDatabase>): Hono<TenantEnv>
 */
export interface ModuleDeps<DB = unknown> {
  db: Kysely<DB>;
  events: EventBus;
  contracts: Contracts;
}

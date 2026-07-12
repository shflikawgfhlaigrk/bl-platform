import { z } from 'zod';
import { EVENT_NAME_PATTERN } from '@blacklabel/core';

/**
 * Industry config file format + Zod loader.
 *
 * An industry is ONE config file in `src/configs/` — plain data, zero code.
 * The loader validates every config; an invalid config produces an
 * `IndustryConfigError` that lists EVERY violation (path + message), not just
 * the first one.
 */

/**
 * Core platform terms every industry terminology map MUST translate.
 * UIs render `terminology[coreTerm]` wherever they would show the core term.
 */
export const CORE_TERMS = [
  'lead',
  'customer',
  'quote',
  'job',
  'appointment',
  'invoice',
  'team_member',
] as const;

export type CoreTerm = (typeof CORE_TERMS)[number];

/** Machine keys inside a config: snake_case. */
const KEY_PATTERN = /^[a-z][a-z0-9_]*$/;
/** Industry keys: kebab-case (e.g. "window-cleaning"). */
const INDUSTRY_KEY_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

const templateLineSchema = z
  .object({
    description: z.string().min(1),
    /** May be fractional (e.g. 2.5 hours). */
    quantity: z.number().positive().finite(),
    /** INTEGER cents — never floats for money. */
    unitPriceCents: z.number().int().nonnegative(),
  })
  .strict();

const leadStageSchema = z
  .object({
    key: z.string().regex(KEY_PATTERN, 'key must be snake_case ([a-z][a-z0-9_]*)'),
    label: z.string().min(1),
  })
  .strict();

const quoteTemplateSchema = z
  .object({
    key: z.string().regex(KEY_PATTERN, 'key must be snake_case ([a-z][a-z0-9_]*)'),
    name: z.string().min(1),
    description: z.string().min(1).optional(),
    lines: z.array(templateLineSchema).min(1),
  })
  .strict();

const appointmentTypeSchema = z
  .object({
    key: z.string().regex(KEY_PATTERN, 'key must be snake_case ([a-z][a-z0-9_]*)'),
    label: z.string().min(1),
    durationMinutes: z.number().int().positive(),
    description: z.string().min(1).optional(),
  })
  .strict();

const dashboardWidgetSchema = z
  .object({
    key: z.string().regex(KEY_PATTERN, 'key must be snake_case ([a-z][a-z0-9_]*)'),
    title: z.string().min(1),
    type: z.enum(['metric', 'list', 'chart', 'feed']),
    config: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const workflowActionSchema = z
  .object({
    type: z.string().regex(KEY_PATTERN, 'action type must be snake_case'),
    params: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const workflowSchema = z
  .object({
    key: z.string().regex(KEY_PATTERN, 'key must be snake_case ([a-z][a-z0-9_]*)'),
    name: z.string().min(1),
    trigger: z
      .string()
      .regex(EVENT_NAME_PATTERN, 'trigger must be a module.entity.verb event name'),
    actions: z.array(workflowActionSchema).min(1),
  })
  .strict();

function checkDuplicateKeys(
  ctx: z.RefinementCtx,
  field: string,
  items: ReadonlyArray<{ key: string }>,
): void {
  const seen = new Set<string>();
  items.forEach((item, index) => {
    if (seen.has(item.key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [field, index, 'key'],
        message: `duplicate ${field} key "${item.key}"`,
      });
    }
    seen.add(item.key);
  });
}

export const industryConfigSchema = z
  .object({
    /** Unique kebab-case identifier, e.g. "window-cleaning". */
    key: z.string().regex(INDUSTRY_KEY_PATTERN, 'industry key must be kebab-case'),
    label: z.string().min(1),
    description: z.string().min(1),
    /** Flat map core-term -> display-term. Must cover all CORE_TERMS. */
    terminology: z.record(
      z.string().regex(KEY_PATTERN, 'terminology keys must be snake_case'),
      z.string().min(1),
    ),
    leadStages: z.array(leadStageSchema).min(2),
    quoteTemplates: z.array(quoteTemplateSchema).min(1),
    appointmentTypes: z.array(appointmentTypeSchema).min(1),
    dashboardWidgets: z.array(dashboardWidgetSchema).min(1),
    workflows: z.array(workflowSchema),
  })
  .strict()
  .superRefine((config, ctx) => {
    for (const term of CORE_TERMS) {
      if (!(term in config.terminology)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['terminology', term],
          message: `missing terminology for core term "${term}"`,
        });
      }
    }
    checkDuplicateKeys(ctx, 'leadStages', config.leadStages);
    checkDuplicateKeys(ctx, 'quoteTemplates', config.quoteTemplates);
    checkDuplicateKeys(ctx, 'appointmentTypes', config.appointmentTypes);
    checkDuplicateKeys(ctx, 'dashboardWidgets', config.dashboardWidgets);
    checkDuplicateKeys(ctx, 'workflows', config.workflows);
  });

export type IndustryConfig = z.infer<typeof industryConfigSchema>;
export type IndustryLeadStage = IndustryConfig['leadStages'][number];
export type IndustryQuoteTemplate = IndustryConfig['quoteTemplates'][number];
export type IndustryTemplateLine = IndustryQuoteTemplate['lines'][number];
export type IndustryAppointmentType = IndustryConfig['appointmentTypes'][number];
export type IndustryDashboardWidget = IndustryConfig['dashboardWidgets'][number];
export type IndustryWorkflow = IndustryConfig['workflows'][number];
export type IndustryWorkflowAction = IndustryWorkflow['actions'][number];

/** One rule the config broke: dotted path + human message. */
export interface ConfigViolation {
  path: string;
  message: string;
}

/** Typed validation error carrying EVERY violation found in a config. */
export class IndustryConfigError extends Error {
  readonly violations: readonly ConfigViolation[];
  readonly source: string | undefined;

  constructor(violations: readonly ConfigViolation[], source?: string) {
    const where = source ? ` (${source})` : '';
    super(
      `invalid industry config${where}: ${violations.length} violation(s)\n` +
        violations.map((v) => `  - ${v.path || '(root)'}: ${v.message}`).join('\n'),
    );
    this.name = 'IndustryConfigError';
    this.violations = violations;
    this.source = source;
  }
}

const KEYED_LIST_FIELDS = [
  'leadStages',
  'quoteTemplates',
  'appointmentTypes',
  'dashboardWidgets',
  'workflows',
] as const;

/**
 * Semantic checks (core-term coverage, duplicate keys) computed directly on
 * the raw data. Zod only runs `superRefine` when the structural parse
 * succeeds, so without this a config with BOTH structural and semantic
 * problems would hide the semantic ones — the loader must list EVERY
 * violation in one pass.
 */
function semanticViolations(raw: unknown): ConfigViolation[] {
  const out: ConfigViolation[] = [];
  if (typeof raw !== 'object' || raw === null) return out;
  const obj = raw as Record<string, unknown>;

  const terminology = obj.terminology;
  if (typeof terminology === 'object' && terminology !== null && !Array.isArray(terminology)) {
    for (const term of CORE_TERMS) {
      if (!(term in (terminology as Record<string, unknown>))) {
        out.push({
          path: `terminology.${term}`,
          message: `missing terminology for core term "${term}"`,
        });
      }
    }
  }

  for (const field of KEYED_LIST_FIELDS) {
    const items = obj[field];
    if (!Array.isArray(items)) continue;
    const seen = new Set<string>();
    items.forEach((item, index) => {
      const key = (item as { key?: unknown } | null)?.key;
      if (typeof key !== 'string') return;
      if (seen.has(key)) {
        out.push({
          path: `${field}.${index}.key`,
          message: `duplicate ${field} key "${key}"`,
        });
      }
      seen.add(key);
    });
  }
  return out;
}

/**
 * Validate raw config data. Never throws — returns either the typed config
 * or the full violation list (structural AND semantic problems together).
 */
export function validateIndustryConfig(
  raw: unknown,
): { ok: true; config: IndustryConfig } | { ok: false; violations: ConfigViolation[] } {
  const result = industryConfigSchema.safeParse(raw);
  if (result.success) {
    return { ok: true, config: result.data };
  }
  const structural: ConfigViolation[] = result.error.issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
  }));
  // Merge in semantic checks (deduped) — superRefine won't have run if the
  // structural parse failed.
  const violations: ConfigViolation[] = [...structural];
  const seen = new Set(structural.map((v) => `${v.path}|${v.message}`));
  for (const violation of semanticViolations(raw)) {
    const signature = `${violation.path}|${violation.message}`;
    if (!seen.has(signature)) {
      seen.add(signature);
      violations.push(violation);
    }
  }
  return { ok: false, violations };
}

/**
 * Parse raw config data or throw an IndustryConfigError listing every
 * violation. `source` (e.g. the file name) is included in the message.
 */
export function parseIndustryConfig(raw: unknown, source?: string): IndustryConfig {
  const result = validateIndustryConfig(raw);
  if (!result.ok) {
    throw new IndustryConfigError(result.violations, source);
  }
  return result.config;
}

/**
 * Look up the display term for a core term. Falls back to the core term
 * itself when the map has no entry — UIs never render `undefined`.
 */
export function termFor(terminology: Record<string, string>, coreTerm: string): string {
  return terminology[coreTerm] ?? coreTerm;
}

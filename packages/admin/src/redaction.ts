/**
 * Redaction pass shared by the diagnostic bundle and the structured logger.
 *
 * Rules:
 *  - Any object KEY matching /pass|secret|token|key|credential/i has its value
 *    replaced with "[REDACTED]" (whole subtree, regardless of value type).
 *  - Any STRING value that looks like an email is replaced with
 *    "[REDACTED_EMAIL]" UNLESS it is in the caller-provided allowlist
 *    (e.g. the business identity contact address, which is public by design).
 *  - Recurses through nested objects and arrays. Cycles are handled.
 */

const REDACT_KEY_RE = /pass|secret|token|key|credential/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface RedactOptions {
  /** Emails that are allowed through verbatim (case-insensitive). */
  emailAllowlist?: readonly string[];
}

export function redact<T = unknown>(value: T, opts: RedactOptions = {}): T {
  const allow = new Set((opts.emailAllowlist ?? []).map((e) => e.toLowerCase()));
  const seen = new WeakSet<object>();

  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      if (EMAIL_RE.test(v) && !allow.has(v.toLowerCase())) return '[REDACTED_EMAIL]';
      return v;
    }
    if (v === null || typeof v !== 'object') return v;
    if (seen.has(v as object)) return '[CIRCULAR]';
    seen.add(v as object);

    if (Array.isArray(v)) return v.map(walk);

    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = REDACT_KEY_RE.test(k) ? '[REDACTED]' : walk(val);
    }
    return out;
  };

  return walk(value) as T;
}

/* ------------------------------------------------------------------ *
 * Structured logger — single-line JSON, correlation ids, same redaction
 * ------------------------------------------------------------------ */

export type LogLevel = 'info' | 'warn' | 'error';

export interface LogRecord {
  ts: string;
  level: LogLevel;
  msg: string;
  correlation_id?: string;
  [k: string]: unknown;
}

export interface LoggerOptions {
  /** When true (default), apply the redaction pass to every field bag. */
  redact?: boolean;
  emailAllowlist?: readonly string[];
  /** Where each single-line JSON string goes. Default: console.log. */
  sink?: (line: string) => void;
  /** Injectable clock for tests. Default: () => new Date().toISOString(). */
  now?: () => string;
}

export interface LogFields {
  correlationId?: string;
  [k: string]: unknown;
}

export interface Logger {
  info(msg: string, fields?: LogFields): LogRecord;
  warn(msg: string, fields?: LogFields): LogRecord;
  error(msg: string, fields?: LogFields): LogRecord;
}

/**
 * Create a structured logger. Each call emits a single-line JSON object to the
 * sink and returns the emitted record (handy for assertions). Secret-named
 * fields and email strings are redacted unless disabled. Exported for
 * apps/api use so the whole platform logs the same shape.
 */
export function createLogger(options: LoggerOptions = {}): Logger {
  const doRedact = options.redact !== false;
  const sink = options.sink ?? ((line: string) => console.log(line));
  const now = options.now ?? (() => new Date().toISOString());
  const allow = options.emailAllowlist;

  const emit = (level: LogLevel, msg: string, fields: LogFields = {}): LogRecord => {
    const { correlationId, ...rest } = fields;
    const bag = doRedact ? (redact(rest, { emailAllowlist: allow }) as Record<string, unknown>) : rest;
    const record: LogRecord = {
      ts: now(),
      level,
      msg: doRedact ? (redact(msg, { emailAllowlist: allow }) as string) : msg,
      ...(correlationId ? { correlation_id: correlationId } : {}),
      ...bag,
    };
    sink(JSON.stringify(record));
    return record;
  };

  return {
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
  };
}

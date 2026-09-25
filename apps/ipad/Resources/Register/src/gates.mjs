/**
 * Gate-report phrasing (pure). The APIs return honest, machine-readable
 * readiness gates (outreach `/settings/gates`, admin health, setup checks).
 * A non-technical owner should never see a raw gate key; this turns a gate
 * object into a plain sentence AND preserves the server's own reason verbatim
 * so we never soften or invent a blocked reason (MAGS build prompt §7).
 *
 * Tolerant of several shapes a gate can arrive in:
 *   { key, open|passed|ok:boolean, reason|message|missing }
 * `missing` may be a string or an array of strings.
 */

/** Human labels for known gate keys; unknown keys fall back to a de-slugged form. */
const GATE_LABELS = {
  armed: 'Sending is turned on',
  consent: 'Customer consent on file',
  postal_address: 'Business mailing address set',
  postalAddress: 'Business mailing address set',
  from_identity: 'From name and email set',
  fromIdentity: 'From name and email set',
  from_email: 'From email address set',
  fromEmail: 'From email address set',
  provider: 'Email provider connected',
  provider_credential: 'Email provider connected',
  approval: 'Campaign approved to send',
  quiet_hours: 'Quiet hours configured',
  suppression: 'Suppression list ready',
  business_identity: 'Business identity complete',
};

export function humanizeKey(key) {
  if (!key) return 'Requirement';
  if (GATE_LABELS[key]) return GATE_LABELS[key];
  return String(key)
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^\w/, (c) => c.toUpperCase());
}

/** Is a gate satisfied? Accepts open|passed|ok|satisfied booleans. */
export function isOpen(gate) {
  if (!gate || typeof gate !== 'object') return false;
  const v = gate.open ?? gate.passed ?? gate.ok ?? gate.satisfied;
  return v === true;
}

/** The server's own reason string, verbatim, if any. */
export function reasonOf(gate) {
  if (!gate || typeof gate !== 'object') return '';
  if (typeof gate.reason === 'string' && gate.reason) return gate.reason;
  if (typeof gate.detail === 'string' && gate.detail) return gate.detail;
  if (typeof gate.message === 'string' && gate.message) return gate.message;
  if (Array.isArray(gate.missing) && gate.missing.length) return gate.missing.join('; ');
  if (typeof gate.missing === 'string' && gate.missing) return gate.missing;
  return '';
}

/**
 * One plain sentence for a gate.
 * @returns {{ key:string, label:string, open:boolean, reason:string, phrase:string }}
 */
export function phraseGate(key, gate) {
  const label = humanizeKey(gate?.label ?? key);
  const open = isOpen(gate);
  const reason = reasonOf(gate);
  const phrase = open
    ? `${label}: ready.`
    : `${label}: not ready${reason ? ` — ${reason}` : '.'}`;
  return { key, label, open, reason, phrase };
}

/**
 * Normalize a whole gate report into a list of phrased gates plus a summary.
 * Accepts either `{ gates: {k:gate} | [gate] }`, a bare map, or an array.
 * @returns {{ gates: Array, openCount:number, blockedCount:number, allOpen:boolean }}
 */
export function phraseReport(report) {
  const raw = report?.gates ?? report ?? {};
  let entries;
  if (Array.isArray(raw)) {
    // Array items may key the gate as `key` or `gate` (outreach uses `gate`).
    entries = raw.map((g, i) => [g.key ?? g.gate ?? String(i), g]);
  } else {
    entries = Object.entries(raw).filter(([, v]) => v && typeof v === 'object');
  }
  const gates = entries.map(([k, g]) => phraseGate(k, g));
  const openCount = gates.filter((g) => g.open).length;
  const blockedCount = gates.length - openCount;
  return { gates, openCount, blockedCount, allOpen: gates.length > 0 && blockedCount === 0 };
}

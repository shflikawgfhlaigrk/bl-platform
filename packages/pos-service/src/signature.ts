import { createHmac, timingSafeEqual } from 'node:crypto';

/** Stripe webhook signature (v1 scheme): HMAC-SHA256 hex over `${timestamp}.${payload}`. */
export function signStripePayload(secret: string, timestamp: number, payload: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${payload}`, 'utf8').digest('hex');
}

export function stripeSignatureHeader(secret: string, timestamp: number, payload: string): string {
  return `t=${timestamp},v1=${signStripePayload(secret, timestamp, payload)}`;
}

export type SignatureCheck =
  | { ok: true; timestamp: number }
  | { ok: false; reason: 'missing_secret' | 'missing_header' | 'malformed_header' | 'timestamp_out_of_tolerance' | 'no_matching_signature' };

/**
 * Verify a Stripe-Signature header against the exact raw request body. Fails closed: a missing
 * secret, a malformed header, a stale timestamp, or no matching v1 signature all reject.
 */
export function verifyStripeSignature(input: {
  payload: string;
  header: string | null | undefined;
  secret: string | null | undefined;
  toleranceSeconds?: number;
  nowSeconds?: number;
}): SignatureCheck {
  if (!input.secret) return { ok: false, reason: 'missing_secret' };
  if (!input.header) return { ok: false, reason: 'missing_header' };
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of input.header.split(',')) {
    const [key, value] = part.split('=', 2).map((s) => s?.trim());
    if (key === 't' && value && /^\d+$/.test(value)) timestamp = Number(value);
    if (key === 'v1' && value && /^[a-f0-9]{64}$/.test(value)) signatures.push(value);
  }
  if (timestamp === null || signatures.length === 0) return { ok: false, reason: 'malformed_header' };
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const tolerance = input.toleranceSeconds ?? 300;
  if (Math.abs(now - timestamp) > tolerance) return { ok: false, reason: 'timestamp_out_of_tolerance' };
  const expected = Buffer.from(signStripePayload(input.secret, timestamp, input.payload), 'utf8');
  const matched = signatures.some((candidate) => {
    const provided = Buffer.from(candidate, 'utf8');
    return provided.length === expected.length && timingSafeEqual(provided, expected);
  });
  return matched ? { ok: true, timestamp } : { ok: false, reason: 'no_matching_signature' };
}

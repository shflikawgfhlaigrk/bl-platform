import { describe, it, expect } from 'vitest';
import { phraseReport, phraseGate, reasonOf, isOpen } from '../src/gates.mjs';

// The exact shape the live /api/outreach/settings/gates endpoint returns.
const LIVE_OUTREACH = {
  armed: false,
  postalAddress: false,
  provider: false,
  fromEmail: false,
  canSend: false,
  gates: [
    { gate: 'armed', open: false, detail: 'not armed (founder must set armed=true)' },
    { gate: 'postal_address', open: false, detail: 'CAN-SPAM postal address missing' },
    { gate: 'provider', open: false, detail: 'no provider connected' },
    { gate: 'from_email', open: false, detail: 'from address missing' },
  ],
};

describe('gate-report phrasing', () => {
  it('phrases the live outreach gate report with keys + verbatim reasons', () => {
    const r = phraseReport(LIVE_OUTREACH);
    expect(r.gates).toHaveLength(4);
    expect(r.blockedCount).toBe(4);
    expect(r.allOpen).toBe(false);
    const armed = r.gates.find((g) => g.key === 'armed')!;
    expect(armed.label).toBe('Sending is turned on'); // plain language, not the key
    expect(armed.reason).toBe('not armed (founder must set armed=true)'); // verbatim
    expect(armed.open).toBe(false);
  });

  it('marks a satisfied gate open and reports allOpen when nothing blocks', () => {
    const r = phraseReport({ gates: [{ gate: 'provider', open: true }] });
    expect(r.allOpen).toBe(true);
    expect(r.openCount).toBe(1);
    expect(r.blockedCount).toBe(0);
  });

  it('reads open/passed/ok booleans and reason/detail/message reasons', () => {
    expect(isOpen({ passed: true })).toBe(true);
    expect(isOpen({ ok: true })).toBe(true);
    expect(isOpen({ open: false })).toBe(false);
    expect(reasonOf({ detail: 'd' })).toBe('d');
    expect(reasonOf({ reason: 'r' })).toBe('r');
    expect(reasonOf({ missing: ['a', 'b'] })).toBe('a; b');
  });

  it('handles a bare map of gates (no wrapper array)', () => {
    const r = phraseReport({ consent: { open: false, reason: 'no consent' }, provider: { open: true } });
    expect(r.gates).toHaveLength(2);
    expect(r.blockedCount).toBe(1);
  });

  it('phraseGate produces a readable sentence', () => {
    const g = phraseGate('postal_address', { open: false, detail: 'address missing' });
    expect(g.phrase).toBe('Business mailing address set: not ready — address missing');
  });
});

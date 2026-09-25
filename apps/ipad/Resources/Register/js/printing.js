import { formatCents } from '../src/money.mjs';

const amountRow = (label, cents) => {
  const amount = formatCents(cents);
  return label.length + amount.length <= 42 ? label + ' '.repeat(42 - label.length - amount.length) + amount : `${label}\n${amount.padStart(42)}`;
};

export function ticketPrintDocument(ticket) {
  const t = ticket.value;
  const role = t.station === 'kitchen' ? 'kitchen' : 'bar';
  return { documentId: `ticket:${ticket.id}`, role, revision: ticket.version,
    text: [ticket.version > 1 ? 'UPDATED TICKET' : 'NEW TICKET', `${role.toUpperCase()} · ${t.tabName}`,
      t.table || 'Bar', `Ticket ${ticket.id}`, new Date(ticket.createdAt).toLocaleString(), '',
      ...t.items.flatMap(i => [`${i.voided ? 'VOID — ' : ''}${i.name} · Seat ${i.seat}`,
        ...(i.modifiers || []), ...(i.instructions ? [i.instructions] : []), ''])].join('\n') };
}

export function receiptPrintDocument(receipt) {
  const { order, tenders, merchant } = receipt;
  return { documentId: `receipt:${order.id}`, role: 'receipt',
    text: [merchant.name, `Receipt ${order.receipt_number}`, order.status.toUpperCase(), '',
      ...(order.note?.startsWith('Bill:') ? [order.note, ''] : []),
      ...order.lines.map(l => amountRow(`${l.qty ?? 1} × ${l.description}`, l.line_total_cents)),
      amountRow('Tax', order.tax_cents), amountRow('Tip', order.tip_cents), amountRow('TOTAL', order.total_cents), '',
      amountRow('Paid', receipt.amountPaidCents), amountRow('Refunded', receipt.amountRefundedCents),
      ...tenders.filter(t => ['captured', 'partially_refunded', 'refunded'].includes(t.status)).flatMap(t => [
        amountRow(t.kind === 'provider' ? 'Card' : t.kind === 'cash' ? 'Cash' : 'Payment', t.amount_cents),
        ...(t.provider_ref ? [`Transaction ID: ${t.provider_ref}`] : []),
        ...(t.kind === 'cash' ? [amountRow('Cash received', t.cash_received_cents), amountRow('Change given', t.change_due_cents)] : [])]),
      '', merchant.receiptFooter || ''].join('\n') };
}

/** One serial stream to the native printer; financial requests never enter it. */
export function createPrintClient({ getBridge, now = Date.now, randomID = () => crypto.randomUUID(), onChange = () => {} }) {
  let tail = Promise.resolve(), pumping = false;
  let configuration = { configuredRoles: [], automaticRoles: [] };
  const outcomes = new Map();
  const enqueue = action => {
    const next = tail.then(action, action);
    tail = next.catch(() => {});
    return next;
  };
  function remember(key, result) { outcomes.set(key, { ...result, checkedAt: now() }); onChange(); }
  const keyFor = ticket => `ticket:${ticket.id}:${ticket.version}`;
  async function manual(document, reprint = false) {
    const bridge = getBridge();
    if (!bridge) return { status: 'browser' };
    return enqueue(() => bridge.print({ id: randomID(), ...document, automatic: false, reprint }));
  }
  async function pump(tickets) {
    const bridge = getBridge();
    if (!bridge || pumping) return;
    pumping = true;
    try {
      configuration = await bridge.status();
      const candidates = tickets.filter(t => t.value.status === 'queued'
        && configuration.automaticRoles.includes(t.value.station || 'bar')
        && configuration.configuredRoles.includes(t.value.station || 'bar'))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      let attempted = 0;
      for (const ticket of candidates) {
        const key = keyFor(ticket), previous = outcomes.get(key);
        if (previous && (['submitted', 'alreadySubmitted', 'unknown'].includes(previous.status) || now() - previous.checkedAt < 30_000)) continue;
        if (attempted++ >= 3) break;
        try {
          const result = await enqueue(() => bridge.print({ id: key, ...ticketPrintDocument(ticket), automatic: true, reprint: false }));
          remember(key, result);
        } catch (error) { remember(key, { status: 'failed', message: error.message || String(error) }); }
      }
    } catch (error) { configuration = { configuredRoles: [], automaticRoles: [], error: error.message || String(error) }; }
    finally { pumping = false; }
  }
  return { manual, pump, status: ticket => outcomes.get(keyFor(ticket)), configuration: () => configuration };
}

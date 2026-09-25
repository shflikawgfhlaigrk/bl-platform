import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const register = readFileSync(path.resolve(here, '../public/js/views/register.js'), 'utf8');
const orders = readFileSync(path.resolve(here, '../public/js/views/orders.js'), 'utf8');

describe('POS register static view contract', () => {
  it('registers a real route and uses catalog barcode/SKU/name lookup', () => {
    expect(register).toMatch(/registerView\(['"]register['"]/);
    expect(register).toContain("const POS_CATALOG_ENDPOINT = '/api/pos/catalog'");
    expect(register).toContain('getData(POS_CATALOG_ENDPOINT, { code: term })');
    expect(register).toContain("lookup.matchType === 'barcode'");
    expect(register).toContain("lookup.matchType === 'sku'");
  });

  it('uses the server-authoritative POS facade and readiness gates', () => {
    expect(register).toContain("const POS_ORDER_ENDPOINT = '/api/pos/orders'");
    expect(register).toContain("const POS_READINESS_ENDPOINT = '/api/pos/readiness'");
    expect(register).toContain("readiness?.operational === true");
    expect(register).toContain('authoritativeTotalCents');
    expect(register).toContain('/api/pos/receipts/');
  });

  it('shows server-provided tax read-only while keeping discounts editable', () => {
    expect(register).toContain('const configuredTax = readiness?.settings?.taxBps');
    expect(register).toContain('tax.readOnly = true');
    expect(register).toContain("tax.setAttribute('aria-readonly', 'true')");
    expect(register).toContain('for (const control of [discountPercent, discountFixed])');
    expect(register).not.toContain('POS_SETTINGS_ENDPOINT');
    expect(register).not.toContain('updateTaxSetting');
  });

  it('requires an open persisted drawer shift for cash tenders', () => {
    expect(register).toContain("const POS_DRAWER_ENDPOINT = '/api/pos/drawer'");
    expect(register).toContain('setRegisterContext');
    expect(register).toContain("cashSessionId: state.cashSessionId");
    expect(register).toContain("registerId: state.registerId");
    expect(register).toContain('hasOpenDrawer()');
    expect(register).toContain("value: 'paid_in'");
    expect(register).toContain("value: 'paid_out'");
    expect(register).toContain("value: 'drop'");
    expect(register).toContain('/movements`');
    expect(register).toContain('/close`');
  });

  it('persists active, held, and pending-payment state locally', () => {
    expect(register).toContain('REGISTER_STORAGE_KEY');
    expect(register).toContain('localStorage.getItem');
    expect(register).toContain('localStorage.setItem');
    expect(register).toContain('holdActiveCart');
    expect(register).toContain('resumeHeldCart');
    expect(register).toContain('setPendingCheckout');
    expect(register).toContain('Recover payment');
  });

  it('supports cash/external/split payment but never fabricates card capture', () => {
    expect(register).toContain("value: 'cash'");
    expect(register).toContain("value: 'external'");
    expect(register).toContain("value: 'split'");
    expect(register).toContain('Card reader not configured.');
    expect(register).not.toMatch(/kind:\s*['"]card['"]/);
    expect(register).toContain('`/api/pos/orders/${orderId}/pay`');
    expect(register).toContain('Cash received $');
    expect(register).toContain('Change due');
    expect(register).toContain("if (!provider) throw new Error('External payment source is required')");
    expect(register).toContain("if (!providerRef) throw new Error('External payment reference is required')");
  });

  it('renders a printable receipt from server-returned order lines and tenders', () => {
    expect(register).toContain("class: 'printable'");
    expect(register).toContain('order.lines || []');
    expect(register).toContain('window.print()');
    expect(register).toContain('/tenders`');
    expect(register).toContain('projection?.cashier?.name');
    expect(register).toContain('`Cashier: ${projection.cashier.name}`');
  });

  it('uses accessible app-owned dialogs for every register confirmation', () => {
    expect(register).not.toMatch(/\b(?:window\.)?confirm\s*\(/);
    expect(register).toContain('function confirmAction');
    expect(register).toContain("dialog.setAttribute('aria-labelledby', titleId)");
    expect(register).toContain("dialog.setAttribute('aria-describedby', messageId)");
    expect(register).toContain("dialog.setAttribute('data-pos-confirmation', 'true')");
    expect(register).toContain("dialog.close('confirm')");
    expect(register.match(/await confirmAction\(\{/g)).toHaveLength(7);
    for (const action of [
      'Refund and cancel',
      'Delete held cart',
      'Clear cart',
      'Complete sale',
      'Send updated total',
      'Cancel card payment',
      'Continue to payment',
    ]) {
      expect(register).toContain(`confirmLabel: '${action}'`);
    }
  });
});

describe('POS order detail static contract', () => {
  it('loads tenders and refunds separately because order detail does not embed them', () => {
    expect(orders).toContain('/tenders`');
    expect(orders).toContain('/refunds`');
    expect(orders).toContain('Promise.all');
  });

  it('posts a refund tied to one tender and selected line dispositions through the channel facade', () => {
    expect(orders).toContain("name: 'returnLine'");
    expect(orders).toContain('tenderId: tender.id');
    expect(orders).toContain('amountCents');
    expect(orders).toContain('lineId: checkbox.value');
    for (const disposition of ['none', 'restock', 'quarantine', 'damaged']) {
      expect(orders).toContain(`value: '${disposition}'`);
    }
    expect(orders).toContain("const refundEndpoint = order.channel === 'pos'");
    expect(orders).toContain('? `/api/pos/orders/${id}/refunds`');
    expect(orders).toContain(': `/api/orders/orders/${id}/refunds`');
    expect(orders).toContain("await mutate(refundEndpoint, 'POST', {");
    expect(orders).toContain("'POST', {");
  });

  it('caps partial returns to the server-projected remaining quantity and treats pending refunds honestly', () => {
    expect(orders).toContain("line?.returned_qty ?? line?.returnedQty");
    expect(orders).toContain("line?.pending_return_qty ?? line?.pendingReturnQty");
    expect(orders).toContain("line?.returnable_qty ?? line?.returnableQty");
    expect(orders).toContain('value: String(remainingQty)');
    expect(orders).toContain("qty.setAttribute('max', String(remainingQty))");
    expect(orders).toContain('qty > returnableQty(source)');
    expect(orders).toContain("refund.status === 'pending'");
    expect(orders).toContain('processor confirmation is pending');
    expect(orders).toContain(".filter((refund) => refund.status === 'completed')");
  });

  it('reuses one refund key per dialog and scopes cash drawer identity to cash refunds', () => {
    const dialogStart = orders.indexOf('function openRefundDialog');
    const submitStart = orders.indexOf('async function submitRefund', dialogStart);
    const dialogPrefix = orders.slice(dialogStart, submitStart);
    const submitBody = orders.slice(submitStart, orders.indexOf('\n  function printReceipt', submitStart));
    expect(dialogStart).toBeGreaterThan(-1);
    expect(submitStart).toBeGreaterThan(dialogStart);
    expect(dialogPrefix).toContain('const refundIdempotencyKey = newIdempotencyKey();');
    expect(submitBody).toContain('idempotencyKey: refundIdempotencyKey');
    expect(submitBody).toContain('deserializeRegisterState(localStorage.getItem(REGISTER_STORAGE_KEY))');
    expect(submitBody).toContain('!registerState.drawerRef || !registerState.cashSessionId');
    expect(submitBody).toContain("getData('/api/pos/drawer', { drawerRef: registerState.drawerRef })");
    expect(submitBody).toContain("currentDrawer?.session?.status !== 'open'");
    expect(submitBody).toContain('currentDrawer.session.id !== registerState.cashSessionId');
    expect(submitBody).toContain('cashSessionId = registerState.cashSessionId');
    expect(submitBody).toContain("...(tender.kind === 'cash' ? { cashSessionId } : {})");
  });

  it('shows true buyer-empty order history and prints receipts', () => {
    expect(orders).toContain('No orders yet');
    expect(orders).toContain("sort: '-created_at'");
    expect(orders).toContain("class: 'printable'");
    expect(orders).toContain('window.print()');
    expect(orders).toContain('Cashier: projection?.cashier?.name');
    expect(orders).toContain('`Cashier: ${projection.cashier.name}`');
  });

  it('uses an app-owned cancellation dialog instead of a native browser confirm', () => {
    expect(orders).toContain("dialogShell('Cancel unpaid order')");
    expect(orders).toContain("button('Keep order'");
    expect(orders).toContain("button('Cancel order'");
    expect(orders).not.toMatch(/\b(?:window\.)?confirm\s*\(/);
  });
});

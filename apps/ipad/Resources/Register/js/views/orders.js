import { clubBrand } from '../brand.js';
/** #/orders — unified sale history, tender detail, receipts, and returns. */
import { registerView, navigate } from '../router.js';
import { el, clear, toast, announce } from '../dom.js';
import { getData, getList, mutate, newIdempotencyKey } from '../api.js';
import { viewHeader, emptyState, dataTable, button, section, field, input, select, withLoading, chip, detailList } from '../ui.js';
import { formatCents } from '../../../src/money.mjs';
import { formatDate } from '../../../src/format.mjs';
import { REGISTER_STORAGE_KEY, deserializeRegisterState, parseMoneyToCents } from '../../../src/cart.mjs';

const REFUNDABLE_STATUSES = new Set(['paid', 'partially_fulfilled', 'fulfilled', 'partially_returned']);
const PAYABLE_STATUSES = new Set(['draft', 'reserved']);

registerView('orders', async (container, params) => {
  if (params[0]) return renderOrder(container, params[0]);
  container.append(
    viewHeader({
      title: 'Orders',
      subtitle: 'Every sale and return recorded by this system.',
      actions: [
        button('Open register', { primary: true, href: '#/register' }),
        button('Create manual draft', { onClick: createManualOrder }),
      ],
    }),
  );

  const filterStatus = select('status', [
    { value: '', label: 'All statuses' },
    { value: 'draft', label: 'Draft' },
    { value: 'reserved', label: 'Reserved' },
    { value: 'paid', label: 'Paid' },
    { value: 'partially_fulfilled', label: 'Partially fulfilled' },
    { value: 'fulfilled', label: 'Fulfilled' },
    { value: 'partially_returned', label: 'Partially returned' },
    { value: 'returned', label: 'Returned' },
    { value: 'canceled', label: 'Canceled' },
  ], '');
  const slot = el('div');
  container.append(section('Filter', field('Status', filterStatus)), slot);
  filterStatus.addEventListener('change', load);
  load();

  async function load() {
    await withLoading(slot, async () => {
      const list = await getList('/api/orders/orders', {
        limit: 100,
        sort: '-created_at',
        status: filterStatus.value || undefined,
      });
      const rows = list.data || [];
      if (!rows.length) {
        return emptyState({
          icon: '🧾',
          title: 'No orders yet',
          message: filterStatus.value ? 'No orders match this status.' : 'Start a sale in Register. Nothing is pre-filled.',
          actions: [button('Open register', { primary: true, href: '#/register' })],
        });
      }
      return dataTable([
        { key: 'receipt_number', label: 'Receipt', render: (row) => row.receipt_number || row.receiptNumber || shortId(row.id) },
        { key: 'channel', label: 'Channel' },
        { key: 'status', label: 'Status', render: (row) => chip(statusLabel(row.status), statusVariant(row.status)) },
        { key: 'total_cents', label: 'Total', num: true, render: (row) => formatCents(centsOf(row, 'total')) },
        { key: 'created_at', label: 'Date', render: (row) => formatDate(row.created_at || row.createdAt) },
        { key: 'open', label: '', render: (row) => button('Open', { onClick: () => navigate(`#/orders/${row.id}`) }) },
      ], rows);
    });
  }

  async function createManualOrder() {
    try {
      const response = await mutate('/api/orders/orders', 'POST', { channel: 'manual', lines: [] });
      const order = response.data || response;
      navigate(`#/orders/${order.id}`);
    } catch (error) {
      toast(error.message, 'err');
    }
  }
});

async function renderOrder(container, id) {
  const screen = el('div', { class: 'print-hide' });
  const printableSlot = el('div');
  const slot = el('div');
  screen.append(
    viewHeader({
      title: 'Order',
      actions: [button('Back', { href: '#/orders' }), button('Print receipt', { onClick: () => printReceipt() })],
    }),
    slot,
  );
  container.append(screen, printableSlot);
  let printable = false;
  await refresh();

  async function refresh() {
    await withLoading(slot, async () => {
      let order = await getData(`/api/orders/orders/${id}`);
      let projection = null;
      const [tenders, refunds] = await Promise.all([
        getData(`/api/orders/orders/${id}/tenders`).catch(() => []),
        getData(`/api/orders/orders/${id}/refunds`).catch(() => []),
      ]);
      if (order.channel === 'pos') {
        projection = await getData(`/api/pos/receipts/${id}`).catch(() => null);
        order = projection?.order || order;
      }
      printable = true;
      renderOrderReceipt(
        printableSlot,
        order,
        projection?.tenders || tenders || [],
        projection?.refunds || refunds || [],
        projection,
      );
      return orderDetail(order, tenders || [], refunds || [], projection);
    });
  }

  function orderDetail(order, tenders, refunds, projection = null) {
    const wrap = el('div');
    const status = order.status || 'draft';
    const availableTenders = refundableTenders(tenders, refunds);
    const hasPendingRefund = (refunds || []).some((refund) => refund.status === 'pending');
    const actionBar = el('div', { class: 'view-actions', style: 'margin-top:12px' }, [
      status === 'draft' ? button('Reserve stock', { onClick: () => transition('reserve') }) : null,
      PAYABLE_STATUSES.has(status) ? button('Cancel order', { danger: true, onClick: () => cancelOrder() }) : null,
      REFUNDABLE_STATUSES.has(status)
        ? button('Refund / return…', { primary: true, disabled: !availableTenders.length, onClick: () => openRefundDialog(order, tenders, refunds) })
        : null,
    ]);
    wrap.append(
      section(
        `Order ${shortId(order.id)}`,
        detailList({
          Receipt: order.receipt_number || order.receiptNumber || shortId(order.id),
          Channel: order.channel,
          Status: chip(statusLabel(status), statusVariant(status)),
          Cashier: projection?.cashier?.name || order.cashier_name || order.cashierName || order.cashier_id || order.cashierId || 'Not assigned',
          Customer: order.customer_id || order.customerId || 'Walk-up / anonymous',
          Created: formatDate(order.created_at || order.createdAt),
          Subtotal: formatCents(centsOf(order, 'subtotal')),
          Discount: formatCents(centsOf(order, 'discount')),
          Tax: formatCents(centsOf(order, 'tax')),
          Total: formatCents(centsOf(order, 'total')),
        }),
        actionBar,
        REFUNDABLE_STATUSES.has(status) && !availableTenders.length
          ? el('p', { class: 'view-sub', style: 'margin-top:10px' }, hasPendingRefund
            ? 'A processor refund is pending confirmation. This tender cannot be refunded again until it completes or fails.'
            : 'No captured tender has a refundable balance.')
          : null,
      ),
      section(
        'Items',
        dataTable([
          { key: 'description', label: 'Item' },
          { key: 'qty', label: 'Qty', num: true },
          { key: 'returned_qty', label: 'Returned', num: true, render: (line) => String(returnedQty(line)) },
          { key: 'pending_return_qty', label: 'Pending', num: true, render: (line) => String(pendingReturnQty(line)) },
          { key: 'returnable_qty', label: 'Returnable', num: true, render: (line) => String(returnableQty(line)) },
          { key: 'unit_price_cents', label: 'Unit', num: true, render: (line) => formatCents(centsOf(line, 'unit_price')) },
          { key: 'line_total_cents', label: 'Total', num: true, render: (line) => formatCents(lineTotal(line)) },
          { key: 'fulfillment_state', label: 'State', render: (line) => statusLabel(line.fulfillment_state || line.fulfillmentState || 'pending') },
        ], order.lines || [], { emptyMessage: 'No lines on this order.' }),
      ),
      section(
        'Payments',
        dataTable([
          { key: 'kind', label: 'Tender', render: (tender) => statusLabel(tender.kind) },
          { key: 'provider_ref', label: 'Reference', render: (tender) => tender.provider_ref || tender.providerRef || '—' },
          { key: 'amount_cents', label: 'Captured', num: true, render: (tender) => formatCents(centsOf(tender, 'amount')) },
          { key: 'cash_received_cents', label: 'Cash received', num: true, render: (tender) => tender.kind === 'cash' ? formatCents(centsOf(tender, 'cash_received')) : '—' },
          { key: 'change_due_cents', label: 'Change', num: true, render: (tender) => tender.kind === 'cash' ? formatCents(centsOf(tender, 'change_due')) : '—' },
          { key: 'refunded_cents', label: 'Refunded', num: true, render: (tender) => formatCents(centsOf(tender, 'refunded')) },
          { key: 'status', label: 'Status', render: (tender) => chip(statusLabel(tender.status), statusVariant(tender.status)) },
        ], tenders, { emptyMessage: 'No tenders recorded.' }),
      ),
      section(
        'Refunds',
        dataTable([
          { key: 'id', label: 'Refund', render: (refund) => shortId(refund.id) },
          { key: 'amount_cents', label: 'Amount', num: true, render: (refund) => formatCents(centsOf(refund, 'amount')) },
          { key: 'reason', label: 'Reason', render: (refund) => refund.reason || '—' },
          { key: 'status', label: 'Status', render: (refund) => chip(statusLabel(refund.status), statusVariant(refund.status)) },
          { key: 'created_at', label: 'Date', render: (refund) => formatDate(refund.created_at || refund.createdAt) },
        ], refunds, { emptyMessage: 'No refunds recorded.' }),
      ),
    );
    return wrap;
  }

  async function transition(action) {
    try {
      await mutate(`/api/orders/orders/${id}/${action}`, 'POST', {});
      toast(action === 'reserve' ? 'Stock reserved.' : 'Order updated.');
      await refresh();
    } catch (error) {
      toast(error.message, 'err');
    }
  }

  function cancelOrder() {
    const dialog = dialogShell('Cancel unpaid order');
    dialog.setAttribute('aria-label', 'Cancel unpaid order');
    const keep = button('Keep order', { onClick: () => dialog.close() });
    const cancel = button('Cancel order', {
      danger: true,
      onClick: async () => {
        cancel.disabled = true;
        try {
          await mutate(`/api/orders/orders/${id}/cancel`, 'POST', {});
          toast('Order canceled.');
          dialog.close();
          await refresh();
        } catch (error) {
          cancel.disabled = false;
          toast(error.message, 'err');
        }
      },
    });
    dialog.append(
      el('p', { class: 'view-sub' }, 'This releases any reservation and leaves the unpaid order canceled.'),
      el('div', { class: 'view-actions' }, [keep, cancel]),
    );
    openDialog(dialog, keep);
  }

  function openRefundDialog(order, tenders, refunds) {
    const available = refundableTenders(tenders, refunds);
    if (!available.length) return toast('No tender is currently available for a refund.', 'warn');
    const refundIdempotencyKey = newIdempotencyKey();
    const dialog = dialogShell('Refund / return');
    const tenderSelect = select('tenderId', available.map((tender) => ({
      value: tender.id,
      label: `${statusLabel(tender.kind)} · ${formatCents(refundableCents(tender))} available${tender.provider_ref ? ` · ${tender.provider_ref}` : ''}`,
    })), available[0].id);
    const amount = input({ name: 'refundAmount', value: moneyInput(refundableCents(available[0])), required: true });
    amount.setAttribute('inputmode', 'decimal');
    const reason = input({ name: 'reason', placeholder: 'Reason for return (optional)' });
    const lineControls = el('div');
    dialog.append(
      el('p', { class: 'view-sub' }, 'Select at least one returned line and choose an inventory disposition. Processor-backed tenders are refunded through their original provider; manually recorded external tenders must also be returned in that source system.'),
      field('Refund from tender', tenderSelect),
      field('Refund amount $', amount),
      field('Reason', reason),
      el('h3', {}, 'Returned items'),
      lineControls,
      el('div', { class: 'view-actions', style: 'margin-top:16px' }, [
        button('Cancel', { onClick: () => dialog.close() }),
        button('Submit refund', { danger: true, big: true, onClick: submitRefund }),
      ]),
    );
    tenderSelect.addEventListener('change', () => {
      const tender = available.find((row) => row.id === tenderSelect.value);
      if (tender) amount.value = moneyInput(refundableCents(tender));
    });
    paintLines();
    openDialog(dialog, tenderSelect);

    function paintLines() {
      clear(lineControls);
      const lines = (order.lines || []).filter((line) => returnableQty(line) > 0);
      if (!lines.length) {
        lineControls.append(el('p', { class: 'view-sub' }, 'No returnable lines remain.'));
        return;
      }
      for (const line of lines) {
        const remainingQty = returnableQty(line);
        const checkbox = el('input', { type: 'checkbox', name: 'returnLine', value: line.id, 'aria-label': `Return ${line.description}` });
        checkbox.style.width = '44px';
        const qty = input({ name: `qty_${line.id}`, type: 'number', value: String(remainingQty), min: 1 });
        qty.setAttribute('max', String(remainingQty));
        qty.disabled = true;
        const disposition = select(`disposition_${line.id}`, [
          { value: 'none', label: 'Do not restock' },
          { value: 'restock', label: 'Return to stock' },
          { value: 'quarantine', label: 'Quarantine' },
          { value: 'damaged', label: 'Damaged' },
        ], 'none');
        disposition.disabled = true;
        checkbox.addEventListener('change', () => {
          qty.disabled = !checkbox.checked;
          disposition.disabled = !checkbox.checked;
        });
        lineControls.append(el('div', { class: 'card', style: 'box-shadow:none;margin:8px 0;padding:12px;display:grid;grid-template-columns:auto minmax(0,1fr);gap:10px;align-items:center' }, [
          checkbox,
          el('div', {}, [
            el('strong', {}, line.description),
            el('div', { style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:8px;margin-top:8px' }, [
              field(`Quantity (max ${remainingQty})`, qty),
              field('Disposition', disposition),
            ]),
          ]),
        ]));
      }
    }

    async function submitRefund() {
      try {
        const tender = available.find((row) => row.id === tenderSelect.value);
        if (!tender) throw new Error('Choose a refundable tender');
        let cashSessionId;
        if (tender.kind === 'cash') {
          const registerState = deserializeRegisterState(localStorage.getItem(REGISTER_STORAGE_KEY));
          if (!registerState.drawerRef || !registerState.cashSessionId) {
            throw new Error('Open a cash drawer shift before recording a cash refund.');
          }
          const currentDrawer = await getData('/api/pos/drawer', { drawerRef: registerState.drawerRef });
          if (currentDrawer?.session?.status !== 'open' || currentDrawer.session.id !== registerState.cashSessionId) {
            throw new Error('The saved cash drawer shift is no longer open. Return to Register and reopen the drawer.');
          }
          cashSessionId = registerState.cashSessionId;
        }
        const amountCents = parseMoneyToCents(amount.value);
        if (amountCents <= 0) throw new Error('Refund amount must be greater than $0');
        if (amountCents > refundableCents(tender)) throw new Error('Refund amount exceeds this tender’s remaining balance');
        const lines = Array.from(lineControls.querySelectorAll('input[name="returnLine"]:checked')).map((checkbox) => {
          const source = (order.lines || []).find((line) => line.id === checkbox.value);
          const qtyControl = lineControls.querySelector(`[name="qty_${cssEscape(checkbox.value)}"]`);
          const dispositionControl = lineControls.querySelector(`[name="disposition_${cssEscape(checkbox.value)}"]`);
          const qty = Number(qtyControl?.value);
          if (!source || !Number.isFinite(qty) || qty <= 0 || qty > returnableQty(source)) throw new Error(`Enter a valid return quantity for ${source?.description || 'the selected line'}`);
          return { lineId: checkbox.value, qty, disposition: dispositionControl?.value || 'none' };
        });
        if (!lines.length) throw new Error('Select at least one returned line');
        const refundEndpoint = order.channel === 'pos'
          ? `/api/pos/orders/${id}/refunds`
          : `/api/orders/orders/${id}/refunds`;
        const response = await mutate(refundEndpoint, 'POST', {
          tenderId: tender.id,
          idempotencyKey: refundIdempotencyKey,
          ...(tender.kind === 'cash' ? { cashSessionId } : {}),
          amountCents,
          reason: reason.value.trim() || undefined,
          lines,
        });
        const refund = response?.data?.refund;
        const pending = refund?.status === 'pending';
        dialog.close();
        toast(pending
          ? `Refund of ${formatCents(amountCents)} submitted; processor confirmation is pending.`
          : `Refund of ${formatCents(amountCents)} completed.`);
        announce(pending ? 'Refund submitted and pending' : 'Refund completed');
        await refresh();
      } catch (error) {
        toast(error.message, 'err', 6000);
      }
    }
  }

  function printReceipt() {
    if (!printable) return toast('Receipt is still loading.', 'warn');
    document.body.dataset.print = 'receipt';
    window.print();
  }
}

function refundableTenders(tenders, refunds = []) {
  const pendingTenderIds = new Set(
    refunds
      .filter((refund) => refund.status === 'pending')
      .map((refund) => refund.tender_id || refund.tenderId),
  );
  return (tenders || []).filter((tender) =>
    ['captured', 'partially_refunded'].includes(tender.status)
      && refundableCents(tender) > 0
      && !pendingTenderIds.has(tender.id),
  );
}

function returnedQty(line) {
  const explicit = line?.returned_qty ?? line?.returnedQty;
  if (Number.isFinite(explicit)) return Math.max(0, Number(explicit));
  return (line?.fulfillment_state || line?.fulfillmentState) === 'returned'
    ? Math.max(0, Number(line?.qty) || 0)
    : 0;
}

function pendingReturnQty(line) {
  const explicit = line?.pending_return_qty ?? line?.pendingReturnQty;
  return Number.isFinite(explicit) ? Math.max(0, Number(explicit)) : 0;
}

function returnableQty(line) {
  const explicit = line?.returnable_qty ?? line?.returnableQty;
  if (Number.isFinite(explicit)) return Math.max(0, Number(explicit));
  return Math.max(0, (Number(line?.qty) || 0) - returnedQty(line) - pendingReturnQty(line));
}

function refundableCents(tender) {
  return Math.max(0, centsOf(tender, 'amount') - centsOf(tender, 'refunded'));
}

function lineTotal(line) {
  const stored = line.line_total_cents ?? line.lineTotalCents;
  return Number.isSafeInteger(stored) ? stored : Math.round((Number(line.qty) || 0) * centsOf(line, 'unit_price'));
}

function centsOf(row, stem) {
  const value = row?.[`${stem}_cents`] ?? row?.[`${stem}Cents`] ?? 0;
  return Number.isSafeInteger(value) ? value : 0;
}

function shortId(value) {
  const id = String(value || '');
  return id.length > 12 ? `${id.slice(0, 8)}…` : id || '—';
}

function statusLabel(value) {
  return String(value || 'unknown').replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function statusVariant(status) {
  if (['paid', 'fulfilled', 'completed', 'captured'].includes(status)) return 'ok';
  if (['canceled', 'failed', 'voided'].includes(status)) return 'critical';
  if (['reserved', 'partially_fulfilled', 'partially_returned', 'partially_refunded'].includes(status)) return 'high';
  return 'medium';
}

function moneyInput(cents) {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

function cssEscape(value) {
  if (globalThis.CSS?.escape) return CSS.escape(value);
  return String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
}

function dialogShell(title) {
  return el('dialog', {
    'aria-label': title,
    style: 'width:min(680px,calc(100vw - 24px));max-height:calc(100vh - 24px);overflow:auto;border:1px solid var(--border);border-radius:var(--radius);background:var(--surface);color:var(--text);padding:20px;box-shadow:var(--shadow)',
  }, el('h2', {}, title));
}

function openDialog(dialog, focusTarget) {
  document.body.append(dialog);
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  dialog.showModal();
  setTimeout(() => focusTarget?.focus(), 0);
}

function renderOrderReceipt(slot, order, tenders, refunds, projection = null) {
  clear(slot);
  const refundTotal = refunds
    .filter((refund) => refund.status === 'completed')
    .reduce((sum, refund) => sum + centsOf(refund, 'amount'), 0);
  slot.append(el('article', { class: 'printable', 'aria-label': `Receipt for order ${order.id}` }, [
    clubBrand('receipt-brand'),
    el('h1', {}, projection?.merchant?.name || 'Receipt'),
    projection?.merchant?.name ? el('h2', {}, 'Receipt') : null,
    el('p', {}, `Receipt ${order.receipt_number || order.receiptNumber || order.id}`),
    el('p', {}, new Date(order.paid_at || order.paidAt || order.created_at || order.createdAt || Date.now()).toLocaleString()),
    projection?.cashier?.name
      ? el('p', {}, `Cashier: ${projection.cashier.name}`)
      : null,
    el('table', {}, [
      el('thead', {}, el('tr', {}, [el('th', {}, 'Item'), el('th', {}, 'Qty'), el('th', {}, 'Amount')])),
      el('tbody', {}, (order.lines || []).map((line) => el('tr', {}, [
        el('td', {}, line.description || 'Item'),
        el('td', {}, returnedQty(line) > 0 || pendingReturnQty(line) > 0
          ? `${line.qty} (${returnedQty(line)} returned, ${pendingReturnQty(line)} pending, ${returnableQty(line)} remaining)`
          : String(line.qty)),
        el('td', {}, formatCents(lineTotal(line))),
      ]))),
    ]),
    receiptRow('Subtotal', centsOf(order, 'subtotal')),
    receiptRow('Discount', -centsOf(order, 'discount')),
    receiptRow('Tax', centsOf(order, 'tax')),
    receiptRow('Total', centsOf(order, 'total'), true),
    ...tenders.flatMap((tender) => {
      const rows = [receiptRow(tender.kind === 'provider' || tender.kind === 'card' ? 'Card' : `${statusLabel(tender.kind)} tender`, centsOf(tender, 'amount'))];
      if (tender.kind === 'cash') {
        rows.push(receiptRow('Cash received', centsOf(tender, 'cash_received')));
        rows.push(receiptRow('Change due', centsOf(tender, 'change_due'), true));
      }
      return rows;
    }),
    refundTotal ? receiptRow('Refunded', -refundTotal, true) : null,
    projection?.merchant?.receiptFooter
      ? el('p', { style: 'margin-top:16px' }, projection.merchant.receiptFooter)
      : null,
  ]));
}

function receiptRow(label, cents, strong = false) {
  return el('div', { style: `display:flex;justify-content:space-between;gap:20px;padding-top:4px;${strong ? 'font-weight:800;border-top:1px solid #000;margin-top:4px' : ''}` }, [
    el('span', {}, label),
    el('span', {}, formatCents(cents)),
  ]);
}

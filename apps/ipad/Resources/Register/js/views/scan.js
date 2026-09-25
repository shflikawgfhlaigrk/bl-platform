/** #/scan — always-focused scan screen with optimistic feedback + offline queue. */
import { registerView } from '../router.js';
import { el, clear, toast, flash, announce } from '../dom.js';
import { getData, mutate, newIdempotencyKey } from '../api.js';
import { viewHeader, emptyState, button, qtyStepper, section, chip, dataTable } from '../ui.js';
import { beepOk, buzzError } from '../audio.js';
import { formatCents } from '../../../src/money.mjs';
import { aggregateScan, DEFAULT_WINDOW_MS } from '../../../src/scan.mjs';

const REASON = { receive: 'received', sell: 'sold', count: 'counted' };

registerView('scan', async (container) => {
  container.append(viewHeader({ title: 'Scan', subtitle: 'Scan an item, then choose what happened.' }));

  // Need at least one location to post movements against.
  let locations = [];
  try {
    locations = (await getData('/api/inventory/locations')) || [];
  } catch {
    locations = [];
  }
  if (!locations.length) {
    container.append(
      emptyState({
        icon: '📍',
        title: 'Add a stock location first',
        message: 'Scanning records stock moving in and out of a place — a warehouse, the trailer, a show. Create one in Stock, then come back.',
        actions: [button('Go to Stock', { primary: true, href: '#/stock' })],
      }),
    );
    return;
  }

  let currentLocation = locations[0].id;
  const locSelect = el(
    'select',
    { 'aria-label': 'Location', onchange: (e) => (currentLocation = e.target.value) },
    locations.map((l) => el('option', { value: l.id }, `${l.name} (${l.kind})`)),
  );

  const scanInput = el('input', {
    type: 'text',
    class: 'scan-box',
    placeholder: 'Scan or type a barcode, then Enter',
    'aria-label': 'Barcode',
    autocomplete: 'off',
    autocapitalize: 'off',
    spellcheck: 'false',
    style: 'font-size:1.3rem;height:64px',
  });

  const resultSlot = el('div', { style: 'margin-top:14px' });
  const recentSlot = el('div', { style: 'margin-top:18px' });

  let pending = []; // aggregation lines [{code, qty, firstAt, lastAt}]
  let lastMatch = null;

  container.append(
    section(
      null,
      el('div', { class: 'field' }, [el('label', { for: 'loc' }, 'Location'), locSelect]),
      scanInput,
      el('p', { class: 'hint' }, 'Tip: the scanner types the code and presses Enter for you.'),
    ),
    resultSlot,
    recentSlot,
  );

  // ---- Keep the scan box focused (keyboard-wedge UX). ----
  const refocus = () => {
    if (document.activeElement === document.body) scanInput.focus();
  };
  scanInput.addEventListener('blur', () => setTimeout(refocus, 60));
  const clickRefocus = (e) => {
    if (!e.target.closest('button') && !e.target.closest('select') && !e.target.closest('a')) scanInput.focus();
  };
  container.addEventListener('click', clickRefocus);
  setTimeout(() => scanInput.focus(), 30);

  scanInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const code = scanInput.value.trim();
      scanInput.value = '';
      if (code) onScan(code);
    }
  });

  async function onScan(code) {
    const at = Date.now();
    const agg = aggregateScan(pending, { code, at }, DEFAULT_WINDOW_MS);
    pending = agg.lines;
    try {
      const match = await getData('/api/catalog/lookup', { code });
      lastMatch = normalizeMatch(match, code);
      beepOk();
      flash('ok');
      announce(`Found ${lastMatch.name}`);
      renderResult(lastMatch, agg.changed === 'bumped' ? aggQty(code) : 1);
    } catch (err) {
      buzzError();
      flash('err');
      announce('Not found');
      renderNotFound(code, err);
    }
    renderRecent();
  }

  function aggQty(code) {
    const line = [...pending].reverse().find((l) => l.code === code);
    return line ? line.qty : 1;
  }

  async function loadStock(variationId) {
    try {
      const rows = (await getData('/api/inventory/stock', { variationId })) || [];
      return Array.isArray(rows) ? rows : rows.rows || [];
    } catch {
      return [];
    }
  }

  async function renderResult(match, initialQty) {
    clear(resultSlot);
    const stepper = qtyStepper(initialQty || 1);
    const stockRows = await loadStock(match.variationId);
    const stockTable = dataTable(
      [
        { key: 'location', label: 'Location', render: (r) => r.locationName || r.locationId || '—' },
        { key: 'onHand', label: 'On hand', num: true, render: (r) => onHandOf(r) },
      ],
      stockRows,
      { emptyMessage: 'Not yet counted here.' },
    );

    const doMove = async (kind) => {
      const qty = stepper.getQty();
      await postMovement(kind, match, qty, currentLocation);
      scanInput.focus();
    };

    resultSlot.append(
      section(
        null,
        el('div', { style: 'display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap' }, [
          el('div', {}, [
            el('h2', { style: 'margin:0' }, match.name),
            match.variationName ? el('div', { class: 'view-sub' }, match.variationName) : null,
            match.priceCents != null ? chip(formatCents(match.priceCents), 'ok') : null,
          ]),
          el('div', {}, [el('div', { class: 'hint' }, 'Quantity'), stepper]),
        ]),
        el('div', { class: 'view-actions', style: 'margin-top:14px' }, [
          button('Count', { big: true, onClick: () => doMove('count'), title: 'Record a counted quantity' }),
          button('Receive', { big: true, primary: true, onClick: () => doMove('receive'), title: 'Stock arriving' }),
          button('Sell', { big: true, onClick: () => doMove('sell'), title: 'Sold off the books' }),
          button('Move', { big: true, onClick: () => quickMove(match, stepper.getQty()) }),
        ]),
        el('h3', { style: 'margin-top:16px' }, 'On hand by location'),
        stockTable,
      ),
    );
  }

  function renderNotFound(code, err) {
    clear(resultSlot);
    resultSlot.append(
      el('div', { class: 'error-banner', role: 'alert' }, [
        el('strong', {}, `No item matches "${code}". `),
        el('span', {}, err && err.status === 404 ? 'That barcode is not in your catalog yet.' : (err?.message || '')),
      ]),
    );
  }

  async function postMovement(kind, match, qty, locationId) {
    const reason = REASON[kind];
    const delta = kind === 'sell' ? -Math.abs(qty) : Math.abs(qty);
    const idem = newIdempotencyKey();
    try {
      const res = await mutate(
        '/api/inventory/movements',
        'POST',
        { variationId: match.variationId, locationId, delta, reason, idempotencyKey: idem, refType: 'scan' },
        { queueable: true, idempotencyKey: idem },
      );
      if (res && res.queued) toast(`${label(kind)} ${qty} — saved offline, will sync.`, 'warn');
      else toast(`${label(kind)} ${qty} recorded.`);
      beepOk();
      // refresh the on-hand table
      renderResult(match, 1);
    } catch (e) {
      buzzError();
      toast(e.message || 'Could not record', 'err');
    }
  }

  async function quickMove(match, qty) {
    const dest = locations.filter((l) => l.id !== currentLocation);
    if (!dest.length) return toast('No other location to move to.', 'warn');
    const toId = prompt(`Move ${qty} to which location?\n` + dest.map((l) => `${l.name} = ${l.id}`).join('\n'), dest[0].id);
    if (!toId) return;
    const idemOut = newIdempotencyKey();
    const idemIn = newIdempotencyKey();
    try {
      await mutate('/api/inventory/movements', 'POST',
        { variationId: match.variationId, locationId: currentLocation, delta: -Math.abs(qty), reason: 'transfer_out', idempotencyKey: idemOut, refType: 'quick_move' },
        { queueable: true, idempotencyKey: idemOut });
      await mutate('/api/inventory/movements', 'POST',
        { variationId: match.variationId, locationId: toId, delta: Math.abs(qty), reason: 'transfer_in', idempotencyKey: idemIn, refType: 'quick_move' },
        { queueable: true, idempotencyKey: idemIn });
      toast(`Moved ${qty}. For a tracked transfer with receiving, use Transfers.`);
      renderResult(match, 1);
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  function renderRecent() {
    clear(recentSlot);
    if (!pending.length) return;
    const rows = [...pending].reverse().slice(0, 12);
    recentSlot.append(
      el('h3', {}, 'This session'),
      dataTable(
        [
          { key: 'code', label: 'Barcode' },
          { key: 'qty', label: 'Times scanned', num: true },
        ],
        rows,
      ),
    );
  }

  // ---- Camera scanning (progressive enhancement only where supported). ----
  if ('BarcodeDetector' in window) {
    container.querySelector('.field').append(
      button('Use camera', {
        onClick: () => startCamera(),
      }),
    );
  }

  async function startCamera() {
    try {
      const Detector = window.BarcodeDetector;
      const detector = new Detector();
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      const video = el('video', { autoplay: true, playsinline: true, style: 'width:100%;max-width:420px;border-radius:10px' });
      video.srcObject = stream;
      const camWrap = section('Camera', video, button('Stop camera', { onClick: () => stop() }));
      resultSlot.before(camWrap);
      let running = true;
      const stop = () => {
        running = false;
        stream.getTracks().forEach((t) => t.stop());
        camWrap.remove();
      };
      const tick = async () => {
        if (!running) return;
        try {
          const codes = await detector.detect(video);
          if (codes && codes.length) {
            stop();
            onScan(codes[0].rawValue);
            return;
          }
        } catch {
          /* keep trying */
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    } catch (e) {
      toast('Camera not available: ' + (e.message || ''), 'warn');
    }
  }
});

function label(kind) {
  return { receive: 'Received', sell: 'Sold', count: 'Counted' }[kind] || 'Recorded';
}

function normalizeMatch(match, code) {
  const m = match || {};
  const variation = m.variation || m;
  const product = m.product || m;
  return {
    code,
    variationId: m.variationId || variation.id || m.id,
    name: m.productName || product.name || m.name || variation.name || `Item ${code}`,
    variationName: m.variationName || variation.name || (variation.sku ? `SKU ${variation.sku}` : ''),
    priceCents: m.priceCents ?? variation.priceCents ?? product.priceCents ?? null,
  };
}

function onHandOf(r) {
  const v = r.onHand ?? r.quantity ?? r.qty ?? r.on_hand;
  return v === null || v === undefined ? 'not counted' : String(v);
}

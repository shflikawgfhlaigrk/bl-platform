import { clubBrand } from '../brand.js';
/** #/register — touch-first POS register with durable local cart/holds. */
import { registerView } from '../router.js';
import { el, clear, toast, announce } from '../dom.js';
import { getData, getList, mutate, newIdempotencyKey } from '../api.js';
import { viewHeader, emptyState, button, section, field, input, chip } from '../ui.js';
import { formatCents } from '../../../src/money.mjs';
import {
  REGISTER_STORAGE_KEY,
  addCartLine,
  buildTenderPlan,
  cartItemCount,
  cartTotals,
  clearPendingCheckout,
  completePendingCheckout,
  createCart,
  decrementLine,
  deserializeRegisterState,
  holdActiveCart,
  incrementLine,
  parseMoneyToCents,
  parsePercentToBps,
  removeHeldCart,
  removeLine,
  resumeHeldCart,
  serializeRegisterState,
  setCartPricing,
  setCustomer,
  setPendingCheckout,
  setRegisterContext,
  toOrderPayload,
} from '../../../src/cart.mjs';

const POS_ORDER_ENDPOINT = '/api/pos/orders';
const POS_CATALOG_ENDPOINT = '/api/pos/catalog';
const POS_READINESS_ENDPOINT = '/api/pos/readiness';
const POS_DRAWER_ENDPOINT = '/api/pos/drawer';

registerView('register', async (container) => {
  let state = loadState();
  let busy = false;
  let lastSale = null;
  let readiness = null;
  let readinessError = null;
  let drawer = null;
  let drawerError = null;
  let activeCardAttempt = null;
  let cardTerminal = null;
  let splitBalance = null;
  let cardPollTimer = null;

  const screen = el('div', { class: 'pos-register print-hide' });
  const receiptSlot = el('div');
  const readinessSlot = el('div');
  const pendingSlot = el('div');
  const successSlot = el('div');
  const searchResults = el('div', { 'aria-live': 'polite' });
  const cartSlot = el('div');
  const customerSlot = el('div');
  const drawerSlot = el('div');
  const pricingSlot = el('div');
  const checkoutSlot = el('div');
  const holdsSlot = el('div');

  const searchBox = input({ name: 'catalogSearch', placeholder: 'Scan barcode or search name / SKU' });
  searchBox.setAttribute('aria-label', 'Barcode, item name, or SKU');
  searchBox.setAttribute('enterkeyhint', 'search');
  searchBox.setAttribute('autocapitalize', 'off');
  searchBox.setAttribute('spellcheck', 'false');
  searchBox.style.fontSize = '1.15rem';
  searchBox.style.minHeight = '56px';

  screen.append(
    viewHeader({
      title: 'Register',
      subtitle: 'A warm welcome. A seamless checkout.',
      actions: [button('Orders', { href: '#/orders' })],
    }),
    readinessSlot,
    pendingSlot,
    successSlot,
    el('div', { class: 'grid pos-register-grid' }, [
      el('div', {}, [
        section(
          'Add items',
          el('div', { style: 'display:flex;gap:8px;align-items:end;flex-wrap:wrap' }, [
            el('div', { style: 'flex:1 1 240px' }, field('Barcode, name, or SKU', searchBox)),
            button('Find item', { primary: true, big: true, onClick: searchCatalog }),
            button('Custom item', { big: true, onClick: openCustomLineDialog }),
          ]),
          searchResults,
        ),
        cartSlot,
      ]),
      el('div', {}, [pricingSlot, checkoutSlot, drawerSlot, customerSlot, holdsSlot]),
    ]),
  );
  container.append(screen, receiptSlot);

  searchBox.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    searchCatalog();
  });

  persist();
  await refreshReadiness();
  await refreshDrawer();
  renderAll();
  if (state.pendingCheckout) setTimeout(() => recoverPendingCheckout(), 0);
  else setTimeout(() => searchBox.focus(), 30);

  function loadState() {
    try {
      return deserializeRegisterState(localStorage.getItem(REGISTER_STORAGE_KEY));
    } catch {
      return deserializeRegisterState(null);
    }
  }

  function persist() {
    try {
      localStorage.setItem(REGISTER_STORAGE_KEY, serializeRegisterState(state));
    } catch {
      toast('This browser could not save the cart locally.', 'warn');
    }
  }

  function cartLocked() {
    if (!state.pendingCheckout) return false;
    toast('Payment recovery is active. Finish or inspect that order before changing this cart.', 'warn');
    return true;
  }

  function cardPresentReady() {
    const card = readiness?.tenders?.cardPresent;
    return card?.enabled === true && card?.physicalReaderVerified === true;
  }

  function updateActive(nextCart) {
    if (cartLocked()) return;
    state = { ...state, active: nextCart };
    persist();
    renderAll();
  }

  function renderAll() {
    renderReadiness();
    renderDrawer();
    renderPending();
    renderSuccess();
    renderCart();
    renderCustomer();
    renderPricing();
    renderCheckout();
    renderHolds();
  }

  async function refreshDrawer() {
    if (!state.drawerRef) {
      drawer = null;
      drawerError = null;
      if (state.cashSessionId) {
        state = setRegisterContext(state, { cashSessionId: null });
        persist();
      }
      return;
    }
    try {
      drawer = await getData(POS_DRAWER_ENDPOINT, { drawerRef: state.drawerRef });
      drawerError = null;
      const openId = drawer?.session?.status === 'open' ? drawer.session.id : null;
      if (openId !== state.cashSessionId) {
        state = setRegisterContext(state, { cashSessionId: openId });
        persist();
      }
    } catch (error) {
      drawer = null;
      drawerError = error;
      state = setRegisterContext(state, { cashSessionId: null });
      persist();
    }
  }

  function hasOpenDrawer() {
    return Boolean(
      drawer?.session?.status === 'open' &&
      drawer.session.id &&
      drawer.session.id === state.cashSessionId,
    );
  }

  function renderDrawer() {
    clear(drawerSlot);
    if (drawerError) {
      drawerSlot.append(section('Cash drawer', el('div', { class: 'error-banner' }, drawerError.message || 'Drawer status could not be loaded.'), button('Retry', { onClick: async () => { await refreshDrawer(); renderAll(); } })));
      return;
    }
    if (!hasOpenDrawer()) {
      drawerSlot.append(section(
        'Cash drawer',
        el('p', { class: 'view-sub' }, state.drawerRef ? `No open shift for ${state.drawerRef}. Cash tender is disabled.` : 'Open a counted drawer shift before taking cash.'),
        button('Open shift', { primary: true, disabled: Boolean(state.pendingCheckout), onClick: openDrawerDialog }),
      ));
      return;
    }
    const session = drawer.session;
    const reconciliation = drawer.reconciliation || {};
    drawerSlot.append(section(
      `Cash drawer · ${state.drawerRef}`,
      el('div', { class: 'blocked', style: 'border-left-color:var(--ok);background:var(--ok-weak)' }, [
        el('strong', {}, 'Shift open. '),
        el('span', {}, `Expected cash ${formatCents(reconciliation.effectiveExpectedCents ?? reconciliation.calculatedExpectedCents ?? 0)}.`),
      ]),
      totalRow('Opening float', reconciliation.openingFloatCents ?? session.opening_float_cents ?? 0),
      totalRow('Cash sales', reconciliation.cashSalesCents ?? 0),
      totalRow('Cash refunds', -(reconciliation.cashRefundsCents ?? 0)),
      totalRow('Paid in', reconciliation.paidInCents ?? 0),
      totalRow('Paid out / drops', -((reconciliation.paidOutCents ?? 0) + (reconciliation.dropsCents ?? 0))),
      el('div', { class: 'view-actions', style: 'margin-top:10px' }, [
        button('Cash movement', { disabled: Boolean(state.pendingCheckout), onClick: openMovementDialog }),
        button('Close shift', { danger: true, disabled: Boolean(state.pendingCheckout), onClick: openCloseDrawerDialog }),
      ]),
    ));
  }

  function openDrawerDialog() {
    const drawerRef = input({ name: 'drawerRef', value: state.drawerRef || '', placeholder: 'Front counter drawer', required: true });
    const openingFloat = input({ name: 'openingFloat', value: '0.00', required: true });
    openingFloat.setAttribute('inputmode', 'decimal');
    const note = input({ name: 'drawerNote', placeholder: 'Shift note (optional)' });
    const dialog = dialogShell('Open cash drawer shift');
    dialog.append(
      field('Drawer ID', drawerRef, 'Use the same physical drawer name each shift.'),
      field('Opening float $', openingFloat),
      field('Note', note),
      el('div', { class: 'view-actions' }, [
        button('Cancel', { onClick: () => dialog.close() }),
        button('Open shift', { primary: true, onClick: submit }),
      ]),
    );
    openDialog(dialog, drawerRef);
    async function submit() {
      try {
        const ref = drawerRef.value.trim();
        if (!ref) throw new Error('Drawer ID is required');
        const response = await mutate(`${POS_DRAWER_ENDPOINT}/open`, 'POST', {
          drawerRef: ref,
          registerRef: state.registerId,
          openingFloatCents: parseMoneyToCents(openingFloat.value),
          note: note.value.trim() || undefined,
        });
        const data = response.data || response;
        state = setRegisterContext(state, { drawerRef: ref, cashSessionId: data.session?.id || null });
        persist();
        dialog.close();
        await refreshDrawer();
        renderAll();
        toast('Cash drawer shift opened.');
      } catch (error) {
        toast(error.message, 'err', 6000);
      }
    }
  }

  function openMovementDialog() {
    if (!hasOpenDrawer()) return toast('Open a drawer shift first.', 'warn');
    const kind = el('select', { name: 'movementKind' }, [
      el('option', { value: 'paid_in' }, 'Paid in'),
      el('option', { value: 'paid_out' }, 'Paid out'),
      el('option', { value: 'drop' }, 'Cash drop'),
    ]);
    const amount = input({ name: 'movementAmount', placeholder: '0.00', required: true });
    amount.setAttribute('inputmode', 'decimal');
    const note = input({ name: 'movementNote', placeholder: 'Required reason', required: true });
    const dialog = dialogShell('Record cash movement');
    dialog.append(
      field('Movement', kind),
      field('Amount $', amount),
      field('Reason', note),
      el('div', { class: 'view-actions' }, [
        button('Cancel', { onClick: () => dialog.close() }),
        button('Record movement', { primary: true, onClick: submit }),
      ]),
    );
    openDialog(dialog, kind);
    async function submit() {
      try {
        const amountCents = parseMoneyToCents(amount.value);
        if (amountCents <= 0) throw new Error('Movement amount must be greater than $0');
        if (!note.value.trim()) throw new Error('A cash movement reason is required');
        await mutate(`${POS_DRAWER_ENDPOINT}/${state.cashSessionId}/movements`, 'POST', {
          kind: kind.value,
          amountCents,
          note: note.value.trim(),
          idempotencyKey: newIdempotencyKey(),
        });
        dialog.close();
        await refreshDrawer();
        renderAll();
        toast('Cash movement recorded.');
      } catch (error) {
        toast(error.message, 'err', 6000);
      }
    }
  }

  function openCloseDrawerDialog() {
    if (!hasOpenDrawer()) return toast('No drawer shift is open.', 'warn');
    const counted = input({ name: 'countedCents', placeholder: '0.00', required: true });
    counted.setAttribute('inputmode', 'decimal');
    const note = input({ name: 'closeNote', placeholder: 'Close note (optional)' });
    const dialog = dialogShell('Close cash drawer shift');
    dialog.append(
      el('p', { class: 'view-sub' }, 'Count the physical drawer before viewing the final variance.'),
      field('Counted cash $', counted),
      field('Note', note),
      el('div', { class: 'view-actions' }, [
        button('Cancel', { onClick: () => dialog.close() }),
        button('Close shift', { danger: true, onClick: submit }),
      ]),
    );
    openDialog(dialog, counted);
    async function submit() {
      try {
        const response = await mutate(`${POS_DRAWER_ENDPOINT}/${state.cashSessionId}/close`, 'POST', {
          countedCents: parseMoneyToCents(counted.value),
          note: note.value.trim() || undefined,
        });
        const data = response.data || response;
        const variance = data.reconciliation?.varianceCents;
        state = setRegisterContext(state, { cashSessionId: null });
        drawer = null;
        persist();
        dialog.close();
        renderAll();
        toast(Number.isSafeInteger(variance) ? `Shift closed. Variance ${formatCents(variance)}.` : 'Shift closed.');
      } catch (error) {
        toast(error.message, 'err', 6000);
      }
    }
  }

  async function refreshReadiness() {
    try {
      readiness = await getData(POS_READINESS_ENDPOINT);
      readinessError = null;
      const configuredTax = readiness?.settings?.taxBps;
      if (!state.pendingCheckout && Number.isSafeInteger(configuredTax) && configuredTax !== state.active.taxBps) {
        state = { ...state, active: setCartPricing(state.active, { taxBps: configuredTax }) };
        persist();
      }
    } catch (error) {
      readiness = null;
      readinessError = error;
    }
  }

  function renderReadiness() {
    clear(readinessSlot);
    if (readinessError) {
      readinessSlot.append(el('div', { class: 'error-banner', role: 'alert' }, `Register setup could not be verified: ${readinessError.message || 'request failed'}`));
      return;
    }
    const blockers = (readiness?.blockers || []).filter((blocker) => blocker.blocking);
    if (!blockers.length) return;
    readinessSlot.append(el('div', { class: 'blocked', role: 'note' }, [
      el('strong', {}, 'Register setup required. '),
      el('ul', { style: 'margin:6px 0 0 18px' }, blockers.map((blocker) => el('li', {}, blocker.message))),
    ]));
  }

  async function searchCatalog() {
    const term = searchBox.value.trim();
    if (!term) {
      clear(searchResults);
      searchResults.append(el('p', { class: 'view-sub' }, 'Scan or enter an item name, SKU, or barcode.'));
      return;
    }
    clear(searchResults);
    searchResults.append(el('div', { class: 'loading' }, 'Searching catalog…'));
    try {
      const lookup = await getData(POS_CATALOG_ENDPOINT, { code: term });
      const matches = Array.isArray(lookup?.matches)
        ? lookup.matches.map((match) => normalizeCatalogMatch(match, term)).filter((match) => !match.archived)
        : [];
      clear(searchResults);
      if (!matches.length) {
        searchResults.append(
          emptyState({
            icon: '🔎',
            title: 'No sellable item found',
            message: `Nothing in this catalog matches “${term}”. Add a custom line only if this is intentionally off-catalog.`,
          }),
        );
        announce('No sellable item found');
        return;
      }
      const exact = (lookup.matchType === 'barcode' || lookup.matchType === 'sku') && matches.length === 1;
      if (exact && matches[0].unitPriceCents !== null) {
        addMatch(matches[0]);
        return;
      }
      searchResults.append(
        el('div', { class: 'grid', style: 'margin-top:10px' }, matches.map((match) => catalogResult(match))),
      );
      announce(`${matches.length} catalog match${matches.length === 1 ? '' : 'es'}`);
    } catch (error) {
      clear(searchResults);
      searchResults.append(el('div', { class: 'error-banner', role: 'alert' }, error.message || 'Catalog search failed.'));
    }
  }

  function catalogResult(match) {
    const canSell = match.unitPriceCents !== null;
    return el('div', { class: 'card', style: 'box-shadow:none;padding:12px' }, [
      el('div', { style: 'display:flex;justify-content:space-between;gap:12px;align-items:center' }, [
        el('div', {}, [
          el('strong', {}, match.description),
          match.sku ? el('div', { class: 'hint' }, `SKU ${match.sku}`) : null,
          canSell ? chip(formatCents(match.unitPriceCents), 'ok') : chip('Price not set', 'high'),
          match.stockAvailable !== null ? el('div', { class: 'hint' }, `${match.stockAvailable} available at the register location`) : null,
        ]),
        button(canSell ? 'Add' : 'Unavailable', {
          primary: canSell,
          disabled: !canSell || Boolean(state.pendingCheckout),
          onClick: () => addMatch(match),
        }),
      ]),
    ]);
  }

  function addMatch(match) {
    if (cartLocked()) return;
    if (match.unitPriceCents === null) return toast('Set an integer-cent catalog price before selling this item.', 'warn');
    try {
      state = {
        ...state,
        active: addCartLine(state.active, {
          variationId: match.variationId,
          description: match.description,
          sku: match.sku,
          barcode: match.barcode,
          qty: 1,
          unitPriceCents: match.unitPriceCents,
        }),
      };
      persist();
      searchBox.value = '';
      clear(searchResults);
      renderAll();
      toast(`${match.description} added.`);
      announce(`${match.description} added to cart`);
      searchBox.focus();
    } catch (error) {
      toast(error.message, 'err');
    }
  }

  function renderCart() {
    clear(cartSlot);
    const cart = state.active;
    const totals = cartTotals(cart);
    const locked = Boolean(state.pendingCheckout);
    const actions = el('div', { class: 'view-actions', style: 'margin-bottom:12px' }, [
      button('Hold cart', { disabled: locked || !cart.lines.length, onClick: openHoldDialog }),
      button('Clear cart', { danger: true, disabled: locked || !cart.lines.length, onClick: clearCart }),
    ]);
    if (!cart.lines.length) {
      cartSlot.append(
        section(
          'Cart',
          actions,
          emptyState({ icon: '🛒', title: 'Cart is empty', message: 'Scan an item, search the catalog, or add a custom line.' }),
        ),
      );
      return;
    }
    const lines = cart.lines.map((line, index) =>
      el('div', { style: 'display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;padding:12px 0;border-bottom:1px solid var(--border)' }, [
        el('div', {}, [
          el('strong', {}, line.description),
          line.sku ? el('div', { class: 'hint' }, `SKU ${line.sku}`) : null,
          el('div', { class: 'view-sub' }, `${formatCents(line.unitPriceCents)} each · ${formatCents(totals.lineTotalsCents[index])}`),
        ]),
        el('div', { style: 'display:flex;gap:6px;align-items:center;flex-wrap:wrap;justify-content:flex-end' }, [
          button('−', { disabled: locked, title: `Decrease ${line.description}`, onClick: () => updateActive(decrementLine(cart, line.id)) }),
          el('strong', { style: 'min-width:2ch;text-align:center;font-variant-numeric:tabular-nums', 'aria-label': `Quantity ${line.qty}` }, String(line.qty)),
          button('+', { disabled: locked, title: `Increase ${line.description}`, onClick: () => updateActive(incrementLine(cart, line.id)) }),
          button('Remove', { disabled: locked, danger: true, onClick: () => updateActive(removeLine(cart, line.id)) }),
        ]),
      ]),
    );
    cartSlot.append(section(`Cart · ${cartItemCount(cart)} item${cartItemCount(cart) === 1 ? '' : 's'}`, actions, ...lines));
  }

  function renderCustomer() {
    clear(customerSlot);
    const selected = state.active.customerId;
    const search = input({ name: 'customerSearch', placeholder: 'Name, email, phone, or exact ID' });
    const results = el('div', { 'aria-live': 'polite' });
    customerSlot.append(
      section(
        'Guest',
        selected
          ? el('div', { class: 'blocked', style: 'border-left-color:var(--ok);background:var(--ok-weak)' }, [
              el('strong', {}, 'Attached: '),
              el('span', { style: 'font-family:var(--font-mono);overflow-wrap:anywhere' }, selected),
              button('Remove', { disabled: Boolean(state.pendingCheckout), onClick: () => updateActive(setCustomer(state.active, null)) }),
            ])
          : el('p', { class: 'view-sub' }, 'Optional. Walk-up sales remain anonymous.'),
        field('Find guest', search),
        button('Search guests', { disabled: Boolean(state.pendingCheckout), onClick: () => findCustomers(search, results) }),
        results,
      ),
    );
    search.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        findCustomers(search, results);
      }
    });
  }

  async function findCustomers(search, results) {
    const term = search.value.trim();
    if (!term) return toast('Enter a customer name, email, phone, or ID.', 'warn');
    clear(results);
    results.append(el('div', { class: 'loading' }, 'Searching customers…'));
    const query = { limit: 25 };
    if (term.includes('@')) query.email = term;
    else if (/^[0-9+()\-\s]+$/.test(term)) query.phone = term;
    else query.name = term;
    try {
      let rows = (await getList('/api/customers/profiles', query)).data || [];
      if (!rows.length) {
        try {
          const exact = await getData(`/api/customers/profiles/${encodeURIComponent(term)}`);
          rows = exact ? [exact] : [];
        } catch { /* search result remains empty */ }
      }
      clear(results);
      if (!rows.length) {
        results.append(el('p', { class: 'view-sub', style: 'margin-top:10px' }, 'No customer found. This sale can remain anonymous.'));
        return;
      }
      results.append(...rows.map((profile) => {
        const name = `${profile.first_name || profile.firstName || ''} ${profile.last_name || profile.lastName || ''}`.trim();
        const label = name || profile.email || profile.phone || profile.id;
        return el('div', { style: 'display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:8px' }, [
          el('span', {}, label),
          button('Attach', { onClick: () => updateActive(setCustomer(state.active, profile.id)) }),
        ]);
      }));
    } catch (error) {
      clear(results);
      results.append(el('div', { class: 'error-banner' }, error.message || 'Customer search failed.'));
    }
  }

  function renderPricing() {
    clear(pricingSlot);
    const cart = state.active;
    const locked = Boolean(state.pendingCheckout);
    const tax = input({ name: 'taxPercent', value: bpsText(cart.taxBps), placeholder: '0.00', type: 'text' });
    tax.setAttribute('inputmode', 'decimal');
    tax.readOnly = true;
    tax.setAttribute('aria-readonly', 'true');
    const discountPercent = input({ name: 'discountPercent', value: bpsText(cart.discountBps), placeholder: '0.00', type: 'text' });
    discountPercent.setAttribute('inputmode', 'decimal');
    const discountFixed = input({ name: 'discountFixed', value: centsInput(cart.discountFixedCents), placeholder: '0.00', type: 'text' });
    discountFixed.setAttribute('inputmode', 'decimal');
    for (const control of [discountPercent, discountFixed]) control.disabled = locked;
    discountPercent.addEventListener('change', () => updatePricing({ discountBps: parsePercentToBps(discountPercent.value) }, discountPercent));
    discountFixed.addEventListener('change', () => updatePricing({ discountFixedCents: parseMoneyToCents(discountFixed.value) }, discountFixed));
    const totals = cartTotals(cart);
    pricingSlot.append(
      section(
        'Totals',
        el('details', { class: 'pos-price-options' }, [
          el('summary', {}, `Tax ${bpsText(cart.taxBps)}% · Discounts`),
          el('div', { class: 'pos-price-fields' }, [
            field('Tax %', tax, 'Set by the owner.'),
            field('Discount %', discountPercent), field('Discount $', discountFixed),
          ]),
        ]),
        totalRow('Subtotal', totals.subtotalCents),
        totalRow('Discount', -totals.discountCents),
        totalRow('Tax', totals.taxCents),
        totalRow('Total', totals.totalCents, true),
      ),
    );
  }

  function updatePricing(patch, control) {
    try {
      updateActive(setCartPricing(state.active, patch));
    } catch (error) {
      control.setAttribute('aria-invalid', 'true');
      toast(error.message, 'err');
      renderPricing();
    }
  }

  function totalRow(label, cents, strong = false) {
    return el('div', { style: `display:flex;justify-content:space-between;gap:12px;padding:6px 0;${strong ? 'font-size:1.35rem;border-top:2px solid var(--border);margin-top:6px' : ''}` }, [
      el(strong ? 'strong' : 'span', {}, label),
      el(strong ? 'strong' : 'span', { style: 'font-variant-numeric:tabular-nums' }, formatCents(cents)),
    ]);
  }

  function renderCheckout() {
    clear(checkoutSlot);
    const totals = cartTotals(state.active);
    const pending = state.pendingCheckout;
    const operational = readiness?.operational === true;
    const pay = button(pending?.paymentKind === 'card_present' ? 'Refresh card status' : pending ? 'Recover payment' : `Take payment · ${formatCents(totals.totalCents)}`, {
      primary: true,
      big: true,
      disabled: busy || (!pending && (!state.active.lines.length || !operational)),
      onClick: pending ? recoverPendingCheckout : () => openCheckoutDialog(totals.totalCents),
    });
    const card = readiness?.tenders?.cardPresent;
    const cardReady = cardPresentReady();
    const cardReason = (readiness?.blockers || []).find((blocker) =>
      blocker.code === 'card_present_not_configured' || blocker.code === 'card_reader_not_verified',
    )?.message;
    checkoutSlot.append(
      section(
        'Payment',
        cardReady
          ? el('div', { class: 'blocked', role: 'note', style: 'border-left-color:var(--ok);background:var(--ok-weak)' }, [
              el('strong', {}, 'Card reader verified. '),
              el('span', {}, 'Online · Full or split payments available.'),
            ])
          : el('div', { class: 'blocked', role: 'note' }, [
              el('strong', {}, card?.configured ? 'Card reader not verified. ' : 'Card reader not configured. '),
              el('span', {}, cardReason || 'Connect a card reader in Settings to accept card payments.'),
            ]),
        pay,
      ),
    );
  }

  function renderPending() {
    clear(pendingSlot);
    const pending = state.pendingCheckout;
    if (!pending) return;
    if (pending.paymentKind === 'card_present') {
      if (pending.awaitingPayment) {
        const canceling = splitBalance?.cancellationStarted;
        pendingSlot.append(section(canceling ? 'Canceling split payment' : 'Split payment',
          el('div', { class: 'split-payment-summary', role: 'status' }, splitBalance
            ? canceling
              ? `${formatCents(splitBalance.refundedCents)} refunded · ${formatCents(splitBalance.netPaidCents)} awaiting refund`
              : `${formatCents(splitBalance.capturedCents)} paid · ${formatCents(splitBalance.remainingCents)} remaining`
            : 'Restoring the paid and remaining amounts…'),
          el('p', { class: 'view-sub' }, canceling
            ? 'Refunds go to the original cards. The cart stays locked until every refund is confirmed.'
            : 'Payments already approved are saved. Complete the balance or cancel and refund the cards.'),
          el('div', { class: 'view-actions' }, [
            !canceling ? button('Take next payment', { primary: true, big: true, disabled: busy || !splitBalance,
              onClick: () => openCheckoutDialog(splitBalance.remainingCents, true) }) : null,
            button(canceling ? 'Retry / check refunds' : 'Cancel split & refund', {
              danger: true, disabled: busy || !splitBalance, onClick: cancelIncompleteSplit }),
            button('Refresh balance', { disabled: busy, onClick: recoverPendingCheckout }),
            button('Open order', { href: `#/orders/${pending.orderId}` }),
          ])));
        return;
      }
      const attempt = activeCardAttempt?.id === pending.attemptId ? activeCardAttempt : null;
      const status = attempt?.status || (pending.attemptId ? 'checking' : pending.orderId ? 'starting' : 'preparing');
      const processing = status === 'pending' || status === 'processing' || status === 'checking' || status === 'starting' || status === 'preparing';
      const failed = status === 'failed';
      const canceled = status === 'canceled';
      const succeeded = status === 'succeeded';
      const title = failed
        ? 'Card payment failed. '
        : canceled
          ? 'Card payment canceled. '
          : succeeded
            ? 'Card approved; verifying the order. '
            : 'Terminal payment in progress. ';
      const detail = failed
        ? `${attempt?.failure_message || 'The processor did not complete this attempt.'} No sale has been completed from this attempt.`
        : canceled
          ? 'The terminal attempt is canceled and no sale has been completed from it.'
          : succeeded
            ? 'The processor reports success, but this register will remain locked until the server also reports the order paid.'
            : `${cardTerminal?.actionStatus ? `Terminal action: ${cardTerminal.actionStatus}. ` : ''}No payment is recorded until the server reports both a succeeded attempt and a paid order.`;
      pendingSlot.append(
        el('div', { class: failed || canceled ? 'error-banner' : 'blocked', role: 'status' }, [
          el('strong', {}, title),
          el('span', {}, detail),
          el('div', { class: 'view-actions', style: 'margin-top:10px' }, [
            button('Refresh status', { primary: processing || succeeded, disabled: busy, onClick: recoverPendingCheckout }),
            pending.attemptId && (status === 'pending' || status === 'processing' || status === 'checking')
              ? button('Cancel card attempt', { danger: true, disabled: busy, onClick: cancelCardPayment })
              : null,
            !pending.attemptId ? button('Stop checkout', { disabled: busy, onClick: stopUnstartedCardCheckout }) : null,
            failed || canceled ? button('Return to checkout', { disabled: busy, onClick: releaseTerminalCardCheckout }) : null,
            pending.orderId ? button('Open order', { href: `#/orders/${pending.orderId}` }) : null,
          ]),
        ]),
      );
      return;
    }
    pendingSlot.append(
      el('div', { class: 'error-banner', role: 'alert' }, [
        el('strong', {}, 'Payment needs recovery. '),
        el('span', {}, `Order ${pending.orderId} was created. This cart is locked so retrying cannot create a duplicate sale. `),
        button('Recover now', { primary: true, disabled: busy, onClick: recoverPendingCheckout }),
        button('Open order', { href: `#/orders/${pending.orderId}` }),
      ]),
    );
  }

  function renderSuccess() {
    clear(successSlot);
    if (!lastSale) return;
    const order = lastSale.order;
    successSlot.append(
      section(
        'Sale complete',
        el('div', { style: 'font-size:1.5rem;font-weight:800;color:var(--ok);margin-bottom:8px' }, formatCents(order.total_cents ?? order.totalCents ?? 0)),
        changeDueOf(lastSale.tenders) !== null
          ? el('div', { style: 'font-size:1.25rem;font-weight:800;margin-bottom:8px' }, `Change due ${formatCents(changeDueOf(lastSale.tenders))}`)
          : null,
        el('p', { class: 'view-sub' }, `Paid order ${order.id}`),
        el('div', { class: 'view-actions' }, [
          button('Print receipt', { primary: true, onClick: printReceipt }),
          button('Open order', { href: `#/orders/${order.id}` }),
        ]),
      ),
    );
  }

  function renderHolds() {
    clear(holdsSlot);
    const holds = state.holds;
    holdsSlot.append(
      section(
        `Held carts · ${holds.length}`,
        holds.length
          ? el('div', {}, holds.map((hold) =>
              el('div', { style: 'display:flex;justify-content:space-between;align-items:center;gap:8px;padding:10px 0;border-bottom:1px solid var(--border)' }, [
                el('div', {}, [
                  el('strong', {}, hold.name),
                  el('div', { class: 'view-sub' }, `${cartItemCount(hold.cart)} items · ${formatCents(cartTotals(hold.cart).totalCents)} · ${new Date(hold.heldAt).toLocaleString()}`),
                ]),
                el('div', { class: 'view-actions' }, [
                  button('Resume', { disabled: Boolean(state.pendingCheckout), onClick: () => resumeHold(hold.id) }),
                  button('Delete', { danger: true, disabled: Boolean(state.pendingCheckout), onClick: () => deleteHold(hold.id) }),
                ]),
              ]),
            ))
          : el('p', { class: 'view-sub' }, 'No held carts on this device.'),
      ),
    );
  }

  function openCustomLineDialog() {
    if (cartLocked()) return;
    const description = input({ name: 'description', placeholder: 'Item or service', required: true });
    const price = input({ name: 'price', placeholder: '0.00', required: true });
    price.setAttribute('inputmode', 'decimal');
    const qty = input({ name: 'qty', type: 'number', value: '1', min: 1, required: true });
    const dialog = dialogShell('Add custom item');
    const form = el('form', { method: 'dialog' }, [
      field('Description', description),
      field('Unit price $', price, 'Enter the price for one item.'),
      field('Quantity', qty),
      el('div', { class: 'view-actions' }, [
        button('Cancel', { onClick: () => dialog.close() }),
        button('Add to cart', { primary: true, onClick: submit }),
      ]),
    ]);
    dialog.append(form);
    openDialog(dialog, description);
    function submit() {
      try {
        const quantity = Number(qty.value);
        state = {
          ...state,
          active: addCartLine(state.active, {
            description: description.value.trim(),
            qty: quantity,
            unitPriceCents: parseMoneyToCents(price.value),
          }),
        };
        persist();
        dialog.close();
        renderAll();
      } catch (error) {
        toast(error.message, 'err');
      }
    }
  }

  function openHoldDialog() {
    if (cartLocked() || !state.active.lines.length) return;
    const name = input({ name: 'holdName', placeholder: 'Customer name or pickup note' });
    const dialog = dialogShell('Hold this cart');
    dialog.append(
      field('Cart label', name, 'Optional. Kept only on this device.'),
      el('div', { class: 'view-actions' }, [
        button('Cancel', { onClick: () => dialog.close() }),
        button('Hold cart', { primary: true, onClick: () => {
          try {
            state = holdActiveCart(state, { name: name.value });
            persist();
            dialog.close();
            renderAll();
            searchBox.focus();
          } catch (error) { toast(error.message, 'err'); }
        } }),
      ]),
    );
    openDialog(dialog, name);
  }

  function resumeHold(id) {
    try {
      state = resumeHeldCart(state, id);
      persist();
      renderAll();
    } catch (error) {
      toast(error.message, 'warn');
    }
  }

  async function deleteHold(id) {
    const accepted = await confirmAction({
      title: 'Delete held cart?',
      message: 'This held cart will be removed from this device. This action cannot be undone.',
      confirmLabel: 'Delete held cart',
      cancelLabel: 'Keep cart',
      danger: true,
    });
    if (!accepted) return;
    state = removeHeldCart(state, id);
    persist();
    renderHolds();
  }

  async function clearCart() {
    if (cartLocked() || !state.active.lines.length) return;
    const accepted = await confirmAction({
      title: 'Clear this cart?',
      message: 'Every item in the active cart will be removed. This action cannot be undone.',
      confirmLabel: 'Clear cart',
      cancelLabel: 'Keep items',
      danger: true,
    });
    if (!accepted) return;
    state = { ...state, active: setCartPricing(createCart(), { taxBps: state.active.taxBps }) };
    persist();
    clear(searchResults);
    renderAll();
    searchBox.focus();
  }

  function openCheckoutDialog(totalCents, resumeSplit = false) {
    if (!state.active.lines.length || (!resumeSplit && cartLocked())) return;
    const dialog = dialogShell('Take payment');
    const cashOpen = hasOpenDrawer();
    const cardReady = cardPresentReady();
    const mode = el('select', { name: 'tenderMode' }, [
      el('option', { value: 'cash', disabled: !cashOpen }, cashOpen ? 'Cash' : 'Cash — open drawer first'),
      el('option', { value: 'external' }, 'External payment — manually verified'),
      el('option', { value: 'card_present', disabled: !cardReady }, cardReady ? 'Card — verified reader' : 'Card — verified reader required'),
      el('option', { value: 'split_card_cash', disabled: !cardReady || !cashOpen }, 'Split cash + card'),
      el('option', { value: 'split_cards', disabled: !cardReady }, 'Split across cards'),
      el('option', { value: 'split', disabled: !cashOpen }, cashOpen ? 'Split cash + external' : 'Split — open drawer first'),
    ]);
    mode.value = cashOpen ? 'cash' : 'external';
    const controls = el('div');
    const complete = button(`Complete ${formatCents(totalCents)} sale`, { primary: true, big: true, onClick: submit });
    const actions = el('div', { class: 'view-actions' }, [
      button('Cancel', { onClick: () => dialog.close() }),
      complete,
    ]);
    dialog.append(
      el('p', { style: 'font-size:1.35rem;font-weight:800' }, `Amount due ${formatCents(totalCents)}`),
      field('Tender', mode),
      controls,
      actions,
    );
    mode.addEventListener('change', paintControls);
    paintControls();
    openDialog(dialog, mode);

    function paintControls() {
      clear(controls);
      complete.textContent = mode.value === 'card_present'
        ? `Send ${formatCents(totalCents)} to reader`
        : `Complete ${formatCents(totalCents)} sale`;
      if (mode.value === 'cash') {
        const received = input({ name: 'cashReceived', value: centsInput(totalCents), required: true });
        received.setAttribute('inputmode', 'decimal');
        controls.append(field('Cash received $', received, `Amount due ${formatCents(totalCents)}. Change is calculated before recording.`));
        return;
      }
      if (mode.value === 'split_card_cash' || mode.value === 'split_cards') {
        const portion = input({ name: 'splitPortion', value: centsInput(Math.floor(totalCents / 2)), required: true });
        portion.setAttribute('inputmode', 'decimal');
        const hint = el('p', { class: 'split-payment-summary', role: 'status' });
        const update = () => {
          try {
            const entered = parseMoneyToCents(portion.value);
            const cardAmount = mode.value === 'split_card_cash' ? totalCents - entered : entered;
            hint.textContent = `First card ${formatCents(cardAmount)} · Remaining ${formatCents(totalCents - cardAmount)}`;
          } catch { hint.textContent = 'Enter the split amount.'; }
        };
        portion.addEventListener('input', update);
        controls.append(field(mode.value === 'split_card_cash' ? 'Cash portion $' : 'First card amount $', portion), hint,
          el('p', { class: 'view-sub' }, 'Process the first card, then collect the remaining balance. Each payment is saved separately.'));
        complete.textContent = 'Start split payment';
        update();
        return;
      }
      if (mode.value === 'card_present') {
        const card = readiness?.tenders?.cardPresent;
        controls.append(el('div', { class: 'blocked', role: 'note', style: 'border-left-color:var(--ok);background:var(--ok-weak)' }, [
          el('strong', {}, `${card?.readerId || 'Card reader'} verified. `),
          el('span', {}, 'The next screen will remain in processing until the server confirms the card attempt succeeded and the order is paid.'),
        ]));
        return;
      }
      const provider = input({ name: 'externalProvider', placeholder: 'Check, bank transfer, invoice, etc.', required: true });
      const reference = input({ name: 'externalReference', placeholder: 'Required transaction / check reference', required: true });
      controls.append(field('External payment source', provider), field('Reference', reference));
      if (mode.value === 'split') {
        const cash = input({ name: 'cashAmount', placeholder: '0.00' });
        cash.setAttribute('inputmode', 'decimal');
        const received = input({ name: 'cashReceived', placeholder: '0.00' });
        received.setAttribute('inputmode', 'decimal');
        controls.prepend(
          field('Cash amount $', cash, 'The remainder is recorded as external payment.'),
          field('Cash received $', received, 'Must be at least the cash amount.'),
        );
      }
    }

    let confirming = false;

    async function submit() {
      if (confirming) return;
      try {
        if (['card_present', 'split_card_cash', 'split_cards'].includes(mode.value)) {
          let amountCents;
          if (mode.value !== 'card_present') {
            const portion = parseMoneyToCents(controls.querySelector('[name="splitPortion"]').value);
            if (portion <= 0 || portion >= totalCents) throw new Error('The split amount must be greater than zero and below the balance due');
            amountCents = mode.value === 'split_card_cash' ? totalCents - portion : portion;
          }
          if (!cardPresentReady()) throw new Error('The card reader is not currently online and verified');
          dialog.close();
          if (resumeSplit) continueCardSplit(amountCents);
          else beginCardCheckout(amountCents);
          return;
        }
        const plan = tenderInputs(mode.value, controls, totalCents);
        const changeDue = plannedChangeDue(plan);
        if (changeDue !== null) {
          const cashTender = plan.find((tender) => tender.kind === 'cash');
          confirming = true;
          complete.disabled = true;
          const accepted = await confirmAction({
            title: 'Confirm cash and change',
            message: `Cash received ${formatCents(cashTender.cashReceivedCents)}. Give the customer ${formatCents(changeDue)} in change, then complete the sale.`,
            confirmLabel: 'Complete sale',
            cancelLabel: 'Review payment',
          });
          confirming = false;
          complete.disabled = false;
          if (!accepted) return;
        }
        dialog.close();
        if (resumeSplit) finishSplitWithManual(plan);
        else beginCheckout(plan);
      } catch (error) {
        confirming = false;
        complete.disabled = false;
        toast(error.message, 'err');
      }
    }
  }

  function tenderInputs(mode, controls, totalCents) {
    if (totalCents === 0) return buildTenderPlan(0, []);
    if (mode === 'cash') {
      if (!hasOpenDrawer()) throw new Error('Open a cash drawer shift before taking cash');
      const cashReceivedCents = parseMoneyToCents(controls.querySelector('[name="cashReceived"]')?.value || '');
      if (cashReceivedCents < totalCents) throw new Error('Cash received must be at least the amount due');
      return buildTenderPlan(totalCents, [{ kind: 'cash', amountCents: totalCents, cashReceivedCents }], { keyFactory: newIdempotencyKey });
    }
    const provider = controls.querySelector('[name="externalProvider"]')?.value.trim();
    const providerRef = controls.querySelector('[name="externalReference"]')?.value.trim();
    if (!provider) throw new Error('External payment source is required');
    if (!providerRef) throw new Error('External payment reference is required');
    if (mode === 'external') {
      return buildTenderPlan(totalCents, [{ kind: 'external', amountCents: totalCents, provider, providerRef }], { keyFactory: newIdempotencyKey });
    }
    if (!hasOpenDrawer()) throw new Error('Open a cash drawer shift before taking split cash');
    const cashCents = parseMoneyToCents(controls.querySelector('[name="cashAmount"]')?.value || '');
    if (cashCents <= 0 || cashCents >= totalCents) throw new Error('Split cash must be greater than $0 and less than the amount due');
    const cashReceivedCents = parseMoneyToCents(controls.querySelector('[name="cashReceived"]')?.value || '');
    if (cashReceivedCents < cashCents) throw new Error('Cash received must be at least the cash portion');
    return buildTenderPlan(totalCents, [
      { kind: 'cash', amountCents: cashCents, cashReceivedCents },
      { kind: 'external', amountCents: totalCents - cashCents, provider, providerRef },
    ], { keyFactory: newIdempotencyKey });
  }

  function beginCardCheckout(amountCents) {
    if (busy || state.pendingCheckout) return;
    if (!cardPresentReady()) return toast('The card reader is not currently online and verified.', 'warn');
    activeCardAttempt = null;
    cardTerminal = null;
    state = setPendingCheckout(state, {
      paymentKind: 'card_present',
      ...(amountCents === undefined ? {} : { amountCents }),
      orderId: null,
      cartId: state.active.id,
      orderIdempotencyKey: newIdempotencyKey(),
      attemptIdempotencyKey: newIdempotencyKey(),
      attemptId: null,
      startedAt: new Date().toISOString(),
    });
    persist();
    renderAll();
    recoverPendingCheckout();
  }

  async function recoverCardCheckout(pending) {
    let current = pending;
    if (!current.orderId) {
      await refreshReadiness();
      if (!cardPresentReady()) throw new Error('The verified card reader is no longer available. Refresh when it is online, or stop this checkout.');
      const expectedTotalCents = cartTotals(state.active).totalCents;
      const orderPayload = {
        ...toOrderPayload(state.active),
        registerId: state.registerId,
        ...(hasOpenDrawer() ? { cashSessionId: state.cashSessionId } : {}),
      };
      const createdBody = await mutate(POS_ORDER_ENDPOINT, 'POST', orderPayload, {
        idempotencyKey: current.orderIdempotencyKey,
      });
      const order = createdBody.data || createdBody;
      const authoritativeTotalCents = order.total_cents ?? order.totalCents;
      if (!Number.isSafeInteger(authoritativeTotalCents) || authoritativeTotalCents < 0) {
        throw new Error('Server did not return an integer-cent order total');
      }
      if (authoritativeTotalCents <= 0) {
        state = clearPendingCheckout(state);
        persist();
        throw new Error('This order has no positive card balance. Choose another completion method.');
      }
      if (authoritativeTotalCents !== expectedTotalCents) {
        const accepted = await confirmAction({
          title: 'Confirm updated card total',
          message: `The total changed from ${formatCents(expectedTotalCents)} to ${formatCents(authoritativeTotalCents)} after current pricing, promotions, and tax were applied.`,
          confirmLabel: 'Send updated total',
          cancelLabel: 'Stop payment',
        });
        if (!accepted) {
          try { await mutate(`/api/pos/orders/${order.id}/cancel`, 'POST', {}); } catch { /* cart id still prevents a duplicate order */ }
          state = clearPendingCheckout(state);
          persist();
          throw new Error('Card payment stopped before contacting the reader');
        }
      }
      current = { ...current, orderId: order.id };
      state = setPendingCheckout(state, current);
      persist();
      renderPending();
    }

    if (current.awaitingPayment) {
      splitBalance = await getData(`/api/pos/orders/${current.orderId}/balance`);
      if (isPaidStatus(splitBalance.status)) await finishSale(await getData(`/api/orders/orders/${current.orderId}`));
      else if (splitBalance.status === 'canceled' && splitBalance.netPaidCents === 0) await finishCanceledSplit();
      return;
    }
    if (!current.attemptId) {
      const attempts = await getData(`/api/pos/orders/${current.orderId}/payment-attempts`);
      const prior = (Array.isArray(attempts) ? attempts : []).find(
        (attempt) => attempt.idempotency_key === current.attemptIdempotencyKey,
      );
      if (prior) {
        current = bindCardAttempt(current, prior);
      } else {
        await refreshReadiness();
        if (!cardPresentReady()) throw new Error('The verified card reader is no longer available. No card attempt was started.');
        const startedBody = await mutate(`/api/pos/orders/${current.orderId}/card-payments`, 'POST', {
          idempotencyKey: current.attemptIdempotencyKey,
          ...(current.amountCents === undefined ? {} : { amountCents: current.amountCents }),
        }, {
          idempotencyKey: current.attemptIdempotencyKey,
        });
        const started = startedBody.data || startedBody;
        const attempt = started.attempt || started;
        if (!attempt?.id) throw new Error('The server did not return a durable card payment attempt');
        cardTerminal = started.terminal || attempt.provider_data?.terminal || null;
        current = bindCardAttempt(current, attempt);
      }
    } else {
      const attempt = await getData(`/api/pos/payment-attempts/${current.attemptId}`);
      activeCardAttempt = attempt;
      cardTerminal = attempt?.provider_data?.terminal || cardTerminal;
    }

    const attempt = activeCardAttempt;
    if (!attempt || attempt.id !== current.attemptId) throw new Error('Card payment status could not be verified');
    if (attempt.status === 'succeeded') {
      const order = await getData(`/api/orders/orders/${current.orderId}`);
      if (!isPaidStatus(order.status)) {
        splitBalance = await getData(`/api/pos/orders/${current.orderId}/balance`);
        if (splitBalance.status === 'canceled' && splitBalance.netPaidCents === 0) {
          await finishCanceledSplit();
          return;
        }
        if (splitBalance.remainingCents > 0 && splitBalance.capturedCents > 0) {
          state = setPendingCheckout(state, { ...current, awaitingPayment: true });
          persist();
          announce(`Payment approved. ${formatCents(splitBalance.remainingCents)} remaining.`);
          return;
        }
        throw new Error(`Card attempt succeeded, but order status is ${order.status}. Refresh payment status.`);
      }
      await finishSale(order);
      return;
    }
    if (attempt.status === 'failed' || attempt.status === 'canceled') return;
    if (attempt.status !== 'pending' && attempt.status !== 'processing') {
      throw new Error(`Unknown card payment status: ${attempt.status}`);
    }
    scheduleCardPoll();
  }

  function bindCardAttempt(pending, attempt) {
    const next = { ...pending, attemptId: attempt.id };
    state = setPendingCheckout(state, next);
    activeCardAttempt = attempt;
    cardTerminal = attempt?.provider_data?.terminal || cardTerminal;
    persist();
    renderPending();
    return next;
  }

  function scheduleCardPoll(delay = 2500) {
    if (cardPollTimer) clearTimeout(cardPollTimer);
    cardPollTimer = setTimeout(() => {
      cardPollTimer = null;
      if (!container.isConnected || state.pendingCheckout?.paymentKind !== 'card_present') return;
      recoverPendingCheckout();
    }, delay);
  }

  async function finishCanceledSplit() {
    if (cardPollTimer) clearTimeout(cardPollTimer);
    cardPollTimer = null;
    state = completePendingCheckout(state);
    activeCardAttempt = null;
    cardTerminal = null;
    splitBalance = null;
    persist();
    await refreshDrawer();
    toast('Split canceled. All approved card payments were refunded.');
    announce('Split canceled and refunded');
  }

  async function cancelIncompleteSplit() {
    const pending = state.pendingCheckout;
    if (busy || !pending?.awaitingPayment || !splitBalance) return;
    busy = true;
    renderAll();
    try {
      if (!splitBalance.cancellationStarted && !await confirmAction({
        title: 'Cancel split and refund cards?',
        message: `Refund ${formatCents(splitBalance.netPaidCents)} to the original cards and cancel this sale.`,
        confirmLabel: 'Refund and cancel', cancelLabel: 'Continue sale', danger: true,
      })) return;
      await mutate(`/api/pos/orders/${pending.orderId}/cancel-split`, 'POST', {});
      splitBalance = await getData(`/api/pos/orders/${pending.orderId}/balance`);
      if (splitBalance.status === 'canceled' && splitBalance.netPaidCents === 0) await finishCanceledSplit();
      else toast('Refunds requested. Waiting for processor confirmation.', 'warn');
    } catch (error) {
      try { splitBalance = await getData(`/api/pos/orders/${pending.orderId}/balance`); } catch { /* preserve recovery */ }
      toast(error.message || 'Refund status needs another check.', 'err', 6000);
    } finally {
      busy = false;
      renderAll();
    }
  }

  async function cancelCardPayment() {
    const pending = state.pendingCheckout;
    if (busy || pending?.paymentKind !== 'card_present' || !pending.attemptId) return;
    if (cardPollTimer) clearTimeout(cardPollTimer);
    cardPollTimer = null;
    busy = true;
    renderAll();
    try {
      const accepted = await confirmAction({
        title: 'Cancel card payment?',
        message: 'Ask the customer to stop using the reader. The cart stays locked until the processor confirms cancellation.',
        confirmLabel: 'Cancel card payment',
        cancelLabel: 'Keep processing',
        danger: true,
      });
      if (!accepted) return;
      const canceledBody = await mutate(`/api/pos/payment-attempts/${pending.attemptId}/cancel`, 'POST', {});
      activeCardAttempt = canceledBody.data || canceledBody;
      cardTerminal = activeCardAttempt?.provider_data?.terminal || cardTerminal;
      if (activeCardAttempt?.status !== 'canceled') {
        throw new Error(`Cancel was not confirmed (attempt status: ${activeCardAttempt?.status || 'unknown'})`);
      }
      toast('Card attempt canceled. No payment was recorded.');
    } catch (error) {
      toast(error.message || 'Card attempt could not be canceled.', 'err', 6000);
    } finally {
      busy = false;
      renderAll();
      if (
        state.pendingCheckout?.paymentKind === 'card_present' &&
        (activeCardAttempt?.status === 'pending' || activeCardAttempt?.status === 'processing')
      ) scheduleCardPoll();
    }
  }

  async function stopUnstartedCardCheckout() {
    const pending = state.pendingCheckout;
    if (busy || pending?.paymentKind !== 'card_present' || pending.attemptId) return;
    busy = true;
    renderAll();
    try {
      if (pending.orderId) {
        const attempts = await getData(`/api/pos/orders/${pending.orderId}/payment-attempts`);
        const prior = (Array.isArray(attempts) ? attempts : []).find(
          (attempt) => attempt.idempotency_key === pending.attemptIdempotencyKey,
        );
        if (prior) {
          const bound = bindCardAttempt(pending, prior);
          await recoverCardCheckout(bound);
          if (state.pendingCheckout?.paymentKind === 'card_present') {
            toast('A durable card attempt already exists. Its current status has been restored.', 'warn', 6000);
          }
          return;
        }
      }
      if (pending.orderId) {
        splitBalance = await getData(`/api/pos/orders/${pending.orderId}/balance`);
        if (splitBalance.capturedCents > 0) {
          state = setPendingCheckout(state, { ...pending, awaitingPayment: true });
          persist(); return;
        }
      }
      state = clearPendingCheckout(state);
      activeCardAttempt = null;
      cardTerminal = null;
      persist();
      toast('Card checkout stopped before a terminal attempt was created.');
    } catch (error) {
      toast(error.message || 'Card checkout status could not be verified.', 'err', 6000);
    } finally {
      busy = false;
      renderAll();
    }
  }

  async function releaseTerminalCardCheckout() {
    const pending = state.pendingCheckout;
    if (pending?.paymentKind !== 'card_present') return;
    if (activeCardAttempt?.status !== 'failed' && activeCardAttempt?.status !== 'canceled') return;
    try {
      splitBalance = await getData(`/api/pos/orders/${pending.orderId}/balance`);
      if (splitBalance.capturedCents > 0) {
        state = setPendingCheckout(state, { ...pending, awaitingPayment: true });
        persist(); renderAll(); return;
      }
    } catch (error) { toast(error.message, 'err'); return; }
    state = clearPendingCheckout(state);
    activeCardAttempt = null;
    cardTerminal = null;
    persist();
    renderAll();
    toast('Cart unlocked. Choose a new payment method or start a new card attempt.');
  }

  function continueCardSplit(amountCents) {
    const pending = state.pendingCheckout;
    if (busy || !pending?.awaitingPayment) return;
    const next = { ...pending, awaitingPayment: false, attemptId: null,
      attemptIdempotencyKey: newIdempotencyKey() };
    delete next.amountCents;
    if (amountCents !== undefined) next.amountCents = amountCents;
    state = setPendingCheckout(state, next);
    activeCardAttempt = null; cardTerminal = null;
    persist(); renderAll(); recoverPendingCheckout();
  }

  function finishSplitWithManual(tenders) {
    const pending = state.pendingCheckout;
    if (busy || !pending?.awaitingPayment) return;
    state = setPendingCheckout(state, { paymentKind: 'manual', orderId: pending.orderId,
      cartId: pending.cartId, tenders, startedAt: pending.startedAt });
    persist(); renderAll(); recoverPendingCheckout();
  }

  async function beginCheckout(tenders) {
    if (busy || state.pendingCheckout) return;
    busy = true;
    renderCheckout();
    try {
      const expectedTotalCents = cartTotals(state.active).totalCents;
      const usesCash = tenders.some((tender) => tender.kind === 'cash');
      if (usesCash && !hasOpenDrawer()) throw new Error('The cash drawer shift is no longer open');
      const orderPayload = {
        ...toOrderPayload(state.active),
        registerId: state.registerId,
        ...(hasOpenDrawer() ? { cashSessionId: state.cashSessionId } : {}),
      };
      const createdBody = await mutate(POS_ORDER_ENDPOINT, 'POST', orderPayload, { idempotency: true });
      const order = createdBody.data || createdBody;
      const authoritativeTotalCents = order.total_cents ?? order.totalCents;
      if (!Number.isSafeInteger(authoritativeTotalCents) || authoritativeTotalCents < 0) {
        throw new Error('Server did not return an integer-cent order total');
      }
      const authoritativeTenders = repriceTenderPlan(tenders, authoritativeTotalCents);
      if (authoritativeTotalCents !== expectedTotalCents) {
        const changeDue = plannedChangeDue(authoritativeTenders);
        const cashMessage = changeDue === null ? '' : ` Cash received ${formatCents(authoritativeTenders.find((tender) => tender.kind === 'cash').cashReceivedCents)}; change due ${formatCents(changeDue)}.`;
        const accepted = await confirmAction({
          title: 'Confirm updated total',
          message: `The total changed from ${formatCents(expectedTotalCents)} to ${formatCents(authoritativeTotalCents)} after current pricing, promotions, and tax were applied.${cashMessage}`,
          confirmLabel: 'Continue to payment',
          cancelLabel: 'Stop payment',
        });
        if (!accepted) {
          try { await mutate(`/api/pos/orders/${order.id}/cancel`, 'POST', {}); } catch { /* cart id still prevents a duplicate order */ }
          throw new Error('Payment stopped before tender capture');
        }
      }
      state = setPendingCheckout(state, {
        paymentKind: 'manual',
        orderId: order.id,
        cartId: state.active.id,
        tenders: authoritativeTenders,
        startedAt: new Date().toISOString(),
      });
      persist();
      renderPending();
      await payPending(order.id, authoritativeTenders);
    } catch (error) {
      toast(error.message || 'Sale could not be completed.', 'err', 6000);
    } finally {
      busy = false;
      renderAll();
    }
  }

  async function recoverPendingCheckout() {
    if (busy || !state.pendingCheckout) return;
    if (cardPollTimer) clearTimeout(cardPollTimer);
    cardPollTimer = null;
    busy = true;
    renderAll();
    const pending = state.pendingCheckout;
    try {
      if (pending.paymentKind === 'card_present') {
        await recoverCardCheckout(pending);
      } else {
        const order = await getData(`/api/orders/orders/${pending.orderId}`);
        if (isPaidStatus(order.status)) await finishSale(order);
        else if (order.status === 'draft' || order.status === 'reserved') await payPending(pending.orderId, pending.tenders);
        else throw new Error(`Order is ${order.status}; open it before taking another payment`);
      }
    } catch (error) {
      toast(error.message || 'Payment recovery failed.', 'err', 6000);
      if (
        state.pendingCheckout?.paymentKind === 'card_present' &&
        (activeCardAttempt?.status === 'pending' || activeCardAttempt?.status === 'processing')
      ) scheduleCardPoll(5000);
    } finally {
      busy = false;
      renderAll();
    }
  }

  async function payPending(orderId, tenders) {
    if (tenders.some((tender) => tender.kind === 'cash') && !hasOpenDrawer()) {
      throw new Error('Reopen or recover the recorded cash drawer shift before retrying this cash payment');
    }
    await mutate(`/api/pos/orders/${orderId}/pay`, 'POST', { tenders });
    const paid = await getData(`/api/orders/orders/${orderId}`);
    if (!isPaidStatus(paid.status)) throw new Error(`Payment did not complete (order status: ${paid.status})`);
    await finishSale(paid);
  }

  async function finishSale(order) {
    if (cardPollTimer) clearTimeout(cardPollTimer);
    cardPollTimer = null;
    let tenders = [];
    let receipt = null;
    try {
      receipt = await getData(`/api/pos/receipts/${order.id}`);
      order = receipt?.order || order;
      tenders = receipt?.tenders || [];
    } catch {
      try { tenders = (await getData(`/api/orders/orders/${order.id}/tenders`)) || []; } catch { /* receipt can still render */ }
    }
    lastSale = { order, tenders, receipt };
    state = completePendingCheckout(state);
    activeCardAttempt = null;
    cardTerminal = null;
    persist();
    await refreshDrawer();
    renderReceipt(receiptSlot, order, tenders, receipt);
    toast('Sale complete.');
    announce('Sale complete');
  }

  function printReceipt() {
    if (!lastSale) return;
    document.body.dataset.print = 'receipt';
    window.print();
  }
});

function normalizeCatalogMatch(match, searchTerm) {
  if (match?.variationId && !match?.variation) {
    const variationName = match.variationName && String(match.variationName).toLowerCase() !== 'regular'
      ? match.variationName
      : '';
    return {
      variationId: match.variationId,
      description: variationName ? `${match.name} — ${variationName}` : (match.name || `Item ${searchTerm}`),
      sku: match.sku || null,
      barcode: match.barcode || null,
      unitPriceCents: Number.isSafeInteger(match.unitPriceCents) && match.unitPriceCents >= 0 ? match.unitPriceCents : null,
      stockAvailable: Number.isFinite(match.stock?.available) ? match.stock.available : null,
      archived: false,
    };
  }
  const variation = match?.variation || match || {};
  const product = match?.product || {};
  const barcode = match?.barcode || {};
  const productName = product.name || match?.productName || '';
  const variationName = variation.name || match?.variationName || '';
  const description = productName
    ? variationName && variationName.toLowerCase() !== 'regular' ? `${productName} — ${variationName}` : productName
    : variationName || `Item ${searchTerm}`;
  const rawPrice = variation.price_cents ?? variation.priceCents ?? match?.priceCents;
  return {
    variationId: variation.id || match?.variationId || null,
    description,
    sku: variation.sku || null,
    barcode: barcode.code_raw || barcode.codeRaw || null,
    unitPriceCents: Number.isSafeInteger(rawPrice) && rawPrice >= 0 ? rawPrice : null,
    stockAvailable: null,
    archived: variation.archived === 1 || variation.archived === true || product.archived === 1 || product.archived === true,
  };
}

function repriceTenderPlan(tenders, totalCents) {
  if (totalCents === 0) return buildTenderPlan(0, []);
  if (tenders.length === 1) {
    return buildTenderPlan(totalCents, [{ ...tenders[0], amountCents: totalCents }]);
  }
  const cash = tenders.find((tender) => tender.kind === 'cash');
  const external = tenders.find((tender) => tender.kind === 'external');
  if (!cash || !external || cash.amountCents >= totalCents) {
    throw new Error('The authoritative total no longer supports the selected split; choose payment again');
  }
  return buildTenderPlan(totalCents, [
    cash,
    { ...external, amountCents: totalCents - cash.amountCents },
  ]);
}

function plannedChangeDue(tenders) {
  const cash = tenders.find((tender) => tender.kind === 'cash');
  return cash ? cash.cashReceivedCents - cash.amountCents : null;
}

function changeDueOf(tenders) {
  const cash = (tenders || []).find((tender) => tender.kind === 'cash');
  if (!cash) return null;
  const stored = cash.change_due_cents ?? cash.changeDueCents;
  if (Number.isSafeInteger(stored)) return stored;
  const received = cash.cash_received_cents ?? cash.cashReceivedCents;
  const amount = cash.amount_cents ?? cash.amountCents;
  return Number.isSafeInteger(received) && Number.isSafeInteger(amount) ? received - amount : 0;
}

function bpsText(bps) {
  const whole = Math.floor(bps / 100);
  const fraction = bps % 100;
  return fraction ? `${whole}.${String(fraction).padStart(2, '0').replace(/0$/, '')}` : String(whole);
}

function centsInput(cents) {
  const whole = Math.floor(cents / 100);
  return `${whole}.${String(cents % 100).padStart(2, '0')}`;
}

function dialogShell(title) {
  return el('dialog', {
    'aria-label': title,
    style: 'width:min(560px,calc(100vw - 24px));max-height:calc(100vh - 24px);overflow:auto;border:1px solid var(--border);border-radius:var(--radius);background:var(--surface);color:var(--text);padding:20px;box-shadow:var(--shadow)',
  }, el('h2', {}, title));
}

function openDialog(dialog, focusTarget) {
  document.body.append(dialog);
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  dialog.showModal();
  setTimeout(() => focusTarget?.focus(), 0);
}

let dialogSequence = 0;

function confirmAction({ title, message, confirmLabel, cancelLabel = 'Cancel', danger = false }) {
  return new Promise((resolve) => {
    const dialog = dialogShell(title);
    const titleNode = dialog.querySelector('h2');
    const titleId = `pos-confirm-title-${++dialogSequence}`;
    const messageId = `pos-confirm-message-${dialogSequence}`;
    titleNode.id = titleId;
    dialog.removeAttribute('aria-label');
    dialog.setAttribute('aria-labelledby', titleId);
    dialog.setAttribute('aria-describedby', messageId);
    dialog.setAttribute('data-pos-confirmation', 'true');

    const messageNode = el('p', { id: messageId, class: 'view-sub' }, message);
    const cancelButton = button(cancelLabel, { onClick: () => dialog.close('cancel') });
    const confirmButton = button(confirmLabel, {
      primary: !danger,
      danger,
      onClick: () => dialog.close('confirm'),
    });
    dialog.append(
      messageNode,
      el('div', { class: 'view-actions' }, [cancelButton, confirmButton]),
    );
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true });
    openDialog(dialog, cancelButton);
  });
}

function isPaidStatus(status) {
  return ['paid', 'partially_fulfilled', 'fulfilled', 'partially_returned', 'returned'].includes(status);
}

function renderReceipt(slot, order, tenders, projection) {
  clear(slot);
  const lines = order.lines || [];
  const receipt = el('article', { class: 'printable', 'aria-label': `Receipt for order ${order.id}` }, [
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
      el('tbody', {}, lines.map((line) => el('tr', {}, [
        el('td', {}, line.description || 'Item'),
        el('td', {}, String(line.qty)),
        el('td', {}, formatCents(line.line_total_cents ?? line.lineTotalCents ?? Math.round(line.qty * (line.unit_price_cents ?? line.unitPriceCents ?? 0)))),
      ]))),
    ]),
    receiptMoneyRow('Subtotal', order.subtotal_cents ?? order.subtotalCents ?? 0),
    receiptMoneyRow('Discount', -(order.discount_cents ?? order.discountCents ?? 0)),
    receiptMoneyRow('Tax', order.tax_cents ?? order.taxCents ?? 0),
    receiptMoneyRow('Total', order.total_cents ?? order.totalCents ?? 0, true),
    tenders.length ? el('div', { style: 'margin-top:12px' }, [
      el('strong', {}, 'Payment'),
      ...tenders.flatMap((tender) => {
        const rows = [receiptMoneyRow(tender.kind === 'provider' || tender.kind === 'card' ? 'Card' : tender.kind === 'cash' ? 'Cash' : 'External payment', tender.amount_cents ?? tender.amountCents ?? 0)];
        if (tender.kind === 'cash') {
          rows.push(receiptMoneyRow('Cash received', tender.cash_received_cents ?? tender.cashReceivedCents ?? tender.amount_cents ?? tender.amountCents ?? 0));
          rows.push(receiptMoneyRow('Change due', changeDueOf([tender]), true));
        }
        return rows;
      }),
    ]) : null,
    projection?.merchant?.receiptFooter ? el('p', { style: 'margin-top:16px' }, projection.merchant.receiptFooter) : null,
  ]);
  slot.append(receipt);
}

function receiptMoneyRow(label, cents, strong = false) {
  return el('div', { style: `display:flex;justify-content:space-between;gap:20px;padding-top:4px;${strong ? 'font-weight:800;border-top:1px solid #000;margin-top:4px' : ''}` }, [
    el('span', {}, label),
    el('span', {}, formatCents(cents)),
  ]);
}

/** Shared, server-priced bartender workspace. No offline payment assumptions. */
import { registerView } from '../router.js';
import { el, clear, toast } from '../dom.js';
import { getData, mutate, newIdempotencyKey, authenticatedActorId } from '../api.js';
import { button, field, input } from '../ui.js';
import { formatCents as dollars } from '../../../src/money.mjs';
import { parseMoneyToCents } from '../../../src/cart.mjs';
import { DRINK_RECIPES, recipeInstructions, findDrinkRecipes } from '../drink-recipes.js';
import { createPrintClient, ticketPrintDocument, receiptPrintDocument } from '../printing.js';

const API = '/api/pos/bar';
const money = (v) => parseMoneyToCents(v || '0');
const row = (...kids) => el('div', { class: 'bar-row' }, kids.map(k => typeof k === 'string' || typeof k === 'number' ? el('span', {}, String(k)) : k));
const note = (text) => el('p', { class: 'bar-note' }, text);
const select = (label, options, value) => el('select', { 'aria-label': label }, options.map(([id, name]) => el('option', { value: id, selected: String(id) === String(value) }, name)));
const menuPrice = (m) => m.priceCents === null ? 'Set price' : dollars(m.happyHour && m.happyHourPriceCents !== null ? m.happyHourPriceCents : m.priceCents);
const preparationNotes = (instructions) => instructions ? el('details', { class: 'bar-preparation' }, [el('summary', {}, 'How to make / serve'), el('p', { class: 'bar-instructions' }, instructions)]) : null;
const doneStatuses = ['paid', 'fulfilled', 'partially_fulfilled', 'returned', 'partially_returned', 'canceled'];

registerView('bar', async (container) => {
  let data, readiness, drawer, busy = false, selectedTab = null, selectedCheck = null;
  let category = 'All items', search = '', tabQuery = '', seat = 1, mode = 'service', ticketStation = 'kitchen', connectionError = '';
  let setupDoc, recipeSearch = '', recipeFamily = 'All recipes', lastAddedMenuId = null;
  const normalizedName = name => name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  function showInstructions(item) {
    const d = dialog(item.name);
    if (item.description) d.append(note(item.description));
    d.append(el('p', { class: 'bar-instructions' }, item.instructions || 'Add the house preparation instructions in Menu & stock.'));
  }
  function renderRecipes() {
    screen.append(el('h2', {}, 'Bartender drink guide'), note('Standard reference recipes · 1 oz ≈ 30 ml. Drinks on the selling menu can be added to a bill below.'));
    const searchBox = input({ placeholder: 'Find a drink, spirit or ingredient…', value: recipeSearch });
    searchBox.setAttribute('aria-label', 'Find a drink recipe');
    const cards = el('div', { class: 'bar-recipe-grid' });
    function draw() {
      clear(cards);
      const matches = findDrinkRecipes(recipeSearch, recipeFamily);
      for (const recipe of matches) {
        const card = el('section', { class: 'bar-recipe-card' }, [el('h3', {}, recipe.name), note(`${recipe.family} · ${recipe.glass}`), el('h4', {}, 'Ingredients'), el('ul', {}, recipe.ingredients.map(i => el('li', {}, i))), el('h4', {}, 'Make it'), el('ol', {}, recipe.steps.map(step => el('li', {}, step)))]);
        const selling = data.menu.find(m => normalizedName(m.value.name) === normalizedName(recipe.name))?.value;
        if (selling) card.append(action(`Add to bill · ${menuPrice(selling)}`, () => addDrink(selling), { primary: true, disabled: busy || !selling.available || selling.priceCents === null || !!pending }));
        else if (data.canManage) card.append(action('Create menu item', () => menuEditor(null, { name: recipe.name, category: ['No alcohol','Shots'].includes(recipe.family) ? recipe.family : 'Cocktails', prepStation: 'bar', priceCents: null, instructions: recipeInstructions(recipe) })));
        cards.append(card);
      }
      if (!matches.length) cards.append(note('No matching recipe. Search by spirit or ingredient.'));
    }
    searchBox.addEventListener('input', () => { recipeSearch = searchBox.value; draw(); });
    const families = ['All recipes', ...new Set(DRINK_RECIPES.map(r => r.family).sort())];
    screen.append(searchBox, el('div', { class: 'bar-categories' }, families.map(family => action(family, () => { recipeFamily = family; render(); }, { primary: recipeFamily === family }))), cards); draw();
  }
  const selected = new Set();
  const station = 'one-club-bar';
  const selectionKey = `one-club-bar-selection:${station}:${authenticatedActorId()}`;
  let newBill = false, refreshRequest = 0, stateFingerprint = '';
  try {
    const saved = JSON.parse(sessionStorage.getItem(selectionKey) || 'null');
    if (saved) { selectedTab = saved.tabId; selectedCheck = saved.checkId; newBill = saved.newBill === true; }
  } catch { /* A missing selection does not affect saved bills. */ }
  const pendingKey = `one-club-bar-pending:${station}`;
  let pending;
  try { pending = JSON.parse(sessionStorage.getItem(pendingKey) || 'null'); } catch { pending = null; }
  const stationName = () => 'Bar One bar';
  const screen = el('div', { class: 'bar-workspace' }); container.append(screen);
  const printers = createPrintClient({ getBridge: () => window.barOnePrint, onChange: () => {
    if (mode === 'tickets' && data && !busy && container.isConnected && !container.querySelector('dialog[open]')) render();
  } });
  const tab = () => data?.tabs.find(t => t.id === selectedTab);
  const check = () => tab()?.value.checks.find(c => c.id === selectedCheck);
  const currentPath = () => `${API}/tabs/${tab().id}`;
  const failure = (e) => toast(e.message || 'The request could not be confirmed.', 'err', 6500);
  const action = (label, fn, options = {}) => button(label, { disabled: busy, ...options, onClick: () => { if (!busy) return Promise.resolve().then(fn).catch(failure); } });
  function pick(t) { newBill = false; selectedTab = t.id; selectedCheck = t.value.checks[0]?.id; selected.clear(); lastAddedMenuId = null; render(); }
  function working() {
    busy = true; ++refreshRequest;
    screen.setAttribute('aria-busy', 'true');
    for (const control of screen.querySelectorAll('button,input,select')) control.disabled = true;
  }
  async function refresh() {
    const request = ++refreshRequest;
    const [state, ready, cash] = await Promise.all([getData(`${API}/state`), getData('/api/pos/readiness'), getData('/api/pos/drawer', { drawerRef: station })]);
    if (request !== refreshRequest) return;
    state.menu.sort((a,b) => a.value.category.localeCompare(b.value.category) || a.value.name.localeCompare(b.value.name));
    const fingerprint = JSON.stringify([state, ready, cash], (key, value) => ['asOf', 'checkedAt'].includes(key) ? undefined : value);
    const changed = fingerprint !== stateFingerprint || !!connectionError;
    stateFingerprint = fingerprint;
    data = state; readiness = ready; drawer = cash; connectionError = '';
    if (!tab() && !newBill) { selectedTab = data.tabs.find(t => t.value.status === 'open')?.id; }
    if (!check()) selectedCheck = tab()?.value.checks[0]?.id;
    if (changed) render();
    if (container.isConnected) void printers.pump(data.tickets);
  }
  async function send(path, body, after) {
    if (busy) return;
    if (connectionError) throw new Error('Reconnect to confirm the latest tabs before continuing.');
    if (pending) throw new Error('Recover the previous action before starting another.');
    pending = { path, body, key: newIdempotencyKey(), actor: authenticatedActorId() };
    sessionStorage.setItem(pendingKey, JSON.stringify(pending));
    return replay(after);
  }
  async function replay(after) {
    if (!pending || busy) return;
    if (pending.actor !== authenticatedActorId()) throw new Error('Sign in as the operator who started this action to recover it.');
    working();
    try {
      const response = await mutate(pending.path, 'POST', pending.body, { idempotencyKey: pending.key });
      pending = null; sessionStorage.removeItem(pendingKey);
      if (after) await after(response.data);
      await refresh(); return response.data;
    } catch (e) {
      if (e.status >= 400 && e.status < 500 && e.status !== 401) { pending = null; sessionStorage.removeItem(pendingKey); }
      await refresh().catch(() => {}); throw e;
    } finally { busy = false; render(); }
  }
  async function command(cmd, after) { return send(`${currentPath()}/commands`, { version: tab().version, ...cmd }, after); }
  async function saveAndNext() {
    if (busy || pending || !tab()) return;
    const current = tab(), bill = check();
    working();
    try {
      await refresh();
      const saved = data.tabs.find(t => t.id === current.id);
      if (!saved || saved.version < current.version || !saved.value.checks.some(c => c.id === bill?.id)) throw new Error('The saved bill could not be confirmed. Reconnect and try again.');
      newBill = true; selectedTab = null; selectedCheck = null; lastAddedMenuId = null; selected.clear(); seat = 1; mode = 'service';
      toast(`${bill?.name || current.value.name} saved. Ready for the next guest.`);
    } finally { busy = false; render(); }
  }
  function dialog(title, description) {
    const d = el('dialog', { class: 'bar-dialog', 'aria-label': title });
    d.append(row(el('h2', {}, title), action('Close', () => d.close())));
    if (description) d.append(note(description));
    container.append(d); d.addEventListener('close', () => d.remove(), { once: true });
    d.showModal(); return d;
  }
  function formDialog(title, fields, submitLabel, submit, description) {
    const d = dialog(title, description); const controls = {};
    const form = el('form');
    for (const f of fields) {
      const control = f.options ? select(f.label, f.options, f.value) : input({ name: f.name, value: f.value ?? '', placeholder: f.placeholder ?? '', type: f.type ?? 'text' });
      control.setAttribute('aria-label', f.label); if (f.numeric) control.setAttribute('inputmode', 'decimal');
      if (f.selectOnFocus) control.addEventListener('click', () => control.select(), { once: true });
      controls[f.name] = control; form.append(field(f.label, control));
    }
    const submitButton = action(submitLabel, save, { primary: true }); form.append(submitButton);
    form.addEventListener('submit', e => { e.preventDefault(); save().catch(failure); }); d.append(form);
    async function save() {
      if (busy || submitButton.disabled) return;
      submitButton.disabled = true;
      try { await submit(Object.fromEntries(Object.entries(controls).map(([k,v]) => [k,v.value]))); d.close(); }
      finally { submitButton.disabled = false; }
    }
    return d;
  }
  function printButton(label, document) {
    let printing = false;
    const button = action(label, async () => {
      if (printing) return;
      printing = true; button.disabled = true;
      try {
        const result = await printers.manual(document);
        if (result.status === 'browser') {
          documentBodyPrint();
        } else if (['alreadySubmitted', 'unknown'].includes(result.status)) {
          const review = dialog('Print another copy?', result.message);
          review.append(note('Check the paper first. An additional copy will be labeled REPRINT.'), action('Print another copy', async () => {
            const copy = await printers.manual(document, true);
            if (copy.status !== 'submitted') throw new Error(copy.message || 'The additional copy was not confirmed.');
            review.close(); toast(copy.message);
          }, { primary: true }));
        } else if (result.status === 'submitted') { toast(result.message || 'Sent to printer.'); }
      } finally { printing = false; button.disabled = busy; }
    }, { primary: true });
    return button;
  }
  function documentBodyPrint() {
    document.body.classList.add('printing-bar');
    try { window.print(); } finally { document.body.classList.remove('printing-bar'); }
  }
  function createTab() {
    formDialog('Open a tab', [{ name: 'name', label: 'Guest or tab name', placeholder: 'Guest name / walk-in' }, { name: 'table', label: 'Table or bar seat', placeholder: 'Patio 7' }, { name: 'billName', label: 'Bill name', placeholder: 'Optional · guest or group name' }], 'Open tab', v => send(`${API}/tabs`, { ...v, billName: v.billName.trim() || undefined }, t => pick(t)), 'Open tabs stay saved while staff switch on this iPad.');
  }
  function render() {
    if (busy && data) return;
    const scroll = [...screen.querySelectorAll('[data-scroll]')].map(node => [node.dataset.scroll, node.scrollLeft, node.scrollTop]);
    const active = screen.contains(document.activeElement) ? document.activeElement : null;
    const focus = active?.getAttribute('aria-label');
    const range = active?.tagName === 'INPUT' ? [active.selectionStart, active.selectionEnd] : null;
    const pagePosition = [window.scrollX, window.scrollY];
    try { drawScreen(); }
    finally {
      screen.removeAttribute('aria-busy');
      sessionStorage.setItem(selectionKey, JSON.stringify({ tabId: selectedTab, checkId: selectedCheck, newBill }));
      for (const [key, left, top] of scroll) {
        const node = screen.querySelector(`[data-scroll="${CSS.escape(key)}"]`);
        if (node) { node.scrollLeft = left; node.scrollTop = top; }
      }
      if (focus) {
        const node = screen.querySelector(`[aria-label="${CSS.escape(focus)}"]`);
        node?.focus({ preventScroll: true });
        if (range && range[0] !== null && node?.setSelectionRange) node.setSelectionRange(...range);
      }
      if (window.scrollX !== pagePosition[0] || window.scrollY !== pagePosition[1]) window.scrollTo(...pagePosition);
    }
  }
  function drawScreen() {
    screen.classList.toggle('bar-service', mode === 'service');
    clear(screen);
    if (!data) { screen.append(note('Loading the bar…')); return; }
    const open = data.tabs.filter(t => t.value.status === 'open');
    screen.append(el('div', { class: 'bar-heading' }, [el('div', {}, [el('p', { class: 'bar-eyebrow' }, 'BAR ONE · BAR SERVICE'), el('h1', {}, 'A round well served.'), note(`${open.length} open tabs · ${data.summary.queuedTickets} prep tickets to make`)]),
      row(action('Service', () => { mode = 'service'; render(); }, { primary: mode === 'service' }), action('Bar & kitchen', () => { mode = 'tickets'; render(); }, { primary: mode === 'tickets' }), action('Drink guide', () => { mode = 'recipes'; render(); }, { primary: mode === 'recipes' }),
        data.canManage ? action('Menu & stock', () => { mode = 'manage'; render(); }, { primary: mode === 'manage' }) : null, data.canManage ? action('Setup', setupDialog) : null)]));
    screen.append(el('div', {class:'bar-connection',role:'status'}, [note(connectionError || `${stationName()} · Updated ${new Date(data.asOf).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}`), connectionError ? action('Reconnect',refresh) : null]));
    if (pending && !busy) screen.append(el('div', { class: 'bar-alert', role: 'status' }, [note('An action is awaiting confirmation. Recover it before continuing.'), action('Recover last action', () => replay())]));
    if (!readiness.operational) screen.append(el('div', { class: 'bar-alert' }, [note(`You can add items and name bills. ${(readiness.blockers || []).filter(b => b.blocking).map(b => b.message).join(' ')} Sending and payment need completed setup.`), button('Open settings', { href: '#/settings' })]));
    if (mode === 'recipes') return renderRecipes();
    if (mode === 'tickets') return renderTickets();
    if (mode === 'manage') return renderManage();
    const tabs = el('aside', { class: 'bar-tabs', 'aria-label': 'Open tabs' }, [row(el('h2', {}, 'Tabs'), action('+ New', createTab, { primary: true }))]);
    const tabSearch = input({ placeholder: 'Find tab', value: tabQuery }); tabSearch.setAttribute('aria-label', 'Find tab'); tabs.append(tabSearch);
    const tabList = el('div', { class: 'bar-tab-list', 'data-scroll': 'tabs' }); tabs.append(tabList);
    const drawTabs = () => { clear(tabList); for (const t of open.filter(t => `${t.value.name} ${t.value.table} ${t.value.checks.map(c => c.name).join(' ')}`.toLowerCase().includes(tabSearch.value.toLowerCase()))) {
      tabList.append(el('button', { type: 'button', class: `bar-tab ${t.id === selectedTab ? 'active' : ''}`, onclick: () => pick(t) }, [el('strong', {}, t.value.name), el('span', {}, t.value.table || 'Bar tab'), el('span', {}, t.value.checks.map(c => c.name).join(' · ')), el('b', {}, `${dollars(t.remainingCents)}${t.taxPending ? ' + tax' : ''}`)]));
    } if (!open.length) tabList.append(note('Open a guest tab to begin.')); }; tabSearch.addEventListener('input', () => { tabQuery=tabSearch.value; drawTabs(); }); drawTabs();
    tabs.append(action('Recent checks', historyDialog));
    const menu = el('section', { class: 'bar-menu', 'aria-label': 'Food & drinks menu' });
    const searchBox = input({ placeholder: 'Find food or drinks…', value: search }); searchBox.setAttribute('aria-label', 'Find food or drinks');
    const seats = select('Seat for new items', Array.from({ length: 20 }, (_, n) => [n+1, `Seat ${n+1}`]), seat);
    seats.addEventListener('change', () => { seat = Number(seats.value); }); menu.append(row(searchBox, seats));
    const categories = ['All items', ...new Set(data.menu.map(m => m.value.category))];
    if (!categories.includes(category)) category = 'All items';
    const chips = el('div', { class: 'bar-categories', 'data-scroll': 'categories' }); const tiles = el('div', { class: 'bar-tiles', 'data-scroll': 'menu' });
    function drawMenu() {
      const chipLeft = chips.scrollLeft;
      clear(chips); clear(tiles);
      for (const c of categories) chips.append(action(c, () => { category = c; drawMenu(); }, { primary: category === c }));
      const matches = data.menu.map(d => d.value).filter(m => (category === 'All items' || m.category === category) && `${m.name} ${m.category}`.toLowerCase().includes(search.toLowerCase()));
      for (const m of matches) {
        const tile = el('button', { type: 'button', class: `bar-drink ${!m.available ? 'unavailable' : ''}`, disabled: busy || !m.available || m.priceCents === null || (tab()?.value.status === 'open' && !!check()?.orderId) || !!pending,
          onclick: () => addDrink(m).catch(failure) }, [el('span', { class: 'bar-drink-category' }, `${m.category}${m.prepStation==='kitchen'?' · Kitchen':''}`), el('strong', {}, m.name), el('span', { class: 'bar-drink-bottom' }, [el('b', {}, menuPrice(m)), el('span', {}, m.priceCents === null ? 'Price needed' : !m.available ? 'Sold out' : m.happyHour ? 'Happy hour' : '+')])]); const entry = el('div', { class: 'bar-menu-entry' }, [tile]); if (m.instructions) { const help = action('How to serve', () => showInstructions(m)); help.classList.add('bar-recipe-link'); help.setAttribute('aria-label', `How to serve ${m.name}`); entry.append(help); } tiles.append(entry);
      }
      if (!matches.length) tiles.append(note(data.menu.length ? 'No matching drinks.' : 'Add the venue’s drinks and prices in Menu & stock.'));
      chips.scrollLeft = chipLeft;
    }
    searchBox.addEventListener('input', () => { search = searchBox.value; drawMenu(); }); drawMenu(); menu.append(chips, tiles);
    const order = el('section', { class: 'bar-check', 'aria-label': 'Current check' }); renderCheck(order);
    screen.append(el('div', { class: 'bar-layout' }, [tabs, menu, order]));
  }
  function renderCheck(target) {
    const t = tab(), c = check();
    if (!t) { target.append(el('h2', {}, newBill ? 'Next guest' : 'Start a bill'), note('Tap an item to start a saved walk-in tab, or open a named tab.'), action('Open a tab', createTab, { primary: true })); return; }
    const heading = el('div', { class: 'bar-check-heading' }); target.append(heading);
    heading.append(row(el('div', {}, [el('h2', {}, c?.name || t.value.name), note(`${t.value.name}${t.value.table ? ' · ' + t.value.table : ''}`)]), action('Manage', tabDialog)));
    const checks = select('Current check', t.value.checks.map(c => [c.id, `${c.name} · ${dollars(c.totalCents)}`]), selectedCheck);
    checks.addEventListener('change', () => { selectedCheck = checks.value; selected.clear(); render(); });
    if (t.value.checks.length > 1) heading.append(checks);
    if (!c) return;
    if (!c.orderId && t.value.status === 'open') heading.append(action('Name bill', () => formDialog('Name bill', [{ name: 'name', label: 'Bill name', value: c.name, selectOnFocus: true }], 'Save bill name', v => command({ action: 'rename_check', checkId: c.id, name: v.name }))));
    const body = el('div', { class: 'bar-check-body', 'data-scroll': `bill:${c.id}` }); target.append(body);
    const lines = el('div', { class: 'bar-lines' });
    for (const a of c.allocations) {
      const i = t.value.items.find(i => i.id === a.itemId);
      const chosen = el('input', { type: 'checkbox', checked: selected.has(i.id), disabled: !!c.orderId, 'aria-label': `Select ${i.name}`, onchange: e => { e.target.checked ? selected.add(i.id) : selected.delete(i.id); target.querySelector('.bar-selection-count').textContent = `${selected.size} items selected`; } });
      lines.append(el('label', { class: `bar-line ${i.voided ? 'voided' : ''}` }, [chosen, el('div', {}, [el('strong', {}, i.name), note(`Seat ${i.seat}${a.share < .99999 ? ` · Shared ${Math.round(a.share * 100)}%` : ''} · ${i.voided ? 'Void' : i.comped ? 'Comp' : i.sentAt ? 'Sent' : 'New'}`), i.modifiers.length ? note(i.modifiers.join(' · ')) : null]), el('b', {}, dollars(a.netCents))]));
    }
    for (const a of c.allocations) { const item = t.value.items.find(i => i.id === a.itemId); if (item?.instructions) lines.append(el('div', {}, [note(item.name), preparationNotes(item.instructions)])); }
    if (!c.allocations.length) lines.append(note('Tap food or a drink to add it to this check.')); body.append(lines);
    if (!c.orderId && t.value.status === 'open') body.append(el('p',{class:'bar-note bar-selection-count'},`${selected.size} items selected`), row(action('Split', splitDialog), action('Move', moveDialog), data.canManage ? action('Comp / void', overrideDialog) : null));
    const unsent = t.value.items.filter(i => !i.sentAt && !i.voided).length;
    if (t.value.status === 'open') body.append(row(action(`Send round${unsent ? ` · ${unsent}` : ''}`, () => command({ action: 'send' }), { primary: true, disabled: busy || !unsent || !!t.taxPending || !readiness.operational }), action('Repeat', repeatDialog)));
    const footer = el('div', { class: 'bar-check-footer' }); target.append(footer);
    footer.append(el('div', { class: 'bar-totals' }, [row('Items', dollars(c.subtotalCents)), row('Tax', c.taxPending ? 'Pending setup' : dollars(c.taxCents)), c.tipCents ? row('Tip', dollars(c.tipCents)) : null, row(el('strong', {}, c.taxPending ? 'Before tax' : 'Total'), el('strong', {}, dollars(c.totalCents)))]));
    const billActions = el('div', { class: 'bar-bill-actions' }); footer.append(billActions);
    if (t.value.status === 'open') billActions.append(action('Save & next', saveAndNext, { primary: true, disabled: busy || !!pending }));
    if (doneStatuses.includes(c.status)) billActions.append(action('Receipt & refund', () => receiptDialog(c.orderId)));
    else billActions.append(action(c.orderId ? `Continue payment · ${dollars(c.remainingCents)}` : `Pay check · ${dollars(c.totalCents)}`, paymentDialog, { disabled: busy || !c.allocations.length || !!c.taxPending || !readiness.operational }));
    if (!c.orderId && t.value.status === 'open' && lastAddedMenuId) {
      const item = data.menu.find(m => m.id === lastAddedMenuId)?.value;
      const suggestions = item ? upsellsFor(item) : [];
      if (suggestions.length) body.append(el('section', { class: 'bar-upsells', 'aria-label': 'Suggested add-ons' }, [el('h3', {}, 'Add to this bill'), ...suggestions.map(m => action(`Add ${m.name} · ${menuPrice(m)}`, () => addDrink(m)))]));
    }
    if (t.value.status === 'open' && t.value.checks.every(c=>!c.allocations.length||doneStatuses.includes(c.status))) body.append(action('Close tab', () => command({ action: 'close' }, () => {
      selectedTab = null; selectedCheck = null; selected.clear();
    })));
  }
  async function addDrink(m) {
    if (busy || pending) return;
    const destination = tab()?.value.status === 'open' ? { tabId: tab().id, checkId: check()?.id } : null;
    if (destination && check()?.orderId) throw new Error('This bill is being paid. Add a new bill from Manage first.');
    const itemSeat = seat;
    const add = async (selections = {}, prepNote = '', quantity = 1, extras = []) => {
      const item = { menuId: m.id, selections, note: prepNote, quantity, seat: itemSeat };
      const after = t => { newBill = false; selectedTab = t.id; selectedCheck = destination?.checkId ?? t.value.checks[0].id; selected.clear(); lastAddedMenuId = m.id; mode = 'service'; };
      if (destination) {
        const current = data.tabs.find(t => t.id === destination.tabId);
        if (!current) throw new Error('This tab is no longer available. Select an open tab.');
        await send(`${API}/tabs/${destination.tabId}/commands`, { action: 'add', ...item, extras, checkId: destination.checkId, version: current.version }, after);
      } else await send(`${API}/tabs`, { name: 'Walk-in', billName: 'Walk-in', initialItems: [item, ...extras] }, after);
      toast(`Added ${quantity > 1 ? quantity + ' × ' : ''}${m.name} to ${check()?.name || 'the bill'}.`);
    };
    if (!m.modifiers.length && m.prepStation !== 'kitchen') return add();
    const d = dialog(m.name, destination ? `Adding to ${check().name} · ${tab().value.name}` : 'Starts a saved walk-in tab. You can name the bill after adding.');
    const form = el('form', { class: 'bar-item-form', id: `add-item-${newIdempotencyKey()}` }); d.append(form);
    const selections = {}, extras = new Map();
    const quantity = select('Quantity', Array.from({ length: 10 }, (_, i) => [i + 1, String(i + 1)]), 1);
    form.append(field('Quantity', quantity));
    const submitButton = el('button', { type: 'submit', class: 'btn btn-primary bar-add-submit', form: form.id }, 'Add to bill');
    const updatePrice = () => {
      let price = m.happyHour && m.happyHourPriceCents !== null ? m.happyHourPriceCents : m.priceCents;
      for (const g of m.modifiers) price += g.choices.find(c => c.id === selections[g.id])?.priceCents || 0;
      const extraPrice = [...extras.values()].reduce((s, e) => s + (e.happyHour && e.happyHourPriceCents !== null ? e.happyHourPriceCents : e.priceCents), 0);
      submitButton.textContent = `Add to bill · ${dollars(price * Number(quantity.value) + extraPrice)}`;
    };
    quantity.addEventListener('change', updatePrice);
    for (const g of m.modifiers) {
      const group = el('fieldset', { class: 'bar-option-group' }, [el('legend', {}, `${g.name}${g.required ? ' · choose one' : ' · optional'}`)]);
      const choices = g.required ? g.choices : [{ id: '', name: 'Standard', priceCents: 0 }, ...g.choices];
      const defaultChoice = g.choices.find(c => c.id === 'included')?.id;
      if (defaultChoice) selections[g.id] = defaultChoice;
      for (const choice of choices) {
        const radio = el('input', { type: 'radio', name: `option-${g.id}`, value: choice.id, required: g.required,
          checked: choice.id === (defaultChoice ?? (g.required ? null : '')), onchange: () => { selections[g.id] = choice.id; updatePrice(); } });
        group.append(el('label', { class: 'bar-option' }, [radio, el('span', {}, choice.name), el('b', {}, choice.priceCents ? `+${dollars(choice.priceCents)}` : 'Included')]));
      }
      form.append(group);
    }
    const suggestions = upsellsFor(m);
    if (suggestions.length) {
      const group = el('fieldset', { class: 'bar-option-group' }, [el('legend', {}, 'Add a drink or extra · optional')]);
      for (const extra of suggestions) group.append(el('label', { class: 'bar-option' }, [el('input', { type: 'checkbox', onchange: e => {
        e.target.checked ? extras.set(extra.id, extra) : extras.delete(extra.id); updatePrice();
      } }), el('span', {}, extra.name), el('b', {}, `+${menuPrice(extra)}`)]));
      form.append(group);
    }
    const prepNote = input({ placeholder: 'No onions / allergy information' }); prepNote.setAttribute('aria-label', 'Preparation note');
    form.append(field('Preparation note', prepNote)); d.append(submitButton); updatePrice();
    let submitting = false;
    form.addEventListener('submit', async e => {
      e.preventDefault(); if (submitting || busy || !form.reportValidity()) return;
      submitting = true; submitButton.disabled = true;
      try {
        await add(Object.fromEntries(Object.entries(selections).filter(([, v]) => v)), prepNote.value, Number(quantity.value), [...extras.keys()].map(menuId => ({ menuId, seat: itemSeat })));
        d.close();
      } catch (error) { failure(error); } finally { submitting = false; submitButton.disabled = false; }
    });
  }
  function upsellsFor(item) {
    const preferred = item.prepStation === 'kitchen' ? ['Bottled Water', 'Coca-Cola', 'House Lager'] : ['Bottled Water', 'Spinach & Artichoke Dip', 'Club Soda'];
    return preferred.map(name => data.menu.find(m => normalizedName(m.value.name) === normalizedName(name))?.value)
      .filter(m => m && m.id !== item.id && m.available && m.priceCents !== null && !m.modifiers.some(g => g.required));
  }
  function splitDialog() {
    const d = dialog('Split this check', 'Select items on the check to move them, or share every item equally.');
    d.append(action(`Move ${selected.size} selected to a new check`, async () => { if (!selected.size) throw new Error('Select drinks first.'); await command({ action: 'split', checkId: check().id, itemIds: [...selected], name: `Check ${tab().value.checks.length + 1}` }, t => { selectedCheck=t.value.checks.at(-1).id; }); selected.clear(); d.close(); }));
    const count = select('Number of equal checks', Array.from({ length: 9 }, (_,i) => [i+2, `${i+2} checks`]), 2);
    d.append(field('Share equally', count), action('Split equally', async () => { await command({ action: 'equal', checkId: check().id, count: Number(count.value) }); selected.clear(); d.close(); }, { primary: true }));
  }
  function moveDialog() {
    if (!selected.size) throw new Error('Select drinks on the check first.');
    formDialog('Move selected drinks', [{ name: 'checkId', label: 'Destination check', value: selectedCheck, options: tab().value.checks.filter(c => !c.orderId).map(c => [c.id, c.name]) }, { name: 'seat', label: 'Seat', value: seat, type: 'number' }], 'Move drinks', v => command({ action: 'move', itemIds: [...selected], checkId: v.checkId, seat: Number(v.seat) }, () => selected.clear()));
  }
  function overrideDialog() {
    if (selected.size !== 1) throw new Error('Select one drink for a comp or void.');
    formDialog('Manager adjustment', [{ name: 'action', label: 'Adjustment', options: [['comp', 'Comp — served free'], ['void', 'Void — remove charge']] }, { name: 'reason', label: 'Reason' }], 'Apply adjustment', v => command({ ...v, itemId: [...selected][0] }, () => selected.clear()), 'Poured drinks remain deducted from stock.');
  }
  function repeatDialog() {
    const rounds = [...new Set(tab().value.items.map(i => i.roundId).filter(Boolean))];
    if (!rounds.length) throw new Error('Send the first round before repeating it.');
    formDialog('Repeat a round', [{ name: 'roundId', label: 'Round', value: rounds.at(-1), options: rounds.map((id,n) => [id, `Round ${n+1}`]) }], 'Add another round', v => command({ action: 'repeat', roundId: v.roundId, checkId: check().id }), 'The current menu prices and availability apply. Review and send the new round.');
  }
  function tabDialog() {
    const d = dialog('Manage tab');
    d.append(action('Rename / change table', () => { d.close(); formDialog('Tab details', [{ name:'name',label:'Guest or tab name',value:tab().value.name }, { name:'table',label:'Table',value:tab().value.table }], 'Save details', v => command({ action:'rename',...v })); }),
      action('Add a check', async () => { await send(`${currentPath()}/new-check`, { version: tab().version, name: `Check ${tab().value.checks.length + 1}` }, t => { selectedCheck = t.value.checks.at(-1).id; }); d.close(); }),
      action('Merge into another tab', () => { const others = data.tabs.filter(t => t.value.status === 'open' && t.id !== selectedTab); if (!others.length) throw new Error('Open another tab first.'); d.close(); formDialog('Merge tabs', [{ name:'targetId',label:'Destination tab',options:others.map(t => [t.id,t.value.name]) }], 'Merge tabs', v => { const target = data.tabs.find(t => t.id === v.targetId); return send(`${currentPath()}/merge`, { version:tab().version,targetId:target.id,targetVersion:target.version }, pick); }); }),
      data.canManage ? action('Cancel unpaid tab', () => { d.close(); formDialog('Cancel unpaid tab', [{ name:'reason',label:'Reason' }], 'Cancel tab', v => command({ action:'cancel',reason:v.reason }, () => {
        newBill = true; selectedTab = null; selectedCheck = null; lastAddedMenuId = null; selected.clear();
      })); }, { danger: true }) : document.createTextNode(''));
  }
  function renderTickets() {
    const automatic = printers.configuration().automaticRoles.includes(ticketStation);
    screen.append(row(action('Kitchen',()=>{ticketStation='kitchen';render();},{primary:ticketStation==='kitchen'}),action('Bar',()=>{ticketStation='bar';render();},{primary:ticketStation==='bar'})),note(ticketStation==='kitchen'?'Food is routed here with its seat, options and preparation notes.':'Drinks are routed here separately from the food.'),
      note(automatic ? 'Automatic printing is enabled for this station. Check each ticket’s print status below.' : 'Print tickets manually, or choose a station printer and enable automatic printing in Receipt printer.'));
    const tickets = data.tickets.filter(t => t.value.status === 'queued' && (t.value.station||'bar')===ticketStation).reverse();
    const board = el('div', { class:'bar-ticket-grid' });
    for (const t of tickets) board.append(el('section', { class:'bar-ticket' }, [row(el('h2',{},t.value.tabName),el('span',{},new Date(t.createdAt).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}))),note(`${t.value.table||'Bar'} · ${ticketStation==='kitchen'?'KITCHEN':'BAR'}`),
      ...t.value.items.map(i => el('div',{class:`bar-ticket-line ${i.voided?'voided':''}`},[el('strong',{},`${i.voided?'VOID — ':''}${i.name}`),note(`Seat ${i.seat}${i.modifiers.length ? ' · '+i.modifiers.join(' · ') : ''}`), preparationNotes(i.instructions)])),
      printers.status(t) ? note(['submitted','alreadySubmitted'].includes(printers.status(t).status) ? 'Sent to printer' : printers.status(t).message || 'Printing needs attention') : null,
      action('Mark ready',()=>send(`${API}/tickets/${t.id}/ready`,{}),{primary:true}),action('Print ticket',()=>ticketReceipt(t))]));
    if (!tickets.length) board.append(note('All caught up. New orders will appear here.')); screen.append(board);
    const ready=data.tickets.filter(t=>t.value.status==='ready' && (t.value.station||'bar')===ticketStation).slice(0,10);
    if(ready.length)screen.append(el('h2',{},'Ready for pickup'),...ready.map(t=>note(`${t.value.tabName} · ${t.value.items.filter(i=>!i.voided).map(i=>i.name).join(', ')}`)));
  }
  function ticketReceipt(t) {
    const d=dialog('Kitchen / bar ticket');d.append(el('div',{class:'bar-receipt'},[el('h2',{},`${(t.value.station||'bar').toUpperCase()} · ${t.value.tabName}`),note(t.value.table||'Bar'),note(`Ticket ${t.id} · ${new Date(t.createdAt).toLocaleString()}`),...t.value.items.map(i=>el('div',{},[el('h3',{},`${i.voided?'VOID — ':''}${i.name} · Seat ${i.seat}`),note(i.modifiers.join(' · ')), i.instructions ? el('p', { class: 'bar-instructions' }, i.instructions) : null]))]));
    d.append(printButton('Print ticket', ticketPrintDocument(t)));
  }
  function historyDialog() {
    const d = dialog('Recent checks');
    const checks = data.tabs.flatMap(t => t.value.checks.filter(c => c.orderId).map(c => ({t,c})));
    if (!checks.length) d.append(note('No checks have reached payment yet.'));
    for (const {t,c} of checks) d.append(action(`${t.value.name} · ${c.name} · ${dollars(c.totalCents)} · ${c.status}`, () => { pick(t); selectedCheck = c.id; render(); d.close(); }));
  }
  async function paymentDialog() {
    if (!check().orderId) {
      const d = dialog('Review check', 'Set the tip before payment. For multiple cards, collect one portion at a time; cash can pay the final balance.');
      const tip = input({ name:'tip',value:(check().tipCents/100).toFixed(2) }); tip.setAttribute('aria-label','Tip amount'); tip.setAttribute('inputmode','decimal');
      const buttons = row(...[0,18,20,25].map(p => action(`${p}%`,()=>{tip.value=(Math.round(check().subtotalCents*p/100)/100).toFixed(2);}))); d.append(buttons,field('Tip $',tip));
      d.append(note(drawer ? 'This check will use the open drawer if cash is collected.' : 'Open a drawer before checkout if any guest will pay cash.'),action('Continue to payment',async()=>{
        if (money(tip.value)!==check().tipCents) await command({action:'tip',checkId:check().id,tipCents:money(tip.value)});
        await send(`${currentPath()}/checks/${check().id}/checkout`, {version:tab().version,registerId:station,...(drawer ? {cashSessionId:drawer.session.id}:{})}); d.close(); await paymentDialog();
      },{primary:true})); return;
    }
    const orderId = check().orderId; const d = dialog('Take payment'); const slot = el('div'); d.append(slot);
    let pollBusy = false;
    async function updatePayment() {
      if (!d.isConnected || pollBusy) return;
      pollBusy = true;
      try {
        const [balance,attempts] = await Promise.all([getData(`/api/pos/orders/${orderId}/balance`),getData(`/api/pos/orders/${orderId}/payment-attempts`)]);
        // Preserve entered amounts while refreshing provider status.
        const oldCard = slot.querySelector('[name="cardAmount"]')?.value;
        const oldCash = slot.querySelector('[name="cashReceived"]')?.value;
        // Typing is local; poll immediately again when the field blurs.
        if (['INPUT','SELECT','TEXTAREA'].includes(document.activeElement?.tagName) && slot.contains(document.activeElement) && !attempts.some(a => !['succeeded','failed','canceled'].includes(a.status))) return;
        const focus = slot.contains(document.activeElement) ? document.activeElement.name : null;
        clear(slot); slot.append(el('h3',{},`Balance ${dollars(balance.remainingCents)}`),note(`${dollars(balance.capturedCents)} collected · ${balance.status}`));
        if (doneStatuses.includes(balance.status)) { slot.append(action('View receipt',()=>{d.close();return receiptDialog(orderId);},{primary:true})); await refresh(); return; }
        const pendingAttempt = attempts.find(a => !['succeeded','failed','canceled'].includes(a.status));
        if (pendingAttempt) {
          slot.append(note(`Reader payment: ${pendingAttempt.status}. Payment is complete only after confirmation.`),action('Cancel reader attempt',()=>send(`/api/pos/payment-attempts/${pendingAttempt.id}/cancel`,{})));
        } else if (!balance.cancellationStarted) {
          const cardAmount = input({name:'cardAmount',value:oldCard ?? (balance.remainingCents/100).toFixed(2)}); cardAmount.setAttribute('aria-label','Card payment amount'); cardAmount.setAttribute('inputmode','decimal');
          slot.append(field('Charge this card $',cardAmount),action('Send to card reader',async()=>{
            const amountCents=money(cardAmount.value); if(amountCents<=0 || amountCents>balance.remainingCents) throw new Error('Enter an amount within the remaining balance.');
            await send(`/api/pos/orders/${orderId}/card-payments`,{amountCents,idempotencyKey:newIdempotencyKey()}); await updatePayment();
          },{primary:true,disabled:busy || !readiness?.tenders?.cardPresent?.enabled || balance.remainingCents<=0}));
          if (!readiness?.tenders?.cardPresent?.enabled) slot.append(note('Connect the approved merchant account and reader to enable cards.'));
          const cashReceived = input({name:'cashReceived',value:oldCash ?? (balance.remainingCents/100).toFixed(2)}); cashReceived.setAttribute('aria-label','Cash received'); cashReceived.setAttribute('inputmode','decimal');
          const change = note(''); const updateChange = () => {try{change.textContent=`Change to give: ${dollars(Math.max(0,money(cashReceived.value)-balance.remainingCents))}`;}catch{change.textContent='Enter the cash received.';}};
          cashReceived.addEventListener('input',updateChange); updateChange();
          slot.append(field('Cash received $',cashReceived),change,action(balance.remainingCents===0?'Complete zero-balance check':'Collect cash & give change',async()=>{
            const received=money(cashReceived.value); if(received<balance.remainingCents) throw new Error('Cash received is below the balance. Use card portions first, then collect the cash remainder.');
            if (drawer && balance.remainingCents > 0) await send(`${currentPath()}/checks/${check().id}/drawer`,{cashSessionId:drawer.session.id,registerId:station});
            await send(`/api/pos/orders/${orderId}/pay`,{tenders:balance.remainingCents ? [{kind:'cash',amountCents:balance.remainingCents,cashReceivedCents:received,idempotencyKey:newIdempotencyKey()}]:[]}); await updatePayment();
          },{disabled:busy || (!drawer && balance.remainingCents>0)}));
        }
        if (!drawer && balance.remainingCents>0) slot.append(action('Open drawer for cash',drawerDialog));
        if(data.canManage) slot.append(action('Cancel check / reverse partial payment',()=>{const confirm=dialog('Reverse this check?',`Collected card portions will be refunded to the original cards. Check total: ${dollars(check().totalCents)}.`);confirm.append(action('Reverse check',async()=>{await send(`/api/pos/orders/${orderId}/cancel-split`,{});confirm.close();await updatePayment();},{danger:true}));},{danger:true}));
        if(focus) slot.querySelector(`[name="${focus}"]`)?.focus({preventScroll:true});
      } finally { pollBusy=false; }
    }
    await updatePayment();
    async function poll() { if(!d.isConnected)return; if(!busy) await updatePayment().catch(failure); setTimeout(poll,2500); }
    d.append(action('Refresh payment status',updatePayment)); setTimeout(poll,2500);
  }
  async function receiptDialog(orderId) {
    const r = await getData(`/api/pos/receipts/${orderId}`); const d = dialog('Receipt & refunds');
    const receipt=el('div',{class:'bar-receipt'},[el('h2',{},r.merchant.name),note(`Receipt ${r.order.receipt_number} · ${r.order.status}`), r.order.note?.startsWith('Bill:') ? el('p', { class: 'bar-instructions' }, r.order.note) : null,...r.order.lines.map(l=>row(l.description,dollars(l.line_total_cents))),row('Tax',dollars(r.order.tax_cents)),row('Tip',dollars(r.order.tip_cents)),row(el('strong',{},'Total'),el('strong',{},dollars(r.order.total_cents))),note(`Paid ${dollars(r.amountPaidCents)} · Refunded ${dollars(r.amountRefundedCents)}`),note(r.merchant.receiptFooter || '')]); d.append(receipt);
    for (const t of r.tenders.filter(t=>['captured','partially_refunded','refunded'].includes(t.status))) {
      receipt.append(row(t.kind==='provider'?'Card':t.kind==='cash'?'Cash':'Payment',dollars(t.amount_cents)));
      if(t.provider_ref) receipt.append(note(`Transaction ID: ${t.provider_ref}`));
      if(t.kind==='cash')receipt.append(row('Cash received',dollars(t.cash_received_cents)),row('Change given',dollars(t.change_due_cents)));
    }
    d.append(printButton('Print receipt', receiptPrintDocument(r)));
    if(data.canManage) for(const tender of r.tenders.filter(t=>t.amount_cents>t.refunded_cents && ['captured','partially_refunded'].includes(t.status))) {
      d.append(action(`Refund ${tender.kind==='provider'?'card':tender.kind} payment`,()=>{ formDialog('Refund original payment',[{name:'amount',label:'Refund amount $',value:((tender.amount_cents-tender.refunded_cents)/100).toFixed(2),numeric:true},{name:'reason',label:'Reason'}],'Issue refund',async v=>{
        await send(`/api/pos/orders/${orderId}/refunds`,{tenderId:tender.id,idempotencyKey:newIdempotencyKey(),amountCents:money(v.amount),reason:v.reason,lines:[],...(tender.kind==='cash' && drawer?{cashSessionId:drawer.session.id}:{})}); d.close(); await receiptDialog(orderId);
      },'Refunds return money to the original payment. Poured stock stays consumed.');}));
    }
  }
  function drawerDialog() {
    if(!drawer) return formDialog('Open drawer shift',[{name:'float',label:'Opening float $',value:'0.00',numeric:true}],'Open drawer',v=>send('/api/pos/drawer/open',{drawerRef:station,registerRef:station,openingFloatCents:money(v.float)}));
    const d=dialog('Drawer shift'); d.append(note(stationName()),note(`Expected cash: ${dollars(drawer.reconciliation.effectiveExpectedCents)}`),action('Cash in / out',()=>{d.close();formDialog('Cash movement',[{name:'kind',label:'Movement',options:[['paid_in','Paid in'],['paid_out','Paid out'],['drop','Cash drop']]},{name:'amount',label:'Amount $',numeric:true},{name:'note',label:'Reason'}],'Save movement',v=>send(`/api/pos/drawer/${drawer.session.id}/movements`,{kind:v.kind,amountCents:money(v.amount),note:v.note,idempotencyKey:newIdempotencyKey()}));}),action('Close drawer',()=>{d.close();formDialog('Close drawer shift',[{name:'counted',label:'Cash counted $',numeric:true},{name:'note',label:'Closing note'}],'Close shift',v=>send(`/api/pos/drawer/${drawer.session.id}/close`,{countedCents:money(v.counted),note:v.note}));}),button('Money & reconciliation',{href:'#/money'}));
  }
  function download(name, content, type='text/csv') {
    const url=URL.createObjectURL(new Blob([content],{type}));
    const link=el('a',{href:url,download:name}); container.append(link); link.click(); link.remove(); setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  function exportMenu() {
    const cell=v=>`"${String(v).replace(/^[=+@-]/,"'$&").replaceAll('"','""')}"`;
    download('one-club-menu.csv',['name,category,price,station',...data.menu.map(m=>[m.value.name,m.value.category,m.value.priceCents === null ? '' : (m.value.priceCents/100).toFixed(2),m.value.prepStation||'bar'].map(cell).join(','))].join('\r\n'));
  }
  function importMenuDialog() {
    const d=dialog('Import menu', 'Paste the menu CSV below. Review every price and preparation station before adding the items. Existing items are kept; duplicate names stop the entire import.');
    const csv=el('textarea',{'aria-label':'Menu CSV',rows:9,placeholder:'name,category,price,station\nHouse Lager,Beer,6.00,bar\nBurger,Food,16.00,kitchen'});
    d.append(csv); const preview=el('div');d.append(preview);
    d.append(action('Review import',async()=>{
      const result=await mutate(`${API}/menu-import-preview`,'POST',{csv:csv.value});clear(preview);
      for(const m of result.data.items) preview.append(row(m.name,m.category,m.prepStation,menuPrice(m)));
      preview.append(action(`Add ${result.data.items.length} items`,async()=>{const imported=await send(`${API}/menu-import`,{items:result.data.items});d.close();toast(`${imported.added} items added.`);},{primary:true}));
    },{primary:true}));
    csv.addEventListener('input',()=>clear(preview));
  }
  async function setupDialog() {
    setupDoc=await getData(`${API}/setup`);
    const d=dialog('Set up the bar', 'Prepare the venue now. Equipment details stay marked pending until we can inspect and connect the actual devices.');
    const v=setupDoc?.value;
    d.append(el('h3',{},'One bar register'),note('One iPad, one cash drawer, and a card reader. Each bartender signs in with their own four-digit PIN.'));
    const venue=input({value:v?.venueName || 'ONE Club'}),phone=input({value:v?.supportPhone || ''}),processor=input({value:v?.processorName || ''});
    d.append(field('Venue name',venue),field('Support phone',phone),field('Existing processor name (when known)',processor));
    d.append(el('h3',{},'Equipment to reuse'));
    const devices=[];const deviceSlot=el('div');d.append(deviceSlot);
    const addDevice=(value={})=>{
      const name=input({value:value.name||'',placeholder:'Bar iPad'}),model=input({value:value.model||'',placeholder:'Model when known'});
      const kind=select('Equipment type',[['ipad','iPad'],['reader','Card reader'],['printer','Printer (kitchen / receipt)'],['drawer','Cash drawer']],value.kind||'ipad');
      const connection=select('Connection',[['unknown','Connection unknown'],['usb','USB'],['bluetooth','Bluetooth'],['network','Network']],value.connection||'unknown');
      const access=select('Equipment access',[['pending','Access pending'],['available','Access available']],value.access||'pending');
      const section=el('div',{class:'bar-option-group'});const device={id:value.id||newIdempotencyKey(),name,model,kind,connection,access};devices.push(device);
      section.append(field('Equipment name',name),row(kind,connection),field('Model',model),row(access,action('Remove equipment',()=>{devices.splice(devices.indexOf(device),1);section.remove();})));deviceSlot.append(section);
    };
    for(const device of v?.devices||[])addDevice(device);
    d.append(action('Add equipment',()=>addDevice()),action('Save venue & equipment',async()=>{await send(`${API}/setup`,{expectedVersion:setupDoc?.version||0,venueName:venue.value,supportPhone:phone.value,processorName:processor.value,devices:devices.map(v=>({id:v.id,name:v.name.value,kind:v.kind.value,model:v.model.value,connection:v.connection.value,access:v.access.value}))});d.close();toast('Venue setup saved.');},{primary:true}));
    d.append(el('h3',{},'Payments & receipts'),note(readiness?.tenders?.cardPresent?.enabled?'The configured reader adapter is responding. Practice mode still uses simulated payments.':'Card payments await the merchant account and a compatible, provisioned reader.'),note('Open tabs currently track food and drinks. Holding a card, adding to its authorization, and changing tips after payment require processor support and are not enabled.'));
    const settings=readiness.settings;
    const tax=input({value:settings.taxBps===null?'':(settings.taxBps/100).toFixed(2)}),footer=input({value:settings.receiptFooter||''});
    d.append(field('Sales tax % (venue-confirmed rate)',tax),field('Receipt footer',footer),action('Save tax & receipt',async()=>{
      if(!/^\d+(\.\d{1,2})?$/.test(tax.value.trim()))throw new Error('Enter a tax percentage such as 10.00.');
      await mutate('/api/pos/settings','PUT',{taxBps:money(tax.value),receiptFooter:footer.value});await refresh();toast('Tax and receipt settings saved.');
    }));
    d.append(el('h3',{},'Opening shift'),note('1. Sign in with your four-digit PIN.\n2. Choose Cash shift below and count the opening cash.\n3. Open a tab, choose seats, food and drinks, then Send round.\n4. Split or pay each check, then close the tab.\n5. Count cash and close the shift at shift end.'),action('Cash shift',()=>{d.close();drawerDialog();}),button('Staff & PIN access',{onClick:()=>{d.close();document.querySelector('#current-user')?.click();}}),button('More venue settings',{href:'#/settings'}));
  }
  function renderManage() {
    const menu=el('section',{class:'bar-manage-section'},[row(el('h2',{},'Food & drinks menu'),action('Add food / drink',()=>menuEditor(),{primary:true}))]);
    for(const m of data.menu)menu.append(row(el('div',{},[el('strong',{},m.value.name),note(`${m.value.category} · ${m.value.prepStation==='kitchen'?'Kitchen':'Bar'} · ${menuPrice(m.value)} · ${m.value.available?'Available':'Sold out'}`)]),action('Edit',()=>menuEditor(m))));
    const stock=el('section',{class:'bar-manage-section'},[row(el('h2',{},'Ingredients & counts'),action('Add ingredient',()=>stockEditor(),{primary:true}))]);
    for(const i of data.ingredients)stock.append(row(el('div',{},[el('strong',{},i.value.name),note(`${i.value.onHand} ${i.value.unit}`)]),action('Count',()=>stockEditor(i))));
    screen.append(row(action('Import menu CSV',importMenuDialog), action('Export menu CSV',exportMenu), action('Export menu & recipes',()=>download('one-club-menu-recipes.json',JSON.stringify({exportedAt:new Date().toISOString(),menu:data.menu,ingredients:data.ingredients},null,2),'application/json'))),el('div',{class:'bar-manage-grid'},[menu,stock]));
  }
  function stockEditor(doc) {
    formDialog(doc?'Count ingredient':'Add ingredient',[{name:'name',label:'Ingredient name',value:doc?.value.name},{name:'unit',label:'Stock unit',value:doc?.value.unit,options:[['ml','Milliliters'],['unit','Units / bottles / cans']]},{name:'onHand',label:'Count on hand',value:doc?.value.onHand ?? 0,type:'number'},{name:'reason',label:'Reason'}],'Save count',v=>send(`${API}/stock`,{...(doc?{id:doc.id,expectedVersion:doc.version}:{}),...v,onHand:Number(v.onHand)}));
  }
  function optionRecipe(choice) {
    const d=dialog('Extra ingredients', 'Ingredients consumed when this option is selected. Quantities add to the base recipe.');const rows=[],slot=el('div');d.append(slot);
    const add=(value={})=>{const ingredient=select('Ingredient',data.ingredients.map(i=>[i.id,`${i.value.name} (${i.value.unit})`]),value.ingredientId);const quantity=input({type:'number',value:value.quantity||1});quantity.setAttribute('aria-label','Extra ingredient quantity');const entry={ingredient,quantity},line=row(ingredient,quantity);rows.push(entry);line.append(action('Remove',()=>{rows.splice(rows.indexOf(entry),1);line.remove();}));slot.append(line);};
    for(const value of choice.recipe)add(value);
    d.append(action('Add ingredient',()=>{if(!data.ingredients.length)throw new Error('Add ingredients in Menu & stock first.');add();}),action('Use these ingredients',()=>{const recipe=rows.map(r=>({ingredientId:r.ingredient.value,quantity:Number(r.quantity.value)}));if(recipe.some(r=>!Number.isInteger(r.quantity)||r.quantity<=0))throw new Error('Use positive whole quantities.');choice.recipe=recipe;d.close();},{primary:true}));
  }
  function menuEditor(doc, preset) {
    const m=doc?.value || preset; const d=dialog(doc?'Edit menu item':'Add food / drink');
    const name=input({value:m?.name ?? ''}); const cat=input({value:m?.category ?? 'Cocktails'}); const price=input({value:m?.priceCents == null ? '' : (m.priceCents/100).toFixed(2),placeholder:'Set price'});
    price.setAttribute('aria-label','Price $');
    const description=input({value:m?.description || ''});
    const instructions=el('textarea', { rows: 6, 'aria-label': 'Preparation instructions' }); instructions.value=m?.instructions || '';
    const prep=select('Send to',[['bar','Bar — drinks'],['kitchen','Kitchen — food']],m?.prepStation||'bar');
    const availability=select('Availability',[['yes','Available'],['no','Sold out']],m?.available===false?'no':'yes');
    const happy=select('Happy hour',[['no','Regular pricing'],['yes','Happy hour active']],m?.happyHour?'yes':'no'); const happyPrice=input({value:m?.happyHourPriceCents==null || !m ? '' : (m.happyHourPriceCents/100).toFixed(2)});
    d.append(field('Item name',name),field('Send to',prep),row(field('Category',cat),field('Price $',price)),row(field('Availability',availability),field('Pricing',happy)),field('Happy hour price $',happyPrice),el('h3',{},'Recipe'));
    d.append(note('Leave an unknown price blank. The item stays on the menu but cannot be sold until priced.'), field('Description / included sides',description), field('Preparation instructions',instructions));
    const recipeRows=[]; const recipes=el('div'); d.append(recipes);
    const addRecipe=(r={})=>{const ingredient=select('Ingredient',data.ingredients.map(i=>[i.id,`${i.value.name} (${i.value.unit})`]),r.ingredientId); const quantity=input({value:r.quantity ?? 1,type:'number'});quantity.setAttribute('aria-label','Recipe quantity');const line=row(ingredient,quantity);const entry={ingredient,quantity,line};recipeRows.push(entry);line.append(action('Remove',()=>{recipeRows.splice(recipeRows.indexOf(entry),1);line.remove();}));recipes.append(line);};
    for(const r of m?.recipe ?? [])addRecipe(r); d.append(action('Add ingredient to recipe',()=>{if(!data.ingredients.length)throw new Error('Add ingredients in stock first.');addRecipe();}));
    d.append(el('h3',{},'Preparation options'),note('Examples: spirit, mixer, side dish, or cooking preference. Each group allows one choice.'));
    const groups=[];const groupSlot=el('div');d.append(groupSlot);
    const addGroup=(g={})=>{const groupName=input({value:g.name ?? ''});const required=select('Choice required',[['no','Optional'],['yes','Required']],g.required?'yes':'no');const group=el('div',{class:'bar-option-group'});const choices=[];const choiceSlot=el('div');const entry={id:g.id || newIdempotencyKey(),groupName,required,choices,group};groups.push(entry);group.append(row(field('Option group',groupName),required,action('Remove group',()=>{groups.splice(groups.indexOf(entry),1);group.remove();})),choiceSlot);
      const addChoice=(v={})=>{const choiceName=input({value:v.name ?? '',placeholder:'Choice name'});choiceName.setAttribute('aria-label','Choice name');const extra=input({value:((v.priceCents ?? 0)/100).toFixed(2)});extra.setAttribute('aria-label','Extra price $');const line=row(choiceName,extra);const choice={id:v.id || newIdempotencyKey(),choiceName,extra,recipe:v.recipe ?? []};choices.push(choice);line.append(action('Extra ingredients',()=>optionRecipe(choice)),action('Remove',()=>{choices.splice(choices.indexOf(choice),1);line.remove();}));choiceSlot.append(line);};for(const v of g.choices ?? [])addChoice(v);group.append(action('Add choice',()=>addChoice()));groupSlot.append(group);};
    for(const g of m?.modifiers ?? [])addGroup(g);d.append(action('Add option group',()=>addGroup()),action('Save menu item',async()=>{
      await send(`${API}/menu`,{...(doc?{id:doc.id,expectedVersion:doc.version}:{}),name:name.value,category:cat.value,prepStation:prep.value,priceCents:price.value.trim()?money(price.value):null,description:description.value,instructions:instructions.value,available:availability.value==='yes',happyHour:happy.value==='yes',happyHourPriceCents:happyPrice.value.trim()?money(happyPrice.value):null,recipe:recipeRows.map(r=>({ingredientId:r.ingredient.value,quantity:Number(r.quantity.value)})),modifiers:groups.map(g=>({id:g.id,name:g.groupName.value,required:g.required.value==='yes',choices:g.choices.map(c=>({id:c.id,name:c.choiceName.value,priceCents:money(c.extra.value),recipe:c.recipe}))}))});d.close();
    },{primary:true}));
  }
  await refresh().catch(()=>{connectionError='Connection unavailable. Reload to reconnect.';screen.append(note(connectionError),action('Reconnect',refresh));});
  async function poll() { if(!container.isConnected)return; if(!busy && !container.querySelector('dialog[open]') && !['INPUT','SELECT','TEXTAREA'].includes(document.activeElement?.tagName))await refresh().catch(()=>{connectionError='Connection lost · Reconnect before taking another order.';render();}); setTimeout(poll,5000); }
  setTimeout(poll,5000);
});

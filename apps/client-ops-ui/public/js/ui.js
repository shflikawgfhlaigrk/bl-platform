import { append, clear, el, fragment } from './dom.js';
import { icon } from './icons.js';
import { statusTone, titleCase } from '../src/transforms.mjs';

export function button(label, options = {}) {
  return el('button', {
    className: `button${options.variant ? ` is-${options.variant}` : ''}${options.wide ? ' is-wide' : ''}`,
    type: options.type || 'button',
    disabled: options.disabled,
    title: options.title,
    'aria-label': options.ariaLabel,
    onclick: options.onClick,
  }, [options.icon ? icon(options.icon) : null, el('span', { text: label })]);
}

export function iconButton(name, label, onClick) {
  return el('button', { className: 'icon-button', type: 'button', 'aria-label': label, onclick: onClick }, icon(name));
}

export function viewHeader(title, description, actions = []) {
  return el('header', { className: 'view-header' }, [
    el('div', {}, [
      el('h1', { text: title }),
      description ? el('p', { className: 'view-description', text: description }) : null,
    ]),
    actions.length ? el('div', { className: 'view-actions' }, actions) : null,
  ]);
}

export function statusLabel(status) {
  const tone = statusTone(status);
  return el('span', { className: 'status-label' }, [
    el('span', { className: `status-dot is-${tone}`, 'aria-hidden': 'true' }),
    el('span', { text: titleCase(status) }),
  ]);
}

export function panel(title, body, options = {}) {
  return el('section', { className: `panel${options.className ? ` ${options.className}` : ''}` }, [
    el('header', { className: 'panel-header' }, [
      el(options.headingLevel || 'h2', { text: title }),
      options.action || null,
    ]),
    body,
    options.footer ? el('footer', { className: 'panel-footer' }, options.footer) : null,
  ]);
}

export function inlineLink(label, options = {}) {
  const attributes = {
    className: 'inline-link',
    onclick: options.onClick,
  };
  const tag = options.href ? 'a' : 'button';
  if (options.href) attributes.href = options.href;
  else attributes.type = 'button';
  return el(tag, attributes, [el('span', { text: label }), icon(options.icon || 'chevron')]);
}

export function loadingState(message = 'Loading live Client Operations data…', rows = 6) {
  return el('div', { className: 'panel' }, [
    el('div', { className: 'loading-state', role: 'status' }, [
      el('span', { className: 'state-icon' }, icon('refresh')),
      el('h2', { text: 'Loading' }),
      el('p', { text: message }),
    ]),
    el('div', { className: 'skeleton-stack', 'aria-hidden': 'true' }, Array.from({ length: rows }, () => el('div', { className: 'skeleton-line' }))),
  ]);
}

export function emptyState(title, message, options = {}) {
  return el('section', { className: 'panel empty-state' }, [
    el('span', { className: 'state-icon' }, icon(options.icon || 'empty')),
    el('h2', { text: title }),
    el('p', { text: message }),
    options.action || null,
  ]);
}

export function errorState(error, retry) {
  const isTenantError = error?.status === 400 && /tenant/i.test(error?.message || '');
  return el('section', { className: 'panel error-state', role: 'alert' }, [
    el('span', { className: 'state-icon' }, icon('alert')),
    el('h2', { text: isTenantError ? 'Client context required' : 'Live data unavailable' }),
    el('p', { text: error?.message || 'The Client Operations API did not return data.' }),
    retry ? button('Try again', { icon: 'refresh', onClick: retry }) : null,
  ]);
}

export function tableShell(title, table, options = {}) {
  return el('section', { className: 'table-shell' }, [
    el('div', { className: 'table-toolbar' }, [
      el('h2', { className: 'table-title', text: title }),
      options.toolbar || null,
    ]),
    el('div', { className: 'table-scroll' }, table),
    options.footer ? el('footer', { className: 'panel-footer' }, options.footer) : null,
  ]);
}

export function definitionList(entries) {
  return el('dl', { className: 'definition-list' }, entries.map(([term, value]) => el('div', { className: 'definition-row' }, [
    el('dt', { text: term }),
    value instanceof Node ? el('dd', {}, value) : el('dd', { text: value ?? '—' }),
  ])));
}

export function drawerSection(title, children) {
  return el('section', { className: 'drawer-section' }, [
    title ? el('h3', { text: title }) : null,
    ...(Array.isArray(children) ? children : [children]),
  ]);
}

export function createDrawer(shell, drawer, contextNode, titleNode, bodyNode, actionsNode) {
  let previouslyFocused = null;

  function close({ restoreFocus = true } = {}) {
    shell.classList.remove('drawer-open');
    drawer.setAttribute('aria-hidden', 'true');
    clear(bodyNode);
    clear(actionsNode);
    actionsNode.hidden = true;
    if (restoreFocus && previouslyFocused?.isConnected) previouslyFocused.focus();
    previouslyFocused = null;
  }

  function open({ context = 'Details', title = 'Selection', body = null, actions = [] } = {}) {
    previouslyFocused = document.activeElement;
    contextNode.textContent = context;
    titleNode.textContent = title;
    clear(bodyNode);
    if (body) append(bodyNode, body);
    clear(actionsNode);
    append(actionsNode, actions);
    actionsNode.hidden = actions.length === 0;
    drawer.setAttribute('aria-hidden', 'false');
    shell.classList.add('drawer-open');
    requestAnimationFrame(() => drawer.querySelector('button, input, select, textarea, a[href]')?.focus());
  }

  return { open, close, get isOpen() { return shell.classList.contains('drawer-open'); } };
}

export function createToastStack(root) {
  return function toast(message, type = 'success') {
    const item = el('div', { className: `toast${type === 'error' ? ' is-error' : ''}`, role: type === 'error' ? 'alert' : 'status' }, [
      icon(type === 'error' ? 'alert' : 'check'),
      el('span', { text: message }),
    ]);
    root.append(item);
    const timer = setTimeout(() => item.remove(), 4200);
    item.addEventListener('click', () => {
      clearTimeout(timer);
      item.remove();
    });
  };
}

export async function mutateWithFeedback(control, operation, context, messages = {}) {
  const priorDisabled = control?.disabled;
  if (control) control.disabled = true;
  try {
    const result = await operation();
    context.setConnection(true);
    context.toast(messages.success || 'Change saved.');
    return result;
  } catch (error) {
    context.setConnection(false);
    context.toast(error?.message || messages.error || 'The request failed.', 'error');
    throw error;
  } finally {
    if (control) control.disabled = Boolean(priorDisabled);
  }
}

export function serviceIcon(service = {}) {
  const name = `${service.id || ''} ${service.name || ''}`.toLowerCase();
  if (/front desk|phone|reception/.test(name)) return 'headset';
  if (/sales/.test(name)) return 'sales';
  if (/market/.test(name)) return 'marketing';
  if (/support/.test(name)) return 'support';
  if (/executive|hq/.test(name)) return 'building';
  if (/private|agent/.test(name)) return 'lock';
  if (/data/.test(name)) return 'database';
  return 'workflows';
}

export function packIcon(pack = {}) {
  const name = `${pack.id || ''} ${pack.name || ''}`.toLowerCase();
  if (/medical|dental/.test(name)) return 'tooth';
  if (/real.?estate|property/.test(name)) return 'home';
  if (/home.?service/.test(name)) return 'tool';
  if (/law/.test(name)) return 'gavel';
  if (/commerce/.test(name)) return 'cart';
  if (/review/.test(name)) return 'star';
  return 'building';
}

export function inputField(label, options = {}) {
  const id = options.id || `field_${Math.random().toString(36).slice(2)}`;
  const attributes = {
    id,
    className: options.multiline ? 'textarea' : 'input',
    value: options.value || '',
    placeholder: options.placeholder,
    required: options.required,
    ...(options.multiline ? { rows: options.rows || 3 } : { type: options.type || 'text' }),
  };
  const control = el(options.multiline ? 'textarea' : 'input', attributes);
  return { control, root: el('label', { for: id }, [el('span', { className: 'field-label', text: label }), control]) };
}

export { clear, el, fragment };

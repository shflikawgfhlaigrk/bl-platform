/** Touch-first POS operator sign-in and session controls. */
import { apiGet, mutate, setAuthenticatedActor } from './api.js';
import { el, toast } from './dom.js';
import { currentSnapshot } from './offline.js';
import { clubBrand } from './brand.js';

const AUTH = '/api/pos/auth';
let identity = null;
let signInPromise = null;

function roleLabel(roles = []) {
  if (roles.includes('owner')) return 'Owner';
  if (roles.includes('manager')) return 'Manager';
  if (roles.includes('cashier')) return 'Cashier';
  return 'Operator';
}

function setHeader(operator) {
  identity = operator;
  setAuthenticatedActor(operator.id);
  const target = document.getElementById('current-user');
  if (!target) return;
  target.textContent = `${operator.name} · ${roleLabel(operator.roles)}`;
  target.title = `Signed in as ${operator.name}. Select to switch operator or manage access.`;
  target.hidden = false;
}

function pinInput(labelText = 'PIN') {
  const input = el('input', {
    type: 'password',
    inputmode: 'numeric',
    pattern: '[0-9]{4}',
    minlength: '4',
    maxlength: '4',
    autocomplete: 'off',
    required: true,
    'aria-label': labelText,
    placeholder: '4-digit PIN',
  });
  return input;
}

function showError(node, error) {
  node.hidden = false;
  node.textContent = error?.message || 'Sign-in failed. Try again.';
}

function shell(title, subtitle) {
  const dialog = el('dialog', { class: 'auth-dialog', 'aria-labelledby': 'auth-title' });
  dialog.addEventListener('cancel', (event) => event.preventDefault());
  dialog.append(
    clubBrand('auth-brand'),
    el('h1', { id: 'auth-title' }, title),
    el('p', { class: 'view-sub' }, subtitle),
  );
  document.body.append(dialog);
  dialog.showModal();
  return dialog;
}

async function operatorDirectory() {
  return (await apiGet(`${AUTH}/operators`)).data;
}

async function bootstrapDialog(directory) {
  const owner = directory.operators.find((operator) => operator.roles.includes('owner'));
  const dialog = shell(
    'Secure this register',
    'Create the owner PIN used to unlock the register and manage cashier access.',
  );
  const pin = pinInput('New owner PIN');
  const confirm = pinInput('Confirm owner PIN');
  const error = el('div', { class: 'error-banner', role: 'alert', hidden: true });
  const submit = el('button', { class: 'btn btn-primary auth-submit', type: 'submit' }, 'Secure & sign in');
  const form = el('form', { class: 'auth-form' }, [
    el('div', { class: 'auth-operator-selected' }, [
      el('strong', {}, owner?.name || 'Owner'),
      el('span', { class: 'chip chip-ok' }, 'Owner'),
    ]),
    el('label', { class: 'field' }, [el('span', {}, 'New PIN'), pin]),
    el('label', { class: 'field' }, [el('span', {}, 'Confirm PIN'), confirm]),
    el('p', { class: 'hint' }, 'Use exactly four digits. Five incorrect attempts lock the operator for five minutes.'),
    error,
    submit,
  ]);
  dialog.append(form);
  queueMicrotask(() => pin.focus());
  return new Promise((resolve) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      error.hidden = true;
      if (pin.value !== confirm.value) {
        showError(error, new Error('The PINs do not match.'));
        confirm.focus();
        return;
      }
      submit.disabled = true;
      submit.textContent = 'Securing…';
      try {
        const result = await mutate(`${AUTH}/bootstrap`, 'POST', { pin: pin.value });
        dialog.close();
        dialog.remove();
        resolve(result.data);
      } catch (err) {
        showError(error, err);
        submit.disabled = false;
        submit.textContent = 'Secure & sign in';
      }
    });
  });
}

async function loginDialog(directory) {
  const configured = directory.operators.filter((operator) => operator.pinConfigured);
  const dialog = shell('Operator sign in', 'Choose your name and enter your register PIN.');
  const select = el(
    'select',
    { required: true, 'aria-label': 'Register operator' },
    configured.length
      ? configured.map((operator) => el('option', { value: operator.id }, `${operator.name} · ${roleLabel(operator.roles)}`))
      : [el('option', { value: '' }, 'No PIN-enabled operators')],
  );
  const pin = pinInput();
  const error = el('div', { class: 'error-banner', role: 'alert', hidden: true });
  const submit = el(
    'button',
    { class: 'btn btn-primary auth-submit', type: 'submit', disabled: configured.length === 0 },
    'Sign in',
  );
  const form = el('form', { class: 'auth-form' }, [
    el('label', { class: 'field' }, [el('span', {}, 'Operator'), select]),
    el('label', { class: 'field' }, [el('span', {}, 'PIN'), pin]),
    configured.length === 0
      ? el('div', { class: 'blocked', role: 'note' }, 'No operator has a PIN. An owner must configure register access.')
      : null,
    error,
    submit,
  ]);
  dialog.append(form);
  queueMicrotask(() => {
    // Show touch users the whole dialog before opening the on-screen keyboard.
    if (!window.matchMedia('(pointer: coarse)').matches) (configured.length ? pin : select).focus();
  });
  return new Promise((resolve) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      submit.disabled = true;
      submit.textContent = 'Signing in…';
      error.hidden = true;
      try {
        const result = await mutate(`${AUTH}/session`, 'POST', {
          userId: select.value,
          pin: pin.value,
        });
        dialog.close();
        dialog.remove();
        resolve(result.data);
      } catch (err) {
        showError(error, err);
        pin.value = '';
        pin.focus();
        submit.disabled = false;
        submit.textContent = 'Sign in';
      }
    });
  });
}

async function forceSignIn() {
  if (signInPromise) return signInPromise;
  signInPromise = (async () => {
    const directory = await operatorDirectory();
    const signedIn = directory.bootstrapRequired
      ? await bootstrapDialog(directory)
      : await loginDialog(directory);
    setHeader(signedIn);
    return signedIn;
  })();
  try {
    return await signInPromise;
  } finally {
    signInPromise = null;
  }
}

function actionButton(text, action, options = {}) {
  return el('button', {
    class: `btn${options.primary ? ' btn-primary' : ''}${options.danger ? ' btn-danger' : ''}`,
    type: options.submit ? 'submit' : 'button',
    onclick: options.submit ? null : action,
  }, text);
}

async function changePinDialog() {
  const dialog = shell('Change my PIN', 'Your other register sessions will be signed out.');
  const pin = pinInput('New PIN');
  const confirm = pinInput('Confirm new PIN');
  const error = el('div', { class: 'error-banner', role: 'alert', hidden: true });
  const save = actionButton('Save PIN', null, { submit: true, primary: true });
  const form = el('form', { class: 'auth-form' }, [
    el('label', { class: 'field' }, [el('span', {}, 'New PIN'), pin]),
    el('label', { class: 'field' }, [el('span', {}, 'Confirm PIN'), confirm]),
    error,
    el('div', { class: 'view-actions' }, [
      actionButton('Cancel', () => { dialog.close(); dialog.remove(); }),
      save,
    ]),
  ]);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (pin.value !== confirm.value) return showError(error, new Error('The PINs do not match.'));
    save.disabled = true;
    try {
      await mutate(`${AUTH}/operators/${identity.id}/pin`, 'PUT', { pin: pin.value });
      toast('Operator PIN updated.');
      dialog.close();
      dialog.remove();
    } catch (err) {
      showError(error, err);
      save.disabled = false;
    }
  });
  dialog.append(form);
  queueMicrotask(() => pin.focus());
}

async function addOperatorDialog() {
  const dialog = shell('Add register operator', 'Create a cashier or manager with their own attributable PIN.');
  const name = el('input', { required: true, maxlength: '120', autocomplete: 'off' });
  const email = el('input', { required: true, type: 'email', autocomplete: 'off' });
  const role = el('select', {}, [
    el('option', { value: 'cashier' }, 'Cashier'),
    el('option', { value: 'manager' }, 'Manager'),
  ]);
  const pin = pinInput('Operator PIN');
  const error = el('div', { class: 'error-banner', role: 'alert', hidden: true });
  const add = actionButton('Add operator', null, { submit: true, primary: true });
  const form = el('form', { class: 'auth-form' }, [
    el('label', { class: 'field' }, [el('span', {}, 'Name'), name]),
    el('label', { class: 'field' }, [el('span', {}, 'Email'), email]),
    el('label', { class: 'field' }, [el('span', {}, 'Role'), role]),
    el('label', { class: 'field' }, [el('span', {}, 'PIN'), pin]),
    error,
    el('div', { class: 'view-actions' }, [
      actionButton('Cancel', () => { dialog.close(); dialog.remove(); }),
      add,
    ]),
  ]);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    add.disabled = true;
    try {
      const result = await mutate(`${AUTH}/operators`, 'POST', {
        name: name.value,
        email: email.value,
        role: role.value,
        pin: pin.value,
      });
      toast(`${result.data.name} can now sign in.`);
      dialog.close();
      dialog.remove();
    } catch (err) {
      showError(error, err);
      add.disabled = false;
    }
  });
  dialog.append(form);
  queueMicrotask(() => name.focus());
}

async function operatorMenu() {
  if (!identity) return;
  const dialog = shell(identity.name, `${roleLabel(identity.roles)} · Session expires ${new Date(identity.expiresAt).toLocaleString()}`);
  const actions = el('div', { class: 'auth-menu' }, [
    actionButton('Change my PIN', () => { dialog.close(); dialog.remove(); changePinDialog(); }),
    identity.canManageOperators
      ? actionButton('Add cashier or manager', () => { dialog.close(); dialog.remove(); addOperatorDialog(); })
      : null,
    actionButton('Switch operator', async () => {
      const queued = currentSnapshot();
      if (queued.items.length > 0) {
        toast(`Finish or review ${queued.items.length} unsynced change${queued.items.length === 1 ? '' : 's'} before switching operator.`, 'warn');
        return;
      }
      const button = dialog.querySelector('button.btn-danger');
      if (button) button.disabled = true;
      await mutate(`${AUTH}/session`, 'DELETE', null);
      identity = null;
      setAuthenticatedActor(null);
      dialog.close();
      dialog.remove();
      await forceSignIn();
      window.location.reload();
    }, { danger: true }),
    actionButton('Close', () => { dialog.close(); dialog.remove(); }),
  ]);
  dialog.append(actions);
}

export async function requireOperatorSession() {
  try {
    const response = await apiGet(`${AUTH}/session`);
    setHeader(response.data);
  } catch (error) {
    if (error?.status !== 401) throw error;
    await forceSignIn();
  }
  const target = document.getElementById('current-user');
  if (target && !target.dataset.authWired) {
    target.dataset.authWired = 'true';
    target.addEventListener('click', operatorMenu);
  }
  window.addEventListener('mags:auth-required', () => {
    identity = null;
    setAuthenticatedActor(null);
    forceSignIn().catch((error) => toast(error.message, 'err'));
  });
  return identity;
}

export function currentOperator() {
  return identity;
}

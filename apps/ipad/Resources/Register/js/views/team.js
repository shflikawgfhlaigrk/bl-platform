/** #/team — workforce: roles matrix, user-role assign, invitations, schedules. */
import { registerView } from '../router.js';
import { el, toast } from '../dom.js';
import { getData, getList, mutate } from '../api.js';
import { viewHeader, emptyState, dataTable, button, section, field, input, select, withLoading, chip } from '../ui.js';

registerView('team', async (container) => {
  container.append(viewHeader({ title: 'Team', subtitle: 'Roles, who can do what, invitations, and schedules.' }));

  const tabs = el('div', { class: 'view-actions', style: 'margin-bottom:12px' });
  const slot = el('div');
  container.append(tabs, slot);
  tabs.append(
    button('Roles', { onClick: () => loadRoles(slot) }),
    button('Invitations', { onClick: () => loadInvites(slot) }),
    button('Schedules', { onClick: () => loadSchedules(slot) }),
  );
  loadRoles(slot);
});

async function loadRoles(slot) {
  await withLoading(slot, async () => {
    const roles = (await getData('/api/workforce/roles')) || [];
    if (!Array.isArray(roles) || !roles.length) return emptyState({ icon: '🧑‍🤝‍🧑', title: 'No roles yet', message: 'Built-in roles (owner, manager, cashier…) seed on setup. Add custom roles here.' });
    const wrap = el('div');
    for (const role of roles) {
      let perms = [];
      try {
        perms = (await getData(`/api/workforce/roles/${role.id}/permissions`)) || [];
      } catch {
        /* */
      }
      wrap.append(section(role.name || role.key, el('div', {}, (Array.isArray(perms) ? perms : []).map((p) => chip(typeof p === 'string' ? p : p.permission, 'low')))));
    }
    return wrap;
  });
}

async function loadInvites(slot) {
  await withLoading(slot, async () => {
    const roles = (await getData('/api/workforce/roles').catch(() => [])) || [];
    const email = input({ name: 'email', type: 'email', placeholder: 'person@example.com' });
    const roleSel = select('role', roles.map((r) => ({ value: r.id, label: r.name || r.key })), roles[0]?.id);
    const list = await getList('/api/workforce/invitations').catch(() => ({ data: [] }));
    const wrap = el('div');
    wrap.append(section(
      'Invite a teammate',
      field('Email', email),
      field('Role', roleSel),
      button('Send invitation', {
        primary: true,
        onClick: async () => {
          if (!email.value.trim() || !roleSel.value) return toast('Email and role required', 'warn');
          try {
            const res = await mutate('/api/workforce/invitations', 'POST', { email: email.value.trim(), roleId: roleSel.value });
            const token = (res.data || res).token;
            toast('Invitation created. Share this one-time token: ' + (token || '(see list)'));
            loadInvites(slot);
          } catch (e) {
            toast(e.message, 'err');
          }
        },
      }),
    ));
    wrap.append(section('Invitations', (list.data || []).length ? dataTable([{ key: 'email', label: 'Email' }, { key: 'status', label: 'Status' }], list.data) : el('p', { class: 'view-sub' }, 'None yet.')));
    return wrap;
  });
}

async function loadSchedules(slot) {
  await withLoading(slot, async () => {
    const list = await getList('/api/workforce/schedules', { limit: 100 }).catch(() => ({ data: [] }));
    const rows = list.data || [];
    return section('Schedules', rows.length
      ? dataTable([{ key: 'userId', label: 'User' }, { key: 'kind', label: 'Kind' }, { key: 'startsAt', label: 'Starts' }, { key: 'endsAt', label: 'Ends' }], rows)
      : emptyState({ icon: '🗓️', title: 'No shifts scheduled', message: 'Add shifts to plan show and shop coverage. Conflicts are flagged when they overlap.' }));
  });
}

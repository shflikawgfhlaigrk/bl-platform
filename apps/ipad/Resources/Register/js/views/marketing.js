/** #/marketing — outreach: honest gate report, templates, campaigns, inbox. */
import { registerView } from '../router.js';
import { el, toast } from '../dom.js';
import { getData, getList, mutate } from '../api.js';
import { viewHeader, emptyState, dataTable, button, section, field, input, withLoading, chip, blockedBanner } from '../ui.js';
import { phraseReport } from '../../../src/gates.mjs';

registerView('marketing', async (container) => {
  container.append(viewHeader({ title: 'Marketing', subtitle: 'Send notes and offers to customers who gave you their email. Starts fully off.' }));

  const gateSlot = el('div');
  const bodySlot = el('div');
  container.append(gateSlot, bodySlot);

  // ---- Gate report (verbatim honest) ----
  await withLoading(gateSlot, async () => {
    let report;
    try {
      report = await getData('/api/outreach/settings/gates');
    } catch (e) {
      return blockedBanner('Email is not configured yet.', [e.message]);
    }
    const phrased = phraseReport(report);
    const wrap = el('div', { class: 'card' });
    wrap.append(el('h2', {}, phrased.allOpen ? '✅ Ready to send' : `Setup — ${phrased.blockedCount} step(s) left`));
    const ul = el('ul', { class: 'setup-list' });
    for (const g of phrased.gates) {
      ul.append(el('li', {}, [
        el('span', { class: `status ${g.open ? 'done' : 'todo'}` }, g.open ? '✓' : '○'),
        el('span', {}, [el('strong', {}, g.label), g.reason ? el('div', { class: 'hint' }, g.reason) : null]),
      ]));
    }
    wrap.append(ul);
    return wrap;
  });

  // ---- Tabs ----
  const tabs = el('div', { class: 'view-actions', style: 'margin:16px 0' });
  container.append(tabs);
  container.append(bodySlot);
  tabs.append(
    button('Templates', { onClick: () => loadTemplates(bodySlot) }),
    button('Campaigns', { onClick: () => loadCampaigns(bodySlot) }),
    button('Inbox', { onClick: () => loadInbox(bodySlot) }),
    button('Check replies', { onClick: async () => { try { await mutate('/api/outreach/check-replies', 'POST', {}); toast('Checked for replies.'); } catch (e) { toast(e.message, 'err'); } } }),
  );
  loadTemplates(bodySlot);
});

async function loadTemplates(slot) {
  await withLoading(slot, async () => {
    const list = await getList('/api/outreach/templates').catch(() => ({ data: [] }));
    const rows = list.data || [];
    const name = input({ name: 'name', placeholder: 'Template name' });
    const subject = input({ name: 'subject', placeholder: 'Subject (use {{placeholders}})' });
    const bodyT = el('textarea', { name: 'body', placeholder: 'Message body. Placeholders like {{first_name}}.' });
    const wrap = el('div');
    wrap.append(section(
      'New template',
      field('Name', name),
      field('Subject', subject),
      field('Body', bodyT),
      button('Save template', {
        primary: true,
        onClick: async () => {
          const required = [...`${subject.value} ${bodyT.value}`.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map((m) => m[1]);
          try {
            await mutate('/api/outreach/templates', 'POST', { name: name.value.trim(), kind: 'promotional', subjectTemplate: subject.value, bodyTemplate: bodyT.value, requiredPlaceholders: [...new Set(required)] });
            toast('Template saved. Placeholders detected: ' + (required.length ? required.join(', ') : 'none'));
            loadTemplates(slot);
          } catch (e) {
            toast(e.message, 'err');
          }
        },
      }),
    ));
    wrap.append(section('Templates', rows.length ? dataTable([{ key: 'name', label: 'Name' }, { key: 'kind', label: 'Kind' }], rows) : el('p', { class: 'view-sub' }, 'No templates yet.')));
    return wrap;
  });
}

async function loadCampaigns(slot) {
  await withLoading(slot, async () => {
    const list = await getList('/api/outreach/campaigns').catch(() => ({ data: [] }));
    const rows = list.data || [];
    if (!rows.length) return emptyState({ icon: '✉️', title: 'No campaigns', message: 'Create a template, then build a campaign from a customer segment. Nothing sends until every gate above is green and you approve it.' });
    return section('Campaigns', dataTable(
      [
        { key: 'name', label: 'Campaign' },
        { key: 'status', label: 'Status', render: (r) => chip(r.status || 'draft', 'medium') },
        { key: 'act', label: '', render: (r) => el('span', {}, [
          button('Approve', { onClick: () => campaignAct(r.id, 'approve', slot) }),
          button('Send pending', { onClick: async () => { try { await mutate('/api/outreach/send-pending', 'POST', {}); toast('Processed pending sends.'); } catch (e) { toast(e.message, 'err'); } } }),
        ]) },
      ],
      rows,
    ));
  });
}

async function campaignAct(id, action, slot) {
  try {
    await mutate(`/api/outreach/campaigns/${id}/${action}`, 'POST', {});
    toast('Done.');
    loadCampaigns(slot);
  } catch (e) {
    toast(e.message, 'err');
  }
}

async function loadInbox(slot) {
  await withLoading(slot, async () => {
    const list = await getList('/api/outreach/inbox').catch(() => ({ data: [] }));
    const rows = list.data || [];
    if (!rows.length) return emptyState({ icon: '📥', title: 'Inbox empty', message: 'Replies from customers appear here after you press "Check replies".' });
    return section('Inbox', dataTable([{ key: 'from', label: 'From' }, { key: 'subject', label: 'Subject' }], rows));
  });
}

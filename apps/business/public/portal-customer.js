export function portalCustomerView(ui) {
  const { api, content, field, area, select, form, panel, table, action, bindForm, bindActions, esc, when, customers, customerOptions } = ui;
  return async () => {
    const [accounts, cs, requests] = await Promise.all([api('portal-customer/accounts?limit=200'), customers(), api('portal-customer/requests?limit=200')]);
    const requestRows = requests.filter(row => ['pending','acknowledged'].includes(row.status));
    const requestKind = row => row.kind === 'repeat' ? 'Repeat service' : 'Reschedule';
    const customer = row => cs.find(c => c.id === row.customer_id)?.name || accounts.find(a => a.id === row.account_id)?.name || 'Customer';
    content.innerHTML = panel('Customer requests',`<p class="muted">Review requested work or preferred times. Confirm any actual booking in Schedule, then record the answer here so the customer can read it.</p>`
      + table(requestRows,[['Customer',customer],['Request',requestKind],['Work','source_title'],['Preferred time',row=>when(row.requested_starts_at)],['Details','note'],['Status','status']],row=>action('respond-request',row.id,'Respond')))
      + form('portal-account','Create customer access',select('customerId','Customer',customerOptions(cs))+field('name','Display name','text','','required')+field('email','Sign-in email','email','','required'),'Create access')
      + panel('Customer portal',`<p class="muted">Customers see their own approvals, work, requests, and shared files. Email must be connected for sign-in delivery.</p><a href="/api/portal-customer/ui" target="_blank" rel="noopener" class="button quiet">Open customer portal</a>`)
      + panel('Customer accounts',table(accounts,[['Name','name'],['Email','email'],['Created',row=>when(row.createdAt)]]))
      + panel('Answered requests',table(requests.filter(row=>['resolved','declined'].includes(row.status)),[['Customer',customer],['Work','source_title'],['Status','status'],['Answer','response']]));
    bindForm('portal-account',d=>api('portal-customer/accounts','POST',d));
    bindActions(async (name,id) => {
      if (name !== 'respond-request') return;
      const row = await api(`portal-customer/requests/${encodeURIComponent(id)}`);
      content.querySelector('[data-request-response]')?.remove();
      content.insertAdjacentHTML('beforeend',`<div data-request-response>${form('portal-request-response',`Respond to ${row.source_title}`,`<p class="wide">${esc(row.note || 'No additional customer notes.')}</p><input type="hidden" name="expectedVersion" value="${row.version}">`
        +select('status','Request status',[['acknowledged','Acknowledged — reviewing'],['resolved','Resolved — answer recorded'],['declined','Declined']],false)+area('response','Customer-visible answer',row.response||''),'Save answer')}</div>`);
      bindForm('portal-request-response',d=>api(`portal-customer/requests/${encodeURIComponent(id)}`,'PATCH',{ status:d.status,response:d.response,expectedVersion:Number(d.expectedVersion) }));
      content.querySelector('[data-request-response]').scrollIntoView({behavior:'smooth'});
    });
  };
}

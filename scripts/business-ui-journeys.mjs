import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

/** Runs only on the isolated extracted-package fixture owned by the caller. */
export async function acceptBusinessControls({ page, read, customerId, checks, out }) {
  async function fill(form, values) {
    for (const [name,value] of Object.entries(values)) await page.$eval(`${form} [name="${name}"]`,(e,value)=>{e.value=String(value);e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));},value);
  }
  async function save(form, apiPath, method='POST') {
    const response=page.waitForResponse(r=>new URL(r.url()).pathname===`/api/${apiPath}`&&r.request().method()===method);
    await page.click(`${form} button:not([type=button])`);const result=await response;
    assert(result.ok(),`${form}: HTTP ${result.status()} ${await result.text()}`);
    await page.waitForFunction(id=>document.querySelector(id)?.dataset.saving!=='true',{},form);
    return (await result.json()).data;
  }
  async function route(hash,selector) { await page.evaluate(hash=>{location.hash=hash;},hash);await page.waitForSelector(selector); }
  await route('/crm/leads','#crm-add');
  await fill('#crm-add',{name:'Fixture pipeline prospect',email:'prospect@example.test',source:'Website fixture',customer_id:customerId,value:'450.00'});const prospect=await save('#crm-add','crm/leads');
  await page.waitForFunction(()=>document.querySelector('tbody')?.textContent.includes('Fixture pipeline prospect'));
  await page.click(`[data-action=view][data-id="${prospect.id}"]`);await page.waitForSelector('#crm-note');
  await fill('#crm-note',{body:'Fixture customer requested a written estimate.'});await save('#crm-note','crm/notes');
  await page.waitForFunction(()=>document.querySelector('#crm-detail')?.textContent.includes('Fixture customer requested a written estimate.'));
  await fill('#crm-tag',{name:'Estimate requested'});const attach=page.waitForResponse(r=>new URL(r.url()).pathname.endsWith('/attach'));await page.click('#crm-tag button');assert.equal((await attach).status(),201);
  await page.waitForFunction(()=>document.querySelector('#crm-detail .badge')?.textContent==='Estimate requested');
  await page.click('details.panel > summary');await fill('#custom-add',{label:'Service zone',kind:'text'});await save('#custom-add','crm/custom-fields');
  await page.waitForSelector('#crm-edit [name="custom:service_zone"]');const leadStages=await read('crm/lead-stages');
  await fill('#crm-edit',{stage:leadStages[1].key,'custom:service_zone':'North fixture area'});await save('#crm-edit',`crm/leads/${prospect.id}`,'PATCH');
  const changed=await read(`crm/leads/${prospect.id}`);assert.equal(changed.stage,leadStages[1].key);assert.equal(changed.custom_fields.service_zone,'North fixture area');assert.equal(changed.value_cents,45000);
  const timeline=await read(`crm/timeline?entity_type=crm.lead&entity_id=${prospect.id}`);assert(timeline.some(r=>r.event_type==='stage_changed'));assert(timeline.some(r=>r.event_type==='note_added'));
  const audit=await read(`business/audit?entityType=crm.lead&entityId=${prospect.id}`);assert(audit.some(r=>r.action==='crm.lead.stage_changed'));
  const csvFile=path.join(out,'fixture-leads.csv');await fs.writeFile(csvFile,'name,email,source\nCSV fixture prospect,csv@example.test,Fixture import\n,missing-name@example.test,Fixture invalid row\n');
  await page.click('details.panel > summary');await (await page.$('#crm-import [name=csv]')).uploadFile(csvFile);const imported=await save('#crm-import','crm/leads/import.csv');assert.equal(imported.imported,1);assert.equal(imported.errors.length,1);
  await page.waitForFunction(()=>document.querySelector('#content')?.textContent.includes('Import result'));
  const exported=await page.evaluate(async()=>fetch('/api/crm/leads/export.csv').then(r=>r.text()));assert.match(exported,/CSV fixture prospect/);assert.match(exported,/Fixture pipeline prospect/);assert(!exported.includes('missing-name@example.test'));
  await fill('#crm-search',{q:'CSV fixture prospect'});await page.click('#crm-search button');await page.waitForFunction(()=>document.querySelector('tbody')?.textContent.includes('CSV fixture prospect')&&!document.querySelector('tbody')?.textContent.includes('Fixture pipeline prospect'));
  checks.push('installed CRM records preserve stage, value, custom fields, notes, tags, activity and audit history; search works; CSV import reports a bad row and exports saved data');
  await route('/scheduling/setup','#staff-add');
  await fill('#staff-add',{name:'Jordan Booking Fixture',email:'jordan@example.test'});const staff=await save('#staff-add','scheduling/staff');
  await page.waitForFunction(()=>document.querySelector('#content').textContent.includes('Jordan Booking Fixture'));
  await fill('#resource-add',{name:'Fixture service vehicle',kind:'Vehicle'});const resource=await save('#resource-add','scheduling/resources');
  await page.waitForFunction(()=>document.querySelector('#content').textContent.includes('Fixture service vehicle'));
  await fill('#type-add',{name:'Fixture 45-minute service',durationMinutes:'45',bufferBeforeMinutes:'10',bufferAfterMinutes:'15'});const type=await save('#type-add','scheduling/appointment-types');
  await page.waitForFunction(()=>document.querySelector('#content').textContent.includes('Fixture 45-minute service'));
  await route('/scheduling/availability','#window-add');
  await fill('#window-add',{owner:`staff:${staff.id}`,weekday:'2',startTime:'09:00',endTime:'17:00'});await save('#window-add','scheduling/availability-windows');
  assert((await read('scheduling/availability-windows')).some(r=>r.owner_id===staff.id&&r.weekday===2));
  await fill('#slot-search',{appointmentTypeId:type.id,staff:staff.id,from:'2027-01-12',days:'1',timezone:'America/Chicago'});await save('#slot-search','scheduling/next-available','GET');
  await page.waitForFunction(()=>document.querySelector('#available-times tbody')?.textContent.includes('Jordan Booking Fixture'));
  await fill('#exception-add',{owner:`staff:${staff.id}`,date:'2027-01-19',available:'false',reason:'Fixture day off'});await save('#exception-add','scheduling/availability-exceptions');
  assert((await read('scheduling/availability-exceptions')).some(r=>r.date==='2027-01-19'&&!r.available));
  await route('/scheduling/appointments','#appointment-add');const calendar=(await read('scheduling/calendars'))[0];
  const booking={calendarId:calendar.id,customerId,title:'Recurring fixture visit',startsAt:'2027-01-12T13:00',endsAt:'2027-01-12T13:45',timezone:'America/Chicago',appointmentTypeId:type.id,staffId:staff.id,resourceId:resource.id,frequency:'weekly',count:'3'};
  await fill('#appointment-add',booking);const recurrence=await save('#appointment-add','scheduling/appointments');assert.equal(recurrence.appointments.length,3);
  await page.waitForFunction(()=>document.querySelector('tbody')?.textContent.includes('Recurring fixture visit'));
  const first=recurrence.appointments[0];assert.equal(first.starts_at,'2027-01-12T19:00:00.000Z');
  const persisted=await read(`scheduling/appointments/${first.id}`);assert.deepEqual(persisted.staff_ids,[staff.id]);assert.deepEqual(persisted.resource_ids,[resource.id]);
  await fill('#appointment-add',{...booking,frequency:'',count:'1'});
  const conflict=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/scheduling/appointments'&&r.request().method()==='POST');await page.click('#appointment-add button:not([type=button])');assert.equal((await conflict).status(),409);
  await page.waitForFunction(()=>document.querySelector('#notice.error')?.textContent.includes('conflict'));
  assert.equal((await read('scheduling/appointments')).filter(r=>r.title==='Recurring fixture visit').length,3);
  await page.click(`[data-action=reschedule][data-id="${first.id}"]`);await page.waitForSelector('#appointment-reschedule');
  await fill('#appointment-reschedule',{startsAt:'2027-01-12T14:00',endsAt:'2027-01-12T14:45',timezone:'America/Chicago'});await save('#appointment-reschedule',`scheduling/appointments/${first.id}/reschedule`);
  assert.equal((await read(`scheduling/appointments/${first.id}`)).starts_at,'2027-01-12T20:00:00.000Z');
  const ics=await page.evaluate(async id=>fetch(`/api/scheduling/calendars/${id}/ics`).then(r=>r.text()),calendar.id);assert.match(ics,/BEGIN:VCALENDAR/);assert.match(ics,/Recurring fixture visit/);assert.match(ics,/20270112T200000Z/);
  await page.click(`[data-action=details][data-id="${first.id}"]`);await page.waitForSelector('#reminder-add');
  await fill('#reminder-add',{sendAt:'2027-01-12T10:00',channel:'email',recipient:'avery@example.test',message:'Fixture appointment reminder only.'});const reminder=await save('#reminder-add',`scheduling/appointments/${first.id}/reminders`);assert.equal(reminder.status,'pending');
  assert.equal((await read(`scheduling/appointments/${first.id}/reminders`))[0].message,'Fixture appointment reminder only.');
  checks.push('installed scheduling forms save staff, resources, appointment types, weekly hours and date exceptions; find free time; create assigned recurring visits with exact timezone conversion; reject a conflict without duplicate data; reschedule and export ICS; retain a pending reminder');

  await route('/quoting/templates','#template-add');
  await fill('#template-add',{name:'Fixture service template',description:'Two hours of service',quantity:'2',price:'100.00',cost:'40.00',lineDiscount:'0'});
  // The template description and the service-line description are separate inputs.
  await page.$eval('#template-add .quote-line [name=description]',e=>{e.value='Fixture service hours';});
  const template=await save('#template-add','quoting/templates');await page.waitForSelector(`#bundle-add [value="${template.id}"]`);
  await fill('#bundle-add',{name:'Fixture bundled service'});await page.click(`#bundle-add [value="${template.id}"]`);const bundle=await save('#bundle-add','quoting/templates');assert.deepEqual(JSON.parse(bundle.child_template_ids),[template.id]);
  await route('/quoting/rules','#rule-add');await fill('#rule-add',{name:'Fixture volume discount',scope:'quote',condition:'subtotal_cents',threshold:'100.00',action:'percent_discount',amount:'10',priority:'0'});const rule=await save('#rule-add','quoting/pricing-rules');
  assert.deepEqual(JSON.parse(rule.action),{type:'percent_discount',amount:1000});
  await route('/quoting/quotes','#quote-add');await fill('#quote-add',{customerId,title:'Fixture priced bundle',templateId:bundle.id,discount:'5',fixedDiscount:'5.00',tax:'8'});const priced=await save('#quote-add','quoting/quotes');
  assert.equal(priced.quote.subtotal_cents,20000);assert.equal(priced.quote.discount_cents,3500);assert.equal(priced.quote.tax_cents,1320);assert.equal(priced.quote.total_cents,17820);assert.equal(priced.quote.total_cost_cents,8000);assert.equal(priced.quote.margin_cents,8500);
  await page.waitForFunction(()=>document.querySelector('tbody')?.textContent.includes('Fixture priced bundle'));
  await page.click(`[data-action=view][data-id="${priced.quote.id}"]`);await page.waitForSelector('#quote-adjust');
  const documentHtml=await page.evaluate(async id=>fetch(`/api/quoting/quotes/${id}/document`).then(r=>r.text()),priced.quote.id);assert.match(documentHtml,/Fixture service hours/);assert.match(documentHtml,/178\.20/);assert(!documentHtml.includes('Internal cost'));
  checks.push('installed pricing forms create service templates and a bundle, apply a conditional pricing rule plus discount and tax, calculate exact internal cost and margin, and produce a matching customer quote');

  await route('/dashboard','#dashboard-config');await page.click('details.panel summary');
  for(const checkbox of await page.$$('#dashboard-config input[type=checkbox]')){
    const change=await checkbox.evaluate(e=>e.checked!==(e.name==='jobs'));if(change)await checkbox.click();
  }
  await save('#dashboard-config','dashboard/config','PUT');
  await page.waitForFunction(()=>document.querySelectorAll('.grid > .panel').length===1);
  assert.deepEqual((await read('dashboard/config')).widgets.filter(r=>r.enabled).map(r=>r.widgetKey),['jobs']);
  await page.reload({waitUntil:'networkidle0'});await page.waitForSelector('#dashboard-range');assert.equal(await page.$$eval('.grid > .panel',items=>items.length),1);
  assert.equal(await page.$eval('.grid .stat',e=>e.textContent),'1');
  await fill('#dashboard-range',{from:'2000-01-01',to:'2000-01-02'});await page.click('#dashboard-range button');await page.waitForFunction(()=>document.querySelector('.grid .stat')?.textContent==='0');
  await page.click('.grid details summary');assert.match(await page.$eval('.grid',e=>e.textContent),/crm_jobs/);
  await fill('#dashboard-range',{from:'',to:''});await page.click('#dashboard-range button');await page.waitForFunction(()=>document.querySelector('.grid .stat')?.textContent==='1');
  await page.setViewport({width:430,height:932});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Owner mobile viewport overflows');await page.setViewport({width:1440,height:1050});
  checks.push('installed dashboard saves selected widgets across reload, filters real job counts by local date, explains its formula, and fits a mobile viewport');
}

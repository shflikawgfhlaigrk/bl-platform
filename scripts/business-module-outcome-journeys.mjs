import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

/** Caller owns the isolated installed-package fixture and all three signed-in contexts. */
export async function acceptModuleOutcomeControls({ page, customerPage, teamPage, read, customerId, assignment, worker, owner, base, checks, out }) {
  assert(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname), 'Outcome journeys require the private loopback fixture.');
  const receipts = {};
  const localDate = date => new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
  owner ||= (await read('business/users'))[0];
  assert(owner?.id && assignment?.id && worker?.id, 'Owner, assigned work and worker fixtures must already exist.');

  async function fill(browserPage, selector, values) {
    for (const [name, value] of Object.entries(values)) await browserPage.$eval(`${selector} [name="${name}"]`, (element, value) => {
      element.value = String(value);
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    }, value);
  }
  async function click(browserPage, selector, route, method = 'POST') {
    await browserPage.waitForSelector(selector);
    await browserPage.$eval(selector, element => element.scrollIntoView({ behavior: 'instant', block: 'center' }));
    const response = browserPage.waitForResponse(result => new URL(result.url()).pathname === `/api/${route}` && result.request().method() === method);
    await browserPage.click(selector);
    const result = await response;
    assert(result.ok(), `${selector}: HTTP ${result.status()} ${await result.text()}`);
    return (await result.json()).data;
  }
  async function save(browserPage, selector, route, method = 'POST') {
    const result = await click(browserPage, `${selector} button:not([type=button])`, route, method);
    await browserPage.waitForFunction(selector => !document.querySelector(selector) || document.querySelector(selector).dataset.saving !== 'true', {}, selector);
    return result;
  }
  async function nav(module, selector) {
    await page.click(`nav a[data-module="${module}"]`);
    await page.waitForSelector(selector);
  }
  async function portalHome() {
    await customerPage.goto(`${base}/api/portal-customer/ui`, { waitUntil: 'networkidle0' });
    assert.match(await customerPage.$eval('h1', element => element.textContent), /^Hi /, 'Existing customer session must remain signed in.');
  }
  async function portalSubmit(selector) {
    await customerPage.$eval(`${selector} button`, element => element.scrollIntoView({ behavior: 'instant', block: 'center' }));
    const [response] = await Promise.all([
      customerPage.waitForNavigation({ waitUntil: 'networkidle0' }),
      customerPage.click(`${selector} button`),
    ]);
    assert.equal(response?.status(), 200, `Customer form ${selector}: ${await customerPage.$eval('body', element => element.textContent)}`);
  }
  async function openWork() {
    await teamPage.goto(`${base}/team`, { waitUntil: 'networkidle0' });
    await teamPage.waitForSelector(`[data-work="${assignment.id}"]`);
    await teamPage.click(`[data-work="${assignment.id}"]`);
    await teamPage.waitForSelector('#work-status');
  }

  // An owned, dated action becomes a durable outcome receipt and leaves the action queue.
  await page.evaluate(() => { location.hash = '/crm/queue'; });
  await page.waitForSelector('#crm-add [name=owner_user_id]');
  await fill(page, '#crm-add', { name: 'Outcome fixture service prospect', email: 'outcome-prospect@example.test', customer_id: customerId,
    source: 'Installed outcome fixture', owner_user_id: owner.id, next_action: 'Confirm access instructions with fixture customer',
    next_action_due_at: localDate(new Date(Date.now() - 3600000)), value: '175.00' });
  const lead = await save(page, '#crm-add', 'crm/leads');
  assert.equal(lead.owner_user_id, owner.id);
  assert((await read('crm/sales-queue?bucket=overdue')).items.some(row => row.id === lead.id));
  await page.waitForSelector(`[data-action=view][data-id="${lead.id}"]`);
  await page.click(`[data-action=view][data-id="${lead.id}"]`);
  await page.waitForSelector('#crm-complete-action');
  await fill(page, '#crm-complete-action', { note: 'Fixture access instructions confirmed; scope can be quoted.' });
  const completion = await save(page, '#crm-complete-action', `crm/leads/${lead.id}/next-action/complete`);
  assert.equal(completion.receipt.action, lead.next_action);
  assert.equal((await read(`crm/leads/${lead.id}`)).next_action, null);
  assert(!(await read('crm/sales-queue?bucket=overdue')).items.some(row => row.id === lead.id));
  const timeline = await read(`crm/timeline?entity_type=crm.lead&entity_id=${lead.id}`);
  assert(timeline.some(row => row.kind === 'next_action_completed' || row.type === 'next_action_completed' || JSON.stringify(row).includes(completion.receipt.id)));
  receipts.crm = completion;
  checks.push('owned overdue CRM next action is completed through its form, creates an outcome receipt and timeline, and disappears from the overdue queue');

  // Requests record customer intent and an owner answer; reschedule intent cannot move a booking.
  await portalHome();
  const repeatForm = 'form[action$="/requests"]:has(input[name=kind][value=repeat])';
  await customerPage.waitForSelector(repeatForm);
  const repeatReference = await customerPage.$eval(`${repeatForm} [name=referenceId]`, element => element.value);
  await customerPage.$eval(repeatForm, element => { element.closest('details').open = true; });
  await fill(customerPage, repeatForm, { note: 'Outcome fixture: repeat the completed service and confirm a new price.' });
  await portalSubmit(repeatForm);
  assert.match(await customerPage.$eval('h1', element => element.textContent), /Your request is recorded/);
  const repeatId = new URL(customerPage.url()).pathname.split('/').at(-1);
  const repeat = await read(`portal-customer/requests/${repeatId}`);
  assert.equal(repeat.kind, 'repeat');
  assert.equal(repeat.reference_id, repeatReference);
  assert.equal(repeat.status, 'pending');

  await portalHome();
  const rescheduleForm = 'form[action$="/requests"]:has(input[name=kind][value=reschedule])';
  await customerPage.waitForSelector(rescheduleForm);
  const appointmentId = await customerPage.$eval(`${rescheduleForm} [name=referenceId]`, element => element.value);
  const beforeBooking = await read(`scheduling/appointments/${appointmentId}`);
  await customerPage.$eval(rescheduleForm, element => { element.closest('details').open = true; });
  await fill(customerPage, rescheduleForm, { requestedStartsAt: '2027-01-26T15:00', timezone: beforeBooking.timezone || 'UTC', note: 'Outcome fixture: please review this preferred time.' });
  await portalSubmit(rescheduleForm);
  const rescheduleId = new URL(customerPage.url()).pathname.split('/').at(-1);
  const reschedule = await read(`portal-customer/requests/${rescheduleId}`);
  assert.equal(reschedule.kind, 'reschedule');
  assert.equal(reschedule.status, 'pending');
  const afterBooking = await read(`scheduling/appointments/${appointmentId}`);
  assert.equal(afterBooking.starts_at, beforeBooking.starts_at);
  assert.equal(afterBooking.ends_at, beforeBooking.ends_at);

  await nav('portal-customer', '#portal-account');
  await page.waitForSelector(`[data-action=respond-request][data-id="${repeatId}"]`);
  await page.click(`[data-action=respond-request][data-id="${repeatId}"]`);
  await page.waitForSelector('#portal-request-response');
  const answer = 'Fixture request received. We will confirm the next scope, price and appointment before booking.';
  await fill(page, '#portal-request-response', { status: 'acknowledged', response: answer });
  await save(page, '#portal-request-response', `portal-customer/requests/${repeatId}`, 'PATCH');
  assert.equal((await read(`portal-customer/requests/${repeatId}`)).response, answer);
  await customerPage.goto(`${base}/api/portal-customer/ui/requests/${repeatId}`, { waitUntil: 'networkidle0' });
  assert.match(await customerPage.$eval('body', element => element.textContent), /Business response/);
  assert((await customerPage.$eval('body', element => element.textContent)).includes(answer));
  await customerPage.screenshot({ path: path.join(out, 'customer-request-outcome.png'), fullPage: true });
  receipts.portalRequests = { repeat: await read(`portal-customer/requests/${repeatId}`), reschedule };
  checks.push('customer repeat and reschedule forms issue private receipts, preserve the existing booking, and show the owner response from the customer-request UI');

  // Preserve the original bytes from a normal customer multipart upload and read them from both accounts.
  const original = Buffer.from('Outcome fixture original access instructions. Preserve these exact bytes.\n');
  const uploadName = 'outcome-site-instructions.txt', uploadPath = path.join(out, uploadName);
  await fs.writeFile(uploadPath, original);
  await portalHome();
  const uploadForm = 'form[action$="/uploads"]';
  await customerPage.waitForSelector(`${uploadForm} [name=file]`);
  await (await customerPage.$(`${uploadForm} [name=file]`)).uploadFile(uploadPath);
  await portalSubmit(uploadForm);
  assert((await customerPage.$eval('body', element => element.textContent)).includes(uploadName));
  const uploaded = (await read('files/files?limit=200')).find(file => file.name === uploadName);
  assert(uploaded, 'Customer original is visible in the owner file vault.');
  assert.equal(uploaded.sha256, hash(original));
  const customerBytes = await customerPage.evaluate(async id => {
    const response = await fetch(`/api/portal-customer/ui/files/${id}/content`);
    if (!response.ok) throw Error(`Customer original readback: ${response.status}`);
    return [...new Uint8Array(await response.arrayBuffer())];
  }, uploaded.id);
  assert.deepEqual(Buffer.from(customerBytes), original);
  const ownerBytes = await page.evaluate(async id => {
    const response = await fetch(`/api/files/files/${id}/content`);
    if (!response.ok) throw Error(`Owner original readback: ${response.status}`);
    return [...new Uint8Array(await response.arrayBuffer())];
  }, uploaded.id);
  assert.deepEqual(Buffer.from(ownerBytes), original);
  receipts.customerUpload = { id: uploaded.id, name: uploaded.name, sha256: uploaded.sha256, sizeBytes: original.length };
  checks.push('customer uploads a real original through the portal form; customer download and owner file readback preserve its exact bytes and hash');

  // Existing synthetic offline payment remains unchanged; a prepared deposit reminder is stopped by customer preference.
  const invoices = await read('billing/invoices?limit=200');
  const invoice = invoices.find(row => row.customer_id === customerId && row.status !== 'draft' && row.status !== 'void' && row.total_cents > row.paid_cents && row.paid_cents > 0);
  assert(invoice, 'Previously recorded synthetic offline payment must have an open published invoice.');
  await nav('billing', '#invoice-add');
  const openCollection = async () => {
    await page.waitForSelector(`[data-collection-view="${invoice.id}"]`);
    await page.click(`[data-collection-view="${invoice.id}"]`);
    await page.waitForSelector('#collection-plan');
  };
  await openCollection();
  const depositCents = Math.min(invoice.total_cents, invoice.paid_cents + 2500);
  await fill(page, '#collection-plan', { deposit: (depositCents / 100).toFixed(2), depositDueAt: localDate(new Date(Date.now() - 86400000)), remindersEnabled: 'true', optedOut: 'false' });
  await save(page, '#collection-plan', `billing/invoices/${invoice.id}/collection-plan`, 'PUT');
  let collection = await read(`billing/invoices/${invoice.id}/collection-plan`);
  assert.equal(collection.stage, 'deposit');
  assert.equal(collection.depositRemainingCents, depositCents - invoice.paid_cents);
  await openCollection();
  const draft = await click(page, '#billing-reminder-prepare', `billing/invoices/${invoice.id}/reminders`);
  assert.equal(draft.status, 'prepared');
  assert.equal(draft.amount_cents, collection.depositRemainingCents);
  assert(!draft.delivery_reference, 'Prepared reminder has no delivery claim.');
  await portalHome();
  const preferenceForm = `form[action$="/invoices/${invoice.id}/reminder-preference"]`;
  assert.equal(await customerPage.$eval(`${preferenceForm} [name=optedOut]`, element => element.value), 'true');
  assert(await customerPage.$(`form[action$="/invoices/${invoice.id}/pay"]:has(input[name=purpose][value=deposit])`), 'Customer sees deposit action.');
  await portalSubmit(preferenceForm);
  collection = await read(`billing/invoices/${invoice.id}/collection-plan`);
  assert.equal(collection.reminderStopReason, 'opted_out');
  const suppressed = (await read(`billing/invoices/${invoice.id}/reminders`)).find(row => row.id === draft.id);
  assert(suppressed && suppressed.status !== 'prepared');
  assert(!suppressed.delivery_reference);
  const stopped = await click(page, '#billing-reminder-prepare', `billing/invoices/${invoice.id}/reminders`);
  assert.equal(stopped.reason, 'opted_out');
  assert.notEqual(stopped.status, 'prepared');
  assert.equal((await read(`billing/invoices/${invoice.id}`)).paid_cents, invoice.paid_cents);
  receipts.billing = { invoiceId: invoice.id, collection, prepared: draft, suppressed, stopped };
  checks.push('manual payment readback drives accurate remaining deposit, a draft makes no delivery claim, and customer opt-out suppresses the draft and blocks later reminders without changing paid balance');

  // Real export form returns portable accessible originals, independently verified byte by byte.
  const document = (await read('files/files?limit=200')).find(file => file.name === 'Customer service agreement.txt');
  assert(document, 'Existing job evidence document fixture must be present.');
  const jobLink = (await read(`files/files/${document.id}/links`)).find(link => link.entity_type === 'crm.job');
  assert(jobLink);
  await nav('files', '#job-evidence');
  await fill(page, '#job-evidence', { job: jobLink.entity_id });
  const packet = await save(page, '#job-evidence', 'files/evidence', 'GET');
  assert.equal(packet.format, 'blacklabel-evidence-v1');
  assert.equal(packet.entityId, jobLink.entity_id);
  assert.equal(packet.originalBytesVerified, true);
  assert(packet.files.some(file => file.id === document.id));
  for (const file of packet.files) {
    const bytes = Buffer.from(file.contentBase64, 'base64');
    assert.equal(bytes.length, file.sizeBytes);
    assert.equal(hash(bytes), file.sha256);
    const storedBytes = await page.evaluate(async id => {
      const response = await fetch(`/api/files/files/${id}/content`);
      if (!response.ok) throw Error(`Evidence original readback: ${response.status}`);
      return [...new Uint8Array(await response.arrayBuffer())];
    }, file.id);
    assert.deepEqual(bytes, Buffer.from(storedBytes));
  }
  await fs.writeFile(path.join(out, 'verified-job-evidence.json'), JSON.stringify(packet, null, 2));
  receipts.evidence = { entityId: packet.entityId, fileCount: packet.files.length, fileIds: packet.files.map(file => file.id) };
  checks.push('job evidence export form produces a portable packet whose original sizes, hashes and bytes match authenticated vault readback');

  // Link a verified source ID to this existing fixture customer, preview a change, apply and find the durable receipt.
  const customerBefore = await read(`crm/customers/${customerId}`);
  const importSource = 'installed-outcome-fixture';
  const records = [{ externalId: 'fixture-customer-001', localId: customerId, name: customerBefore.name, email: customerBefore.email, phone: '555-0109' }];
  await nav('integrations', '#customer-import');
  await fill(page, '#customer-import', { source: importSource, records: JSON.stringify(records, null, 2) });
  const preview = await save(page, '#customer-import', 'business/integrations/customers/preview');
  assert.equal(preview.canApply, true);
  assert.equal(preview.sourceWrites, false);
  assert.equal(preview.rows[0].localId, customerId);
  assert.equal(preview.rows[0].after.phone, '555-0109');
  await page.waitForSelector('#apply-import');
  const imported = await click(page, '#apply-import', 'business/integrations/customers/apply');
  assert.equal(imported.sourceWrites, false);
  assert.equal(imported.imported[0].customerId, customerId);
  const customerAfter = await read(`crm/customers/${customerId}`);
  assert.equal(customerAfter.phone, '555-0109');
  assert.equal(customerAfter.name, customerBefore.name);
  assert.equal(customerAfter.email, customerBefore.email);
  assert.equal(customerAfter.address, customerBefore.address);
  assert((await read('business/integrations/receipts')).some(row => row.id === imported.id && row.source === importSource));
  await page.waitForFunction(id => document.querySelector('#import-preview')?.textContent.includes(id), {}, imported.id);
  await nav('crm', '#crm-add');
  await nav('integrations', '#customer-import');
  assert((await page.$eval('#content', element => element.textContent)).includes(imported.id), 'Import receipt appears after reopening the import screen.');
  receipts.import = { preview, imported };
  checks.push('JSON customer import previews a verified existing-record update, preserves unspecified fields, applies locally without source writes, and shows its saved receipt after reopening');

  // Worker reports a blocker and clocked time; owner resolves and approves before the worker can close work.
  await openWork();
  const unchecked = await teamPage.$$eval('[data-check]:not(:checked)', elements => elements.map(element => element.dataset.check));
  for (const itemId of unchecked) {
    await click(teamPage, `[data-check="${itemId}"]`, `portal-employee/portal/checklist-items/${itemId}/check`);
    await teamPage.waitForFunction(id => {
      const checkbox = document.querySelector(`[data-check="${id}"]`);
      return checkbox?.checked && !checkbox.disabled;
    }, {}, itemId);
    await teamPage.waitForFunction(() => document.querySelector('#notice')?.textContent === 'Checklist saved.');
  }
  await fill(teamPage, '#work-exception', { reason: 'Outcome fixture: supervisor must confirm access instruction before closeout.' });
  const exception = await save(teamPage, '#work-exception', `portal-employee/portal/assignments/${assignment.id}/exceptions`);
  await teamPage.waitForFunction(() => document.querySelector('#notice')?.textContent === 'Exception recorded for manager review.');
  assert.equal(await teamPage.$eval('#work-status option[value=completed]', element => element.disabled), true);
  await click(teamPage, '#work-clock[data-mode=in]', 'portal-employee/portal/clock-in');
  await teamPage.waitForSelector('#work-clock[data-mode=out]');
  const timeEntry = await click(teamPage, '#work-clock[data-mode=out]', 'portal-employee/portal/clock-out');
  await teamPage.waitForSelector('#work-clock[data-mode=in]');
  assert.equal(timeEntry.assignment_id, assignment.id);
  assert.equal(timeEntry.employee_id, worker.id);
  let closeout = await read(`portal-employee/assignments/${assignment.id}/closeout`);
  assert(closeout.blockers.some(row => row.kind === 'exception'));
  assert(closeout.blockers.some(row => row.kind === 'time_review'));

  await nav('portal-employee', '#employee-time-filter');
  await page.waitForSelector(`[data-action=employee-review][data-id="${timeEntry.id}"]`);
  await page.click(`[data-action=employee-review][data-id="${timeEntry.id}"]`);
  await page.waitForSelector('#employee-time-review');
  await fill(page, '#employee-time-review', { status: 'approved', note: 'Fixture linked work time inspected against the recorded notes and photo.' });
  await save(page, '#employee-time-review', `portal-employee/time-entries/${timeEntry.id}/review`);
  await page.waitForSelector(`[data-action=employee-closeout][data-id="${assignment.id}"]`);
  await page.click(`[data-action=employee-closeout][data-id="${assignment.id}"]`);
  await page.waitForSelector(`#resolve-${exception.id}`);
  await fill(page, `#resolve-${exception.id}`, { decision: 'resolved', resolution_note: 'Fixture supervisor confirmed the access instruction; no checklist items were waived.' });
  await save(page, `#resolve-${exception.id}`, `portal-employee/exceptions/${exception.id}/resolve`);
  closeout = await read(`portal-employee/assignments/${assignment.id}/closeout`);
  assert.equal(closeout.blockers.length, 0);
  assert(closeout.time_entries.some(entry => entry.id === timeEntry.id && entry.review_status === 'approved'));
  assert(closeout.exceptions.some(issue => issue.id === exception.id && issue.status === 'resolved' && issue.resolution_kind === 'resolved'));
  await openWork();
  assert.equal(await teamPage.$eval('#work-status option[value=completed]', element => element.disabled), false);
  await fill(teamPage, '#work-status', { status: 'completed', note: 'Fixture closeout verified: checklist, original photo, manager resolution and approved work time.' });
  await save(teamPage, '#work-status', `portal-employee/portal/assignments/${assignment.id}/status`);
  await teamPage.waitForFunction(() => document.querySelector('#notice')?.textContent === 'Work status saved.');
  const completedWork = await read(`portal-employee/assignments/${assignment.id}`);
  assert.equal(completedWork.status, 'completed');
  assert(completedWork.completed_at);
  await teamPage.screenshot({ path: path.join(out, 'team-closeout-outcome.png'), fullPage: true });
  receipts.employee = { assignmentId: assignment.id, timeEntryId: timeEntry.id, exceptionId: exception.id, completedAt: completedWork.completed_at };
  checks.push('worker checklist, exception and linked clocked time block premature closeout; owner records a resolution and time approval, then the worker completes the same assignment');

  await fs.writeFile(path.join(out, 'module-outcome-receipts.json'), JSON.stringify(receipts, null, 2));
  console.log('Passed installed module outcome journeys (7 grouped checks; no external delivery or payment).');
}

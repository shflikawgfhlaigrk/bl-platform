export function reviewsView(ui) {
  const { api, content, field, select, form, panel, table, action, bindForm, bindActions, render, say, esc, when, customers } = ui;
  const receipt = row => ({ not_sent: 'Not submitted', sending: 'Readback required', blocked: 'Delivery unavailable', submitted: 'Provider accepted', delivered: 'Delivered', needs_attention: 'Needs attention' }[row.delivery_status] || 'Not submitted');
  return async () => {
    const [requests, campaigns, responses, testimonials, reminders, cs, platforms, eligibility] = await Promise.all([
      api('reviews/requests?limit=200'), api('reviews/campaigns?limit=200'), api('reviews/responses?limit=200'), api('reviews/testimonials?limit=200'),
      api('reviews/reminders?limit=200'), customers(), api('reviews/platforms?limit=200'),
      api('reviews/eligible-customers').catch(error => ({ error: error.message, eligible: [], excluded: [] })),
    ]);
    const options = eligibility.eligible.map(job => [job.customerId, job.customerName || cs.find(customer => customer.id === job.customerId)?.name || 'Customer']);
    const prepare = eligibility.error ? panel('Completed-job requests', `<p>${esc(eligibility.error)}</p>`)
      : options.length ? form('review-request', 'Prepare one completed-job request', select('customerId', 'Eligible customer', options), 'Create request')
        + form('review-campaign', `Prepare requests for all ${options.length} eligible customers`,
          field('name', 'Campaign name', 'text', '', 'required') + field('throttlePerDay', 'Maximum requests per day', 'number', '25', 'min="1" max="1000"')
          + field('scheduleStartAt', 'Start at (optional)', 'datetime-local')
          + '<p class="wide">Every customer with a completed job, usable contact details, and no prior request or opt-out is included. Ratings never control public review access.</p>', 'Prepare all eligible requests')
        : panel('Completed-job requests', '<p>No customers are currently eligible. Complete a job and add usable contact details before requesting feedback.</p>');
    content.innerHTML = prepare
      + panel('Review requests', table(requests, [
        ['Customer', row => cs.find(customer => customer.id === row.customer_id)?.name || 'Customer'], ['Feedback', 'status'], ['Delivery', receipt],
        ['Submitted', row => when(row.sent_at)], ['Completed job', row => row.source_job_type ? `${row.source_job_type} · ${when(row.source_job_completed_at)}` : 'Legacy manual request'],
      ], row => action('link', row.id, 'Get customer link')
        + (['completed', 'opted_out'].includes(row.status) ? '' : action('reminder', row.id, 'Schedule reminder'))
        + (row.delivery_status !== 'not_sent' ? action('delivery', row.id, 'Check delivery receipt') : '')))
      + panel('Campaigns', table(campaigns, [['Campaign', 'name'], ['Status', 'status'], ['Daily maximum', 'throttle_per_day']],
        row => action('campaign-toggle', row.id, row.status === 'active' ? 'Pause' : 'Resume', `data-status="${row.status}"`)
          + (row.status === 'active' ? action('dispatch', row.id, 'Submit next batch') : '')))
      + panel('Scheduled reminders', action('process', 'all', 'Submit due reminders')
        + table(reminders, [['Status', 'status'], ['Delivery', receipt], ['Scheduled', row => when(row.send_at)], ['Submitted', row => when(row.sent_at)]],
          row => row.delivery_status !== 'not_sent' ? action('reminder-delivery', row.id, 'Check delivery receipt') : ''))
      + (eligibility.excluded.length ? panel('Customers excluded from this batch', table(eligibility.excluded,
        [['Customer', row => row.customerName || cs.find(customer => customer.id === row.customerId)?.name || 'Customer'],
          ['Reason', row => ({ opted_out: 'Opted out', no_contact: 'Add contact details', already_requested: 'Request already prepared for this job' }[row.reason] || row.reason)]])) : '')
      + panel('Customer feedback', table(responses, [['Rating', 'rating'], ['Feedback', 'comment'], ['Follow-up', row => row.flagged_for_followup && !row.resolved_at ? 'Needs attention' : 'Reviewed']],
        row => row.flagged_for_followup && !row.resolved_at ? action('resolve', row.id, 'Resolve follow-up') : ''))
      + form('testimonial-add', 'Capture an approved testimonial', select('responseId', 'Customer feedback', responses.map(row => [row.id, `${row.rating}/5 — ${row.comment || 'Rating only'}`]))
        + field('authorName', 'Customer display name') + '<label class="wide check-row"><input name="consent" type="checkbox" required>Customer explicitly approved using this feedback as a testimonial.</label>', 'Save testimonial')
      + panel('Approved testimonials', table(testimonials, [['Customer', 'author_name'], ['Testimonial', 'quote'], ['Recorded', row => when(row.created_at)]]))
      + '<details class="panel"><summary>Review destinations</summary>'
      + form('review-platform', 'Add a review destination', field('name', 'Platform name', 'text', '', 'required') + field('targetUrl', 'Business review-page URL', 'url', '', 'required'), 'Save destination')
      + table(platforms, [['Platform', 'name'], ['URL', 'target_url'], ['Enabled', row => row.enabled ? 'Yes' : 'No']],
        row => action('platform-toggle', row.id, row.enabled ? 'Disable' : 'Enable', `data-enabled="${row.enabled}"`)) + '</details>';
    if (options.length) {
      bindForm('review-request', data => api('reviews/requests', 'POST', data));
      bindForm('review-campaign', data => api('reviews/campaigns/completed-jobs', 'POST', {
        name: data.name, throttlePerDay: Number(data.throttlePerDay), scheduleStartAt: data.scheduleStartAt ? new Date(data.scheduleStartAt).toISOString() : undefined,
      }));
    }
    bindForm('testimonial-add', data => {
      const response = responses.find(row => row.id === data.responseId);
      if (!response?.comment) throw Error('Choose a customer response with written feedback.');
      return api('reviews/testimonials', 'POST', { responseId: response.id, customerId: response.customer_id, quote: response.comment, authorName: data.authorName || undefined, consent: data.consent === 'on' });
    });
    bindForm('review-platform', data => api('reviews/platforms', 'POST', { ...data, key: data.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') }));
    bindActions(async (name, id, button) => {
      if (name === 'link') {
        const link = await api(`reviews/requests/${id}/link`);
        content.insertAdjacentHTML('beforeend', panel('Customer review link', `<p><a href="/review#${encodeURIComponent(link.token)}" target="_blank" rel="noopener">Open review request</a></p>`));
        return;
      }
      if (name === 'reminder') {
        document.querySelector('#review-reminder')?.closest('.panel').remove();
        content.insertAdjacentHTML('beforeend', form('review-reminder', 'Schedule a follow-up', field('sendAt', 'Send after', 'datetime-local', '', 'required'), 'Schedule reminder'));
        bindForm('review-reminder', data => api(`reviews/requests/${id}/reminders`, 'POST', { sendAt: new Date(data.sendAt).toISOString() }));
        return;
      }
      if (name === 'campaign-toggle') await api(`reviews/campaigns/${id}`, 'PATCH', { status: button.dataset.status === 'active' ? 'paused' : 'active' });
      if (name === 'dispatch') {
        const result = await api(`reviews/campaigns/${id}/dispatch`, 'POST', {});
        await render(); say(`${result.dispatched} review requests submitted.${result.failed ? ` ${result.failed} need delivery attention.` : ''}`); return;
      }
      if (name === 'process') {
        const result = await api('reviews/reminders/process', 'POST', {});
        await render(); say(`${result.sent} reminders submitted; ${result.canceled} stopped.${result.failed ? ` ${result.failed} need delivery attention.` : ''}`); return;
      }
      if (name === 'delivery' || name === 'reminder-delivery') {
        const result = await api(`reviews/${name === 'delivery' ? 'requests' : 'reminders'}/${id}/delivery`, 'POST', {});
        await render(); say(`Delivery receipt: ${receipt({ delivery_status: result.status })}.`); return;
      }
      if (name === 'resolve') await api(`reviews/responses/${id}/resolve`, 'POST', {});
      if (name === 'platform-toggle') await api(`reviews/platforms/${id}`, 'PATCH', { enabled: button.dataset.enabled !== 'true' });
      await render(); say('Review workspace updated.');
    });
  };
}

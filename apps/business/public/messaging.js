export function messagingView(ui) {
  const { api, content, field, area, select, form, panel, table, action, bindForm, bindActions, render, say, esc, when, customers, customerOptions } = ui;
  let query = '', selected;
  const drafts = new Map();
  const messageState = message => message.channel === 'internal' && message.status === 'sent' ? 'Recorded internally'
    : message.delivery_status === 'delivered' ? 'Delivered' : message.status === 'sent' ? 'Provider accepted'
      : message.status === 'queued' ? 'Readback required' : message.status === 'failed' ? 'Rejected' : 'Received';
  return async () => {
    const [rows, templates, connections, cs, people, settings, receipts] = await Promise.all([
      api('messaging/conversations?limit=200'), api('messaging/templates?limit=200'), api('messaging/channels?limit=200'),
      customers(), api('business/users'), api('business/settings'), api('messaging/inbound-receipts?limit=50'),
    ]);
    const supported = settings.supportedChannels || ['email', 'internal'];
    const available = channel => channel === 'internal' || supported.includes(channel) && channel === 'email' && settings.email?.connected;
    const sendChannels = supported.filter(available), channelOptions = supported.map(channel => [channel, channel]);
    content.innerHTML = panel('Connected channels', `<p>Email: ${settings.email?.connected ? 'Configured; provider receipts show submission and delivery.' : 'Connect the company email sender under Connections.'} Internal: records messages in this workspace.</p><p>Existing records from other channels remain searchable. Their external transports are unavailable in this installation.</p>`)
      + form('message-search', 'Search recorded conversations', field('q', 'Search words', 'text', query), 'Search')
      + form('conversation-add', 'Start a conversation', field('subject', 'Subject', 'text', '', 'required') + select('channel', 'Channel', sendChannels.map(channel => [channel, channel]), false)
        + field('to', 'Recipient', 'text', '', 'required') + select('customerId', 'Link to customer', [['', 'No customer selected'], ...customerOptions(cs)], false), 'Create conversation')
      + panel('Conversations', table(rows, [['Subject', 'subject'], ['Channel', row => `${row.channel}${available(row.channel) ? '' : ' · transport unavailable'}`], ['Status', 'status'],
        ['Owner', row => people.find(person => person.id === row.assigned_user_id)?.name || 'Unassigned'], ['Last activity', row => when(row.last_message_at)]], row => action('thread', row.id, 'Open')))
      + '<div id="message-thread"></div><details class="panel"><summary>Channels, receipts and reply templates</summary>'
      + form('channel-add', 'Add a supported channel', select('type', 'Channel', channelOptions, false) + field('name', 'Channel name', 'text', '', 'required') + field('address', 'Sender / channel address', 'text', '', 'required'), 'Add channel')
      + panel('Channel settings', '<p class="muted">Adding an address does not connect a provider. Email uses the sender configured under Connections.</p>'
        + table(connections, [['Channel', 'name'], ['Type', 'type'], ['Address', 'address'], ['Enabled', row => row.is_active ? 'Yes' : 'No'], ['Transport', row => available(row.type) ? 'Available' : 'Unavailable']],
          row => action('channel-toggle', row.id, row.is_active ? 'Disable' : 'Enable', `data-active="${row.is_active}"`)))
      + panel('Inbound event receipts', table(receipts, [['Provider', 'provider'], ['Event', 'provider_event_id'], ['Channel', 'channel'], ['State', row => row.message_id ? 'Recorded once' : 'Needs recovery'], ['Recorded', row => when(row.created_at)]],
        row => row.conversation_id ? action('thread', row.conversation_id, 'Open recorded message') : ''))
      + form('message-template', 'Save a reply template', field('name', 'Template name', 'text', '', 'required') + select('channel', 'Channel', channelOptions, false) + field('subject', 'Subject') + area('body', 'Message. Use {{name}} for the customer name.'), 'Save template')
      + panel('Reply templates', table(templates, [['Name', 'name'], ['Channel', 'channel'], ['Subject', 'subject']])) + '</details>';
    bindForm('message-search', async data => {
      query = data.q;
      const results = await api(`messaging/search?q=${encodeURIComponent(query)}&limit=100`);
      content.insertAdjacentHTML('beforeend', panel('Search results', table(results.messages, [['Channel', 'channel'], ['Message', 'body'], ['Recorded', row => when(row.created_at)]], row => action('thread', row.conversation_id, 'Open conversation'))
        + table(results.conversations, [['Subject', 'subject'], ['Channel', 'channel']], row => action('thread', row.id, 'Open'))));
    }, false);
    bindForm('conversation-add', async data => {
      const row = await api('messaging/conversations', 'POST', { subject: data.subject, channel: data.channel, customerId: data.customerId || undefined, participants: [{ kind: 'external', address: data.to }] });
      selected = row.id;
    });
    bindForm('channel-add', data => api('messaging/channels', 'POST', data));
    bindForm('message-template', data => api('messaging/templates', 'POST', data));
    async function thread(id) {
      selected = id;
      const conversation = await api(`messaging/conversations/${id}`), owner = people.find(person => person.id === conversation.assigned_user_id);
      const blocked = !available(conversation.channel) ? 'The external transport for this conversation is unavailable. Existing messages remain recorded.'
        : conversation.status === 'closed' ? 'Reopen this conversation before preparing a reply.'
        : conversation.messages.some(message => message.direction === 'out' && message.status === 'queued') ? 'A submission is unresolved. Check its existing provider record before sending another reply.'
          : conversation.assigned_user_id && conversation.assigned_user_id !== settings.ownerUserId ? `Assigned to ${owner?.name || 'another team member'}. Reassign the conversation before replying.` : '';
      const messages = conversation.messages.map(message => `<article class="panel"><p class="muted">${esc(message.direction === 'in' ? message.from_address : message.to_address)} · ${esc(messageState(message))}</p><p class="receipt">${esc(message.body)}</p>${message.failed_reason ? `<p>${esc(message.failed_reason)}</p>` : ''}${message.direction === 'out' && message.channel !== 'internal' ? action('reconcile', message.id, 'Check delivery receipt') : ''}</article>`).join('') || '<p class="empty">No messages yet.</p>';
      document.querySelector('#message-thread').innerHTML = panel(conversation.subject, messages)
        + form('thread-settings', 'Conversation settings', select('status', 'Status', ['open', 'pending', 'closed'].map(status => [status, status]), false)
          + select('customerId', 'Linked customer', [['', 'No customer'], ...customerOptions(cs)], false)
          + select('userId', 'Assign to', [['', 'Keep current owner'], ...people.map(person => [person.id, person.name])], false), 'Update conversation')
        + (blocked ? panel('Reply requires attention', `<p>${esc(blocked)}</p>`) : form('reply', 'Prepare a reply', select('template', 'Reply template', [['', 'Write a message'], ...templates.filter(template => !template.channel || template.channel === conversation.channel).map(template => [template.id, template.name])], false)
          + field('name', 'Customer name for template') + area('body', 'Message', drafts.get(id) || ''), conversation.channel === 'internal' ? 'Record message' : 'Submit reply'));
      document.querySelector('#thread-settings [name=status]').value = conversation.status;
      document.querySelector('#thread-settings [name=customerId]').value = conversation.customer_id || '';
      document.querySelector('#thread-settings [name=userId]').value = conversation.assigned_user_id || '';
      bindForm('thread-settings', async data => {
        let current = conversation;
        if (data.status !== current.status) current = await api(`messaging/conversations/${id}/status`, 'POST', { status: data.status });
        if ((data.customerId || null) !== current.customer_id) current = await api(`messaging/conversations/${id}`, 'PATCH', { customerId: data.customerId || null });
        if (data.userId && data.userId !== current.assigned_user_id) await api(`messaging/conversations/${id}/assign`, 'POST', { userId: data.userId, expectedRevision: current.revision });
      });
      if (blocked) return;
      document.querySelector('#reply [name=body]').oninput = event => drafts.set(id, event.target.value);
      document.querySelector('#reply [name=template]').onchange = async event => {
        if (!event.target.value) return;
        try {
          const result = await api(`messaging/templates/${event.target.value}/render`, 'POST', { variables: { name: document.querySelector('#reply [name=name]').value } });
          document.querySelector('#reply [name=body]').value = result.body; drafts.set(id, result.body);
        } catch (error) { say(error.message, true); }
      };
      const operation = crypto.randomUUID();
      bindForm('reply', async data => {
        const message = await api(`messaging/conversations/${id}/messages`, 'POST', { body: data.body, idempotencyKey: operation, expectedRevision: conversation.revision });
        if (message.status === 'sent') drafts.delete(id);
        await thread(id);
        if (message.status !== 'sent') throw Error(message.failed_reason || 'Submission is unresolved. Inspect the existing message before another attempt.');
      });
    }
    if (selected && rows.some(row => row.id === selected)) await thread(selected);
    bindActions(async (name, id, button) => {
      if (name === 'thread') { await thread(id); return; }
      if (name === 'channel-toggle') { await api(`messaging/channels/${id}`, 'PATCH', { isActive: button.dataset.active !== 'true' }); await render(); return; }
      if (name === 'reconcile') {
        const message = await api(`messaging/messages/${id}`);
        if (!message.provider_message_id) {
          document.getElementById('existing-provider-message')?.closest('.panel')?.remove();
          content.insertAdjacentHTML('beforeend', form('existing-provider-message', 'Locate the existing provider message', '<p>Use the provider record for this exact submission. Checking a receipt never resends the message.</p>' + field('providerMessageId', 'Existing provider message ID', 'text', '', 'required maxlength="255"'), 'Check existing receipt'));
          bindForm('existing-provider-message', async data => { await api(`messaging/messages/${id}/reconcile`, 'POST', { providerMessageId: data.providerMessageId }); });
          return;
        }
        const result = await api(`messaging/messages/${id}/reconcile`, 'POST', {});
        await thread(selected); say(`Provider receipt: ${messageState(result)}.`);
      }
    });
  };
}

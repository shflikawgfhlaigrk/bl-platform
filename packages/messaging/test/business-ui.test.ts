import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const script = readFileSync(new URL('../../../apps/business/public/messaging.js', import.meta.url), 'utf8').replace('export function messagingView', 'function messagingView');
async function page(emailConnected: boolean, conversation?: Record<string, unknown>) {
  const content = { innerHTML: '', insertAdjacentHTML: vi.fn() }, threadContent = { innerHTML: '' }, fields = new Map<string, any>();
  const state: any = { createView: undefined, crypto: { randomUUID: () => 'ui-operation' }, document: {
    querySelector: (selector: string) => selector === '#message-thread' ? threadContent : fields.get(selector) || (() => { const field: any = {}; fields.set(selector, field); return field; })(),
  } };
  runInNewContext(script + '\nglobalThis.createView = messagingView;', state);
  const options: Array<{ name: string; choices: string[] }> = [], bound: Record<string, any> = {};
  let actions: any;
  const settings = { supportedChannels: ['email', 'internal'], email: { connected: emailConnected }, ownerUserId: 'owner' };
  const api = vi.fn(async (route: string) => {
    if (route === 'business/settings') return settings;
    if (route === 'business/users') return [{ id: 'owner', name: 'Owner' }, { id: 'teammate', name: 'Teammate' }];
    if (route.startsWith('messaging/conversations/') && !route.endsWith('/messages')) return conversation;
    if (route.startsWith('messaging/conversations?')) return conversation ? [conversation] : [];
    return [];
  });
  const helpers = {
    api, content, field: () => '', area: () => '', select: (name: string, _label: string, choices: string[][]) => { options.push({ name, choices: choices.map(choice => choice[0]) }); return ''; },
    form: (id: string, title: string) => `<form id="${id}">${title}</form>`, panel: (title: string, body: string) => `<section>${title}${body}</section>`,
    table: () => '', action: () => '', bindForm: (name: string, handler: any) => { bound[name] = handler; }, bindActions: (handler: any) => { actions = handler; },
    render: () => {}, say: () => {}, esc: String, when: String, customers: async () => [], customerOptions: () => [],
  };
  await state.createView(helpers)();
  if (conversation) await actions('thread', conversation.id);
  return { content, threadContent, options, bound, api };
}

describe('business inbox supported transports and composer', () => {
  it('offers only internal recording until email is configured, then only email/internal', async () => {
    expect((await page(false)).options.find(option => option.name === 'channel')!.choices).toEqual(['internal']);
    const configured = await page(true);
    expect(configured.options.find(option => option.name === 'channel')!.choices).toEqual(['email', 'internal']);
    expect(configured.options.find(option => option.name === 'type')!.choices).toEqual(['email', 'internal']);
  });
  it.each([
    { channel: 'sms', status: 'open', messages: [], assigned_user_id: null, reason: 'transport' },
    { channel: 'email', status: 'closed', messages: [], assigned_user_id: null, reason: 'Reopen' },
    { channel: 'email', status: 'open', messages: [{ direction: 'out', status: 'queued' }], assigned_user_id: null, reason: 'unresolved' },
    { channel: 'email', status: 'open', messages: [], assigned_user_id: 'teammate', reason: 'Teammate' },
  ])('blocks a composer when $reason requires attention', async scenario => {
    const f = await page(true, { id: 'thread', subject: 'Fixture thread', revision: 4, customer_id: null, ...scenario });
    expect(f.threadContent.innerHTML).toContain(scenario.reason);
    expect(f.threadContent.innerHTML).not.toContain('id="reply"');
    expect(f.bound.reply).toBeUndefined();
  });
  it('includes the observed revision and stable operation in a permitted reply', async () => {
    const f = await page(true, { id: 'thread', subject: 'Fixture thread', revision: 7, customer_id: null, channel: 'email', status: 'open', messages: [], assigned_user_id: 'owner' });
    f.api.mockImplementation(async (route: string) => route.endsWith('/messages') ? ({ status: 'sent', channel: 'email' }) : ({ id: 'thread', subject: 'Fixture thread', revision: 8, customer_id: null, channel: 'email', status: 'open', messages: [], assigned_user_id: 'owner' }));
    await f.bound.reply({ body: 'Synthetic reply' });
    expect(f.api).toHaveBeenCalledWith('messaging/conversations/thread/messages', 'POST', { body: 'Synthetic reply', idempotencyKey: 'ui-operation', expectedRevision: 7 });
  });
});

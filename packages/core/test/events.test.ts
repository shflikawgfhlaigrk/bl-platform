import { describe, expect, it } from 'vitest';
import { EventBus, KNOWN_EVENTS, EVENT_NAME_PATTERN } from '@blacklabel/core';

describe('EventBus', () => {
  it('delivers events with tenantId, payload, id and occurredAt', async () => {
    const bus = new EventBus();
    const received: unknown[] = [];
    bus.on<{ leadId: string }>('crm.lead.created', (e) => {
      received.push(e);
    });
    const result = await bus.emit('tenant-1', 'crm.lead.created', { leadId: 'L1' });
    expect(result.delivered).toBe(1);
    expect(result.errors).toEqual([]);
    expect(received).toHaveLength(1);
    const event = received[0] as any;
    expect(event.tenantId).toBe('tenant-1');
    expect(event.type).toBe('crm.lead.created');
    expect(event.payload).toEqual({ leadId: 'L1' });
    expect(typeof event.id).toBe('string');
    expect(new Date(event.occurredAt).toISOString()).toBe(event.occurredAt);
  });

  it('isolates handlers — a throwing handler cannot break emit or other handlers', async () => {
    const bus = new EventBus();
    const seen: string[] = [];
    bus.on('crm.lead.created', () => {
      throw new Error('sync boom');
    });
    bus.on('crm.lead.created', async () => {
      throw new Error('async boom');
    });
    bus.on('crm.lead.created', (e) => {
      seen.push(e.tenantId);
    });

    const result = await bus.emit('t1', 'crm.lead.created', {});
    expect(seen).toEqual(['t1']);
    expect(result.delivered).toBe(1);
    expect(result.errors).toHaveLength(2);
    expect(result.errors.map((e) => e.message).sort()).toEqual(['async boom', 'sync boom']);
  });

  it('supports wildcard subscription for the workflows module', async () => {
    const bus = new EventBus();
    const types: string[] = [];
    bus.on('*', (e) => {
      types.push(e.type);
    });
    await bus.emit('t1', 'crm.lead.created', {});
    await bus.emit('t1', 'billing.invoice.paid', {});
    expect(types).toEqual(['crm.lead.created', 'billing.invoice.paid']);
  });

  it('unsubscribe stops delivery', async () => {
    const bus = new EventBus();
    let calls = 0;
    const off = bus.on('crm.lead.created', () => {
      calls += 1;
    });
    await bus.emit('t1', 'crm.lead.created', {});
    off();
    await bus.emit('t1', 'crm.lead.created', {});
    expect(calls).toBe(1);
    expect(bus.handlerCount('crm.lead.created')).toBe(0);
  });

  it('rejects malformed event names and missing tenant ids', async () => {
    const bus = new EventBus();
    await expect(bus.emit('t1', 'NotValid', {})).rejects.toThrow(/invalid event type/);
    await expect(bus.emit('t1', 'lead.created', {})).rejects.toThrow(/invalid event type/);
    await expect(bus.emit('t1', 'crm.Lead.created', {})).rejects.toThrow(/invalid event type/);
    await expect(bus.emit('', 'crm.lead.created', {})).rejects.toThrow(/tenantId is required/);
    expect(() => bus.on('BAD NAME', () => {})).toThrow(/invalid event type/);
  });

  it('the entire planned events catalog passes the naming rule', () => {
    for (const name of KNOWN_EVENTS) {
      expect(name).toMatch(EVENT_NAME_PATTERN);
    }
    expect(KNOWN_EVENTS).toHaveLength(13);
  });
});

import { describe, expect, it } from 'vitest';
import { parseCsv } from '@blacklabel/core';
import { body, create, setup } from './helpers';

describe('CSV import/export', () => {
  it('round-trips customers: import -> export -> parse matches', async () => {
    const ctx = await setup();
    const csv = [
      'name,email,phone,address,status',
      'Avery Collins,avery@example.com,+1-555-0201,"12 Elm Street, Springfield",active',
      'Jordan Blake,jordan@example.com,,,inactive',
    ].join('\n');

    const importRes = await ctx.req(ctx.A, '/customers/import.csv', {
      method: 'POST',
      headers: { 'content-type': 'text/csv' },
      body: csv,
    });
    expect(importRes.status).toBe(200);
    const result = (await body(importRes)).data;
    expect(result.imported).toBe(2);
    expect(result.errors).toEqual([]);
    expect(result.ids).toHaveLength(2);

    const exportRes = await ctx.req(ctx.A, '/customers/export.csv');
    expect(exportRes.status).toBe(200);
    expect(exportRes.headers.get('content-type')).toContain('text/csv');
    const exported = parseCsv(await exportRes.text());
    expect(exported).toHaveLength(2);
    const avery = exported.find((r) => r.name === 'Avery Collins')!;
    expect(avery.email).toBe('avery@example.com');
    expect(avery.address).toBe('12 Elm Street, Springfield'); // quoted comma survived
    expect(avery.status).toBe('active');
    const jordan = exported.find((r) => r.name === 'Jordan Blake')!;
    expect(jordan.status).toBe('inactive');
    expect(jordan.phone).toBe('');
  });

  it('maps headers case-insensitively and with spaces, ignoring unknown columns', async () => {
    const ctx = await setup();
    const csv = ['First Name,LAST NAME,Email,Nonsense Column', 'Sam,Reyes,sam@example.com,ignored'].join(
      '\n',
    );
    const res = await ctx.req(ctx.A, '/contacts/import.csv', {
      method: 'POST',
      headers: { 'content-type': 'text/csv' },
      body: csv,
    });
    const result = (await body(res)).data;
    expect(result.imported).toBe(1);
    const contact = (await body(await ctx.req(ctx.A, `/contacts/${result.ids[0]}`))).data;
    expect(contact.first_name).toBe('Sam');
    expect(contact.last_name).toBe('Reyes');
    expect(contact.email).toBe('sam@example.com');
  });

  it('imports leads with stage validation and reports bad rows without aborting', async () => {
    const ctx = await setup();
    const csv = [
      'name,stage,value_cents,source',
      'Good Lead,contacted,45000,website',
      'Bad Stage Lead,not_a_stage,100,referral',
      ',new,50,referral',
      'Bad Cents Lead,new,notanumber,ads',
      'Defaults Lead,,,',
    ].join('\n');
    const res = await ctx.req(ctx.A, '/leads/import.csv', {
      method: 'POST',
      headers: { 'content-type': 'text/csv' },
      body: csv,
    });
    const result = (await body(res)).data;
    expect(result.imported).toBe(2);
    expect(result.errors).toHaveLength(3);
    expect(result.errors.map((e: any) => e.row).sort()).toEqual([3, 4, 5]);

    const leads = (await body(await ctx.req(ctx.A, '/leads?sort=name'))).data;
    expect(leads.map((l: any) => l.name)).toEqual(['Defaults Lead', 'Good Lead']);
    const good = leads.find((l: any) => l.name === 'Good Lead');
    expect(good.stage).toBe('contacted');
    expect(good.value_cents).toBe(45000);
    const defaults = leads.find((l: any) => l.name === 'Defaults Lead');
    expect(defaults.stage).toBe('new');
  });

  it('imported rows emit events like normal creates', async () => {
    const ctx = await setup();
    const seen: any[] = [];
    ctx.events.on('crm.lead.created', (e) => {
      seen.push(e);
    });
    await ctx.req(ctx.A, '/leads/import.csv', {
      method: 'POST',
      headers: { 'content-type': 'text/csv' },
      body: 'name\nEvent Lead One\nEvent Lead Two\n',
    });
    expect(seen).toHaveLength(2);
  });

  it('export is tenant-scoped and empty body import is 400', async () => {
    const ctx = await setup();
    await create(ctx, ctx.A, '/customers', { name: 'Only In A' });
    const bExport = await ctx.req(ctx.B, '/customers/export.csv');
    expect((await bExport.text()).includes('Only In A')).toBe(false);

    const empty = await ctx.req(ctx.A, '/customers/import.csv', {
      method: 'POST',
      headers: { 'content-type': 'text/csv' },
      body: '   ',
    });
    expect(empty.status).toBe(400);
  });
});

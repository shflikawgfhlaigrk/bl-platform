import { describe, expect, it } from 'vitest';
import { asCoreDb, coreMigrations, createTenant } from '@blacklabel/core';
import { createTestDb, runMigrations } from '@blacklabel/db';
import { portalEmployeeMigrations, type PortalEmployeeDatabase } from '@blacklabel/portal-employee';
import { body, del, get, makeAssignment, makeEmployee, post, setup } from './helpers';

async function fixture() {
  const ctx = await setup();
  const worker = await makeEmployee(ctx, ctx.tenantA, { name: 'Synthetic crew', email: 'crew@example.test' });
  const other = await makeEmployee(ctx, ctx.tenantA, { name: 'Other crew', email: 'other@example.test' });
  const manager = await makeEmployee(ctx, ctx.tenantA, { name: 'Manager', email: 'manager@example.test', role: 'manager' });
  const foreign = await makeEmployee(ctx, ctx.tenantB, { name: 'Other company manager', email: 'foreign@example.test', role: 'manager' });
  const work = await makeAssignment(ctx, ctx.tenantA, { employeeId: worker.employeeId, kind: 'service', title: 'Synthetic service work' });
  const checklist = (await body(await post(ctx.app, ctx.tenantA, `/assignments/${work.id}/checklists`, { name: 'Work evidence', items: ['Confirm scope', 'Final inspection'] }))).data;
  const status = (value: string, token = worker.token) => post(ctx.app, ctx.tenantA, `/portal/assignments/${work.id}/status`, { status: value }, token);
  const closeout = async () => (await body(await get(ctx.app, ctx.tenantA, `/portal/assignments/${work.id}/closeout`, worker.token))).data;
  return { ctx, worker, other, manager, foreign, work, checklist, status, closeout };
}

describe('reviewed assignment closeout', () => {
  it('upgrades old completed assignments and time records conservatively without implying historical approval', async () => {
    const db = createTestDb<PortalEmployeeDatabase>();
    await runMigrations(db, [...coreMigrations, ...portalEmployeeMigrations.slice(0,2)]);
    const tenant = await createTenant(asCoreDb(db), { name: 'Existing company' });
    const at = '2026-01-01T00:00:00.000Z';
    await db.insertInto('portal_employee_assignments').values({ id: 'old-work', tenant_id: tenant.id, employee_id: 'old-worker', kind: 'job', title: 'Existing completed work', status: 'completed', created_at: at, updated_at: at } as never).execute();
    await db.insertInto('portal_employee_time_entries').values({ id: 'old-time', tenant_id: tenant.id, employee_id: 'old-worker', clock_in_at: at, clock_out_at: '2026-01-01T01:00:00.000Z', created_at: at } as never).execute();
    expect((await runMigrations(db, [...coreMigrations, ...portalEmployeeMigrations])).applied).toEqual(['portal_employee.0003_reviewed_job_closeout']);
    const work = await db.selectFrom('portal_employee_assignments').selectAll().where('tenant_id', '=', tenant.id).executeTakeFirstOrThrow();
    expect(work).toMatchObject({ title: 'Existing completed work', completed_at: at });
    const entry = await db.selectFrom('portal_employee_time_entries').selectAll().where('tenant_id', '=', tenant.id).executeTakeFirstOrThrow();
    expect(entry).toMatchObject({ assignment_id: null, review_status: 'pending', reviewed_at: null });
    expect((await runMigrations(db, [...coreMigrations, ...portalEmployeeMigrations])).applied).toEqual([]);
    await db.destroy();
  });

  it('blocks incomplete checklists, then completes once with receipt/audit and protects closed evidence', async () => {
    const { ctx, worker, manager, work, checklist, status, closeout } = await fixture();
    const seen: any[] = [];
    ctx.events.on('portal_employee.task.completed', (event) => { seen.push(event); });
    expect((await status('completed')).status).toBe(409);
    expect((await closeout()).blockers).toHaveLength(2);
    for (const item of checklist.items) expect((await post(ctx.app, ctx.tenantA, `/portal/checklist-items/${item.id}/check`, { checked: true }, worker.token)).status).toBe(200);
    expect((await closeout()).blockers).toEqual([]);
    const completed = (await body(await status('completed'))).data;
    expect(completed.completed_at).toBeTypeOf('string');
    expect((await status('completed')).status).toBe(200);
    expect(seen).toHaveLength(1);
    expect((await get(ctx.app, ctx.tenantA, `/assignments/${work.id}/logs`)).status).toBe(200);
    const logs = (await body(await get(ctx.app, ctx.tenantA, `/assignments/${work.id}/logs`))).data;
    expect(logs.filter((row: any) => row.status === 'completed')).toHaveLength(1);
    expect((await post(ctx.app, ctx.tenantA, `/portal/checklist-items/${checklist.items[0].id}/check`, { checked: false }, worker.token)).status).toBe(409);
    expect((await post(ctx.app, ctx.tenantA, `/assignments/${work.id}/checklists`, { name: 'Late checklist', items: ['Sneak in new requirement'] })).status).toBe(409);
    expect((await status('in_progress')).status).toBe(403);
    expect((await status('in_progress', manager.token)).status).toBe(200);
    expect((await status('completed')).status).toBe(200);
    expect((await closeout()).assignment.completed_at).toBe(completed.completed_at);
    expect(seen).toHaveLength(1);
  });

  it('records a reasoned exception once; only managers can waive the exact checklist item', async () => {
    const { ctx, worker, other, manager, foreign, work, checklist, status, closeout } = await fixture();
    const reported: any[] = [], resolved: any[] = [];
    ctx.events.on('portal_employee.exception.reported', e => { reported.push(e); });
    ctx.events.on('portal_employee.exception.resolved', e => { resolved.push(e); });
    const payload = { reason: 'Access unavailable for final inspection', checklist_item_id: checklist.items[1].id, idempotency_key: 'synthetic-exception-001' };
    const path = `/portal/assignments/${work.id}/exceptions`;
    const issue = (await body(await post(ctx.app, ctx.tenantA, path, payload, worker.token))).data;
    expect((await body(await post(ctx.app, ctx.tenantA, path, payload, worker.token))).data.id).toBe(issue.id);
    expect(reported).toHaveLength(1);
    expect((await post(ctx.app, ctx.tenantA, path, { ...payload, reason: 'Different report' }, worker.token)).status).toBe(409);
    expect((await post(ctx.app, ctx.tenantA, path, { ...payload, idempotency_key: 'unauthorized-other' }, other.token)).status).toBe(403);
    const resolvePath = `/portal/exceptions/${issue.id}/resolve`, resolution = { resolution_note: 'Manager verified alternate evidence; item waived', waive_item: true };
    expect((await post(ctx.app, ctx.tenantA, resolvePath, resolution, worker.token)).status).toBe(403);
    expect((await post(ctx.app, ctx.tenantB, resolvePath, resolution, foreign.token)).status).toBe(404);
    expect((await status('completed')).status).toBe(409);
    expect((await post(ctx.app, ctx.tenantA, resolvePath, resolution, manager.token)).status).toBe(200);
    expect((await post(ctx.app, ctx.tenantA, resolvePath, resolution, manager.token)).status).toBe(200);
    expect(resolved).toHaveLength(1);
    await post(ctx.app, ctx.tenantA, `/portal/checklist-items/${checklist.items[0].id}/check`, { checked: true }, worker.token);
    expect((await closeout()).blockers).toEqual([]);
    expect((await status('completed')).status).toBe(200);
    const audit = await ctx.db.selectFrom('audit_log').selectAll().where('tenant_id', '=', ctx.tenantA).where('action', '=', 'portal_employee.exception.resolved').execute();
    expect(audit).toHaveLength(1);
    expect(audit[0].actor).not.toBe(worker.employeeId);
  });

  it('does not treat a generic resolution as checklist completion and rejects unrelated item waivers', async () => {
    const { ctx, worker, manager, work, checklist, closeout } = await fixture();
    const general = (await body(await post(ctx.app, ctx.tenantA, `/portal/assignments/${work.id}/exceptions`, { reason: 'Weather delayed work', idempotency_key: 'generic-exception-001' }, worker.token))).data;
    expect((await post(ctx.app, ctx.tenantA, `/portal/exceptions/${general.id}/resolve`, { resolution_note: 'Resume tomorrow', waive_item: true }, manager.token)).status).toBe(400);
    expect((await post(ctx.app, ctx.tenantA, `/portal/exceptions/${general.id}/resolve`, { resolution_note: 'Weather cleared' }, manager.token)).status).toBe(200);
    expect((await closeout()).blockers.filter((row: any) => row.kind === 'checklist')).toHaveLength(2);
    expect((await post(ctx.app, ctx.tenantA, `/portal/assignments/${work.id}/exceptions`, { reason: 'Foreign item', checklist_item_id: 'foreign-item', idempotency_key: 'foreign-item-exception' }, worker.token)).status).toBe(404);
    expect((await closeout()).exceptions).toHaveLength(1);
    expect(checklist.items).toHaveLength(2);
  });

  it('links time to the owned job and requires clock-out plus an explicit manager approval before completion', async () => {
    const { ctx, worker, other, manager, foreign, work, checklist, status, closeout } = await fixture();
    for (const item of checklist.items) await post(ctx.app, ctx.tenantA, `/portal/checklist-items/${item.id}/check`, { checked: true }, worker.token);
    expect((await post(ctx.app, ctx.tenantA, '/portal/clock-in', { assignmentId: work.id }, other.token)).status).toBe(403);
    expect((await post(ctx.app, ctx.tenantB, '/portal/clock-in', { assignmentId: work.id }, foreign.token)).status).toBe(404);
    const entry = (await body(await post(ctx.app, ctx.tenantA, '/portal/clock-in', { assignmentId: work.id }, worker.token))).data;
    expect(entry).toMatchObject({ assignment_id: work.id, review_status: 'pending' });
    const reviewPath = `/portal/time-entries/${entry.id}/review`, approval = { status: 'approved', note: 'Verified against checklist and work log' };
    expect((await post(ctx.app, ctx.tenantA, reviewPath, approval, manager.token)).status).toBe(409);
    expect((await status('completed')).status).toBe(409);
    await post(ctx.app, ctx.tenantA, '/portal/clock-out', {}, worker.token);
    expect((await post(ctx.app, ctx.tenantA, reviewPath, approval, worker.token)).status).toBe(403);
    expect((await post(ctx.app, ctx.tenantB, reviewPath, approval, foreign.token)).status).toBe(404);
    expect((await status('completed')).status).toBe(409);
    const seen: any[]=[];ctx.events.on('portal_employee.time_entry.reviewed',e=>{seen.push(e);});
    const approved = (await body(await post(ctx.app, ctx.tenantA, reviewPath, approval, manager.token))).data;
    expect(approved).toMatchObject({ review_status: 'approved', reviewed_by: manager.employeeId, review_note: approval.note });
    await post(ctx.app, ctx.tenantA, reviewPath, approval, manager.token);
    expect(seen).toHaveLength(1);
    expect((await closeout()).blockers).toEqual([]);
    expect((await status('completed')).status).toBe(200);
    expect((await post(ctx.app, ctx.tenantA, reviewPath, { status: 'rejected', note: 'Late revision' }, manager.token)).status).toBe(409);
    expect((await post(ctx.app, ctx.tenantA, '/portal/clock-in', { assignmentId: work.id }, worker.token)).status).toBe(409);
  });

  it('supports rejection and audited re-review while work remains open, and owner review uses the trusted surface', async () => {
    const { ctx, worker, manager, work, closeout } = await fixture();
    const entry = (await body(await post(ctx.app, ctx.tenantA, '/portal/clock-in', { assignmentId: work.id }, worker.token))).data;
    await post(ctx.app, ctx.tenantA, '/portal/clock-out', {}, worker.token);
    expect((await post(ctx.app, ctx.tenantA, `/portal/time-entries/${entry.id}/review`, { status: 'rejected', note: 'Work log missing' }, manager.token)).status).toBe(200);
    expect((await closeout()).blockers.some((row: any) => row.kind === 'time_review')).toBe(true);
    expect((await post(ctx.app, ctx.tenantA, `/time-entries/${entry.id}/review`, { status: 'approved', note: 'Owner verified corrected work log' })).status).toBe(200);
    const audits = await ctx.db.selectFrom('audit_log').selectAll().where('tenant_id', '=', ctx.tenantA).where('action', '=', 'portal_employee.time_entry.reviewed').execute();
    expect(audits).toHaveLength(2);
    expect((await post(ctx.app, ctx.tenantA, `/time-entries/${entry.id}/review`, { status: 'approved', note: ' ' })).status).toBe(400);
  });

  it('keeps review reports tenant scoped and denies worker review/report access', async () => {
    const { ctx, worker, other, manager, foreign, work } = await fixture();
    await post(ctx.app, ctx.tenantA, '/portal/clock-in', { assignmentId: work.id }, worker.token);
    expect((await get(ctx.app, ctx.tenantA, '/portal/time-entries', worker.token)).status).toBe(403);
    expect((await get(ctx.app, ctx.tenantA, `/portal/assignments/${work.id}/closeout`, other.token)).status).toBe(403);
    expect((await get(ctx.app, ctx.tenantB, `/portal/assignments/${work.id}/closeout`, foreign.token)).status).toBe(404);
    const mine = (await body(await get(ctx.app, ctx.tenantA, '/portal/time-entries', manager.token))).data;
    expect(mine.summary).toEqual({ pending: 1, approved: 0, rejected: 0, open: 1 });
    expect(mine.items[0]).toMatchObject({ employee_name: 'Synthetic crew', assignment_id: work.id, duration_minutes: null });
    const foreignQueue = (await body(await get(ctx.app, ctx.tenantB, '/portal/time-entries', foreign.token))).data;
    expect(foreignQueue.items).toEqual([]);
    expect(foreignQueue.summary).toEqual({ pending: 0, approved: 0, rejected: 0, open: 0 });
  });

  it('serializes simultaneous clock-ins and emits one clock-out despite a concurrent retry', async () => {
    const { ctx, worker, work } = await fixture();
    const ins: any[] = [], outs: any[] = [];
    ctx.events.on('portal_employee.shift.clocked_in',e=>{ins.push(e);});
    ctx.events.on('portal_employee.shift.clocked_out',e=>{outs.push(e);});
    const clockIns = await Promise.all([post(ctx.app, ctx.tenantA, '/portal/clock-in', { assignmentId: work.id }, worker.token),post(ctx.app, ctx.tenantA, '/portal/clock-in', { assignmentId: work.id }, worker.token)]);
    expect(clockIns.map(res=>res.status).sort()).toEqual([201,409]);
    const clockOuts = await Promise.all([post(ctx.app, ctx.tenantA, '/portal/clock-out', {}, worker.token),post(ctx.app, ctx.tenantA, '/portal/clock-out', {}, worker.token)]);
    expect(clockOuts.map(res=>res.status).sort()).toEqual([200,409]);
    expect(ins).toHaveLength(1);expect(outs).toHaveLength(1);
    const entries=await ctx.db.selectFrom('portal_employee_time_entries').selectAll().where('tenant_id','=',ctx.tenantA).execute();
    expect(entries).toHaveLength(1);
  });

  it('counts all time records beyond pagination and keeps historical entries readable after employee deletion', async () => {
    const { ctx, worker, manager, work } = await fixture();
    const at='2026-01-01T00:00:00.000Z';
    for(let n=0;n<205;n++)await ctx.db.insertInto('portal_employee_time_entries').values({
      id:`historical-${n}`,tenant_id:ctx.tenantA,employee_id:worker.employeeId,assignment_id:work.id,
      clock_in_at:at,clock_out_at:'2026-01-01T01:15:00.000Z',review_status:n<200?'pending':'approved',created_at:at,
    } as never).execute();
    const queue=(await body(await get(ctx.app,ctx.tenantA,'/portal/time-entries?limit=10&offset=200',manager.token))).data;
    expect(queue.items).toHaveLength(5);
    expect(queue.summary).toEqual({pending:200,approved:5,rejected:0,open:0});
    expect(queue.items.every((row:any)=>row.duration_minutes===75)).toBe(true);
    const pending=(await body(await get(ctx.app,ctx.tenantA,'/time-entries?status=pending&limit=50&offset=150'))).data;
    expect(pending.items).toHaveLength(50);
    expect(pending.items.every((row:any)=>row.review_status==='pending')).toBe(true);
    const approved=(await body(await get(ctx.app,ctx.tenantA,'/portal/time-entries?status=approved&limit=50',manager.token))).data;
    expect(approved.items).toHaveLength(5);
    expect(approved.items.every((row:any)=>row.review_status==='approved')).toBe(true);
    await del(ctx.app,ctx.tenantA,`/employees/${worker.employeeId}`);
    const history=(await body(await get(ctx.app,ctx.tenantA,'/time-entries?limit=10'))).data;
    expect(history.items.every((row:any)=>row.employee_name==='Former team member')).toBe(true);
    expect(history.summary.pending).toBe(200);
  });
});

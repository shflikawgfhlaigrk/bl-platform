import { describe, expect, it } from 'vitest';
import { body, get, makeAssignment, makeEmployee, post, setup } from './helpers';

async function checklistFixture(ctx: Awaited<ReturnType<typeof setup>>) {
  const worker = await makeEmployee(ctx, ctx.tenantA, { name: 'Riley', email: 'r@example.com' });
  const other = await makeEmployee(ctx, ctx.tenantA, { name: 'Other', email: 'o@example.com' });
  const assignment = await makeAssignment(ctx, ctx.tenantA, {
    employeeId: worker.employeeId,
    kind: 'job',
    title: 'Checklist job',
  });
  const templateRes = await post(ctx.app, ctx.tenantA, '/checklist-templates', {
    name: 'Job completion',
    items: ['Confirm scope', 'Do the work', 'Take photos'],
  });
  const template = (await body(templateRes)).data;
  return { worker, other, assignment, template };
}

describe('checklists (template + per-assignment instance)', () => {
  it('creates a template and instantiates it on an assignment (items copied in order)', async () => {
    const ctx = await setup();
    const { assignment, template } = await checklistFixture(ctx);
    expect(template.items).toHaveLength(3);
    expect(template.items.map((i: any) => i.position)).toEqual([0, 1, 2]);

    const instRes = await post(ctx.app, ctx.tenantA, `/assignments/${assignment.id}/checklists`, {
      templateId: template.id,
    });
    expect(instRes.status).toBe(201);
    const checklist = (await body(instRes)).data;
    expect(checklist.template_id).toBe(template.id);
    expect(checklist.name).toBe('Job completion');
    expect(checklist.items.map((i: any) => i.label)).toEqual([
      'Confirm scope',
      'Do the work',
      'Take photos',
    ]);
    expect(checklist.items.every((i: any) => i.checked === false)).toBe(true);
  });

  it('supports ad-hoc checklists and rejects empty instantiation', async () => {
    const ctx = await setup();
    const { assignment } = await checklistFixture(ctx);
    const adHoc = await post(ctx.app, ctx.tenantA, `/assignments/${assignment.id}/checklists`, {
      name: 'One-off',
      items: ['Only step'],
    });
    expect(adHoc.status).toBe(201);
    expect((await body(adHoc)).data.template_id).toBeNull();

    const bad = await post(ctx.app, ctx.tenantA, `/assignments/${assignment.id}/checklists`, {});
    expect(bad.status).toBe(400);
  });

  it('worker checks and unchecks items on their own assignment', async () => {
    const ctx = await setup();
    const { worker, assignment, template } = await checklistFixture(ctx);
    const checklist = (await body(
      await post(ctx.app, ctx.tenantA, `/assignments/${assignment.id}/checklists`, {
        templateId: template.id,
      }),
    )).data;
    const item = checklist.items[0];

    const checked = await post(
      ctx.app,
      ctx.tenantA,
      `/portal/checklist-items/${item.id}/check`,
      { checked: true },
      worker.token,
    );
    expect(checked.status).toBe(200);
    const checkedItem = (await body(checked)).data;
    expect(checkedItem.checked).toBe(true);
    expect(checkedItem.checked_by).toBe(worker.employeeId);
    expect(checkedItem.checked_at).not.toBeNull();

    const unchecked = await post(
      ctx.app,
      ctx.tenantA,
      `/portal/checklist-items/${item.id}/check`,
      { checked: false },
      worker.token,
    );
    const uncheckedItem = (await body(unchecked)).data;
    expect(uncheckedItem.checked).toBe(false);
    expect(uncheckedItem.checked_at).toBeNull();
  });

  it('workers cannot check items on someone else\'s assignment', async () => {
    const ctx = await setup();
    const { other, assignment, template } = await checklistFixture(ctx);
    const checklist = (await body(
      await post(ctx.app, ctx.tenantA, `/assignments/${assignment.id}/checklists`, {
        templateId: template.id,
      }),
    )).data;
    const res = await post(
      ctx.app,
      ctx.tenantA,
      `/portal/checklist-items/${checklist.items[0].id}/check`,
      { checked: true },
      other.token,
    );
    expect(res.status).toBe(403);
  });

  it('tenant isolation: checklists and items are invisible cross-tenant', async () => {
    const ctx = await setup();
    const { assignment, template } = await checklistFixture(ctx);
    const checklist = (await body(
      await post(ctx.app, ctx.tenantA, `/assignments/${assignment.id}/checklists`, {
        templateId: template.id,
      }),
    )).data;

    // tenant B: template list empty, instance fetch 404, item check 404
    expect((await body(await get(ctx.app, ctx.tenantB, '/checklist-templates'))).data).toEqual([]);
    expect((await get(ctx.app, ctx.tenantB, `/assignments/${assignment.id}/checklists`)).status).toBe(404);

    const bWorker = await makeEmployee(ctx, ctx.tenantB, { name: 'B', email: 'b@example.com' });
    const res = await post(
      ctx.app,
      ctx.tenantB,
      `/portal/checklist-items/${checklist.items[0].id}/check`,
      { checked: true },
      bWorker.token,
    );
    expect(res.status).toBe(404);

    // A's item untouched
    const still = (await body(
      await get(ctx.app, ctx.tenantA, `/assignments/${assignment.id}/checklists`),
    )).data;
    expect(still[0].items[0].checked).toBe(false);
  });
});

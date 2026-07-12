/**
 * portal-employee router factory.
 *
 * Two surfaces:
 * - Back-office (tenant header only, trusted like every other module router):
 *   employee CRUD, token issue/revoke, assignment + shift + checklist admin.
 * - `/portal/*` (employee-token authenticated): the employee-facing portal —
 *   me/schedule/clock/assignments/checklists/photos + minimal mobile HTML
 *   pages. Role permissions (worker vs manager/admin) are middleware- and
 *   service-enforced here.
 */
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { z } from 'zod';
import {
  ApiError,
  asCoreDb,
  errorHandler,
  parseFilters,
  parsePagination,
  tenantMiddleware,
  type ModuleDeps,
  type TenantEnv,
} from '@blacklabel/core';
import type { EmployeeRole, PortalEmployeeDatabase } from './schema';
import {
  addJobPhoto,
  addWorkLog,
  authenticateEmployeeToken,
  clockIn,
  clockOut,
  createAssignment,
  createChecklistTemplate,
  createEmployee,
  createShift,
  deleteEmployee,
  getAssignment,
  getAssignmentForActor,
  getDailySchedule,
  getEmployee,
  instantiateChecklist,
  isManager,
  issueEmployeeToken,
  listAssignments,
  listChecklistTemplates,
  listChecklistsForAssignment,
  listEmployees,
  listJobPhotos,
  listShifts,
  listTimeEntries,
  listWorkLogs,
  revokeEmployeeToken,
  setChecklistItemChecked,
  updateAssignmentStatus,
  updateEmployee,
  type Employee,
} from './service';

/** Hono env for the token-authenticated portal surface. */
export type PortalEmployeeEnv = {
  Variables: {
    tenantId: string;
    employee: Employee;
  };
};

/* ------------------------------------------------------------------ *
 * Auth middleware
 * ------------------------------------------------------------------ */

/**
 * Employee token auth. Reads `x-employee-token` (header) or `?token=` (query,
 * for the HTML pages), resolves it tenant-scoped, and sets c.set('employee').
 * 401 on missing/invalid/expired/revoked tokens and inactive employees.
 */
export function employeeAuthMiddleware(
  db: ModuleDeps<PortalEmployeeDatabase>['db'],
): MiddlewareHandler<PortalEmployeeEnv> {
  return async (c, next) => {
    const token = c.req.header('x-employee-token') ?? c.req.query('token');
    if (!token || token.trim() === '') {
      throw ApiError.unauthorized('employee token required (x-employee-token header or ?token=)');
    }
    const employee = await authenticateEmployeeToken(db, c.get('tenantId'), token.trim());
    if (!employee) {
      throw ApiError.unauthorized('invalid, expired, or revoked employee token');
    }
    c.set('employee', employee);
    await next();
  };
}

/** Role gate for portal routes: 403 unless the authenticated employee has one of the roles. */
export function requireRole(...roles: EmployeeRole[]): MiddlewareHandler<PortalEmployeeEnv> {
  return async (c, next) => {
    const employee = c.get('employee');
    if (!roles.includes(employee.role)) {
      throw ApiError.forbidden(`requires role: ${roles.join(' or ')}`);
    }
    await next();
  };
}

/* ------------------------------------------------------------------ *
 * Validation schemas
 * ------------------------------------------------------------------ */

const roleSchema = z.enum(['worker', 'manager', 'admin']);

const createEmployeeSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  role: roleSchema.optional(),
  phone: z.string().optional(),
  title: z.string().optional(),
  userId: z.string().optional(),
  custom: z.record(z.unknown()).optional(),
});

const updateEmployeeSchema = z.object({
  name: z.string().min(1).optional(),
  email: z.string().email().optional(),
  role: roleSchema.optional(),
  phone: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  userId: z.string().nullable().optional(),
  active: z.boolean().optional(),
  custom: z.record(z.unknown()).nullable().optional(),
});

const issueTokenSchema = z.object({ expiresAt: z.string().optional() });

const createAssignmentSchema = z.object({
  employeeId: z.string().min(1),
  kind: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
  scheduledAt: z.string().optional(),
  relatedEntityType: z.string().optional(),
  relatedEntityId: z.string().optional(),
  custom: z.record(z.unknown()).optional(),
});

const createShiftSchema = z.object({
  employeeId: z.string().min(1),
  startsAt: z.string().min(1),
  endsAt: z.string().min(1),
  notes: z.string().optional(),
});

const createTemplateSchema = z.object({
  name: z.string().min(1),
  items: z.array(z.string().min(1)).min(1),
});

const instantiateChecklistSchema = z.object({
  templateId: z.string().optional(),
  name: z.string().min(1).optional(),
  items: z.array(z.string().min(1)).optional(),
});

const statusSchema = z.object({
  status: z.enum(['assigned', 'in_progress', 'completed', 'canceled']),
  note: z.string().optional(),
});

const logBodySchema = z.object({ body: z.string().min(1) });

const clockInSchema = z.object({ shiftId: z.string().optional() });

const checkSchema = z.object({ checked: z.boolean() });

const photoSchema = z.object({ fileId: z.string().min(1), caption: z.string().optional() });

async function jsonBody(c: { req: { json: () => Promise<unknown> } }): Promise<unknown> {
  return c.req.json().catch(() => ({}));
}

/* ------------------------------------------------------------------ *
 * Router factory
 * ------------------------------------------------------------------ */

export function portalEmployeeRouter(deps: ModuleDeps<PortalEmployeeDatabase>): Hono<TenantEnv> {
  const { db, events } = deps;
  const app = new Hono<TenantEnv>();
  app.onError(errorHandler);
  app.use('*', tenantMiddleware(asCoreDb(db)));

  const BACK_OFFICE_ACTOR = 'system';

  /* ---------------- back-office: employees ---------------- */

  app.post('/employees', async (c) => {
    const input = createEmployeeSchema.parse(await jsonBody(c));
    const employee = await createEmployee(db, events, c.get('tenantId'), BACK_OFFICE_ACTOR, input);
    return c.json({ data: employee }, 201);
  });

  app.get('/employees', async (c) => {
    const query = c.req.query();
    const page = parsePagination(query);
    const filters = parseFilters(query, ['role', 'active']);
    const employees = await listEmployees(db, c.get('tenantId'), filters, page);
    return c.json({ data: employees, limit: page.limit, offset: page.offset });
  });

  app.get('/employees/:employeeId', async (c) => {
    const employee = await getEmployee(db, c.get('tenantId'), c.req.param('employeeId'));
    return c.json({ data: employee });
  });

  app.patch('/employees/:employeeId', async (c) => {
    const patch = updateEmployeeSchema.parse(await jsonBody(c));
    const employee = await updateEmployee(
      db,
      c.get('tenantId'),
      BACK_OFFICE_ACTOR,
      c.req.param('employeeId'),
      patch,
    );
    return c.json({ data: employee });
  });

  app.delete('/employees/:employeeId', async (c) => {
    await deleteEmployee(db, c.get('tenantId'), BACK_OFFICE_ACTOR, c.req.param('employeeId'));
    return c.json({ data: { deleted: true } });
  });

  /* ---------------- back-office: tokens ---------------- */

  app.post('/employees/:employeeId/tokens', async (c) => {
    const input = issueTokenSchema.parse(await jsonBody(c));
    const token = await issueEmployeeToken(
      db,
      c.get('tenantId'),
      BACK_OFFICE_ACTOR,
      c.req.param('employeeId'),
      input,
    );
    return c.json({ data: token }, 201);
  });

  app.delete('/tokens/:tokenId', async (c) => {
    await revokeEmployeeToken(db, c.get('tenantId'), BACK_OFFICE_ACTOR, c.req.param('tokenId'));
    return c.json({ data: { revoked: true } });
  });

  /* ---------------- back-office: assignments / shifts ---------------- */

  app.post('/assignments', async (c) => {
    const input = createAssignmentSchema.parse(await jsonBody(c));
    const assignment = await createAssignment(db, events, c.get('tenantId'), BACK_OFFICE_ACTOR, input);
    return c.json({ data: assignment }, 201);
  });

  app.get('/assignments', async (c) => {
    const query = c.req.query();
    const page = parsePagination(query);
    const filters = parseFilters(query, ['employee_id', 'status', 'kind']);
    const assignments = await listAssignments(
      db,
      c.get('tenantId'),
      { employeeId: filters.employee_id, status: filters.status, kind: filters.kind },
      page,
    );
    return c.json({ data: assignments, limit: page.limit, offset: page.offset });
  });

  app.get('/assignments/:assignmentId', async (c) => {
    const assignment = await getAssignment(db, c.get('tenantId'), c.req.param('assignmentId'));
    return c.json({ data: assignment });
  });

  app.get('/assignments/:assignmentId/logs', async (c) => {
    await getAssignment(db, c.get('tenantId'), c.req.param('assignmentId'));
    const logs = await listWorkLogs(db, c.get('tenantId'), c.req.param('assignmentId'));
    return c.json({ data: logs });
  });

  app.get('/assignments/:assignmentId/photos', async (c) => {
    await getAssignment(db, c.get('tenantId'), c.req.param('assignmentId'));
    const photos = await listJobPhotos(db, c.get('tenantId'), c.req.param('assignmentId'));
    return c.json({ data: photos });
  });

  app.post('/shifts', async (c) => {
    const input = createShiftSchema.parse(await jsonBody(c));
    const shift = await createShift(db, c.get('tenantId'), BACK_OFFICE_ACTOR, input);
    return c.json({ data: shift }, 201);
  });

  app.get('/shifts', async (c) => {
    const query = c.req.query();
    const page = parsePagination(query);
    const filters = parseFilters(query, ['employee_id']);
    const shifts = await listShifts(db, c.get('tenantId'), { employeeId: filters.employee_id }, page);
    return c.json({ data: shifts, limit: page.limit, offset: page.offset });
  });

  /* ---------------- back-office: checklist templates ---------------- */

  app.post('/checklist-templates', async (c) => {
    const input = createTemplateSchema.parse(await jsonBody(c));
    const template = await createChecklistTemplate(db, c.get('tenantId'), BACK_OFFICE_ACTOR, input);
    return c.json({ data: template }, 201);
  });

  app.get('/checklist-templates', async (c) => {
    const templates = await listChecklistTemplates(db, c.get('tenantId'));
    return c.json({ data: templates });
  });

  app.post('/assignments/:assignmentId/checklists', async (c) => {
    const input = instantiateChecklistSchema.parse(await jsonBody(c));
    const checklist = await instantiateChecklist(
      db,
      c.get('tenantId'),
      BACK_OFFICE_ACTOR,
      c.req.param('assignmentId'),
      input,
    );
    return c.json({ data: checklist }, 201);
  });

  app.get('/assignments/:assignmentId/checklists', async (c) => {
    await getAssignment(db, c.get('tenantId'), c.req.param('assignmentId'));
    const checklists = await listChecklistsForAssignment(db, c.get('tenantId'), c.req.param('assignmentId'));
    return c.json({ data: checklists });
  });

  /* ---------------- portal: employee-token surface ---------------- */

  const portal = new Hono<PortalEmployeeEnv>();
  portal.use('*', employeeAuthMiddleware(db));

  portal.get('/me', (c) => c.json({ data: c.get('employee') }));

  portal.get('/my/assignments', async (c) => {
    const me = c.get('employee');
    const query = c.req.query();
    const page = parsePagination(query);
    const filters = parseFilters(query, ['status', 'kind']);
    const assignments = await listAssignments(
      db,
      c.get('tenantId'),
      { employeeId: me.id, status: filters.status, kind: filters.kind },
      page,
    );
    return c.json({ data: assignments, limit: page.limit, offset: page.offset });
  });

  // Managers/admins only: every assignment in the tenant. Middleware-enforced.
  portal.get('/assignments', requireRole('manager', 'admin'), async (c) => {
    const query = c.req.query();
    const page = parsePagination(query);
    const filters = parseFilters(query, ['employee_id', 'status', 'kind']);
    const assignments = await listAssignments(
      db,
      c.get('tenantId'),
      { employeeId: filters.employee_id, status: filters.status, kind: filters.kind },
      page,
    );
    return c.json({ data: assignments, limit: page.limit, offset: page.offset });
  });

  portal.get('/assignments/:assignmentId', async (c) => {
    const assignment = await getAssignmentForActor(
      db,
      c.get('tenantId'),
      c.get('employee'),
      c.req.param('assignmentId'),
    );
    return c.json({ data: assignment });
  });

  portal.post('/assignments/:assignmentId/status', async (c) => {
    const input = statusSchema.parse(await jsonBody(c));
    const assignment = await updateAssignmentStatus(
      db,
      events,
      c.get('tenantId'),
      c.get('employee'),
      c.req.param('assignmentId'),
      input.status,
      input.note,
    );
    return c.json({ data: assignment });
  });

  portal.post('/assignments/:assignmentId/logs', async (c) => {
    const input = logBodySchema.parse(await jsonBody(c));
    const log = await addWorkLog(db, c.get('tenantId'), c.get('employee'), c.req.param('assignmentId'), {
      kind: 'note',
      body: input.body,
    });
    return c.json({ data: log }, 201);
  });

  // Manager comments — middleware-enforced role gate.
  portal.post(
    '/assignments/:assignmentId/comments',
    requireRole('manager', 'admin'),
    async (c) => {
      const input = logBodySchema.parse(await jsonBody(c));
      const log = await addWorkLog(db, c.get('tenantId'), c.get('employee'), c.req.param('assignmentId'), {
        kind: 'manager_comment',
        body: input.body,
      });
      return c.json({ data: log }, 201);
    },
  );

  portal.get('/assignments/:assignmentId/logs', async (c) => {
    await getAssignmentForActor(db, c.get('tenantId'), c.get('employee'), c.req.param('assignmentId'));
    const logs = await listWorkLogs(db, c.get('tenantId'), c.req.param('assignmentId'));
    return c.json({ data: logs });
  });

  portal.get('/assignments/:assignmentId/checklists', async (c) => {
    await getAssignmentForActor(db, c.get('tenantId'), c.get('employee'), c.req.param('assignmentId'));
    const checklists = await listChecklistsForAssignment(db, c.get('tenantId'), c.req.param('assignmentId'));
    return c.json({ data: checklists });
  });

  portal.post('/checklist-items/:itemId/check', async (c) => {
    const input = checkSchema.parse(await jsonBody(c));
    const item = await setChecklistItemChecked(
      db,
      c.get('tenantId'),
      c.get('employee'),
      c.req.param('itemId'),
      input.checked,
    );
    return c.json({ data: item });
  });

  portal.post('/assignments/:assignmentId/photos', async (c) => {
    const input = photoSchema.parse(await jsonBody(c));
    const photo = await addJobPhoto(db, c.get('tenantId'), c.get('employee'), c.req.param('assignmentId'), input);
    return c.json({ data: photo }, 201);
  });

  portal.get('/assignments/:assignmentId/photos', async (c) => {
    await getAssignmentForActor(db, c.get('tenantId'), c.get('employee'), c.req.param('assignmentId'));
    const photos = await listJobPhotos(db, c.get('tenantId'), c.req.param('assignmentId'));
    return c.json({ data: photos });
  });

  portal.get('/my/schedule', async (c) => {
    const me = c.get('employee');
    const date = c.req.query('date') ?? new Date().toISOString().slice(0, 10);
    const requested = c.req.query('employee_id');
    let employeeId = me.id;
    if (requested !== undefined && requested !== me.id) {
      if (!isManager(me)) throw ApiError.forbidden('workers can only view their own schedule');
      await getEmployee(db, c.get('tenantId'), requested); // 404 if absent (tenant-scoped)
      employeeId = requested;
    }
    const schedule = await getDailySchedule(db, c.get('tenantId'), employeeId, date);
    return c.json({ data: schedule });
  });

  portal.get('/my/time-entries', async (c) => {
    const me = c.get('employee');
    const page = parsePagination(c.req.query());
    // Managers/admins may view another employee's entries via ?employee_id=
    // (same pattern as /my/schedule); workers only their own.
    const requested = c.req.query('employee_id');
    let employeeId = me.id;
    if (requested !== undefined && requested !== me.id) {
      if (!isManager(me)) throw ApiError.forbidden('workers can only view their own time entries');
      await getEmployee(db, c.get('tenantId'), requested); // 404 if absent (tenant-scoped)
      employeeId = requested;
    }
    const entries = await listTimeEntries(db, c.get('tenantId'), employeeId, page);
    return c.json({ data: entries, limit: page.limit, offset: page.offset });
  });

  portal.post('/clock-in', async (c) => {
    const input = clockInSchema.parse(await jsonBody(c));
    const entry = await clockIn(db, events, c.get('tenantId'), c.get('employee'), input);
    return c.json({ data: entry }, 201);
  });

  portal.post('/clock-out', async (c) => {
    const entry = await clockOut(db, events, c.get('tenantId'), c.get('employee'));
    return c.json({ data: entry });
  });

  /* ---------------- portal: mobile-first HTML pages ---------------- */

  portal.get('/day', async (c) => {
    const me = c.get('employee');
    const date = c.req.query('date') ?? new Date().toISOString().slice(0, 10);
    const schedule = await getDailySchedule(db, c.get('tenantId'), me.id, date);
    const token = c.req.header('x-employee-token') ?? c.req.query('token') ?? '';
    return c.html(
      dayPageHtml({
        tenantId: c.get('tenantId'),
        token,
        employeeName: me.name,
        schedule,
      }),
    );
  });

  portal.get('/clock', async (c) => {
    const me = c.get('employee');
    const open = (await getDailySchedule(db, c.get('tenantId'), me.id, new Date().toISOString().slice(0, 10)))
      .openTimeEntry;
    const token = c.req.header('x-employee-token') ?? c.req.query('token') ?? '';
    return c.html(
      clockPageHtml({
        tenantId: c.get('tenantId'),
        token,
        employeeName: me.name,
        clockedInAt: open?.clock_in_at ?? null,
      }),
    );
  });

  app.route('/portal', portal);
  return app;
}

/* ------------------------------------------------------------------ *
 * Minimal mobile-first HTML (no external assets, no framework)
 * ------------------------------------------------------------------ */

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const BASE_STYLE = `
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:system-ui,-apple-system,sans-serif;background:#111;color:#eee;padding:16px;max-width:480px;margin:0 auto}
  h1{font-size:1.25rem;margin-bottom:4px}
  h2{font-size:1rem;margin:16px 0 8px;color:#aaa}
  .card{background:#1d1d1d;border:1px solid #333;border-radius:10px;padding:12px;margin-bottom:8px}
  .muted{color:#888;font-size:.85rem}
  .pill{display:inline-block;font-size:.75rem;padding:2px 8px;border-radius:999px;background:#333;margin-left:6px}
  button{width:100%;padding:14px;font-size:1rem;border:0;border-radius:10px;margin-top:8px;cursor:pointer}
  .in{background:#1f6f43;color:#fff}
  .out{background:#8a2d2d;color:#fff}
  #msg{margin-top:10px;font-size:.9rem;color:#9ad}
`;

function clockScript(tenantId: string, token: string): string {
  // JSON.stringify gives safe JS string literals for embedding.
  return `
  <script>
    const HEADERS = { 'content-type': 'application/json', 'x-tenant-id': ${JSON.stringify(tenantId)}, 'x-employee-token': ${JSON.stringify(token)} };
    async function punch(action) {
      const res = await fetch(action, { method: 'POST', headers: HEADERS, body: '{}' });
      const body = await res.json();
      const msg = document.getElementById('msg');
      if (res.ok) { msg.textContent = action === 'clock-in' ? 'Clocked in.' : 'Clocked out.'; location.reload(); }
      else { msg.textContent = body.error ? body.error.message : 'error'; }
    }
  </script>`;
}

function clockButtons(clockedIn: boolean): string {
  return clockedIn
    ? '<button class="out" onclick="punch(\'clock-out\')">Clock Out</button>'
    : '<button class="in" onclick="punch(\'clock-in\')">Clock In</button>';
}

function dayPageHtml(input: {
  tenantId: string;
  token: string;
  employeeName: string;
  schedule: {
    date: string;
    shifts: { starts_at: string; ends_at: string; notes: string | null }[];
    assignments: { id: string; title: string; kind: string; status: string; scheduled_at: string | null }[];
    openTimeEntry: { clock_in_at: string } | null;
  };
}): string {
  const { schedule } = input;
  const shifts =
    schedule.shifts.length === 0
      ? '<p class="muted">No shifts scheduled.</p>'
      : schedule.shifts
          .map(
            (s) =>
              `<div class="card">${escapeHtml(s.starts_at)} &rarr; ${escapeHtml(s.ends_at)}${
                s.notes ? `<div class="muted">${escapeHtml(s.notes)}</div>` : ''
              }</div>`,
          )
          .join('');
  const assignments =
    schedule.assignments.length === 0
      ? '<p class="muted">No assignments today.</p>'
      : schedule.assignments
          .map(
            (a) =>
              `<div class="card">${escapeHtml(a.title)}<span class="pill">${escapeHtml(a.kind)}</span><span class="pill">${escapeHtml(a.status)}</span>${
                a.scheduled_at ? `<div class="muted">${escapeHtml(a.scheduled_at)}</div>` : ''
              }</div>`,
          )
          .join('');
  const clockedIn = schedule.openTimeEntry !== null;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>My Day</title>
<style>${BASE_STYLE}</style>
</head>
<body>
<h1>My Day</h1>
<p class="muted">${escapeHtml(input.employeeName)} &middot; ${escapeHtml(schedule.date)}</p>
<h2>Shifts</h2>
${shifts}
<h2>Assignments</h2>
${assignments}
<h2>Time clock</h2>
<p class="muted">${clockedIn ? `Clocked in at ${escapeHtml(schedule.openTimeEntry!.clock_in_at)}` : 'Not clocked in.'}</p>
${clockButtons(clockedIn)}
<div id="msg"></div>
${clockScript(input.tenantId, input.token)}
</body>
</html>`;
}

function clockPageHtml(input: {
  tenantId: string;
  token: string;
  employeeName: string;
  clockedInAt: string | null;
}): string {
  const clockedIn = input.clockedInAt !== null;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Time Clock</title>
<style>${BASE_STYLE}</style>
</head>
<body>
<h1>Time Clock</h1>
<p class="muted">${escapeHtml(input.employeeName)}</p>
<div class="card">${
    clockedIn ? `Clocked in at ${escapeHtml(input.clockedInAt as string)}` : 'Not clocked in.'
  }</div>
${clockButtons(clockedIn)}
<div id="msg"></div>
${clockScript(input.tenantId, input.token)}
</body>
</html>`;
}

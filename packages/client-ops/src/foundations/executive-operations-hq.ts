import { readFileSync, readdirSync, lstatSync, openSync, closeSync, constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, join } from 'node:path';
import type { ClientOpsService } from '../service';
import { canonicalManifestJson } from '../manifest';
import type {
  FoundationAdapterReadiness,
  FoundationInvocationRequest,
  FoundationInvocationResult,
  FoundationVerificationRequest,
  FoundationVerificationResult,
  ServiceFoundationAdapter,
  OwnedSourceConnection,
} from '../adapters';

/**
 * Executive Operations HQ (service `executive-operations-hq`, capability
 * `client_ops.hq.publish_brief`). Owned source is `BlackLabelHQ`.
 *
 * Reads only an explicitly provisioned tenant/installation connector mapping.
 * Each invocation and verification revalidates the run and current connector
 * against the server's database. There is no process-home or environment source.
 *
 * Anti-vapor guarantee: it NEVER fabricates a brief. If the HQ handoff source
 * cannot be read (missing directory, zero well-formed packets), `readiness()`
 * reports `declared` and `invoke()` returns `status: 'failed'` so the run fails
 * honestly instead of minting a receipt over invented output.
 *
 * READ-ONLY: it only reads packet JSON from disk. No writes, no network, no
 * mutation of any live system.
 */

export interface ExecutiveOperationsHqConfig {
  /** Server-owned run/connection lookups; never supplied by invocation input. */
  service?: Pick<ClientOpsService, 'getRun' | 'getInstallation' | 'listConnectedOwnedSources'>;
  /** Explicit operator-provisioned mappings; a tenant's connector metadata cannot add one. */
  sources?: readonly HqSourceBinding[];
  /** @deprecated Unbound directories are ignored. Provision `sources` instead. */
  handoffsDir?: string;
  /** @deprecated Set a dashboard URL on the tenant source binding. */
  dashboardBaseUrl?: string;
  /** Newest DISTINCT seats to summarize in one brief (default 12). */
  maxSeats?: number;
  /** Upper bound on files parsed per newest-first scan; keeps I/O bounded (default 500). */
  scanCap?: number;
}

export interface HqSourceBinding {
  tenantId: string;
  connection: OwnedSourceConnection;
  handoffsDir: string;
  dashboardBaseUrl?: string;
}

/** One checklist row inside a handoff packet. */
interface ChecklistItem {
  item?: string;
  done?: boolean;
  status?: string;
  evidence?: string;
}

/** The computed-% handoff packet on disk (defensively typed — packets vary). */
interface HandoffPacket {
  seat: string;
  task?: string;
  ts?: string;
  checklist?: ChecklistItem[];
  percent?: number;
  blockers?: string[];
  next?: string;
  client_work?: boolean;
}

interface LoadedPacket {
  packet: HandoffPacket;
  file: string;
  mtimeMs: number;
  sha256: string;
}

interface SeatSummary {
  seat: string;
  task: string;
  percent: number;
  checklistDone: number;
  checklistTotal: number;
  blockerCount: number;
  ts: string | null;
  next: string | null;
  clientWork: boolean;
  evidenceRef: string;
}

interface AttentionItem {
  seat: string;
  reason: string;
  percent: number;
  blockers: string[];
  evidenceRef: string;
}

interface HqBriefAggregate {
  seatCount: number;
  meanPercent: number;
  medianPercent: number;
  completedSeats: number;
  seatsWithBlockers: number;
  openBlockerCount: number;
  clientWorkSeats: number;
}

interface HqBrief {
  generatedAt: string;
  source: { kind: 'handoff_packets'; ownedSource: 'BlackLabelHQ'; bindingId: string; packetsRead: number };
  aggregate: HqBriefAggregate;
  seats: SeatSummary[];
  attention: AttentionItem[];
  narrative: string;
}

const DEEP_LINK_PREFIX = 'client-ops://hq/handoffs/';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** A JSON blob is a handoff packet iff it has a string `seat` and a percent or checklist. */
function asPacket(value: unknown): HandoffPacket | null {
  if (!isRecord(value)) return null;
  if (typeof value.seat !== 'string' || value.seat.length === 0) return null;
  const hasPercent = typeof value.percent === 'number';
  const hasChecklist = Array.isArray(value.checklist);
  if (!hasPercent && !hasChecklist) return null;
  return value as unknown as HandoffPacket;
}

function clampPercent(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
    : sorted[mid];
}

function deepLink(file: string, source: HqSourceBinding): string {
  return DEEP_LINK_PREFIX + [source.tenantId, source.connection.installationId, source.connection.bindingId, basename(file)].map(encodeURIComponent).join('/');
}

function sameConnection(a: OwnedSourceConnection, b: OwnedSourceConnection): boolean {
  return (['bindingId', 'installationId', 'connectorId', 'credentialRef', 'ownedSourceIdentifier'] as const).every(k => a[k] === b[k]);
}

export class ExecutiveOperationsHqAdapter implements ServiceFoundationAdapter {
  readonly serviceId = 'executive-operations-hq';
  readonly capabilityId = 'client_ops.hq.publish_brief';
  readonly ownedSourceIdentifier = 'BlackLabelHQ';

  private readonly service: ExecutiveOperationsHqConfig['service'];
  private readonly sources: readonly HqSourceBinding[];
  private readonly maxSeats: number;
  private readonly scanCap: number;

  constructor(config: ExecutiveOperationsHqConfig = {}) {
    this.service = config.service;
    this.sources = (config.sources ?? []).map(s => ({ ...s, connection: { ...s.connection } }));
    this.maxSeats = Math.max(1, config.maxSeats ?? 12);
    this.scanCap = Math.max(this.maxSeats, config.scanCap ?? 500);
  }

  /** Configuration readiness only; source access is checked for each tenant request. */
  readiness(): FoundationAdapterReadiness {
    return this.service && this.sources.length > 0 ? 'ready' : 'declared';
  }

  private async resolveSource(request: Pick<FoundationInvocationRequest, 'tenantId' | 'installationId' | 'runId' | 'ownedSourceRef'>, verifying = false): Promise<HqSourceBinding | null> {
    const ref = request.ownedSourceRef;
    if (!this.service || !ref || ref.ownedSourceIdentifier !== this.ownedSourceIdentifier || ref.installationId !== request.installationId) return null;
    const source = this.sources.find(s => s.tenantId === request.tenantId && sameConnection(s.connection, ref));
    if (!source) return null;
    try {
      const [run, installation, connected] = await Promise.all([
        this.service.getRun(request.tenantId, request.runId),
        this.service.getInstallation(request.tenantId, request.installationId),
        this.service.listConnectedOwnedSources(request.tenantId),
      ]);
      if (run.installationId !== request.installationId ||
          (run.status !== 'running' && !(verifying && run.status === 'succeeded')) ||
          installation.catalogId !== this.serviceId || installation.status !== 'active' ||
          !connected.some(c => sameConnection(c, ref))) return null;
      return source;
    } catch { return null; }
  }

  async invoke(request: FoundationInvocationRequest): Promise<FoundationInvocationResult> {
    const invocationId = `hq-brief-${request.runId}-${request.actionType}`;
    const source = await this.resolveSource(request);
    const loaded = source ? this.collectSeats(source, this.maxSeats) : [];

    // Honest failure: the registry only invokes a `ready` adapter, but the source
    // can drift between the readiness check and here. Never fabricate a brief.
    if (!source || loaded.length === 0) {
      return {
        invocationId,
        status: 'failed',
        output: {
          error: 'no authorized readable HQ handoff source for this run',
        },
        externalReferences: [],
      };
    }

    return this.compose(request, source, loaded, new Date().toISOString());
  }

  private compose(request: FoundationInvocationRequest, source: HqSourceBinding, loaded: LoadedPacket[], generatedAt: string): FoundationInvocationResult {
    const invocationId = `hq-brief-${request.runId}-${request.actionType}`;
    const brief = this.buildBrief(loaded, source, generatedAt);
    const seatRefs = brief.seats.map((s) => s.evidenceRef);
    const attentionRefs = brief.attention.map((a) => a.evidenceRef);
    const briefArtifactRef = 'client-ops://hq/briefs/' + [request.tenantId, request.installationId, request.runId].map(encodeURIComponent).join('/');

    // Each workflow action produces its real slice of the same evidenced brief.
    let output: Record<string, unknown>;
    let externalReferences: string[];
    switch (request.actionType) {
      case 'collect_summaries':
      case 'assemble_failure':
        output = {
          section: request.actionType,
          aggregate: brief.aggregate,
          narrative: brief.narrative,
          moduleSummaries: brief.seats,
        };
        externalReferences = seatRefs;
        break;
      case 'prioritize_attention':
      case 'assign_owner':
        output = {
          section: request.actionType,
          aggregate: brief.aggregate,
          narrative: brief.narrative,
          attention: brief.attention,
        };
        externalReferences = attentionRefs.length > 0 ? attentionRefs : seatRefs;
        break;
      case 'publish_brief':
      case 'track_resolution':
        output = { section: request.actionType, artifact: 'executive-operations-brief', brief };
        externalReferences = [briefArtifactRef, ...(source.dashboardBaseUrl ? [`${source.dashboardBaseUrl.replace(/\/$/, '')}/flow.html`] : []), ...seatRefs];
        break;
      default:
        output = { section: request.actionType, brief };
        externalReferences = seatRefs;
        break;
    }

    return {
      invocationId,
      status: 'completed',
      output: { ...output, sourceProof: {
        bindingId: source.connection.bindingId, tenantId: request.tenantId,
        installationId: request.installationId, invocationId, generatedAt,
        packetDigest: createHash('sha256').update(canonicalManifestJson(loaded.map(l => ({ file: basename(l.file), sha256: l.sha256 })))).digest('hex'),
      } },
      externalReferences: [...new Set(externalReferences)].sort(),
    };
  }

  /** Re-authorize the same source, then reproduce the exact output from its packets. */
  async verify(request: FoundationVerificationRequest): Promise<FoundationVerificationResult> {
    const source = await this.resolveSource(request, true);
    const loaded = source ? this.collectSeats(source, this.maxSeats) : [];
    const expected = request.expected;
    let verified = false;
    if (source && loaded.length && isRecord(expected) && isRecord(expected.sourceProof) &&
        typeof expected.section === 'string' && typeof expected.sourceProof.generatedAt === 'string' &&
        Number.isFinite(Date.parse(expected.sourceProof.generatedAt))) {
      const rebuilt = this.compose({ ...request, actionType: expected.section, workflowTemplateId: '', input: null }, source, loaded, expected.sourceProof.generatedAt);
      verified = rebuilt.invocationId === request.invocationId && canonicalManifestJson(rebuilt.output) === canonicalManifestJson(expected);
    }
    return {
      verified,
      evidence: {
        invocationId: request.invocationId,
        ownedSource: this.ownedSourceIdentifier,
        bindingId: source?.connection.bindingId ?? null,
        packetsResolved: loaded.length,
        references: verified && source ? loaded.map((l) => deepLink(l.file, source)) : [],
      },
      checkedAt: new Date().toISOString(),
    };
  }

  /**
   * Read the handoff directory newest-first and return one packet per distinct
   * seat (newest wins), up to `maxSeats`. Bounded by `scanCap`. Fully defensive:
   * unreadable / malformed / non-packet JSON is skipped, never fatal.
   */
  private collectSeats(source: HqSourceBinding, maxSeats: number): LoadedPacket[] {
    let entries: string[];
    try {
      entries = readdirSync(source.handoffsDir);
    } catch {
      return [];
    }

    const candidates: Array<{ file: string; mtimeMs: number }> = [];
    for (const name of entries) {
      if (!name.endsWith('.json')) continue;
      const file = join(source.handoffsDir, name);
      try {
        const stat = lstatSync(file);
        if (!stat.isFile()) continue;
        candidates.push({ file, mtimeMs: stat.mtimeMs });
      } catch {
        // vanished / permission — skip
      }
    }
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs || a.file.localeCompare(b.file));

    const collected: LoadedPacket[] = [];
    const seenSeats = new Set<string>();
    let examined = 0;
    for (const candidate of candidates) {
      if (collected.length >= maxSeats) break;
      if (examined >= this.scanCap) break;
      examined += 1;
      let parsed: unknown;
      let sha256: string;
      try {
        const fd = openSync(candidate.file, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const bytes = readFileSync(fd);
          parsed = JSON.parse(bytes.toString('utf8'));
          sha256 = createHash('sha256').update(bytes).digest('hex');
        } finally { closeSync(fd); }
      } catch {
        continue;
      }
      const packet = asPacket(parsed);
      if (!packet) continue;
      if (seenSeats.has(packet.seat)) continue;
      seenSeats.add(packet.seat);
      collected.push({ packet, file: candidate.file, mtimeMs: candidate.mtimeMs, sha256 });
    }
    return collected;
  }

  private summarizeSeat(loaded: LoadedPacket, source: HqSourceBinding): SeatSummary {
    const { packet, file } = loaded;
    const checklist = Array.isArray(packet.checklist) ? packet.checklist : [];
    const checklistTotal = checklist.length;
    const checklistDone = checklist.filter((c) => c?.done === true).length;
    const percent =
      typeof packet.percent === 'number'
        ? clampPercent(packet.percent)
        : checklistTotal > 0
          ? clampPercent((checklistDone / checklistTotal) * 100)
          : 0;
    const blockers = Array.isArray(packet.blockers) ? packet.blockers : [];
    return {
      seat: packet.seat,
      task: typeof packet.task === 'string' ? packet.task : '(unspecified)',
      percent,
      checklistDone,
      checklistTotal,
      blockerCount: blockers.length,
      ts: typeof packet.ts === 'string' ? packet.ts : null,
      next: typeof packet.next === 'string' ? packet.next : null,
      clientWork: packet.client_work === true,
      evidenceRef: deepLink(file, source),
    };
  }

  private buildBrief(loaded: LoadedPacket[], source: HqSourceBinding, generatedAt: string): HqBrief {
    const seats = loaded.map((l) => this.summarizeSeat(l, source));

    const percents = seats.map((s) => s.percent);
    const meanPercent = percents.length
      ? Math.round(percents.reduce((a, b) => a + b, 0) / percents.length)
      : 0;
    const aggregate: HqBriefAggregate = {
      seatCount: seats.length,
      meanPercent,
      medianPercent: median(percents),
      completedSeats: seats.filter((s) => s.percent >= 100).length,
      seatsWithBlockers: seats.filter((s) => s.blockerCount > 0).length,
      openBlockerCount: seats.reduce((a, s) => a + s.blockerCount, 0),
      clientWorkSeats: seats.filter((s) => s.clientWork).length,
    };

    // Attention: blocked seats first, then least-complete. Every entry deep-links.
    const attention: AttentionItem[] = loaded
      .map((l, index) => ({ summary: seats[index], packet: l.packet }))
      .filter(({ summary }) => summary.blockerCount > 0 || summary.percent < 100)
      .sort((a, b) => {
        const aBlocked = a.summary.blockerCount > 0 ? 1 : 0;
        const bBlocked = b.summary.blockerCount > 0 ? 1 : 0;
        if (aBlocked !== bBlocked) return bBlocked - aBlocked;
        return a.summary.percent - b.summary.percent;
      })
      .map(({ summary, packet }) => {
        const blockers = Array.isArray(packet.blockers) ? packet.blockers : [];
        const reason =
          summary.blockerCount > 0
            ? `${summary.blockerCount} open blocker(s) at ${summary.percent}%`
            : `incomplete (${summary.percent}%)`;
        return { seat: summary.seat, reason, percent: summary.percent, blockers, evidenceRef: summary.evidenceRef };
      });

    const lowest = seats.reduce<SeatSummary | null>(
      (min, s) => (min === null || s.percent < min.percent ? s : min),
      null,
    );
    const narrative =
      `HQ operations brief — ${aggregate.seatCount} seat(s); mean completion ${aggregate.meanPercent}% ` +
      `(median ${aggregate.medianPercent}%). ${aggregate.seatsWithBlockers} seat(s) carry ` +
      `${aggregate.openBlockerCount} open blocker(s); ${aggregate.completedSeats} at 100%.` +
      (lowest ? ` Lowest: ${lowest.seat} at ${lowest.percent}%.` : '');

    return {
      generatedAt,
      source: {
        kind: 'handoff_packets',
        ownedSource: 'BlackLabelHQ',
        bindingId: source.connection.bindingId,
        packetsRead: loaded.length,
      },
      aggregate,
      seats,
      attention,
      narrative,
    };
  }
}

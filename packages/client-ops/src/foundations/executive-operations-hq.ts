import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type {
  FoundationAdapterReadiness,
  FoundationInvocationRequest,
  FoundationInvocationResult,
  FoundationVerificationRequest,
  FoundationVerificationResult,
  ServiceFoundationAdapter,
} from '../adapters';

/**
 * Executive Operations HQ (service `executive-operations-hq`, capability
 * `client_ops.hq.publish_brief`). Owned source is `BlackLabelHQ`.
 *
 * This adapter performs REAL, evidenced work: it reads the fleet's computed-%
 * handoff packets from disk (the same `~/BlackLabel-Team/STATE/handoffs/*.json`
 * packets ATLAS/HQ dispatch from) and assembles one module-scoped operations
 * brief — per-seat percent, checklist progress, blockers, and next step — with a
 * deep-link reference to every packet that backs a statement.
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
  /**
   * Directory of computed-% handoff packets.
   * Default: env `BL_HQ_HANDOFFS_DIR`, else `~/BlackLabel-Team/STATE/handoffs`.
   */
  handoffsDir?: string;
  /** Deep-link base for the HQ dashboard (the HQ dashboard runs on :8791). */
  dashboardBaseUrl?: string;
  /** Newest DISTINCT seats to summarize in one brief (default 12). */
  maxSeats?: number;
  /** Upper bound on files parsed per newest-first scan; keeps I/O bounded (default 500). */
  scanCap?: number;
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
  source: { kind: 'handoff_packets'; ownedSource: 'BlackLabelHQ'; dir: string; packetsRead: number };
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

function deepLink(file: string): string {
  return `${DEEP_LINK_PREFIX}${basename(file)}`;
}

export class ExecutiveOperationsHqAdapter implements ServiceFoundationAdapter {
  readonly serviceId = 'executive-operations-hq';
  readonly capabilityId = 'client_ops.hq.publish_brief';
  readonly ownedSourceIdentifier = 'BlackLabelHQ';

  private readonly handoffsDir: string;
  private readonly dashboardBaseUrl: string;
  private readonly maxSeats: number;
  private readonly scanCap: number;

  constructor(config: ExecutiveOperationsHqConfig = {}) {
    this.handoffsDir =
      config.handoffsDir ??
      process.env.BL_HQ_HANDOFFS_DIR ??
      join(homedir(), 'BlackLabel-Team', 'STATE', 'handoffs');
    this.dashboardBaseUrl = config.dashboardBaseUrl ?? 'http://localhost:8791';
    this.maxSeats = Math.max(1, config.maxSeats ?? 12);
    this.scanCap = Math.max(this.maxSeats, config.scanCap ?? 500);
  }

  /** Ready only when the HQ handoff source yields at least one well-formed packet. */
  readiness(): FoundationAdapterReadiness {
    try {
      return this.collectSeats(1).length > 0 ? 'ready' : 'declared';
    } catch {
      return 'declared';
    }
  }

  async invoke(request: FoundationInvocationRequest): Promise<FoundationInvocationResult> {
    const invocationId = `hq-brief-${request.runId}-${request.actionType}`;
    const loaded = this.collectSeats(this.maxSeats);

    // Honest failure: the registry only invokes a `ready` adapter, but the source
    // can drift between the readiness check and here. Never fabricate a brief.
    if (loaded.length === 0) {
      return {
        invocationId,
        status: 'failed',
        output: {
          error: 'no readable BlackLabelHQ handoff packets',
          dir: this.handoffsDir,
        },
        externalReferences: [],
      };
    }

    const brief = this.buildBrief(loaded);
    const seatRefs = brief.seats.map((s) => s.evidenceRef);
    const attentionRefs = brief.attention.map((a) => a.evidenceRef);
    const briefArtifactRef = `client-ops://hq/briefs/${request.runId}`;
    const dashboardRef = `${this.dashboardBaseUrl}/flow.html`;

    // Each workflow action produces its real slice of the same evidenced brief.
    let output: unknown;
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
        externalReferences = [briefArtifactRef, dashboardRef, ...seatRefs];
        break;
      default:
        output = { section: request.actionType, brief };
        externalReferences = seatRefs;
        break;
    }

    return {
      invocationId,
      status: 'completed',
      output,
      externalReferences: [...new Set(externalReferences)].sort(),
    };
  }

  /** Re-resolve the packets that back the brief; verified iff the source still reads. */
  async verify(request: FoundationVerificationRequest): Promise<FoundationVerificationResult> {
    const loaded = this.collectSeats(this.maxSeats);
    return {
      verified: loaded.length > 0,
      evidence: {
        invocationId: request.invocationId,
        ownedSource: this.ownedSourceIdentifier,
        dir: this.handoffsDir,
        packetsResolved: loaded.length,
        references: loaded.map((l) => deepLink(l.file)),
      },
      checkedAt: new Date().toISOString(),
    };
  }

  /**
   * Read the handoff directory newest-first and return one packet per distinct
   * seat (newest wins), up to `maxSeats`. Bounded by `scanCap`. Fully defensive:
   * unreadable / malformed / non-packet JSON is skipped, never fatal.
   */
  private collectSeats(maxSeats: number): LoadedPacket[] {
    let entries: string[];
    try {
      entries = readdirSync(this.handoffsDir);
    } catch {
      return [];
    }

    const candidates: Array<{ file: string; mtimeMs: number }> = [];
    for (const name of entries) {
      if (!name.endsWith('.json')) continue;
      const file = join(this.handoffsDir, name);
      try {
        const stat = statSync(file);
        if (!stat.isFile()) continue;
        candidates.push({ file, mtimeMs: stat.mtimeMs });
      } catch {
        // vanished / permission — skip
      }
    }
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);

    const collected: LoadedPacket[] = [];
    const seenSeats = new Set<string>();
    let examined = 0;
    for (const candidate of candidates) {
      if (collected.length >= maxSeats) break;
      if (examined >= this.scanCap) break;
      examined += 1;
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(candidate.file, 'utf8'));
      } catch {
        continue;
      }
      const packet = asPacket(parsed);
      if (!packet) continue;
      if (seenSeats.has(packet.seat)) continue;
      seenSeats.add(packet.seat);
      collected.push({ packet, file: candidate.file, mtimeMs: candidate.mtimeMs });
    }
    return collected;
  }

  private summarizeSeat(loaded: LoadedPacket): SeatSummary {
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
      evidenceRef: deepLink(file),
    };
  }

  private buildBrief(loaded: LoadedPacket[]): HqBrief {
    const seats = loaded.map((l) => this.summarizeSeat(l));

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
      generatedAt: new Date().toISOString(),
      source: {
        kind: 'handoff_packets',
        ownedSource: 'BlackLabelHQ',
        dir: this.handoffsDir,
        packetsRead: loaded.length,
      },
      aggregate,
      seats,
      attention,
      narrative,
    };
  }
}

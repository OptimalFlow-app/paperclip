import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentWakeupRequests, companies, issueComments, issues } from "@paperclipai/db";
import {
  queuedCommentIdsFromRunContext,
  queuedCommentIdsFromWakePayload,
  withQueuedCommentIdsInRunContext,
  withQueuedCommentIdsInWakePayload,
} from "../../../services/issue-queued-comment-queue.js";
import { hasInteractionContinuationWakeContext } from "../domain/context.js";
import type { BatchedWakeRevalidationFacts } from "../domain/policy.js";
import { readNonEmptyString } from "../domain/values.js";

// Postgres side of the per-agent wake batch window: the `batched` rows of
// `agent_wakeup_requests`. A batched row keeps the enriched wake context in
// `payload._paperclipWakeContext` (like `deferred_issue_execution`) and its
// batch bookkeeping in `payload.wakeBatch`.

export const WAKE_BATCH_STATUS = "batched";
const WAKE_CONTEXT_KEY = "_paperclipWakeContext";
const COMMENT_ONLY_REASONS = new Set(["issue_commented", "issue_reopened_via_comment"]);

type WakeRow = typeof agentWakeupRequests.$inferSelect;

export type WakeBatchMeta = {
  assigneeAgentIdAtAdmission: string | null;
  reasons: string[];
  idempotencyKey: string | null;
};

export type BatchedWake = {
  id: string;
  companyId: string;
  agentId: string;
  issueId: string;
  source: string;
  triggerDetail: string | null;
  reason: string | null;
  payload: Record<string, unknown>;
  contextSnapshot: Record<string, unknown>;
  requestedByActorType: string | null;
  requestedByActorId: string | null;
  requestedAt: Date;
  meta: WakeBatchMeta;
};

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readMeta(payload: Record<string, unknown>, fallbackReason: string | null): WakeBatchMeta {
  const meta = record(payload.wakeBatch);
  const reasons = Array.isArray(meta.reasons)
    ? meta.reasons.filter((value): value is string => typeof value === "string" && value.length > 0)
    : [];
  return {
    assigneeAgentIdAtAdmission: readNonEmptyString(meta.assigneeAgentIdAtAdmission),
    reasons: reasons.length > 0 ? reasons : fallbackReason ? [fallbackReason] : [],
    idempotencyKey: readNonEmptyString(meta.idempotencyKey),
  };
}

function toBatchedWake(row: WakeRow): BatchedWake {
  const payload = record(row.payload);
  return {
    id: row.id,
    companyId: row.companyId,
    agentId: row.agentId,
    issueId: String(payload.issueId ?? ""),
    source: row.source,
    triggerDetail: row.triggerDetail,
    reason: row.reason,
    payload,
    contextSnapshot: record(payload[WAKE_CONTEXT_KEY]),
    requestedByActorType: row.requestedByActorType,
    requestedByActorId: row.requestedByActorId,
    requestedAt: row.requestedAt,
    meta: readMeta(payload, row.reason),
  };
}

function carriesInteraction(payload: Record<string, unknown>, context: Record<string, unknown>) {
  return readNonEmptyString(payload.mutation) === "interaction" || hasInteractionContinuationWakeContext(context);
}

/** True when the wake has a reason to run beyond the comments it carries. */
export function batchedWakePreservesIndependentContinuation(wake: BatchedWake): boolean {
  return carriesInteraction(wake.payload, wake.contextSnapshot) ||
    wake.meta.reasons.some((reason) => !COMMENT_ONLY_REASONS.has(reason));
}

export type AdmitWakeIntoBatchInput = {
  companyId: string;
  agentId: string;
  issueId: string;
  assigneeAgentId: string | null;
  source: string;
  triggerDetail: string | null;
  reason: string | null;
  payload: Record<string, unknown> | null;
  contextSnapshot: Record<string, unknown>;
  wakeCommentId: string | null;
  requestedByActorType: string | null;
  requestedByActorId: string | null;
  idempotencyKey: string | null;
};

/**
 * Writes a wake into the agent's pending batch. Runs inside the caller's
 * issue-locked transaction. A second plain wake on an issue already in the
 * batch merges into the same row; an interaction wake keeps its own row so
 * its continuation context is never folded into another wake's.
 */
export async function admitWakeIntoBatch(tx: Db, input: AdmitWakeIntoBatchInput): Promise<{ wakeupRequestId: string; merged: boolean }> {
  const commentIds = [...new Set([
    ...queuedCommentIdsFromRunContext(input.contextSnapshot),
    ...(input.wakeCommentId ? [input.wakeCommentId] : []),
  ])];
  const payload = record(input.payload);
  const interaction = carriesInteraction(payload, input.contextSnapshot);
  if (!interaction) {
    const candidates = await tx
      .select()
      .from(agentWakeupRequests)
      .where(and(
        eq(agentWakeupRequests.companyId, input.companyId),
        eq(agentWakeupRequests.agentId, input.agentId),
        eq(agentWakeupRequests.status, WAKE_BATCH_STATUS),
        sql`${agentWakeupRequests.payload}->>'issueId' = ${input.issueId}`,
      ))
      .orderBy(asc(agentWakeupRequests.requestedAt));
    const existing = candidates.map(toBatchedWake).find((wake) => !carriesInteraction(wake.payload, wake.contextSnapshot));
    if (existing) {
      const mergedIds = [...new Set([...queuedCommentIdsFromWakePayload(existing.payload), ...commentIds])];
      const reasons = [...new Set([...existing.meta.reasons, ...(input.reason ? [input.reason] : [])])];
      const nextPayload = withQueuedCommentIdsInWakePayload({
        ...existing.payload,
        [WAKE_CONTEXT_KEY]: withQueuedCommentIdsInRunContext(existing.contextSnapshot, mergedIds),
        wakeBatch: { ...existing.meta, reasons },
      }, mergedIds);
      await tx
        .update(agentWakeupRequests)
        .set({
          payload: nextPayload,
          coalescedCount: sql`${agentWakeupRequests.coalescedCount} + 1`,
          updatedAt: new Date(),
        })
        .where(and(eq(agentWakeupRequests.id, existing.id), eq(agentWakeupRequests.status, WAKE_BATCH_STATUS)));
      return { wakeupRequestId: existing.id, merged: true };
    }
  }
  const [row] = await tx
    .insert(agentWakeupRequests)
    .values({
      companyId: input.companyId,
      agentId: input.agentId,
      source: input.source,
      triggerDetail: input.triggerDetail,
      reason: input.reason,
      payload: withQueuedCommentIdsInWakePayload({
        ...payload,
        issueId: input.issueId,
        [WAKE_CONTEXT_KEY]: input.contextSnapshot,
        wakeBatch: {
          assigneeAgentIdAtAdmission: input.assigneeAgentId,
          reasons: input.reason ? [input.reason] : [],
          idempotencyKey: input.idempotencyKey,
        } satisfies WakeBatchMeta,
      }, commentIds),
      status: WAKE_BATCH_STATUS,
      requestedByActorType: input.requestedByActorType,
      requestedByActorId: input.requestedByActorId,
      idempotencyKey: input.idempotencyKey,
    })
    .returning({ id: agentWakeupRequests.id });
  return { wakeupRequestId: row!.id, merged: false };
}

/** Agents with a pending batch in an active company, with their oldest batched wake. */
export async function listAgentsWithBatchedWakes(db: Db, agentId?: string) {
  return db
    .select({
      agentId: agentWakeupRequests.agentId,
      oldestRequestedAt: sql<Date>`min(${agentWakeupRequests.requestedAt})`.mapWith((value) => new Date(value)),
    })
    .from(agentWakeupRequests)
    .innerJoin(companies, and(eq(companies.id, agentWakeupRequests.companyId), eq(companies.status, "active")))
    .where(and(
      eq(agentWakeupRequests.status, WAKE_BATCH_STATUS),
      agentId ? eq(agentWakeupRequests.agentId, agentId) : undefined,
    ))
    .groupBy(agentWakeupRequests.agentId);
}

export async function listBatchedWakes(db: Db, agentId: string): Promise<BatchedWake[]> {
  const rows = await db
    .select()
    .from(agentWakeupRequests)
    .where(and(eq(agentWakeupRequests.agentId, agentId), eq(agentWakeupRequests.status, WAKE_BATCH_STATUS)))
    .orderBy(asc(agentWakeupRequests.requestedAt), asc(agentWakeupRequests.id));
  return rows.map(toBatchedWake);
}

export type BatchedWakeIssue = {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
  priority: string;
  assigneeAgentId: string | null;
};

/** Reads the current issue and comment facts each batched wake is revalidated against. */
export async function readBatchedWakeFacts(db: Db, wakes: BatchedWake[]) {
  const issueIds = [...new Set(wakes.map((wake) => wake.issueId).filter(Boolean))];
  const commentIds = [...new Set(wakes.flatMap((wake) => queuedCommentIdsFromWakePayload(wake.payload)))];
  const companyId = wakes[0]?.companyId;
  const issueRows = issueIds.length && companyId
    ? await db
        .select({
          id: issues.id,
          identifier: issues.identifier,
          title: issues.title,
          status: issues.status,
          priority: issues.priority,
          assigneeAgentId: issues.assigneeAgentId,
        })
        .from(issues)
        .where(and(eq(issues.companyId, companyId), inArray(issues.id, issueIds)))
    : [];
  const liveCommentRows = commentIds.length && companyId
    ? await db
        .select({ id: issueComments.id })
        .from(issueComments)
        .where(and(eq(issueComments.companyId, companyId), inArray(issueComments.id, commentIds), isNull(issueComments.deletedAt)))
    : [];
  const issuesById = new Map<string, BatchedWakeIssue>(issueRows.map((row) => [row.id, row]));
  const liveCommentIds = new Set(liveCommentRows.map((row) => row.id));
  const facts = new Map<string, BatchedWakeRevalidationFacts>();
  for (const wake of wakes) {
    const issue = issuesById.get(wake.issueId) ?? null;
    const ids = queuedCommentIdsFromWakePayload(wake.payload);
    facts.set(wake.id, {
      issueFound: Boolean(issue),
      issueStatus: issue?.status ?? null,
      assigneeAgentIdAtAdmission: wake.meta.assigneeAgentIdAtAdmission,
      currentAssigneeAgentId: issue?.assigneeAgentId ?? null,
      commentIdCount: ids.length,
      liveCommentIdCount: ids.filter((id) => liveCommentIds.has(id)).length,
      preservesIndependentContinuation: batchedWakePreservesIndependentContinuation(wake),
    });
  }
  return { facts, issuesById };
}

export async function cancelBatchedWake(db: Db, wakeId: string, reason: string) {
  const now = new Date();
  await db
    .update(agentWakeupRequests)
    .set({ status: "cancelled", error: reason, finishedAt: now, updatedAt: now })
    .where(and(eq(agentWakeupRequests.id, wakeId), eq(agentWakeupRequests.status, WAKE_BATCH_STATUS)));
}

/**
 * Atomically takes batched wakes out of the batch before they are delivered,
 * so two flushers can never deliver the same wake. The idempotency key moves
 * back into `payload.wakeBatch` so a replayed wake can reuse it without
 * colliding with this row on a partial unique index.
 */
export async function claimBatchedWakes(db: Db, wakeIds: string[]): Promise<string[]> {
  if (wakeIds.length === 0) return [];
  const now = new Date();
  const rows = await db
    .update(agentWakeupRequests)
    .set({ status: "coalesced", idempotencyKey: null, finishedAt: now, updatedAt: now })
    .where(and(inArray(agentWakeupRequests.id, wakeIds), eq(agentWakeupRequests.status, WAKE_BATCH_STATUS)))
    .returning({ id: agentWakeupRequests.id });
  return rows.map((row) => row.id);
}

/** Puts claimed wakes back into the batch after a delivery that did not start. */
export async function releaseClaimedBatchedWakes(db: Db, wakes: BatchedWake[]) {
  for (const wake of wakes) {
    await db
      .update(agentWakeupRequests)
      .set({ status: WAKE_BATCH_STATUS, idempotencyKey: wake.meta.idempotencyKey, finishedAt: null, updatedAt: new Date() })
      .where(and(eq(agentWakeupRequests.id, wake.id), eq(agentWakeupRequests.status, "coalesced"), isNull(agentWakeupRequests.runId)));
  }
}

/** Records the run that delivered claimed wakes; a wake no run picked up is marked skipped. */
export async function completeClaimedBatchedWakes(db: Db, wakeIds: string[], runId: string | null) {
  if (wakeIds.length === 0) return;
  await db
    .update(agentWakeupRequests)
    .set(runId
      ? { runId, updatedAt: new Date() }
      : { status: "skipped", error: "batch_delivery_not_started", updatedAt: new Date() })
    .where(inArray(agentWakeupRequests.id, wakeIds));
}

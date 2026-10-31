import {
  decideBatchedWakeRevalidation,
  decideBatchFlush,
  WAKE_BATCH_MAX_ISSUES_PER_RUN,
  type BatchedWakeCancelReason,
  type BatchedWakeRevalidationFacts,
} from "../domain/policy.js";

// Flushes the per-agent wake batches (`runtimeConfig.heartbeat.batchWindowSec`).
// The use case only orders the steps; the ports own every read and write, and
// both delivery ports re-enter the ordinary wake admission, so every gate
// that applies to a fresh wake (budget, pause, daily cap, issue lock) also
// applies to a flushed one.

export type FlushableBatchedWake = {
  id: string;
  issueId: string;
};

export type AgentBatchState =
  | { kind: "missing" }
  | { kind: "held" }
  | { kind: "ready"; batchWindowSec: number; agentHasActiveRun: boolean };

export type WakeBatchFlushPorts<W extends FlushableBatchedWake> = {
  now(): Date;
  listPendingAgents(agentId?: string): Promise<Array<{ agentId: string; oldestRequestedAt: Date }>>;
  /** Missing agents cancel their batch; paused, non-invokable, or budget-blocked agents hold it. */
  readAgentBatchState(agentId: string): Promise<AgentBatchState>;
  listBatchedWakes(agentId: string): Promise<W[]>;
  readRevalidationFacts(wakes: W[]): Promise<Map<string, BatchedWakeRevalidationFacts>>;
  cancel(wake: W, reason: BatchedWakeCancelReason | "batch_agent_missing"): Promise<void>;
  /** Returns the ids it took out of the batch; a concurrent flusher gets the rest. */
  claim(wakes: W[]): Promise<string[]>;
  release(wakes: W[]): Promise<void>;
  complete(wakes: W[], runId: string | null): Promise<void>;
  /** One wake left: deliver it as the ordinary issue-bound run. */
  deliverSingle(wake: W): Promise<{ runId: string | null }>;
  /** Two or more wakes: deliver them in one run that is bound to no issue. */
  deliverBatch(agentId: string, wakes: W[]): Promise<{ runId: string | null }>;
  onError?(agentId: string, error: unknown): void;
};

export type WakeBatchFlushResult = {
  agentId: string;
  outcome: "waiting" | "held" | "cancelled_all" | "empty" | "single" | "batch" | "contended";
  runId?: string | null;
  deliveredWakeIds?: string[];
  cancelledWakeIds?: string[];
};

/** Splits deliverable wakes into the next run's share (at most N issues) and the remainder. */
export function selectBatchShare<W extends FlushableBatchedWake>(wakes: W[], maxIssues = WAKE_BATCH_MAX_ISSUES_PER_RUN) {
  const issueIds = new Set<string>();
  const share: W[] = [];
  for (const wake of wakes) {
    if (!issueIds.has(wake.issueId)) {
      if (issueIds.size >= maxIssues) continue;
      issueIds.add(wake.issueId);
    }
    share.push(wake);
  }
  return share;
}

export function createFlushDueWakeBatches<W extends FlushableBatchedWake>(ports: WakeBatchFlushPorts<W>) {
  const flushing = new Set<string>();

  async function flushAgent(agentId: string, oldestRequestedAt: Date): Promise<WakeBatchFlushResult> {
    const state = await ports.readAgentBatchState(agentId);
    if (state.kind === "held") return { agentId, outcome: "held" };
    const wakes = await ports.listBatchedWakes(agentId);
    if (state.kind === "missing") {
      for (const wake of wakes) await ports.cancel(wake, "batch_agent_missing");
      return { agentId, outcome: "cancelled_all", cancelledWakeIds: wakes.map((wake) => wake.id) };
    }
    const decision = decideBatchFlush({
      batchWindowSec: state.batchWindowSec,
      oldestRequestedAtMs: oldestRequestedAt.getTime(),
      nowMs: ports.now().getTime(),
      agentHasActiveRun: state.agentHasActiveRun,
    });
    if (decision.kind === "wait") return { agentId, outcome: "waiting" };

    const facts = await ports.readRevalidationFacts(wakes);
    const deliverable: W[] = [];
    const cancelledWakeIds: string[] = [];
    for (const wake of wakes) {
      const wakeFacts = facts.get(wake.id);
      const verdict = wakeFacts
        ? decideBatchedWakeRevalidation(wakeFacts)
        : { kind: "cancel" as const, reason: "batch_issue_closed" as const };
      if (verdict.kind === "cancel") {
        await ports.cancel(wake, verdict.reason);
        cancelledWakeIds.push(wake.id);
      } else {
        deliverable.push(wake);
      }
    }
    if (deliverable.length === 0) return { agentId, outcome: "empty", cancelledWakeIds };

    const share = selectBatchShare(deliverable);
    const claimedIds = new Set(await ports.claim(share));
    const claimed = share.filter((wake) => claimedIds.has(wake.id));
    if (claimed.length === 0) return { agentId, outcome: "contended", cancelledWakeIds };

    let runId: string | null;
    try {
      runId = claimed.length === 1
        ? (await ports.deliverSingle(claimed[0]!)).runId
        : (await ports.deliverBatch(agentId, claimed)).runId;
    } catch (error) {
      await ports.release(claimed);
      throw error;
    }
    await ports.complete(claimed, runId);
    return {
      agentId,
      outcome: claimed.length === 1 ? "single" : "batch",
      runId,
      deliveredWakeIds: claimed.map((wake) => wake.id),
      cancelledWakeIds,
    };
  }

  /**
   * Flushes every due batch, or only `agentId`'s. Called from the scheduler
   * tick and when one of the agent's runs finishes. A flush already running
   * for an agent in this process makes a second call skip that agent.
   */
  return async function flushDueWakeBatches(opts: { agentId?: string } = {}): Promise<WakeBatchFlushResult[]> {
    const results: WakeBatchFlushResult[] = [];
    for (const pending of await ports.listPendingAgents(opts.agentId)) {
      if (flushing.has(pending.agentId)) continue;
      flushing.add(pending.agentId);
      try {
        results.push(await flushAgent(pending.agentId, pending.oldestRequestedAt));
      } catch (error) {
        if (!ports.onError) throw error;
        ports.onError(pending.agentId, error);
      } finally {
        flushing.delete(pending.agentId);
      }
    }
    return results;
  };
}

import { describe, expect, it, vi } from "vitest";
import type { BatchedWakeRevalidationFacts } from "../domain/policy.js";
import {
  createFlushDueWakeBatches,
  selectBatchShare,
  type AgentBatchState,
  type WakeBatchFlushPorts,
} from "./wake-batch.js";

type Wake = { id: string; issueId: string };

const deliverable: BatchedWakeRevalidationFacts = {
  issueFound: true,
  issueStatus: "todo",
  assigneeAgentIdAtAdmission: "agent-1",
  currentAssigneeAgentId: "agent-1",
  commentIdCount: 0,
  liveCommentIdCount: 0,
  preservesIndependentContinuation: true,
};

function harness(wakes: Wake[], state: AgentBatchState = { kind: "ready", batchWindowSec: 300, agentHasActiveRun: false }) {
  const now = new Date("2026-10-31T10:00:00Z");
  const ports: WakeBatchFlushPorts<Wake> = {
    now: () => now,
    listPendingAgents: vi.fn(async () => [{ agentId: "agent-1", oldestRequestedAt: new Date(now.getTime() - 600_000) }]),
    readAgentBatchState: vi.fn(async () => state),
    listBatchedWakes: vi.fn(async () => wakes),
    readRevalidationFacts: vi.fn(async (list: Wake[]) => new Map(list.map((wake) => [wake.id, deliverable]))),
    cancel: vi.fn(async () => {}),
    claim: vi.fn(async (list: Wake[]) => list.map((wake) => wake.id)),
    release: vi.fn(async () => {}),
    complete: vi.fn(async () => {}),
    deliverSingle: vi.fn(async () => ({ runId: "run-single" })),
    deliverBatch: vi.fn(async () => ({ runId: "run-batch" })),
  };
  return { ports, flush: createFlushDueWakeBatches(ports) };
}

const wakesOn = (count: number) => Array.from({ length: count }, (_, index) => ({ id: `w${index}`, issueId: `i${index}` }));

describe("selectBatchShare", () => {
  it("keeps every wake of the first ten issues and leaves the rest", () => {
    const wakes = [...wakesOn(12), { id: "w0b", issueId: "i0" }];
    const share = selectBatchShare(wakes);
    expect(share.map((wake) => wake.id)).toEqual([...wakesOn(10).map((wake) => wake.id), "w0b"]);
  });
});

describe("flushDueWakeBatches", () => {
  it("delivers two or more wakes as one batch run and records it", async () => {
    const { ports, flush } = harness(wakesOn(3));
    expect(await flush()).toMatchObject([{ outcome: "batch", runId: "run-batch" }]);
    expect(ports.deliverBatch).toHaveBeenCalledWith("agent-1", wakesOn(3));
    expect(ports.complete).toHaveBeenCalledWith(wakesOn(3), "run-batch");
  });

  it("caps a batch run at ten issues", async () => {
    const { ports, flush } = harness(wakesOn(12));
    await flush();
    expect(vi.mocked(ports.deliverBatch).mock.calls[0]![1]).toHaveLength(10);
  });

  it("puts claimed wakes back when delivery throws", async () => {
    const { ports, flush } = harness(wakesOn(2));
    vi.mocked(ports.deliverBatch).mockRejectedValueOnce(new Error("budget"));
    await expect(flush()).rejects.toThrow("budget");
    expect(ports.release).toHaveBeenCalledWith(wakesOn(2));
    expect(ports.complete).not.toHaveBeenCalled();
  });

  it("delivers nothing when a concurrent flusher claimed the wakes", async () => {
    const { ports, flush } = harness(wakesOn(2));
    vi.mocked(ports.claim).mockResolvedValueOnce([]);
    expect(await flush()).toMatchObject([{ outcome: "contended" }]);
    expect(ports.deliverBatch).not.toHaveBeenCalled();
  });

  it("cancels the batch of a deleted agent and holds the batch of a paused one", async () => {
    const missing = harness(wakesOn(2), { kind: "missing" });
    expect(await missing.flush()).toMatchObject([{ outcome: "cancelled_all" }]);
    expect(missing.ports.cancel).toHaveBeenCalledTimes(2);

    const held = harness(wakesOn(2), { kind: "held" });
    expect(await held.flush()).toMatchObject([{ outcome: "held" }]);
    expect(held.ports.listBatchedWakes).not.toHaveBeenCalled();
  });
});

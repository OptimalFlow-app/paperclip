import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { agents, budgetPolicies, companies, costEvents, createDb, heartbeatRuns } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { accountRunCost, reconcileRunCosts } from "../services/run-cost-accounting.js";
import { accountingIntegrityService } from "../services/accounting-integrity.js";
import { budgetService } from "../services/budgets.js";
import { recoverPendingRunUsageReceipts, replayUsageReceipts, spoolUsageReceipt } from "../services/usage-receipts.js";
import { logger } from "../middleware/logger.js";

describe("terminal runs without a usage receipt", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let spool: string;
  let companyId: string;
  let agentId: string;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("run-cost-no-receipt-");
    db = createDb(database.connectionString);
  }, 30_000);
  afterAll(async () => { await database?.cleanup(); });

  beforeEach(async () => {
    spool = await mkdtemp(path.join(os.tmpdir(), "paperclip-receipts-"));
    companyId = randomUUID();
    agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Accounting", issuePrefix: `A${companyId.slice(0, 4).toUpperCase()}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "KB", role: "engineer", adapterType: "claude_local" });
    await db.insert(budgetPolicies).values({ companyId, scopeType: "agent", scopeId: agentId, metric: "billed_cents",
      windowKind: "calendar_month_utc", amount: 2500, hardStopEnabled: true, isActive: true });
    return () => rm(spool, { recursive: true, force: true });
  });

  /** Shape of run 8ccc9c1c: killed at timeoutSec before any receipt reached
   * the spool, finalized by heartbeat with `usageComplete: false`. */
  async function timedOutRun(billingType: string, extra: Record<string, unknown> = {}) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "timed_out", startedAt: new Date(),
      finishedAt: new Date(), costAccountingPending: true,
      usageJson: { accountingReceiptReady: false, billingType, provider: "anthropic", biller: "anthropic", model: "claude",
        inputTokens: 120, cachedInputTokens: 0, outputTokens: 30, costUsdExact: null, ...extra } });
    return runId;
  }
  const run = async (runId: string) => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0];
  const agent = async () => (await db.select().from(agents).where(eq(agents.id, agentId)))[0];
  const events = (runId: string) => db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, runId));
  const status = async () => (await budgetService(db).overview(companyId)).policies[0]?.status;
  const healthState = async (runId: string) =>
    (await accountingIntegrityService(db).health(companyId)).items.find(item => "runId" in item && item.runId === runId)?.state;

  it("settles a subscription run at zero with its partial tokens, then the hard stop clears and the agent resumes", async () => {
    const runId = await timedOutRun("subscription_included");
    expect(await status()).toBe("hard_stop");
    await budgetService(db).reconcilePolicies();
    expect(await agent()).toMatchObject({ status: "paused", pauseReason: "budget" });
    expect(await healthState(runId)).toBe("retryable");

    expect(await reconcileRunCosts(db)).toMatchObject({ scanned: 1, accounted: 1 });
    expect(await run(runId)).toMatchObject({ costAccountingPending: false, costAccountedAt: expect.any(Date) });
    expect(await events(runId)).toEqual([expect.objectContaining({
      costCents: 0, costStatus: "estimated", billingType: "subscription_included", inputTokens: 120, outputTokens: 30 })]);
    expect(await status()).toBe("ok");
    expect(await agent()).toMatchObject({ status: "idle", pauseReason: null });
  });

  it("keeps a metered run without its final receipt pending (no invented zero), then settles its final incomplete receipt as unpriced", async () => {
    const runId = await timedOutRun("metered_api", { costUsd: 0.4 });

    expect(await accountRunCost(db, runId)).toBe(false);
    expect(await reconcileRunCosts(db)).toMatchObject({ scanned: 0, accounted: 0 });
    expect(await run(runId)).toMatchObject({ costAccountingPending: true, costAccountedAt: null });
    expect(await events(runId)).toEqual([]);
    expect(await healthState(runId)).toBe("waiting_for_receipt");
    expect(await status()).toBe("hard_stop");
    expect(await agent()).toMatchObject({ status: "paused", pauseReason: "budget" });

    // The adapter's final receipt says nothing more will come: settle what
    // was observed, unpriced (a lower bound), never as an invented zero.
    const finalRunId = await timedOutRun("metered_api", { costUsd: 0.4, accountingReceiptFinal: true });
    expect(await healthState(finalRunId)).toBe("retryable");
    expect(await reconcileRunCosts(db)).toMatchObject({ scanned: 1, accounted: 1 });
    expect(await run(finalRunId)).toMatchObject({ costAccountingPending: false, costAccountedAt: expect.any(Date) });
    expect(await events(finalRunId)).toEqual([expect.objectContaining({
      costCents: 40, costStatus: "unpriced", billingType: "metered_api", inputTokens: 120, outputTokens: 30 })]);
    expect(await run(runId)).toMatchObject({ costAccountingPending: true, costAccountedAt: null });
  });

  it("keeps a subscription run whose usage capture failed pending", async () => {
    const runId = await timedOutRun("subscription_included", { accountingCaptureFailed: true });

    expect(await accountRunCost(db, runId)).toBe(false);
    expect(await reconcileRunCosts(db)).toMatchObject({ scanned: 0 });
    expect(await healthState(runId)).toBe("waiting_for_receipt");
    expect(await status()).toBe("hard_stop");
  });

  it("logs and ignores a late receipt for a run already settled", async () => {
    const runId = await timedOutRun("subscription_included");
    expect(await accountRunCost(db, runId)).toBe(true);
    const settled = await run(runId);
    const info = vi.spyOn(logger, "info");
    const late = (sequence: number) => ({ schema: "paperclip/accounting-receipt/v1" as const, id: randomUUID(), companyId, runId,
      sourceId: randomUUID(), sequence, receivedAt: new Date().toISOString(), adapterType: "claude_local",
      receipt: { provider: "anthropic", model: "claude", billingType: "subscription", usage: { inputTokens: 900, outputTokens: 300 }, complete: true } });

    await spoolUsageReceipt(late(1), spool);
    expect(await replayUsageReceipts(db, spool)).toEqual({ replayed: 1, failed: 0 });
    await spoolUsageReceipt(late(2), spool);
    await expect(recoverPendingRunUsageReceipts(db, { companyId, runId }, spool)).resolves.toHaveLength(1);

    expect(info).toHaveBeenCalledWith(expect.objectContaining({ runId }), "Late usage receipt for an accounted run ignored");
    expect(await run(runId)).toMatchObject({ costAccountingPending: false, costAccountedAt: settled.costAccountedAt, usageJson: settled.usageJson });
    expect(await events(runId)).toEqual([expect.objectContaining({ costCents: 0, inputTokens: 120, outputTokens: 30 })]);
    info.mockRestore();
  });
});

import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agents, budgetPolicies, companies, costEvents, createDb, heartbeatRuns } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { accountRunCost, INCOMPLETE_RECEIPT_GRACE_MS, reconcileRunCosts } from "../services/run-cost-accounting.js";
import { accountingIntegrityService } from "../services/accounting-integrity.js";
import { budgetService } from "../services/budgets.js";
import { createRunUsageRecorder } from "../services/usage-receipts.js";

describe("incomplete final usage receipts", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let spool: string;
  let companyId: string;
  let agentId: string;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("run-cost-incomplete-receipts-");
    db = createDb(database.connectionString);
    spool = await mkdtemp(path.join(os.tmpdir(), "paperclip-receipts-"));
  }, 30_000);
  afterAll(async () => { await database?.cleanup(); await rm(spool, { recursive: true, force: true }); });

  beforeEach(async () => {
    companyId = randomUUID();
    agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Accounting", issuePrefix: `A${companyId.slice(0, 4).toUpperCase()}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Claude", role: "engineer", adapterType: "acpx_local" });
  });

  async function policy(unpricedUsagePolicy: "block" | "allow" = "block") {
    await db.insert(budgetPolicies).values({ companyId, scopeType: "agent", scopeId: agentId, metric: "billed_cents",
      windowKind: "calendar_month_utc", amount: 2500, hardStopEnabled: true, isActive: true, unpricedUsagePolicy });
  }
  async function status() {
    return (await budgetService(db).overview(companyId)).policies[0]?.status;
  }
  /** A terminal run whose adapter went through the recorder and ended with an
   * incomplete receipt, exactly as ACPX Claude does on a timeout. */
  async function timedOutRun(input: { billingType: string; final: boolean; captureFailed?: boolean; finishedAt?: Date }) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", startedAt: new Date() });
    const recorder = await createRunUsageRecorder(db, { companyId, runId, adapterType: "acpx_local" }, spool);
    const receipt = { provider: "anthropic", model: "claude", billingType: input.billingType,
      usage: { inputTokens: 120, outputTokens: 30 }, costUsd: input.billingType === "subscription" ? null : 0.4, usageComplete: false };
    if (input.final) await recorder.complete(receipt as never);
    else await recorder.capture({ ...receipt, complete: false } as never);
    if (input.captureFailed) {
      const [row] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      await db.update(heartbeatRuns).set({ usageJson: { ...row.usageJson, accountingCaptureFailed: true } }).where(eq(heartbeatRuns.id, runId));
    }
    const finishedAt = input.finishedAt ?? new Date();
    const [row] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    await db.update(heartbeatRuns).set({ status: "timed_out", finishedAt, costAccountingPending: true,
      usageJson: { ...row.usageJson, accountingReceiptReady: false, ...(input.finishedAt ? { accountingReceiptReceivedAt: finishedAt.toISOString() } : {}) },
    }).where(eq(heartbeatRuns.id, runId));
    return runId;
  }
  const run = async (runId: string) => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0];
  const events = (runId: string) => db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, runId));
  const healthState = async (runId: string) =>
    (await accountingIntegrityService(db).health(companyId)).items.find(item => "runId" in item && item.runId === runId)?.state;

  it("(a) settles a final incomplete subscription receipt at zero and unblocks the budget", async () => {
    await policy();
    const runId = await timedOutRun({ billingType: "subscription", final: true });
    expect((await run(runId)).usageJson).toMatchObject({ accountingReceiptFinal: true, accountingReceiptReady: false });
    expect(await status()).toBe("hard_stop");
    expect(await healthState(runId)).toBe("retryable");

    expect(await accountRunCost(db, runId)).toBe(true);
    expect(await run(runId)).toMatchObject({ costAccountingPending: false });
    expect(await events(runId)).toEqual([expect.objectContaining({
      costCents: 0, costStatus: "estimated", billingType: "subscription_included", inputTokens: 120, outputTokens: 30 })]);
    expect(await status()).toBe("ok");
  });

  it("(b) settles a final incomplete metered receipt as unpriced, governed by the unpriced policy", async () => {
    await policy("block");
    const runId = await timedOutRun({ billingType: "api", final: true });
    expect(await reconcileRunCosts(db)).toMatchObject({ accounted: 1 });
    expect(await events(runId)).toEqual([expect.objectContaining({ costStatus: "unpriced", billingType: "metered_api", costCents: 40 })]);
    expect(await status()).toBe("hard_stop");

    await db.update(budgetPolicies).set({ unpricedUsagePolicy: "allow" }).where(eq(budgetPolicies.companyId, companyId));
    expect(await status()).toBe("ok");
  });

  it("(c) keeps a stopped run without its final receipt pending within the grace period", async () => {
    await policy();
    // Metered: a subscription run settles at once (no billable spend to wait for).
    const runId = await timedOutRun({ billingType: "api", final: false });
    expect((await run(runId)).usageJson).toMatchObject({ accountingReceiptFinal: false });

    expect(await accountRunCost(db, runId)).toBe(false);
    expect(await reconcileRunCosts(db)).toMatchObject({ scanned: 0, accounted: 0 });
    expect(await run(runId)).toMatchObject({ costAccountingPending: true, costAccountedAt: null });
    expect(await healthState(runId)).toBe("waiting_for_receipt");
    expect(await status()).toBe("hard_stop");
  });

  it("(d) settles a run left without its final receipt beyond the grace period", async () => {
    await policy();
    // Legacy shape: finalized before the final marker existed (e.g. run 8ccc9c1c).
    const runId = await timedOutRun({ billingType: "api", final: false,
      finishedAt: new Date(Date.now() - INCOMPLETE_RECEIPT_GRACE_MS - 60_000) });
    const [row] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    const { accountingReceiptFinal: _final, ...legacyUsage } = row.usageJson as Record<string, unknown>;
    await db.update(heartbeatRuns).set({ usageJson: legacyUsage }).where(eq(heartbeatRuns.id, runId));
    expect(await healthState(runId)).toBe("retryable");

    expect(await reconcileRunCosts(db)).toMatchObject({ accounted: 1 });
    expect(await events(runId)).toEqual([expect.objectContaining({ costCents: 40, costStatus: "unpriced", billingType: "metered_api" })]);
    expect(await status()).toBe("hard_stop");
  });

  it("(e) keeps a failed usage capture pending even after its final receipt and the grace period", async () => {
    await policy();
    const runId = await timedOutRun({ billingType: "subscription", final: true, captureFailed: true,
      finishedAt: new Date(Date.now() - INCOMPLETE_RECEIPT_GRACE_MS - 60_000) });

    expect(await accountRunCost(db, runId)).toBe(false);
    expect(await reconcileRunCosts(db)).toMatchObject({ scanned: 0 });
    expect(await run(runId)).toMatchObject({ costAccountingPending: true, costAccountedAt: null });
    expect(await healthState(runId)).toBe("waiting_for_receipt");
    expect(await events(runId)).toEqual([]);
    expect(await status()).toBe("hard_stop");
  });
});

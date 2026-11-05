import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { heartbeatService } from "./heartbeat.js";
import { HOST_SUSPENDED_ERROR_CODE, hasLiveLegacyController, isHostSuspendedLeaseLoss, legacyControllerBootId, legacyControllerClaim,
  LEGACY_CONTROLLER_LEASE_MS, LEGACY_CONTROLLER_RENEW_MS, reclaimSuspendedLegacyController,
  renewLegacyControllerLease, revokeExpiredLegacyController, watchLegacyControllerLease } from "./legacy-controller-lease.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("durable legacy controller ownership", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("legacy-controller-");
    db = createDb(database.connectionString);
  }, 30000);
  afterAll(async () => { await database?.cleanup(); });
  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Controller test", issuePrefix: `C${companyId.slice(0, 7)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Agent", role: "general", adapterType: "claude_local", status: "idle" });
    const [queued] = await db.insert(heartbeatRuns).values({ companyId, agentId }).returning();
    const [run] = await db.update(heartbeatRuns).set({ status: "running", ...legacyControllerClaim("legacy") })
      .where(eq(heartbeatRuns.id, queued.id)).returning();
    return run;
  }
  async function expire(id: string) {
    await db.update(heartbeatRuns).set({ controllerLeaseExpiresAt: sql`clock_timestamp() - interval '1 second'` })
      .where(eq(heartbeatRuns.id, id));
  }
  it("commits ownership with the queued claim before provisioning or logs exist", async () => {
    const run = await seed();
    expect(run).toMatchObject({ status: "running", controllerBootId: legacyControllerBootId, executionStage: "preparing", processPid: null });
    expect(await hasLiveLegacyController(db, run)).toBe(true);
    expect(await revokeExpiredLegacyController(db, run)).toBe(false);
  });
  it("another deployment's startup reaper preserves an unexpired controller", async () => {
    const run = await seed();
    await db.update(heartbeatRuns).set({ controllerBootId: randomUUID() }).where(eq(heartbeatRuns.id, run.id));
    await heartbeatService(db).reapOrphanedRuns({ staleThresholdMs: 0 });
    const [saved] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    expect(saved.status).toBe("running");
    expect(saved.errorCode).toBeNull();
  });
  it.each([false, true])("shutdown preserves a foreign controller (expired: %s)", async expired => {
    const run = await seed();
    await db.update(heartbeatRuns).set({ controllerBootId: randomUUID() }).where(eq(heartbeatRuns.id, run.id));
    if (expired) await expire(run.id);
    const result = await heartbeatService(db).drainRunningRunsForShutdown("SIGTERM", new Date(), [run.id]);
    expect(result.interruptedRunIds).toEqual([]);
    const [saved] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    expect(saved.status).toBe("running");
  });
  it("a current controller renews and records the dispatch boundary", async () => {
    const run = await seed();
    expect(await renewLegacyControllerLease(db, run, "dispatching")).toBe(true);
    const [saved] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    expect(saved.executionStage).toBe("dispatching");
    expect(await revokeExpiredLegacyController(db, run)).toBe(false);
  });
  it("an expired controller cannot renew or dispatch even before a reaper claims it", async () => {
    const run = await seed();
    await expire(run.id);
    expect(await renewLegacyControllerLease(db, run, "dispatching")).toBe(false);
    const controller = new AbortController();
    const watch = watchLegacyControllerLease(db, run, controller);
    try {
      await expect(watch.assertOwned("dispatching")).rejects.toThrow("lease lost");
      expect(controller.signal.aborted).toBe(true);
    } finally { watch.stop(); }
  });
  it("only one competing recovery revokes the observed expired owner", async () => {
    const run = await seed();
    await expire(run.id);
    const attempts = await Promise.all([revokeExpiredLegacyController(db, run), revokeExpiredLegacyController(db, run)]);
    expect(attempts.filter(Boolean)).toHaveLength(1);
    expect(await renewLegacyControllerLease(db, run)).toBe(false);
  });
  it("a crash after revocation permits a later recovery claim", async () => {
    const run = await seed();
    await expire(run.id);
    expect(await revokeExpiredLegacyController(db, run)).toBe(true);
    const [claimed] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    expect(await hasLiveLegacyController(db, claimed)).toBe(true);
    expect(await revokeExpiredLegacyController(db, claimed)).toBe(false);
    await expire(run.id);
    const [saved] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    expect(await revokeExpiredLegacyController(db, saved)).toBe(true);
  });
  it("rejects foreign company renewal and revocation", async () => {
    const run = await seed();
    expect(await renewLegacyControllerLease(db, { ...run, companyId: randomUUID() })).toBe(false);
    await expire(run.id);
    expect(await revokeExpiredLegacyController(db, { ...run, companyId: randomUUID() })).toBe(false);
  });
  it("never turns a terminal run back into owned execution", async () => {
    const run = await seed();
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, run.id));
    expect(await renewLegacyControllerLease(db, run)).toBe(false);
    expect(await revokeExpiredLegacyController(db, run)).toBe(false);
  });
  it("rejects dispatch at the lease deadline even if the database query never settles", async () => {
    const run = await seed();
    const hungDb = { update: () => ({ set: () => ({ where: () => ({ returning: () => new Promise(() => {}) }) }) }) } as unknown as typeof db;
    vi.useFakeTimers();
    const controller = new AbortController();
    const watch = watchLegacyControllerLease(hungDb, { ...run, controllerLeaseExpiresAt: new Date(Date.now() + 100) }, controller);
    try {
      const checked = expect(watch.assertOwned("dispatching")).rejects.toThrow("lease lost");
      await vi.advanceTimersByTimeAsync(101);
      await checked;
      expect(controller.signal.aborted).toBe(true);
      // The event loop kept running: a stalled database is not a host suspension.
      expect(isHostSuspendedLeaseLoss(controller.signal.reason)).toBe(false);
    } finally { watch.stop(); vi.useRealTimers(); }
  });

  // The renewal is refused (the lease expired or another boot owns the row).
  const refusingDb = { update: () => ({ set: () => ({ where: () => ({ returning: async () => [] }) }) }) } as unknown as ReturnType<typeof createDb>;
  it("classifies a lease lost across a host suspension as recoverable", async () => {
    const run = await seed();
    vi.useFakeTimers();
    const controller = new AbortController();
    const watch = watchLegacyControllerLease(refusingDb, run, controller);
    try {
      // The host sleeps: wall-clock time jumps past the lease, no tick ran.
      vi.setSystemTime(Date.now() + LEGACY_CONTROLLER_LEASE_MS + 60_000);
      await vi.advanceTimersByTimeAsync(LEGACY_CONTROLLER_RENEW_MS);
      expect(controller.signal.aborted).toBe(true);
      expect(isHostSuspendedLeaseLoss(controller.signal.reason)).toBe(true);
      expect(controller.signal.reason).toMatchObject({ code: HOST_SUSPENDED_ERROR_CODE, message: expect.stringContaining("lease lost") });
    } finally { watch.stop(); vi.useRealTimers(); }
  });
  it("keeps a lease lost while the host stayed awake non-recoverable", async () => {
    const run = await seed();
    vi.useFakeTimers();
    const controller = new AbortController();
    const watch = watchLegacyControllerLease(refusingDb, run, controller);
    try {
      await vi.advanceTimersByTimeAsync(LEGACY_CONTROLLER_RENEW_MS);
      expect(controller.signal.aborted).toBe(true);
      expect(controller.signal.reason).toMatchObject({ message: "Legacy controller lease lost", code: null });
      expect(isHostSuspendedLeaseLoss(controller.signal.reason)).toBe(false);
    } finally { watch.stop(); vi.useRealTimers(); }
  });
  it("reclaims an expired lease only while this boot still owns the row", async () => {
    const run = await seed();
    await expire(run.id);
    expect(await reclaimSuspendedLegacyController(db, run)).toBe(true);
    expect(await hasLiveLegacyController(db, run)).toBe(true);
    expect(await revokeExpiredLegacyController(db, run)).toBe(false);

    // Another controller revoked the expired lease first: no concurrent requeue.
    const foreign = await seed();
    await expire(foreign.id);
    expect(await revokeExpiredLegacyController(db, foreign)).toBe(true);
    expect(await reclaimSuspendedLegacyController(db, foreign)).toBe(false);

    const terminal = await seed();
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, terminal.id));
    expect(await reclaimSuspendedLegacyController(db, terminal)).toBe(false);
    expect(await reclaimSuspendedLegacyController(db, { ...run, companyId: randomUUID() })).toBe(false);
  });

  it("leaves native controller ownership to the native coordinator", () => {
    expect(legacyControllerClaim("native")).toEqual({});
  });
});

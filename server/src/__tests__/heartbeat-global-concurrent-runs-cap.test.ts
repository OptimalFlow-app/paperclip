import { randomUUID } from "node:crypto";
import { inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  instanceSettings,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { instanceSettingsService } from "../services/instance-settings.ts";
import { runningProcesses } from "../adapters/index.ts";

// Each adapter execution blocks until the test releases its run, so the test
// controls exactly when a slot frees up.
const adapterGate = vi.hoisted(() => {
  const releases = new Map<string, () => void>();
  const started: string[] = [];
  return {
    releases,
    started,
    // Teardown: let every execution, including newly promoted ones, finish.
    autoRelease: false,
    release(runId: string) {
      const release = releases.get(runId);
      if (!release) throw new Error(`run ${runId} has not started`);
      releases.delete(runId);
      release();
    },
    releaseAll() {
      for (const runId of [...releases.keys()]) this.release(runId);
    },
    reset() {
      releases.clear();
      started.length = 0;
      this.autoRelease = false;
    },
  };
});

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async (ctx: { runId: string }) => {
    adapterGate.started.push(ctx.runId);
    if (!adapterGate.autoRelease) {
      await new Promise<void>((resolve) => adapterGate.releases.set(ctx.runId, resolve));
    }
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      summary: "Global concurrent-run cap test run.",
      provider: "test",
      model: "test-model",
    };
  }),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres global concurrent-run cap tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat instance-wide concurrent-run cap", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const services: Array<ReturnType<typeof heartbeatService>> = [];

  function newHeartbeat(runtimeEnv: Record<string, string | undefined> = {}) {
    const { PAPERCLIP_MAX_CONCURRENT_RUNS: _ignored, ...baseEnv } = process.env;
    const heartbeat = heartbeatService(db, { runtimeEnv: { ...baseEnv, ...runtimeEnv } });
    services.push(heartbeat);
    return heartbeat;
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-global-concurrent-runs-cap-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    adapterGate.autoRelease = true;
    adapterGate.releaseAll();
    for (const heartbeat of services) await heartbeat.drainActiveRunExecutions();
    services.length = 0;
    adapterGate.reset();
    mockAdapterExecute.mockClear();
    runningProcesses.clear();
    await db.execute(sql`truncate table ${companies} cascade`);
    await db.delete(instanceSettings);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function insertAgent(name: string) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `${name} Co`,
      status: "active",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name,
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          enabled: true,
          intervalSec: 60,
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });
    return { companyId, agentId };
  }

  // A manual wake from a user: claimable without any issue or membership setup.
  async function insertQueuedRun(owner: { companyId: string; agentId: string }, createdAt: Date) {
    const wakeupRequestId = randomUUID();
    const runId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId: owner.companyId,
      agentId: owner.agentId,
      source: "on_demand",
      triggerDetail: "manual",
      status: "queued",
      runId,
      requestedByActorType: "user",
      requestedByActorId: "board-user",
      payload: { manualUserWake: true },
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: owner.companyId,
      agentId: owner.agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "queued",
      wakeupRequestId,
      createdAt,
    });
    return runId;
  }

  async function statuses(runIds: string[]) {
    const rows = await db
      .select({ id: heartbeatRuns.id, status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns)
      .where(inArray(heartbeatRuns.id, runIds));
    const byId = new Map(rows.map((row) => [row.id, row]));
    return runIds.map((id) => byId.get(id)!);
  }

  async function countRunning() {
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(heartbeatRuns)
      .where(sql`${heartbeatRuns.status} = 'running'`);
    return Number(count);
  }

  async function waitForStarted(count: number) {
    await vi.waitFor(() => expect(adapterGate.started.length).toBeGreaterThanOrEqual(count), {
      timeout: 15_000,
      interval: 20,
    });
  }

  // Let any in-flight promotion settle, so "still queued" assertions are not
  // racing a claim that is about to happen.
  async function settle() {
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  const at = (offsetSec: number) => new Date(Date.UTC(2026, 9, 29, 10, 0, offsetSec));

  it("defaults to 3 and persists the general setting", async () => {
    const settings = instanceSettingsService(db, { runtimeEnv: {} });
    expect((await settings.getGeneral()).maxConcurrentRuns).toBe(3);
    await settings.updateGeneral({ maxConcurrentRuns: 2 });
    expect((await settings.getGeneral()).maxConcurrentRuns).toBe(2);
    // Unrelated writes keep the stored cap.
    await settings.updateGeneral({ censorUsernameInLogs: true });
    expect((await settings.getGeneral()).maxConcurrentRuns).toBe(2);
  });

  it("caps runs across agents at N and promotes the queued run of another agent when one finishes", async () => {
    await instanceSettingsService(db, { runtimeEnv: {} }).updateGeneral({ maxConcurrentRuns: 2 });
    const heartbeat = newHeartbeat();
    const a = await insertAgent("Agent A");
    const b = await insertAgent("Agent B");
    const c = await insertAgent("Agent C");
    const runA = await insertQueuedRun(a, at(0));
    const runB = await insertQueuedRun(b, at(1));
    const runC = await insertQueuedRun(c, at(2));

    await heartbeat.resumeQueuedRuns();
    await waitForStarted(2);
    await settle();

    expect(await statuses([runA, runB, runC])).toMatchObject([
      { status: "running" },
      { status: "running" },
      { status: "queued", errorCode: null },
    ]);
    // Both claims happen in createdAt order; their executions then run concurrently.
    expect([...adapterGate.started].sort()).toEqual([runA, runB].sort());

    adapterGate.release(runA);
    await waitForStarted(3);

    expect(adapterGate.started[2]).toBe(runC);
    await vi.waitFor(async () => {
      expect(await statuses([runA, runB, runC])).toMatchObject([
        { status: "succeeded" },
        { status: "running" },
        { status: "running" },
      ]);
    }, { timeout: 15_000, interval: 20 });
    expect(await countRunning()).toBe(2);
  });

  it("gives a freed slot to the oldest queued run in the instance, not to the agent that finished", async () => {
    await instanceSettingsService(db, { runtimeEnv: {} }).updateGeneral({ maxConcurrentRuns: 1 });
    const heartbeat = newHeartbeat();
    const a = await insertAgent("Agent A");
    const b = await insertAgent("Agent B");
    const c = await insertAgent("Agent C");
    const firstA = await insertQueuedRun(a, at(0));
    // Inserted before C's run but created later: order must come from createdAt.
    const runB = await insertQueuedRun(b, at(20));
    const runC = await insertQueuedRun(c, at(10));
    const secondA = await insertQueuedRun(a, at(30));

    await heartbeat.resumeQueuedRuns();
    await waitForStarted(1);
    await settle();
    expect(adapterGate.started).toEqual([firstA]);
    expect(await countRunning()).toBe(1);

    adapterGate.release(firstA);
    await waitForStarted(2);
    await settle();
    // Agent A finished, but C's queued run is older than A's second run.
    expect(adapterGate.started[1]).toBe(runC);

    adapterGate.release(runC);
    await waitForStarted(3);
    await settle();
    expect(adapterGate.started[2]).toBe(runB);

    adapterGate.release(runB);
    await waitForStarted(4);
    expect(adapterGate.started[3]).toBe(secondA);
    expect(await countRunning()).toBe(1);
  });

  it("keeps capped runs queued across a restart and starts them within the cap; the env var wins", async () => {
    // Stored cap 5, env override 2: the override must win.
    await instanceSettingsService(db, { runtimeEnv: {} }).updateGeneral({ maxConcurrentRuns: 5 });
    const owners = await Promise.all(["A", "B", "C", "D"].map((name) => insertAgent(`Agent ${name}`)));
    const runIds = await Promise.all(owners.map((owner, index) => insertQueuedRun(owner, at(index))));

    // Fresh service, as after a server restart: only the database knows the queue.
    const restarted = newHeartbeat({ PAPERCLIP_MAX_CONCURRENT_RUNS: "2" });
    await restarted.resumeQueuedRuns();
    await waitForStarted(2);
    await settle();

    expect(await statuses(runIds)).toMatchObject([
      { status: "running" },
      { status: "running" },
      { status: "queued", errorCode: null },
      { status: "queued", errorCode: null },
    ]);

    // A second recovery pass (scheduler tick) neither cancels nor overshoots.
    await restarted.resumeQueuedRuns();
    await settle();
    expect(await countRunning()).toBe(2);
    expect((await statuses(runIds)).filter((row) => row.status === "cancelled")).toEqual([]);

    // Every capped run eventually starts, never more than 2 at once.
    for (let finished = 0; finished < runIds.length; finished += 1) {
      await waitForStarted(Math.min(finished + 2, runIds.length));
      expect(await countRunning()).toBeLessThanOrEqual(2);
      adapterGate.release(adapterGate.started[finished]!);
    }
    await vi.waitFor(async () => {
      expect((await statuses(runIds)).map((row) => row.status)).toEqual([
        "succeeded",
        "succeeded",
        "succeeded",
        "succeeded",
      ]);
    }, { timeout: 15_000, interval: 20 });
  });

  it("does not overshoot the cap when several services claim at the same time", async () => {
    const owners = await Promise.all(
      ["A", "B", "C", "D", "E", "F"].map((name) => insertAgent(`Agent ${name}`)),
    );
    const runIds = await Promise.all(owners.map((owner, index) => insertQueuedRun(owner, at(index))));
    const env = { PAPERCLIP_MAX_CONCURRENT_RUNS: "2" };
    const first = newHeartbeat(env);
    const second = newHeartbeat(env);
    const third = newHeartbeat(env);

    await Promise.all([
      first.resumeQueuedRuns(),
      second.resumeQueuedRuns(),
      third.resumeQueuedRuns(),
    ]);
    await waitForStarted(2);
    await settle();

    expect(await countRunning()).toBe(2);
    expect(adapterGate.started).toHaveLength(2);
    expect((await statuses(runIds)).filter((row) => row.status === "queued")).toHaveLength(4);
  });
});

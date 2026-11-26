import { assert, describe, it } from "@effect/vitest";
import {
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ServerCommand,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  UsageLimitSourceId,
  type UsageLimitsReport,
  type UsageLimitSourceSnapshot,
  type UsageThresholdPauseSettings,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as UsageLimitSources from "../usage/UsageLimitSources.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as UsageThresholdPauseWorker from "./UsageThresholdPauseWorker.ts";
import {
  resumeAtByDriver,
  thresholdCrossings,
  usageReadings,
} from "./UsageThresholdPauseWorker.ts";
import { runUsagePauseScript, type ScriptRun } from "./usagePauseScript.ts";

const settings = (
  overrides: Partial<UsageThresholdPauseSettings> = {},
): UsageThresholdPauseSettings => ({
  enabled: true,
  remainingPercent: 20,
  windowKinds: ["session"],
  aggregation: "pooled",
  drivers: [],
  accountIds: [],
  mode: "rules",
  script: "",
  ...overrides,
});

const claude = ProviderDriverKind.make("claudeAgent");
const codex = ProviderDriverKind.make("codex");

const account = (
  id: string,
  driver: ProviderDriverKind,
  windows: ReadonlyArray<{ kind: "session" | "weekly"; usedPercent: number; resetsAt?: string }>,
): UsageLimitsReport["accounts"][number] => ({
  id,
  driver,
  label: id,
  limits: {
    checkedAt: "2026-11-16T10:00:00.000Z",
    windows: windows.map((window) => ({
      id: window.kind === "session" ? "five_hour" : "seven_day",
      label: window.kind === "session" ? "5h" : "Weekly",
      ...window,
    })),
  },
});

const report = (...accounts: ReadonlyArray<UsageLimitsReport["accounts"][number]>) => ({
  createdAt: "2026-11-16T10:00:00.000Z",
  accounts,
  notices: [],
});

describe("usageReadings", () => {
  it("pools a provider's accounts by mean remaining and earliest reset", () => {
    const readings = usageReadings(settings(), [
      report(
        account("a", claude, [
          { kind: "session", usedPercent: 90, resetsAt: "2026-11-16T12:00:00Z" },
        ]),
        account("b", claude, [
          { kind: "session", usedPercent: 50, resetsAt: "2026-11-16T11:00:00Z" },
        ]),
        account("c", claude, [{ kind: "weekly", usedPercent: 99 }]),
      ),
    ]);
    assert.deepStrictEqual(
      readings.map(({ remainingPercent, resetsAt }) => ({ remainingPercent, resetsAt })),
      [{ remainingPercent: 30, resetsAt: "2026-11-16T11:00:00Z" }],
    );
  });

  it("reads each account alone and honours the provider and account scope", () => {
    const reports = [
      report(
        account("a", claude, [{ kind: "session", usedPercent: 90 }]),
        account("b", claude, [{ kind: "session", usedPercent: 50 }]),
      ),
      report(account("x", codex, [{ kind: "session", usedPercent: 95 }])),
    ];
    const perAccount = usageReadings(settings({ aggregation: "perAccount" }), reports);
    assert.deepStrictEqual(
      perAccount.map((reading) => reading.remainingPercent),
      [10, 50, 5],
    );
    const scoped = usageReadings(
      settings({ aggregation: "perAccount", drivers: [claude], accountIds: ["b"] }),
      reports,
    );
    assert.deepStrictEqual(
      scoped.map((reading) => reading.key),
      ["b:five_hour"],
    );
  });
});

describe("thresholdCrossings", () => {
  it("fires once when a reading falls from above the threshold, never when first seen below", () => {
    const armed = new Map<string, boolean>();
    const reading = (key: string, remainingPercent: number) => ({
      key,
      driver: claude,
      label: "5h",
      remainingPercent,
      resetsAt: null,
    });
    // `late` is first seen below the threshold, like after a restart: work started now must run.
    assert.lengthOf(thresholdCrossings([reading("early", 40), reading("late", 10)], 20, armed), 0);
    assert.deepStrictEqual(
      thresholdCrossings([reading("early", 20), reading("late", 5)], 20, armed).map((r) => r.key),
      ["early"],
    );
    assert.lengthOf(thresholdCrossings([reading("early", 10)], 20, armed), 0);
    // A reset above the threshold re-arms it.
    assert.lengthOf(thresholdCrossings([reading("early", 100)], 20, armed), 0);
    assert.lengthOf(thresholdCrossings([reading("early", 15)], 20, armed), 1);
  });
});

describe("resumeAtByDriver", () => {
  it("continues after the latest crossed reset, and never when one is unknown", () => {
    const crossing = (resetsAt: string | null) => ({
      key: resetsAt ?? "none",
      driver: claude,
      label: "5h",
      remainingPercent: 10,
      resetsAt,
    });
    assert.equal(
      resumeAtByDriver([crossing("2026-11-16T11:00:00Z"), crossing("2026-11-20T00:00:00Z")]).get(
        claude,
      )?.resumeAt,
      "2026-11-20T00:00:00Z",
    );
    assert.isNull(
      resumeAtByDriver([crossing("2026-11-16T11:00:00Z"), crossing(null)]).get(claude)?.resumeAt,
    );
  });
});

describe("runUsagePauseScript", () => {
  const run = (runId: string, provider: string): ScriptRun => ({
    runId,
    threadId: `thread:${runId}`,
    title: runId,
    projectId: "project",
    project: "Project",
    workspaceRoot: "/repo",
    provider,
    providerInstanceId: provider,
    model: "model",
    delegated: false,
    parentThreadId: null,
    startedAt: "2026-11-16T10:00:00.000Z",
    runningMinutes: 5,
  });
  const input = {
    usage: [
      {
        provider: "claudeAgent",
        accountId: "a",
        account: "a",
        kind: "weekly",
        window: "Weekly",
        windowId: "seven_day",
        remainingPercent: 10,
        usedPercent: 90,
        resetsAt: "2026-11-20T00:00:00.000Z",
        priority: 2,
      },
    ],
    runs: [run("one", "claudeAgent"), run("two", "codex")],
    nowMs: Date.parse("2026-11-16T10:05:00.000Z"),
  };

  it("returns the chosen runs and keeps state between calls", () => {
    const script = `
      state.calls = (state.calls ?? 0) + 1;
      const low = usage.filter((w) => w.remainingPercent <= 20).map((w) => w.provider);
      return runs
        .filter((r) => low.includes(r.provider))
        .map((r) => ({ runId: r.runId, resumeAt: state.calls > 1 ? null : new Date(now.getTime() + 60000) }));
    `;
    const first = runUsagePauseScript(script, input, "{}");
    assert.deepEqual(first.stops, [{ runId: "one", resumeAt: "2026-11-16T10:06:00.000Z" }]);
    const second = runUsagePauseScript(script, input, first.stateJson);
    assert.deepEqual(second.stops, [{ runId: "one", resumeAt: null }]);
    assert.deepEqual(JSON.parse(second.stateJson), { calls: 2 });
  });

  it("reports the last priority per account and the shortest re-check", () => {
    const decided = runUsagePauseScript(
      `setPriority("a", 2); setPriority("a", 0); setPriority("b", 1);
       checkAgainIn(120); checkAgainIn(75); checkAgainIn("soon");`,
      input,
      "{}",
    );
    assert.deepEqual(decided.priorities, [
      { accountId: "a", priority: 0 },
      { accountId: "b", priority: 1 },
    ]);
    assert.equal(decided.checkAgainInSeconds, 75);
    assert.throws(
      () => runUsagePauseScript(`setPriority("a", 1.5)`, input, "{}"),
      "Expected an integer",
    );
  });

  it("fails on errors, endless loops, bad results and eval", () => {
    for (const [script, message] of [
      ["throw new Error('nope')", "nope"],
      ["while (true) {}", "timed out"],
      ["return 'one'", "Return an array"],
      ["return [{ runId: 'one', resumeAt: 'soon' }]", "resumeAt is not a time"],
      ["return eval('runs')", "Code generation from strings disallowed"],
    ] as const) {
      assert.throws(() => runUsagePauseScript(script, input, "{}"), message);
    }
  });

  it("sees no host globals", () => {
    const script =
      "return typeof process === 'undefined' && typeof require === 'undefined' ? [] : runs";
    assert.deepEqual(runUsagePauseScript(script, input, "{}").stops, []);
  });
});

it.effect("stops the crossed provider's running threads and continues them at reset", () =>
  Effect.gen(function* () {
    const startMs = Date.parse("2026-11-16T10:00:00.000Z");
    const resetAt = "2026-11-16T11:00:00.000Z";
    yield* TestClock.setTime(startMs);
    const usedPercent = yield* Ref.make(70);
    const paused = yield* Ref.make<
      ReadonlyArray<{
        threadId: ThreadId;
        usagePause: { runId: RunId; resumeAt: string | null };
      }>
    >([]);
    const dispatched = yield* Queue.unbounded<OrchestrationV2ServerCommand>();
    const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
    const hub = (used: number): UsageLimitSourceSnapshot => ({
      id: UsageLimitSourceId.make("hub"),
      kind: "cliproxy",
      label: "Hub",
      checkedAt: "2026-11-16T10:00:00.000Z",
      accounts: [
        {
          id: "claude-1.json",
          driver: claude,
          usageLimits: {
            checkedAt: "2026-11-16T10:00:00.000Z",
            windows: [
              {
                id: "five_hour",
                kind: "session",
                label: "5h",
                usedPercent: used,
                resetsAt: resetAt,
              },
            ],
          },
        },
      ],
    });
    const layer = UsageThresholdPauseWorker.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Scheduler.layer,
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            listLiveRuns: () =>
              Effect.succeed(
                (
                  [
                    ["claude", null],
                    ["codex", null],
                    ["omp", "anthropic/claude-opus-5-5"],
                  ] as const
                ).map(([name, model]) => ({
                  threadId: ThreadId.make(`thread:${name}`),
                  runId: RunId.make(`run:${name}`),
                  providerInstanceId: ProviderInstanceId.make(name),
                  title: name,
                  projectId: "project",
                  projectTitle: null,
                  workspaceRoot: null,
                  model,
                  parentThreadId: null,
                  startedAt: "2026-11-16T10:00:00.000Z",
                })),
              ),
            listUsagePausedThreads: () => Ref.get(paused),
          }),
          Layer.mock(ThreadManagement.ThreadManagementService)({
            dispatch: (command) => Queue.offer(dispatched, command).pipe(Effect.as({} as never)),
          }),
          Layer.mock(Orchestrator.OrchestratorV2)({ streamDomainEvents: Stream.fromQueue(events) }),
          Layer.mock(ServerSettings.ServerSettingsService)({
            getSettings: Effect.succeed({ usageThresholdPause: settings() } as never),
          }),
          Layer.mock(ProviderRegistry.ProviderRegistry)({
            getProviders: Effect.succeed([
              { instanceId: "claude", driver: claude, enabled: false } as never,
              { instanceId: "codex", driver: codex, enabled: false } as never,
              {
                instanceId: "omp",
                driver: ProviderDriverKind.make("acpRegistry"),
                enabled: false,
              } as never,
            ]),
          }),
          Layer.mock(UsageLimitSources.UsageLimitSources)({
            current: Ref.get(usedPercent).pipe(Effect.map((used) => [hub(used)])),
          }),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      yield* TestClock.adjust("5 seconds");
      yield* Ref.set(usedPercent, 85);
      yield* TestClock.adjust("5 seconds");
      const pause = yield* Queue.take(dispatched);
      const stop = yield* Queue.take(dispatched);
      assert.deepInclude(pause, {
        type: "thread.metadata.update",
        threadId: ThreadId.make("thread:claude"),
        usagePause: { runId: RunId.make("run:claude"), resumeAt: resetAt },
      });
      assert.deepInclude(stop, { type: "thread.stop", threadId: ThreadId.make("thread:claude") });
      // An ACP agent reports no usage of its own; its "anthropic/" model draws on Claude's.
      assert.deepInclude(yield* Queue.take(dispatched), {
        type: "thread.metadata.update",
        threadId: ThreadId.make("thread:omp"),
      });
      assert.deepInclude(yield* Queue.take(dispatched), {
        type: "thread.stop",
        threadId: ThreadId.make("thread:omp"),
      });
      // Still below the threshold: nothing more is stopped, so work the user starts now runs.
      yield* TestClock.adjust("30 seconds");
      assert.equal(yield* Queue.size(dispatched), 0);

      yield* Ref.set(paused, [
        {
          threadId: ThreadId.make("thread:claude"),
          usagePause: { runId: RunId.make("run:claude"), resumeAt: resetAt },
        },
      ]);
      yield* Queue.offer(events, { type: "thread.metadata-updated" } as never);
      yield* TestClock.adjust("5 seconds");
      assert.equal(yield* Queue.size(dispatched), 0);
      yield* TestClock.setTime(Date.parse(resetAt) + 5_000);
      const continued = yield* Queue.take(dispatched);
      assert.deepInclude(continued, {
        type: "message.dispatch",
        threadId: ThreadId.make("thread:claude"),
        manualContinuationOfRunId: RunId.make("run:claude"),
      });
      assert.equal((yield* Queue.take(dispatched)).type, "queue.resume");
      assert.deepInclude(yield* Queue.take(dispatched), {
        type: "thread.metadata.update",
        usagePause: null,
      });
    }).pipe(Effect.provide(layer));
  }),
);

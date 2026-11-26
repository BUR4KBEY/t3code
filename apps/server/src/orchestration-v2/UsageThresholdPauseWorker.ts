import {
  CommandId,
  MessageId,
  type ProviderDriverKind,
  type RunId,
  type ServerProvider,
  type ThreadId,
  type UsageLimitSourceSnapshot,
  type UsageLimitsReport,
  type UsageThresholdPauseSettings,
} from "@t3tools/contracts";
import { collectDriverUsageLimits } from "@t3tools/shared/usageLimits";
import { limitsNotice } from "@t3tools/shared/usageLimitsCopy";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as DueHint from "../scheduling/DueHint.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as UsageLimitSources from "../usage/UsageLimitSources.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import {
  hubAccountKey,
  runUsagePauseScript,
  scriptUsage,
  type ScriptUsageWindow,
} from "./usagePauseScript.ts";

/** Floor between hub re-reads a script asks for; the usage endpoint answers 429 when hit often. */
const HUB_READ_FLOOR_MS = 75_000;

export interface UsageReading {
  readonly key: string;
  readonly driver: ProviderDriverKind;
  readonly label: string;
  readonly remainingPercent: number;
  readonly resetsAt: string | null;
}

/** One reading per account window, or per pooled window of a provider's accounts. */
export function usageReadings(
  settings: UsageThresholdPauseSettings,
  reports: ReadonlyArray<UsageLimitsReport>,
): ReadonlyArray<UsageReading> {
  const members = new Map<string, Array<UsageReading>>();
  for (const account of reports.flatMap((report) => report.accounts)) {
    if (settings.drivers.length > 0 && !settings.drivers.includes(account.driver)) continue;
    if (settings.accountIds.length > 0 && !settings.accountIds.includes(account.id)) continue;
    if (limitsNotice(account.limits) !== null) continue;
    for (const window of account.limits.windows) {
      if (!settings.windowKinds.includes(window.kind)) continue;
      const reading = {
        driver: account.driver,
        label: window.label,
        remainingPercent: 100 - Math.max(0, Math.min(100, window.usedPercent)),
        resetsAt: window.resetsAt ?? null,
      };
      // Codex window ids name slots, so its accounts pool by kind, as the Usage page does.
      const key =
        settings.aggregation === "perAccount"
          ? `${account.id}:${window.id}`
          : `${account.driver}:${window.kind}:${account.driver === "codex" ? "" : window.id}`;
      members.set(key, [...(members.get(key) ?? []), { key, ...reading }]);
    }
  }
  return [...members].map(([key, group]) => ({
    key,
    driver: group[0]!.driver,
    label: group[0]!.label,
    remainingPercent: group.reduce((sum, m) => sum + m.remainingPercent, 0) / group.length,
    // The pool regains capacity at its first member's reset.
    resetsAt: group.reduce<string | null>(
      (at, m) =>
        at === null || (m.resetsAt !== null && Date.parse(m.resetsAt) < Date.parse(at))
          ? m.resetsAt
          : at,
      null,
    ),
  }));
}

/**
 * Readings that fell to the threshold since they were last seen above it. A window first seen
 * below it, as after a restart or enabling the setting, never fires, so work the user starts
 * below the threshold keeps running.
 */
export function thresholdCrossings(
  readings: ReadonlyArray<UsageReading>,
  remainingPercent: number,
  armed: Map<string, boolean>,
): ReadonlyArray<UsageReading> {
  const crossed: Array<UsageReading> = [];
  for (const reading of readings) {
    const below = reading.remainingPercent <= remainingPercent;
    if (below && armed.get(reading.key) === true) crossed.push(reading);
    armed.set(reading.key, !below);
  }
  return crossed;
}

/** Continue after the latest reset among a provider's crossed windows, or never if none is known. */
export function resumeAtByDriver(
  crossings: ReadonlyArray<UsageReading>,
): ReadonlyMap<ProviderDriverKind, UsageReading & { readonly resumeAt: string | null }> {
  const byDriver = new Map<
    ProviderDriverKind,
    UsageReading & { readonly resumeAt: string | null }
  >();
  for (const crossing of crossings) {
    const previous = byDriver.get(crossing.driver);
    const resumeAt =
      previous === undefined
        ? crossing.resetsAt
        : previous.resumeAt === null || crossing.resetsAt === null
          ? null
          : Date.parse(previous.resumeAt) >= Date.parse(crossing.resetsAt)
            ? previous.resumeAt
            : crossing.resetsAt;
    const lowest =
      previous === undefined || crossing.remainingPercent < previous.remainingPercent
        ? crossing
        : previous;
    byDriver.set(crossing.driver, { ...lowest, resumeAt });
  }
  return byDriver;
}

/** The reset of the provider's tightest window, which is what most likely made the script stop. */
function defaultResumeAt(
  usage: ReadonlyArray<ScriptUsageWindow>,
  driver: ProviderDriverKind | undefined,
): string | null {
  let tightest: ScriptUsageWindow | undefined;
  for (const window of usage) {
    if (window.provider !== driver) continue;
    if (tightest === undefined || window.remainingPercent < tightest.remainingPercent) {
      tightest = window;
    }
  }
  return tightest?.resetsAt ?? null;
}

const makeSweep = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const settings = yield* ServerSettings.ServerSettingsService;
  const registry = yield* ProviderRegistry.ProviderRegistry;
  const hubs = yield* UsageLimitSources.UsageLimitSources;
  const armed = new Map<string, boolean>();
  let script = { source: "", stateJson: "{}", lastError: null as string | null };
  let lastHubReadMs = -Infinity;
  // Requested account=priority → when last tried, so a failing PATCH is not retried every tick.
  const priorityAttempts = new Map<string, number>();
  const warnedAccounts = new Set<string>();
  const due = DueHint.make();
  yield* forkParked(
    Stream.runForEach(orchestrator.streamDomainEvents, (event) =>
      event.type === "thread.metadata-updated" ? due.invalidate : Effect.void,
    ),
  );

  const dispatchLogged = (label: string, command: Parameters<typeof threads.dispatch>[0]) =>
    threads.dispatch(command).pipe(
      Effect.as(true),
      Effect.catchCause((cause) =>
        Effect.logWarning(`orchestration-v2.usage-threshold.${label}-failed`, {
          commandId: command.commandId,
          cause,
        }).pipe(Effect.as(false)),
      ),
    );

  const stopRun = Effect.fn("UsageThresholdPauseWorker.stopRun")(function* (
    run: { readonly threadId: ThreadId; readonly runId: RunId },
    resumeAt: string | null,
    reason: string,
  ) {
    // Recorded first, so a stop that lands without its record never strands the thread.
    yield* dispatchLogged("pause", {
      type: "thread.metadata.update",
      commandId: CommandId.make(`usage-threshold-pause:${run.runId}`),
      threadId: run.threadId,
      usagePause: { runId: run.runId, resumeAt },
    });
    yield* dispatchLogged("stop", {
      type: "thread.stop",
      commandId: CommandId.make(`usage-threshold-stop:${run.runId}`),
      threadId: run.threadId,
      reason,
      // Every live run is listed, delegated children included, so each gets its own record.
      stopDelegatedTasks: false,
    });
  });

  const stopCrossed = Effect.fn("UsageThresholdPauseWorker.stopCrossed")(function* (
    providers: ReadonlyArray<ServerProvider>,
    crossings: ReadonlyArray<UsageReading>,
    threshold: number,
  ) {
    const byDriver = resumeAtByDriver(crossings);
    const driverOf = new Map(providers.map((provider) => [provider.instanceId, provider.driver]));
    for (const run of yield* projections.listLiveRuns()) {
      const driver = driverOf.get(run.providerInstanceId);
      const crossing = driver === undefined ? undefined : byDriver.get(driver);
      if (crossing === undefined) continue;
      yield* stopRun(
        run,
        crossing.resumeAt,
        `Paused at ${Math.round(crossing.remainingPercent)}% ${crossing.label} usage left (threshold ${threshold}%). ${crossing.resumeAt === null ? "No reset time is known, so continue it yourself." : "Continues when the limit resets."}`,
      );
    }
  });

  const applyPriorities = Effect.fn("UsageThresholdPauseWorker.applyPriorities")(function* (
    requested: ReadonlyArray<{ readonly accountId: string; readonly priority: number }>,
    sources: ReadonlyArray<UsageLimitSourceSnapshot>,
    nowMs: number,
  ) {
    for (const [key, at] of priorityAttempts) {
      if (nowMs - at >= HUB_READ_FLOOR_MS) priorityAttempts.delete(key);
    }
    const accounts = new Map(
      sources.flatMap((source) =>
        source.accounts.map((account) => [
          hubAccountKey(source.id, account.id),
          { sourceId: source.id, accountId: account.id, priority: account.priority ?? 0 },
        ]),
      ),
    );
    for (const { accountId, priority } of requested) {
      const target = accounts.get(accountId);
      if (target === undefined) {
        if (!warnedAccounts.has(accountId)) {
          warnedAccounts.add(accountId);
          yield* Effect.logWarning("orchestration-v2.usage-threshold.priority-unknown-account", {
            accountId,
          });
        }
        continue;
      }
      const attempt = `${accountId}=${priority}`;
      if (target.priority === priority || priorityAttempts.has(attempt)) continue;
      priorityAttempts.set(attempt, nowMs);
      yield* hubs.setPriority({ ...target, priority }).pipe(
        Effect.tap(() =>
          Effect.logInfo("orchestration-v2.usage-threshold.priority-set", { accountId, priority }),
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("orchestration-v2.usage-threshold.priority-failed", {
            accountId,
            cause,
          }),
        ),
      );
    }
  });

  const runScript = Effect.fn("UsageThresholdPauseWorker.runScript")(function* (
    source: string,
    providers: ReadonlyArray<ServerProvider>,
    sources: ReadonlyArray<UsageLimitSourceSnapshot>,
    reports: ReadonlyArray<UsageLimitsReport>,
    nowMs: number,
  ) {
    if (script.source !== source) script = { source, stateJson: "{}", lastError: null };
    if (source.trim() === "") return;
    const usage = scriptUsage(reports, sources);
    const driverOf = new Map(providers.map((provider) => [provider.instanceId, provider.driver]));
    const liveRuns = yield* projections.listLiveRuns();
    const runs = liveRuns.map((run) => ({
      runId: run.runId,
      threadId: run.threadId,
      title: run.title,
      projectId: run.projectId,
      project: run.projectTitle,
      workspaceRoot: run.workspaceRoot,
      provider: driverOf.get(run.providerInstanceId) ?? null,
      providerInstanceId: run.providerInstanceId,
      model: run.model,
      delegated: run.parentThreadId !== null,
      parentThreadId: run.parentThreadId,
      startedAt: run.startedAt,
      runningMinutes: Math.max(0, (nowMs - Date.parse(run.startedAt)) / 60_000),
    }));
    const decided = yield* Effect.try({
      try: () => runUsagePauseScript(source, { usage, runs, nowMs }, script.stateJson),
      catch: (error) => (error instanceof Error ? error.message : String(error)),
    }).pipe(
      Effect.tapError((message) =>
        // Logged once per distinct failure: the script runs every tick.
        message === script.lastError
          ? Effect.void
          : Effect.logWarning("orchestration-v2.usage-threshold.script-failed", { message }),
      ),
      Effect.tapError((message) => Effect.sync(() => (script.lastError = message))),
      Effect.option,
    );
    if (decided._tag === "None") return;
    const { stateJson, stops, priorities, checkAgainInSeconds } = decided.value;
    script.stateJson = stateJson;
    script.lastError = null;
    const byRunId = new Map(liveRuns.map((run) => [run.runId as string, run]));
    for (const stop of stops) {
      const run = byRunId.get(stop.runId);
      if (run === undefined) continue;
      const resumeAt =
        stop.resumeAt === undefined
          ? defaultResumeAt(usage, driverOf.get(run.providerInstanceId))
          : stop.resumeAt;
      yield* stopRun(
        run,
        resumeAt,
        `${stop.message ?? "Paused by your usage pause script."} ${resumeAt === null ? "Continue it yourself." : "Continues automatically."}`,
      );
    }
    yield* applyPriorities(priorities, sources, nowMs);
    if (
      checkAgainInSeconds !== null &&
      nowMs - lastHubReadMs >= Math.max(HUB_READ_FLOOR_MS, checkAgainInSeconds * 1000)
    ) {
      lastHubReadMs = nowMs;
      yield* hubs.refresh;
    }
  });

  const resumeDue = Effect.fn("UsageThresholdPauseWorker.resumeDue")(function* (nowMs: number) {
    if (yield* due.isIdle(nowMs)) return;
    const readVersion = yield* due.version;
    let nextWakeMs = Infinity;
    for (const { threadId, usagePause } of yield* projections.listUsagePausedThreads()) {
      if (usagePause.resumeAt === null) continue;
      const resumeMs = Date.parse(usagePause.resumeAt);
      if (resumeMs > nowMs) {
        nextWakeMs = Math.min(nextWakeMs, resumeMs);
        continue;
      }
      const identity = `${threadId}:${usagePause.runId}`;
      // The orchestrator refuses it once anything ran after the stopped run, e.g. the user continued.
      const continued = yield* dispatchLogged("continue", {
        type: "message.dispatch",
        commandId: CommandId.make(`usage-threshold-continue:${identity}`),
        messageId: MessageId.make(`usage-threshold-continue:${identity}`),
        threadId,
        manualContinuationOfRunId: usagePause.runId,
        text: "",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "system",
        creationSource: "server",
      });
      if (continued) {
        yield* dispatchLogged("queue-resume", {
          type: "queue.resume",
          commandId: CommandId.make(`usage-threshold-queue:${identity}`),
          threadId,
        });
      }
      yield* dispatchLogged("clear", {
        type: "thread.metadata.update",
        commandId: CommandId.make(`usage-threshold-clear:${identity}`),
        threadId,
        usagePause: null,
      });
    }
    yield* due.record(readVersion, nextWakeMs, nowMs);
  });

  return Effect.fn("UsageThresholdPauseWorker.sweep")(function* () {
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    const config = (yield* settings.getSettings).usageThresholdPause;
    if (!config.enabled) {
      armed.clear();
    } else {
      const providers = yield* registry.getProviders;
      const sources = yield* hubs.current;
      const drivers = new Set([
        ...providers.map((provider) => provider.driver),
        ...sources.flatMap((source) => source.accounts.map((account) => account.driver)),
      ]);
      const reports = [...drivers].flatMap(
        (driver) => collectDriverUsageLimits(driver, providers, sources, nowMs) ?? [],
      );
      if (config.mode === "script") {
        // Rules re-arm from scratch when switched back, as when the setting is turned on.
        armed.clear();
        yield* runScript(config.script, providers, sources, reports, nowMs);
      } else {
        const crossings = thresholdCrossings(
          usageReadings(config, reports),
          config.remainingPercent,
          armed,
        );
        if (crossings.length > 0) yield* stopCrossed(providers, crossings, config.remainingPercent);
      }
    }
    yield* resumeDue(nowMs);
  });
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sweep = yield* makeSweep;
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register("usage-threshold-pause", sweep());
  }),
);

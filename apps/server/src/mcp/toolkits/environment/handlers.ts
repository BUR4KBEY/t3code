import {
  OrchestratorMcpFailure,
  type ProviderDriverKind,
  type ServerSettings,
  type UsageLimitsReport,
} from "@t3tools/contracts";
import { collectDriverUsageLimits, limitsNotice } from "@t3tools/shared/usageLimits";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Environment from "../../../environment/ServerEnvironment.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as Settings from "../../../serverSettings.ts";
import * as UsageLimitSources from "../../../usage/UsageLimitSources.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller, unavailable } from "../../threadAccess.ts";
import { EnvironmentToolkit } from "./tools.ts";

const USAGE_LIMITS_REFRESH_FLOOR_MS = 60_000;

export function preferences(settings: ServerSettings) {
  const {
    defaultThreadEnvMode,
    newWorktreesStartFromOrigin,
    enableProviderUpdateChecks,
    backgroundActivity,
    sourceControlWritingStyle,
  } = settings;
  const characters = Array.from(sourceControlWritingStyle.customInstructions);
  return {
    defaultThreadEnvMode,
    newWorktreesStartFromOrigin,
    enableProviderUpdateChecks,
    backgroundActivity: { profile: backgroundActivity.profile },
    sourceControlWritingStyle: {
      ...sourceControlWritingStyle,
      customInstructions: characters.slice(0, 4000).join(""),
      truncated: characters.length > 4000,
    },
  };
}
// Allowlist only: report accounts also carry emails, credit ids and hub ids.
function usageLimitAccount(account: UsageLimitsReport["accounts"][number]) {
  const unavailable = limitsNotice(account.limits);
  return {
    label: account.label,
    driver: account.driver,
    ...(account.instanceId ? { instanceId: account.instanceId } : { source: "cliproxy" as const }),
    ...(account.plan ? { plan: account.plan } : {}),
    checkedAt: account.limits.checkedAt,
    windows: account.limits.windows.map((window) => ({
      label: window.label,
      usedPercent: window.usedPercent,
      ...(window.resetsAt ? { resetsAt: window.resetsAt } : {}),
    })),
    ...(unavailable ? { unavailable } : {}),
  };
}
const access = Effect.gen(function* () {
  const context = yield* readCaller();
  const environment = yield* Environment.ServerEnvironment;
  const descriptor = yield* environment.getDescriptor;
  if (descriptor.environmentId !== context.scope.environmentId)
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "This credential belongs to another environment.",
    });
  return { ...context, descriptor, settings: yield* Settings.ServerSettingsService };
});
export const layer = McpToolAccess.toLayer(
  EnvironmentToolkit,
  Effect.gen(function* () {
    // One floor for every caller: a refresh re-runs provider CLIs and calls every hub.
    const lastRefreshAt = yield* Ref.make<number | null>(null);
    const refreshLock = yield* Semaphore.make(1);
    const refreshLimits = Effect.fn("EnvironmentHandlers.refreshUsageLimits")(function* (
      driver: ProviderDriverKind | undefined,
    ) {
      const now = yield* Clock.currentTimeMillis;
      const last = yield* Ref.get(lastRefreshAt);
      if (last !== null && now - last < USAGE_LIMITS_REFRESH_FLOOR_MS) return false;
      yield* Ref.set(lastRefreshAt, now);
      const registry = yield* ProviderRegistry.ProviderRegistry;
      const hubs = yield* UsageLimitSources.UsageLimitSources;
      yield* Effect.all([hubs.refresh, registry.refresh(driver)], {
        concurrency: "unbounded",
        discard: true,
      });
      return true;
    }, refreshLock.withPermits(1));
    return {
      t3_environment_read: McpToolAccess.reads(() =>
        Effect.gen(function* () {
          const { descriptor, settings } = yield* access;
          const current = yield* settings.getSettings.pipe(Effect.mapError(unavailable));
          return {
            environmentId: descriptor.environmentId,
            label: descriptor.label,
            serverVersion: descriptor.serverVersion,
            platform: descriptor.platform,
            preferences: preferences(current),
          };
        }),
      ),
      t3_environment_preferences_update: McpToolAccess.writesEnvironment((patch, check) =>
        Effect.gen(function* () {
          const scope = yield* McpInvocationContext.McpInvocationContext;
          const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
          const update = Effect.gen(function* () {
            // The turn may have ended, or the thread's modes changed, while this waited for the lock.
            yield* check;
            const { settings } = yield* access;
            return preferences(
              yield* settings.updateSettings(patch).pipe(Effect.mapError(unavailable)),
            );
          });
          return yield* scope.thread === undefined
            ? update
            : executor.withLock(scope.thread.threadId, update);
        }),
      ),
      t3_usage_limits: McpToolAccess.reads(({ driver, refresh }) =>
        Effect.gen(function* () {
          yield* access;
          const refreshed = refresh === true ? yield* refreshLimits(driver) : undefined;
          const providers = yield* (yield* ProviderRegistry.ProviderRegistry).getProviders;
          const sources = yield* (yield* UsageLimitSources.UsageLimitSources).current;
          const now = yield* Clock.currentTimeMillis;
          const drivers =
            driver !== undefined
              ? [driver]
              : [
                  ...new Set([
                    ...providers.map((provider) => provider.driver),
                    ...sources.flatMap((source) =>
                      source.accounts.map((account) => account.driver),
                    ),
                  ]),
                ];
          const reports = drivers.flatMap(
            (kind) => collectDriverUsageLimits(kind, providers, sources, now) ?? [],
          );
          return {
            accounts: reports.flatMap((report) => report.accounts.map(usageLimitAccount)),
            notices: [...new Set(reports.flatMap((report) => report.notices))],
            ...(refreshed === undefined ? {} : { refreshed }),
          };
        }),
      ),
    };
  }),
);

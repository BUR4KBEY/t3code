import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageLimits,
  type UsageLimitSourceSnapshot,
  UsageLimitSourceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as Environment from "../../../environment/ServerEnvironment.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as Settings from "../../../serverSettings.ts";
import * as UsageLimitSources from "../../../usage/UsageLimitSources.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as EnvironmentHandlers from "./handlers.ts";
import { EnvironmentToolkit } from "./tools.ts";

const environmentId = EnvironmentId.make("environment:usage");
const checkedAt = "2026-09-03T11:00:00.000Z";
const resetsAt = "2026-09-03T15:00:00.000Z";

const limits = (usedPercent: number): ServerProviderUsageLimits => ({
  checkedAt,
  windows: [{ id: "five_hour", kind: "session", label: "5h", usedPercent, resetsAt }],
});

function provider(overrides: Partial<ServerProvider>): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt,
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

function hub(
  accounts: UsageLimitSourceSnapshot["accounts"],
  overrides: Partial<UsageLimitSourceSnapshot> = {},
): UsageLimitSourceSnapshot {
  return {
    id: UsageLimitSourceId.make("hub"),
    kind: "cliproxy",
    label: "Hub",
    checkedAt,
    accounts,
    ...overrides,
  };
}

function usageLimitsLayer(services: {
  readonly registry: Partial<ProviderRegistry.ProviderRegistry["Service"]>;
  readonly hubs: Partial<UsageLimitSources.UsageLimitSources["Service"]>;
}) {
  return McpToolAccess.HandlersLayer.layer(EnvironmentHandlers.layer).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.succeed(McpInvocationContext.McpInvocationContext, {
          environmentId,
          requestNamespace: "provider:usage",
          thread: undefined,
          client: undefined,
          capabilities: new Set(["orchestration" as const]),
          issuedAt: 0,
        }),
        Layer.mock(ThreadCommandExecutor.ThreadCommandExecutor)({}),
        Layer.mock(ThreadManagement.ThreadManagementService)({}),
        Layer.mock(Environment.ServerEnvironment)({
          getDescriptor: Effect.succeed({
            environmentId,
            label: "Test",
            platform: { os: "linux", arch: "x64" },
            serverVersion: "0.0.0",
            capabilities: { repositoryIdentity: false },
          }),
        }),
        Layer.mock(Settings.ServerSettingsService)({}),
        Layer.mock(ProviderRegistry.ProviderRegistry)(services.registry),
        Layer.mock(UsageLimitSources.UsageLimitSources)(services.hubs),
      ),
    ),
  );
}

const staticLayer = (
  providers: ReadonlyArray<ServerProvider>,
  sources: ReadonlyArray<UsageLimitSourceSnapshot>,
) =>
  usageLimitsLayer({
    registry: { getProviders: Effect.succeed(providers) },
    hubs: { current: Effect.succeed(sources) },
  });

const usageLimits = (input: { driver?: ProviderDriverKind; refresh?: boolean }) =>
  Effect.gen(function* () {
    const toolkit = yield* EnvironmentToolkit;
    const results = yield* toolkit
      .handle("t3_usage_limits", input)
      .pipe(Stream.unwrap, Stream.runCollect);
    return results.at(-1)?.result;
  });

it.effect("reports provider and hub accounts as Usage → Limits pools them", () =>
  Effect.gen(function* () {
    const all = yield* usageLimits({});
    expect(all).toEqual({
      accounts: [
        {
          label: "codex [codex]",
          driver: "codex",
          instanceId: "codex",
          checkedAt,
          windows: [{ label: "5h", usedPercent: 40, resetsAt }],
        },
        {
          label: "Hub · team",
          driver: "claudeAgent",
          source: "cliproxy",
          checkedAt,
          windows: [{ label: "5h", usedPercent: 90, resetsAt }],
        },
      ],
      notices: [],
    });
    const claude = yield* usageLimits({ driver: ProviderDriverKind.make("claudeAgent") });
    expect(claude).toMatchObject({ accounts: [{ label: "Hub · team", source: "cliproxy" }] });
  }).pipe(
    Effect.provide(
      staticLayer(
        [
          provider({
            auth: { status: "authenticated", email: "same@example.com" },
            usageLimits: limits(40),
          }),
        ],
        [
          hub([
            {
              id: "dup",
              driver: ProviderDriverKind.make("codex"),
              email: "SAME@example.com",
              usageLimits: limits(40),
            },
            {
              id: "team.json",
              driver: ProviderDriverKind.make("claudeAgent"),
              usageLimits: limits(90),
            },
          ]),
        ],
      ),
    ),
  ),
);

it.effect("reports unavailable limits and hub errors once", () =>
  Effect.gen(function* () {
    expect(yield* usageLimits({})).toEqual({
      accounts: [
        {
          label: "codex [codex]",
          driver: "codex",
          instanceId: "codex",
          checkedAt,
          windows: [],
          unavailable: "Codex did not answer the usage request.",
        },
      ],
      notices: ["Hub: The hub answered with HTTP 401."],
    });
  }).pipe(
    Effect.provide(
      staticLayer(
        [
          provider({
            usageLimits: {
              checkedAt,
              windows: [],
              unavailable: {
                reason: "probeFailed",
                message: "Codex did not answer the usage request.",
              },
            },
          }),
          provider({
            instanceId: ProviderInstanceId.make("claude"),
            driver: ProviderDriverKind.make("claudeAgent"),
          }),
        ],
        [hub([], { error: "The hub answered with HTTP 401." })],
      ),
    ),
  ),
);

it.effect("returns an empty report without limits or hubs", () =>
  Effect.gen(function* () {
    expect(yield* usageLimits({})).toEqual({ accounts: [], notices: [] });
  }).pipe(Effect.provide(staticLayer([provider({})], []))),
);

it.effect("never returns emails, workspace ids, credit ids or hub ids", () =>
  Effect.gen(function* () {
    const result = yield* usageLimits({});
    expect(JSON.stringify(result)).not.toMatch(/leak-/);
    expect(result).toMatchObject({ accounts: [{ driver: "codex" }, { driver: "claudeAgent" }] });
  }).pipe(
    Effect.provide(
      staticLayer(
        [
          provider({
            auth: {
              status: "authenticated",
              email: "leak-email@example.com",
              workspaceId: "leak-workspace",
            },
            usageLimits: {
              ...limits(40),
              credentialFingerprint: "leak-fingerprint",
              resetCredits: { availableCount: 1, nextCreditId: "leak-credit" },
              externalUsage: { label: "x", url: "https://leak.example/usage" },
            },
          }),
        ],
        [
          hub(
            [
              {
                id: "team",
                driver: ProviderDriverKind.make("claudeAgent"),
                email: "leak-hub@example.com",
                workspaceId: "leak-hub-ws",
                usageLimits: {
                  ...limits(10),
                  resetCredits: { availableCount: 1, nextCreditId: "leak-hub-credit" },
                },
              },
            ],
            { id: UsageLimitSourceId.make("leak-source-id") },
          ),
        ],
      ),
    ),
  ),
);

it.effect("refreshes at most once a minute and reads the refreshed data", () =>
  Effect.gen(function* () {
    const providers = yield* Ref.make([provider({ usageLimits: limits(40) })]);
    const providerRefreshes = yield* Ref.make(0);
    const hubRefreshes = yield* Ref.make(0);
    const layer = usageLimitsLayer({
      registry: {
        getProviders: Ref.get(providers),
        refresh: () =>
          Ref.update(providerRefreshes, (count) => count + 1).pipe(
            Effect.andThen(Ref.set(providers, [provider({ usageLimits: limits(55) })])),
            Effect.andThen(Ref.get(providers)),
          ),
      },
      hubs: {
        current: Effect.succeed([]),
        refresh: Ref.update(hubRefreshes, (count) => count + 1),
      },
    });
    const counts = Effect.all([Ref.get(providerRefreshes), Ref.get(hubRefreshes)]);
    yield* Effect.gen(function* () {
      expect(yield* usageLimits({ refresh: true })).toMatchObject({
        refreshed: true,
        accounts: [{ windows: [{ usedPercent: 55 }] }],
      });
      expect(yield* counts).toEqual([1, 1]);
      expect(yield* usageLimits({ refresh: true })).toMatchObject({ refreshed: false });
      expect(yield* counts).toEqual([1, 1]);
      expect(yield* usageLimits({})).not.toHaveProperty("refreshed");
      yield* TestClock.adjust("61 seconds");
      expect(yield* usageLimits({ refresh: true })).toMatchObject({ refreshed: true });
      expect(yield* counts).toEqual([2, 2]);
    }).pipe(Effect.provide(layer));
  }),
);

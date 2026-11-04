import {
  BackgroundActivityProfile,
  BackgroundActivityProfileSelection,
  ExecutionEnvironmentDescriptor,
  OrchestratorMcpEnvironmentTarget,
  OrchestratorMcpFailure,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
  ServerSettings,
  ServerSettingsPatch,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as Settings from "../../../serverSettings.ts";
import * as UsageLimitSources from "../../../usage/UsageLimitSources.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const PreferenceFields = {
  defaultThreadEnvMode: ServerSettings.fields.defaultThreadEnvMode,
  newWorktreesStartFromOrigin: ServerSettings.fields.newWorktreesStartFromOrigin,
  enableProviderUpdateChecks: ServerSettings.fields.enableProviderUpdateChecks,
  backgroundActivity: Schema.Struct({ profile: BackgroundActivityProfileSelection }),
  sourceControlWritingStyle: Schema.Struct({
    mode: Schema.String,
    followChangeRequestTemplates: Schema.Boolean,
    customInstructions: Schema.String,
    truncated: Schema.Boolean,
  }),
};
const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ServerEnvironment.ServerEnvironment,
    Settings.ServerSettingsService,
    ThreadCommandExecutor.ThreadCommandExecutor,
  ],
};
const EnvironmentReadTool = Tool.make("t3_environment_read", {
  ...shared,
  description:
    "Read this server's identity and preferences. Providers and models: `orchestrator_capabilities`.",
  parameters: Schema.Struct({ environmentId: OrchestratorMcpEnvironmentTarget }),
  success: Schema.Struct({
    environmentId: ExecutionEnvironmentDescriptor.fields.environmentId,
    label: Schema.String,
    serverVersion: Schema.String,
    platform: ExecutionEnvironmentDescriptor.fields.platform,
    preferences: Schema.Struct(PreferenceFields),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const EnvironmentPreferencesTool = Tool.make("t3_environment_preferences_update", {
  ...shared,
  description:
    "Update environment-wide preferences. Live full-access or default caller thread only. Omitted fields are unchanged; `customInstructions: ''` clears it.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    defaultThreadEnvMode: ServerSettingsPatch.fields.defaultThreadEnvMode,
    newWorktreesStartFromOrigin: ServerSettingsPatch.fields.newWorktreesStartFromOrigin,
    enableProviderUpdateChecks: ServerSettingsPatch.fields.enableProviderUpdateChecks,
    backgroundActivity: Schema.optionalKey(Schema.Struct({ profile: BackgroundActivityProfile })),
    sourceControlWritingStyle: ServerSettingsPatch.fields.sourceControlWritingStyle,
  }),
  success: Schema.Struct(PreferenceFields),
}).annotate(Tool.Destructive, true);
const UsageLimitsTool = Tool.make("t3_usage_limits", {
  ...shared,
  dependencies: [
    ...shared.dependencies,
    ProviderRegistry.ProviderRegistry,
    UsageLimitSources.UsageLimitSources,
  ],
  description:
    "Read subscription usage limits per account for this environment's providers and CLIProxyAPI hubs, as Usage → Limits shows. Cached; `checkedAt` is each account's last check.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    driver: Schema.optionalKey(
      ProviderDriverKind.annotate({ description: "Only this driver's accounts, e.g. `codex`." }),
    ),
    refresh: Schema.optionalKey(
      Schema.Boolean.annotate({
        description:
          "Re-check providers and hubs first. Slow; at most once a minute, else `refreshed: false`.",
      }),
    ),
  }),
  success: Schema.Struct({
    accounts: Schema.Array(
      Schema.Struct({
        label: Schema.String,
        driver: ProviderDriverKind,
        instanceId: Schema.optionalKey(ProviderInstanceId),
        source: Schema.optionalKey(Schema.Literal("cliproxy")),
        plan: Schema.optionalKey(Schema.String),
        checkedAt: ServerProviderUsageLimits.fields.checkedAt,
        windows: Schema.Array(
          Schema.Struct({
            label: ServerProviderUsageWindow.fields.label,
            usedPercent: ServerProviderUsageWindow.fields.usedPercent,
            resetsAt: ServerProviderUsageWindow.fields.resetsAt,
          }),
        ),
        unavailable: Schema.optionalKey(Schema.String),
      }),
    ),
    notices: Schema.Array(Schema.String),
    refreshed: Schema.optionalKey(Schema.Boolean),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
export const EnvironmentToolkit = Toolkit.make(
  EnvironmentReadTool,
  EnvironmentPreferencesTool,
  UsageLimitsTool,
);

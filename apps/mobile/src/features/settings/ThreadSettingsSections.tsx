import { Button } from "../../components/ui/Button";
import {
  AuthSettingsWriteScope,
  isManagedSettingPath,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import { useEnvironmentsWithScope } from "../../state/session";
import { AutoSettleDaysField } from "./components/AutoSettleDaysField";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import type { ComponentProps } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { DEFAULT_SERVER_SETTINGS, PROVIDER_DISPLAY_NAMES } from "@t3tools/contracts";
import { toggleAllByDefaultFilter, usageThresholdPauseChoices } from "@t3tools/shared/usageLimits";
import { supportsSharedSettingsSync } from "@t3tools/client-runtime/state/shared-settings";
import { AppText as Text } from "../../components/ui/AppText";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import { NumberField } from "../../components/ui/NumberField";
import { useEnvironments } from "../../state/environments";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { environmentPresentations } from "../../state/presentation";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { SettingsScreen } from "./components/SettingsScreen";
import { planAutoSettleSettingsSync, type AutoSettleSettings } from "./autoSettleSettingsSync";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";
import {
  managedSettingReason,
  resolveMobileSettingsTargets,
  uniformMobileSetting,
} from "./settings-scoped-server";

export function SettingsLabsRouteScreen() {
  const insets = useSafeAreaInsets();

  return (
    <SettingsScreen title="Labs">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <MachineBetaSection
          title="Linked environments"
          icon="link"
          capability="peerLinks"
          setting="linkedEnvironmentsEnabled"
          description="Let agents on a machine work on your other machines, and theirs on it. Turn it on for each machine. While off, nothing new starts over a link; running tasks finish."
        />
        <MachineBetaSection
          title="Fast worktree checkout"
          icon="bolt.circle"
          capability="fastWorktreeCheckout"
          setting="fastWorktreeCheckout"
          description="On a Mac, clone new worktrees from a checkout cached in the T3 home folder instead of writing every file. Uses Git’s normal checkout when it can’t. Turning it off deletes the cache."
        />
      </ScrollView>
    </SettingsScreen>
  );
}

const AUTO_SETTLE_DEFAULT_DAYS = DEFAULT_SERVER_SETTINGS.sidebarAutoSettleAfterDays ?? 7;

const USAGE_WINDOW_KINDS = [
  { kind: "session", label: "Session windows" },
  { kind: "weekly", label: "Weekly windows" },
  { kind: "monthly", label: "Monthly windows" },
  { kind: "other", label: "Other windows" },
] as const;

const USAGE_PAUSE_AGGREGATIONS = [
  {
    value: "pooled",
    label: "Pooled across accounts",
    description: "Combine each provider's accounts into one remaining amount.",
  },
  {
    value: "perAccount",
    label: "Each account",
    description: "Pause when any one account reaches the threshold.",
  },
] as const;

/**
 * Usage-limit and auto-settle rows. The Threads page owns their writes, so they share its queue
 * with the page's other project overrides, and their project override reset.
 */
export function AutoSettleSettingsRows(props: {
  readonly write: (patch: ServerSettingsPatch) => void;
  readonly pending: boolean;
}) {
  const { selectedTargets, projectGroups, selectedProjectKey } = useSettingsEnvironmentFilter();
  const selectedProject = projectGroups.find((group) => group.key === selectedProjectKey);
  const writableEnvironments = useEnvironmentsWithScope(selectedTargets, AuthSettingsWriteScope);
  const projectSelected = selectedProjectKey !== null;
  const presentations = useAtomValue(environmentPresentations.presentationsWithProvidersAtom);

  const projectMembers = projectSelected
    ? (selectedProject?.members.map((member) => member.project) ?? [])
    : null;
  const displayTargets = resolveMobileSettingsTargets(
    selectedTargets.filter(supportsSharedSettingsSync),
    projectMembers,
  );
  // The page saves to all its targets, so any read-only one blocks the save.
  const canWriteSettings =
    displayTargets.length > 0 &&
    resolveMobileSettingsTargets(selectedTargets, projectMembers).every((target) =>
      writableEnvironments.has(target.environment.environmentId),
    );
  const reference = displayTargets[0] ?? null;
  const referenceSettings = reference?.settings ?? null;

  if (reference === null || referenceSettings === null) {
    return null;
  }

  const writeToAll = (
    patch: Partial<AutoSettleSettings> & {
      autoResumeLimitedThreads?: boolean;
      snoozeLimitedThreads?: boolean;
    },
  ) => props.write(patch);

  const { patch: autoSettlePatch, mismatches } = planAutoSettleSettingsSync(
    {
      environmentId: reference.environment.environmentId,
      projectId: reference.projectId,
      settings: referenceSettings,
    },
    displayTargets.map((target) => ({
      environmentId: target.environment.environmentId,
      projectId: target.projectId,
      label: target.environment.label,
      settings: target.settings,
    })),
  );

  const disabled = !canWriteSettings || props.pending;
  const disabledFor = (...keys: string[]) =>
    disabled || managedSettingReason(displayTargets, ...keys) !== undefined;
  const afterDays = referenceSettings.sidebarAutoSettleAfterDays;
  const pause = referenceSettings.usageThresholdPause;
  const pauseEnabled = displayTargets.every(
    (target) => target.settings.usageThresholdPause.enabled === pause.enabled,
  )
    ? pause.enabled
    : null;
  const pauseDisabled = disabledFor("usageThresholdPause");
  const writePause = (patch: NonNullable<ServerSettingsPatch["usageThresholdPause"]>) =>
    props.write({ usageThresholdPause: patch });
  const pauseChoices = usageThresholdPauseChoices(
    displayTargets.flatMap(
      (target) => presentations.get(target.environment.environmentId)?.serverConfig ?? [],
    ),
  );
  const pauseFilters = [
    {
      title: "Watched providers",
      selected: pause.drivers as readonly string[],
      options: pauseChoices.drivers.map((driver) => ({
        value: driver as string,
        label: PROVIDER_DISPLAY_NAMES[driver] ?? String(driver),
      })),
      write: (values: string[]) =>
        writePause({
          drivers: pauseChoices.drivers.filter((driver) => values.includes(driver)),
        }),
    },
    {
      title: "Watched accounts",
      selected: pause.accountIds,
      options: pauseChoices.accounts.map((account) => ({
        value: account.id,
        label: account.label,
      })),
      write: (values: string[]) => writePause({ accountIds: values }),
    },
  ];
  return (
    <View className="gap-6">
      {!projectSelected ? (
        <SettingsSection title="Usage limits">
          <SettingsSwitchRow
            icon="clock"
            label="Resume after usage limits"
            subtitle="Automatically resume threads when their usage limits reset. You can cancel auto-resume in each thread."
            value={uniformMobileSetting(displayTargets, "autoResumeLimitedThreads")}
            disabled={disabledFor("autoResumeLimitedThreads")}
            onValueChange={(value) => writeToAll({ autoResumeLimitedThreads: value })}
          />
          <SettingsSwitchRow
            icon="clock"
            label="Snooze until limits reset"
            subtitle="Snooze threads until their usage limits reset. Enable auto-resume to continue the agent after the reset."
            value={uniformMobileSetting(displayTargets, "snoozeLimitedThreads")}
            disabled={disabledFor("snoozeLimitedThreads")}
            onValueChange={(value) => writeToAll({ snoozeLimitedThreads: value })}
          />
          <SettingsSwitchRow
            icon="pause"
            label="Pause agents at a usage threshold"
            subtitle="Stop running agents when a usage limit drops to a set amount remaining, then continue them when it resets. You can cancel the continuation in each thread."
            value={pauseEnabled}
            disabled={pauseDisabled}
            onValueChange={(enabled) => writePause({ enabled })}
          />
          {pause.enabled ? (
            <View className="flex-row items-center gap-4 px-4 py-4 android:min-h-14 android:py-3">
              <View className="w-[22px] android:w-6" />
              <Text className="flex-1 text-foreground text-lg android:text-base">
                Remaining usage
              </Text>
              <NumberField
                label="Remaining usage"
                min={1}
                max={99}
                formatValue={(value) => `${value}%`}
                value={pause.remainingPercent}
                disabled={pauseDisabled}
                onValueChange={(remainingPercent) => writePause({ remainingPercent })}
              />
            </View>
          ) : null}
        </SettingsSection>
      ) : null}
      {!projectSelected && pause.enabled ? (
        <SettingsSection title="Usage threshold">
          {USAGE_WINDOW_KINDS.map(({ kind, label }) => {
            const on = pause.windowKinds.includes(kind);
            return (
              <SettingsSwitchRow
                key={kind}
                label={label}
                value={on}
                // At least one window must stay watched.
                disabled={pauseDisabled || (on && pause.windowKinds.length === 1)}
                onValueChange={(next) =>
                  writePause({
                    windowKinds: USAGE_WINDOW_KINDS.flatMap((entry) =>
                      entry.kind === kind
                        ? next
                          ? [kind]
                          : []
                        : pause.windowKinds.includes(entry.kind)
                          ? [entry.kind]
                          : [],
                    ),
                  })
                }
              />
            );
          })}
          {USAGE_PAUSE_AGGREGATIONS.map((choice) => (
            <ListChoiceRow
              key={choice.value}
              label={choice.label}
              description={choice.description}
              selected={pause.aggregation === choice.value}
              separated
              disabled={pauseDisabled}
              onPress={() => writePause({ aggregation: choice.value })}
            />
          ))}
        </SettingsSection>
      ) : null}
      {!projectSelected && pause.enabled
        ? pauseFilters.map((filter) =>
            filter.options.length === 0 ? null : (
              <SettingsSection key={filter.title} title={filter.title}>
                {filter.options.map((option) => (
                  <SettingsSwitchRow
                    key={option.value}
                    label={option.label}
                    value={filter.selected.length === 0 || filter.selected.includes(option.value)}
                    disabled={pauseDisabled}
                    onValueChange={(on) => {
                      const next = toggleAllByDefaultFilter(
                        filter.selected,
                        filter.options.map((entry) => entry.value),
                        option.value,
                        on,
                      );
                      if (next !== null) filter.write(next);
                    }}
                  />
                ))}
              </SettingsSection>
            ),
          )
        : null}
      <SettingsSection title="Auto-settle">
        <SettingsSwitchRow
          icon="arrow.triangle.branch"
          label="Auto-settle merged threads"
          value={referenceSettings.sidebarAutoSettleOnMerge}
          disabled={disabledFor("sidebarAutoSettleOnMerge")}
          onValueChange={(value) => writeToAll({ sidebarAutoSettleOnMerge: value })}
        />
        <SettingsSwitchRow
          icon="clock"
          label="Auto-settle inactive threads"
          value={afterDays !== null}
          disabled={disabledFor("sidebarAutoSettleAfterDays")}
          onValueChange={(value) =>
            writeToAll({ sidebarAutoSettleAfterDays: value ? AUTO_SETTLE_DEFAULT_DAYS : null })
          }
        />
        {afterDays !== null ? (
          <View className="flex-row items-center gap-4 px-4 py-4 android:min-h-14 android:py-3">
            <View className="w-[22px] android:w-6" />
            <Text className="flex-1 text-foreground text-lg android:text-base">Inactive days</Text>
            <AutoSettleDaysField
              value={afterDays}
              disabled={disabledFor("sidebarAutoSettleAfterDays")}
              onValueChange={(value) => writeToAll({ sidebarAutoSettleAfterDays: value })}
            />
          </View>
        ) : null}
      </SettingsSection>
      {!props.pending && mismatches.length > 0 ? (
        <SettingsSection title="Across environments">
          <View className="gap-3 p-4">
            <Text className="text-base text-foreground">Auto-settle defaults differ</Text>
            <Text className="text-sm text-foreground-muted">
              {mismatches.map((mismatch) => mismatch.label).join(", ")}
            </Text>
            <Button
              label="Apply auto-settle defaults"
              tone="secondary"
              disabled={disabledFor("sidebarAutoSettleOnMerge", "sidebarAutoSettleAfterDays")}
              onPress={() => writeToAll(autoSettlePatch)}
            />
          </View>
        </SettingsSection>
      ) : null}
    </View>
  );
}

export function WorkingSectionSettings() {
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const preferences = useAtomValue(mobilePreferencesAtom);
  const workingShelfEnabled =
    AsyncResult.isSuccess(preferences) && preferences.value.workingShelfEnabled !== false;

  return (
    <View className="gap-3">
      <SettingsSection title="Sidebar">
        <SettingsSwitchRow
          icon="bolt.circle"
          label="Working section"
          value={workingShelfEnabled}
          onValueChange={(value) => savePreferences({ workingShelfEnabled: value })}
        />
      </SettingsSection>
      <Text className="px-2 text-sm text-foreground-muted">
        Fold working and monitoring threads into a Working section. They return to the top of the
        list when they need you. While this is on, active threads are ordered by time and cannot be
        moved.
      </Text>
    </View>
  );
}

export function NewThreadSettingsSection() {
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const preferences = useAtomValue(mobilePreferencesAtom);
  const useLastProject =
    AsyncResult.isSuccess(preferences) && preferences.value.useLastProjectForNewThreads !== false;

  return (
    <SettingsSection title="New threads">
      <SettingsSwitchRow
        icon="square.and.pencil"
        label="Use last project"
        subtitle="Start new threads in the last project you used on this device."
        value={useLastProject}
        onValueChange={(value) => savePreferences({ useLastProjectForNewThreads: value })}
      />
    </SettingsSection>
  );
}

type MachineBetaSetting = "linkedEnvironmentsEnabled" | "fastWorktreeCheckout";

/** One switch per connected machine that offers the beta, since each machine's own setting decides. */
function MachineBetaSection({
  title,
  icon,
  capability,
  setting,
  description,
}: {
  readonly title: string;
  readonly icon: ComponentProps<typeof SettingsSwitchRow>["icon"];
  readonly capability: "peerLinks" | "fastWorktreeCheckout";
  readonly setting: MachineBetaSetting;
  readonly description: string;
}) {
  const { environments } = useEnvironments();
  const supported = environments.filter(
    (environment) =>
      environment.connection.phase === "connected" &&
      environment.serverConfig?.environment.capabilities[capability] === true,
  );
  const writable = useEnvironmentsWithScope(supported, AuthSettingsWriteScope);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: `${setting} beta update`,
    reportFailure: true,
  });
  if (supported.length === 0) return null;
  return (
    <View className="gap-3">
      <SettingsSection title={`Beta: ${title}`}>
        {supported.map((environment) => {
          const policy = environment.serverConfig?.managedPolicy;
          const managed = isManagedSettingPath(policy, setting);
          return (
            <SettingsSwitchRow
              key={environment.environmentId}
              icon={icon}
              label={environment.label}
              {...(managed ? { subtitle: `Managed by ${policy?.organization}.` } : {})}
              value={environment.serverConfig?.settings[setting] === true}
              disabled={managed || !writable.has(environment.environmentId)}
              onValueChange={(value) =>
                void updateSettings({
                  environmentId: environment.environmentId,
                  input: {
                    patch:
                      setting === "linkedEnvironmentsEnabled"
                        ? { linkedEnvironmentsEnabled: value }
                        : { fastWorktreeCheckout: value },
                  },
                })
              }
            />
          );
        })}
      </SettingsSection>
      <Text className="px-2 text-sm text-foreground-muted">{description}</Text>
    </View>
  );
}

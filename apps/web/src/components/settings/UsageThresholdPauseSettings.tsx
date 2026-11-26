import { useAtomValue } from "@effect/atom-react";
import { PROVIDER_DISPLAY_NAMES, type ServerProviderUsageWindow } from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import {
  toggleAllByDefaultFilter,
  USAGE_PAUSE_SCRIPT_EXAMPLE,
  usageThresholdPauseChoices,
} from "@t3tools/shared/usageLimits";
import * as Equal from "effect/Equal";
import { useRef, useState } from "react";

import { environmentPresentations } from "../../state/presentation";
import { Menu, MenuCheckboxItem, MenuPopup, MenuTrigger } from "../ui/menu";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "../ui/number-field";
import {
  Select,
  SelectButton,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { Textarea } from "../ui/textarea";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { ScopedSwitch } from "./ScopedSwitch";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

type WindowKind = ServerProviderUsageWindow["kind"];

const WINDOW_KINDS: ReadonlyArray<{ readonly kind: WindowKind; readonly label: string }> = [
  { kind: "session", label: "Session" },
  { kind: "weekly", label: "Weekly" },
  { kind: "monthly", label: "Monthly" },
  { kind: "other", label: "Other" },
];

const AGGREGATION_LABELS = {
  pooled: "Pooled across accounts",
  perAccount: "Each account",
} as const;

const SETTING_KEYS = ["usageThresholdPause"] as const;

/** Picks from a list where nothing picked means everything. */
function AllByDefaultMenu<T extends string>(props: {
  readonly label: string;
  readonly allLabel: string;
  readonly selected: readonly T[];
  readonly options: ReadonlyArray<{ readonly value: T; readonly label: string }>;
  readonly onChange: (next: T[]) => void;
}) {
  const known = new Set(props.options.map((option) => option.value));
  // A saved choice the servers no longer report still filters, so it stays removable.
  const options = [
    ...props.options,
    ...props.selected
      .filter((value) => !known.has(value))
      .map((value) => ({ value, label: value })),
  ];
  const values = options.map((option) => option.value);
  return (
    <Menu>
      <MenuTrigger
        aria-label={props.label}
        render={<SelectButton size="sm" />}
        disabled={options.length === 0}
      >
        {props.selected.length === 0
          ? props.allLabel
          : props.selected
              .map((value) => options.find((option) => option.value === value)?.label ?? value)
              .join(", ")}
      </MenuTrigger>
      <MenuPopup align="end">
        {options.map((option) => (
          <MenuCheckboxItem
            key={option.value}
            checked={props.selected.length === 0 || props.selected.includes(option.value)}
            onCheckedChange={(checked) => {
              const next = toggleAllByDefaultFilter(props.selected, values, option.value, checked);
              if (next !== null) props.onChange(next);
            }}
          >
            {option.label}
          </MenuCheckboxItem>
        ))}
      </MenuPopup>
    </Menu>
  );
}

function RemainingPercentField(props: {
  readonly value: number;
  readonly onCommit: (value: number) => void;
}) {
  // Typing stays local until the field commits, so half-typed values never reach the server.
  const [draft, setDraft] = useState<number | null>(props.value);
  const [draftSource, setDraftSource] = useState(props.value);
  if (draftSource !== props.value) {
    setDraftSource(props.value);
    setDraft(props.value);
  }
  return (
    <NumberField
      size="sm"
      className="w-32"
      min={1}
      max={99}
      step={1}
      value={draft}
      onValueChange={setDraft}
      onValueCommitted={(value) => {
        if (value === null) {
          setDraft(props.value);
          return;
        }
        const next = Math.min(99, Math.max(1, Math.round(value)));
        setDraft(next);
        if (next !== props.value) props.onCommit(next);
      }}
    >
      <NumberFieldGroup>
        <NumberFieldDecrement aria-label="Decrease remaining usage" />
        <NumberFieldInput
          aria-label="Remaining usage percent"
          // Base UI commits on blur but not on Enter; refocus so keyboard users stay put.
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            const input = event.currentTarget;
            input.blur();
            input.focus();
          }}
        />
        <NumberFieldIncrement aria-label="Increase remaining usage" />
      </NumberFieldGroup>
    </NumberField>
  );
}

export function UsageThresholdPauseRows() {
  const searchableSetting = useSearchableSetting();
  const pause = useScopedSettings((settings) => settings.usageThresholdPause);
  const updateSettings = useUpdateScopedSettings();
  const { connectedEnvironments } = useSettingsScope();
  const presentations = useAtomValue(environmentPresentations.presentationsWithProvidersAtom);
  const choices = usageThresholdPauseChoices(
    connectedEnvironments.flatMap(
      (environment) => presentations.get(environment.environmentId)?.serverConfig ?? [],
    ),
  );
  const scriptEdited = useRef(false);
  const update = (patch: {
    enabled?: boolean;
    remainingPercent?: number;
    windowKinds?: WindowKind[];
    aggregation?: keyof typeof AGGREGATION_LABELS;
    drivers?: (typeof choices.drivers)[number][];
    accountIds?: string[];
    mode?: "rules" | "script";
    script?: string;
  }) => updateSettings({ usageThresholdPause: patch });

  return (
    <>
      <SettingsRow
        serverScoped
        {...searchableSetting("usage-threshold-pause")}
        description="Stop running agents when a usage limit drops to a set amount remaining, then continue them when it resets. You can cancel the continuation in each thread."
        settingKeys={SETTING_KEYS}
        resetAction={
          !Equal.equals(pause, DEFAULT_UNIFIED_SETTINGS.usageThresholdPause) ? (
            <SettingResetButton
              ariaLabel="Reset usage threshold pause to default"
              onClick={() =>
                updateSettings({
                  usageThresholdPause: DEFAULT_UNIFIED_SETTINGS.usageThresholdPause,
                })
              }
            />
          ) : null
        }
        control={
          <ScopedSwitch
            settingKeys={SETTING_KEYS}
            checked={pause.enabled}
            onCheckedChange={(checked) => update({ enabled: Boolean(checked) })}
            aria-label="Pause agents at a usage threshold"
          />
        }
      />
      {pause.enabled ? (
        <SettingsRow
          serverScoped
          settingKeys={SETTING_KEYS}
          title="Decide with"
          description="Use the settings below, or your own script that sees every usage window and running agent and picks which to stop."
          control={
            <ToggleGroup
              variant="outline"
              size="sm"
              aria-label="Decide with"
              value={[pause.mode]}
              onValueChange={([mode]) => {
                if (mode !== "rules" && mode !== "script") return;
                update(
                  mode === "script" && pause.script.trim() === ""
                    ? { mode, script: USAGE_PAUSE_SCRIPT_EXAMPLE }
                    : { mode },
                );
              }}
            >
              <Toggle value="rules">Settings</Toggle>
              <Toggle value="script">Script</Toggle>
            </ToggleGroup>
          }
        />
      ) : null}
      {pause.enabled && pause.mode === "script" ? (
        <SettingsRow
          serverScoped
          settingKeys={SETTING_KEYS}
          title="Script"
          description="JavaScript function body, run on the server. Saved when you leave the field. Errors are written to the server log and stop nothing."
        >
          <div className="mt-3 pb-3.5">
            <Textarea
              key={pause.script}
              aria-label="Usage pause script"
              spellCheck={false}
              autoCapitalize="none"
              rows={14}
              maxLength={20_000}
              defaultValue={pause.script}
              onChange={() => {
                scriptEdited.current = true;
              }}
              onBlur={(event) => {
                const script = event.target.value;
                if (scriptEdited.current && script !== pause.script) update({ script });
                scriptEdited.current = false;
              }}
            />
          </div>
        </SettingsRow>
      ) : null}
      {pause.enabled && pause.mode === "rules" ? (
        <>
          <SettingsRow
            serverScoped
            settingKeys={SETTING_KEYS}
            title="Remaining usage"
            description="Pause when this percentage of a usage window remains."
            control={
              <RemainingPercentField
                value={pause.remainingPercent}
                onCommit={(remainingPercent) => update({ remainingPercent })}
              />
            }
          />
          <SettingsRow
            serverScoped
            settingKeys={SETTING_KEYS}
            title="Usage windows"
            description="The limit windows that can pause agents."
            control={
              <ToggleGroup
                multiple
                variant="outline"
                size="sm"
                aria-label="Usage windows"
                value={[...pause.windowKinds]}
                onValueChange={(values) => {
                  if (values.length === 0) return;
                  update({
                    windowKinds: WINDOW_KINDS.flatMap(({ kind }) =>
                      values.includes(kind) ? [kind] : [],
                    ),
                  });
                }}
              >
                {WINDOW_KINDS.map(({ kind, label }) => (
                  <Toggle key={kind} value={kind}>
                    {label}
                  </Toggle>
                ))}
              </ToggleGroup>
            }
          />
          <SettingsRow
            serverScoped
            settingKeys={SETTING_KEYS}
            title="Accounts"
            description="Pool a provider's accounts into one remaining amount, or pause when any one account reaches the threshold."
            control={
              <Select
                value={pause.aggregation}
                onValueChange={(value) => {
                  if (value === "pooled" || value === "perAccount") update({ aggregation: value });
                }}
              >
                <SelectTrigger size="sm" className="w-full sm:w-56" aria-label="Accounts">
                  <SelectValue>
                    {(value: keyof typeof AGGREGATION_LABELS) => AGGREGATION_LABELS[value]}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {(["pooled", "perAccount"] as const).map((value) => (
                    <SelectItem hideIndicator key={value} value={value}>
                      {AGGREGATION_LABELS[value]}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          />
          <SettingsRow
            serverScoped
            settingKeys={SETTING_KEYS}
            title="Watched providers"
            description="Only these providers' usage can pause agents."
            control={
              <AllByDefaultMenu
                label="Watched providers"
                allLabel="All providers"
                selected={pause.drivers}
                options={choices.drivers.map((driver) => ({
                  value: driver,
                  label: PROVIDER_DISPLAY_NAMES[driver] ?? String(driver),
                }))}
                onChange={(drivers) => update({ drivers })}
              />
            }
          />
          <SettingsRow
            serverScoped
            settingKeys={SETTING_KEYS}
            title="Watched accounts"
            description="Only these accounts' usage can pause agents."
            control={
              <AllByDefaultMenu
                label="Watched accounts"
                allLabel="All accounts"
                selected={pause.accountIds}
                options={choices.accounts.map((account) => ({
                  value: account.id,
                  label: account.label,
                }))}
                onChange={(accountIds) => update({ accountIds })}
              />
            }
          />
        </>
      ) : null}
    </>
  );
}

import type { UsageLimitSourceSnapshot, UsageLimitsReport } from "@t3tools/contracts";
import { limitsNotice } from "@t3tools/shared/usageLimitsCopy";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import * as NodeVM from "node:vm";

/** What a usage pause script sees: one entry per account window, unpooled. */
export interface ScriptUsageWindow {
  readonly provider: string;
  readonly accountId: string;
  readonly account: string;
  readonly kind: string;
  readonly window: string;
  readonly windowId: string;
  readonly remainingPercent: number;
  readonly usedPercent: number;
  readonly resetsAt: string | null;
  /** CLIProxyAPI routing priority, or null when the account is not on a hub. */
  readonly priority: number | null;
}

export interface ScriptRun {
  readonly runId: string;
  readonly threadId: string;
  readonly title: string;
  readonly projectId: string;
  readonly project: string | null;
  readonly workspaceRoot: string | null;
  readonly provider: string | null;
  readonly providerInstanceId: string;
  readonly model: string | null;
  readonly delegated: boolean;
  readonly parentThreadId: string | null;
  readonly startedAt: string;
  readonly runningMinutes: number;
}

interface ScriptStop {
  readonly runId: string;
  /** Absent: the default reset time. Null: never continue automatically. */
  readonly resumeAt?: string | null;
  readonly message?: string;
}

interface ScriptPriority {
  readonly accountId: string;
  readonly priority: number;
}

interface ScriptDecision {
  readonly stops: ReadonlyArray<ScriptStop>;
  /** Last `setPriority` call per account. */
  readonly priorities: ReadonlyArray<ScriptPriority>;
  /** Shortest `checkAgainIn` the script asked for, in seconds. */
  readonly checkAgainInSeconds: number | null;
  /** JSON of the script's `state`, handed back on the next tick. */
  readonly stateJson: string;
}

const TIMEOUT_MS = 200;

const ScriptOutput = Schema.Union([
  Schema.Struct({ error: Schema.String }),
  Schema.Struct({
    stops: Schema.Array(
      Schema.Struct({
        runId: Schema.String,
        resumeAt: Schema.optional(Schema.NullOr(Schema.Union([Schema.String, Schema.Finite]))),
        message: Schema.optional(Schema.String),
      }),
    ),
    priorities: Schema.Array(Schema.Struct({ accountId: Schema.String, priority: Schema.Int })),
    checkAgainInSeconds: Schema.NullOr(Schema.Finite),
    state: Schema.String,
  }),
]);
const decodeOutput = Schema.decodeUnknownSync(Schema.fromJsonString(ScriptOutput));

/** Hub accounts appear in usage reports as `<source id>:<hub account id>`. */
export function hubAccountKey(sourceId: string, accountId: string): string {
  return `${sourceId}:${accountId}`;
}

export function scriptUsage(
  reports: ReadonlyArray<UsageLimitsReport>,
  sources: ReadonlyArray<UsageLimitSourceSnapshot>,
): ReadonlyArray<ScriptUsageWindow> {
  const priorities = new Map(
    sources.flatMap((source) =>
      source.accounts.map((account) => [
        hubAccountKey(source.id, account.id),
        account.priority ?? 0,
      ]),
    ),
  );
  return reports.flatMap((report) =>
    report.accounts.flatMap((account) =>
      limitsNotice(account.limits) !== null
        ? []
        : account.limits.windows.map((window) => {
            const used = Math.max(0, Math.min(100, window.usedPercent));
            return {
              provider: account.driver,
              accountId: account.id,
              account: account.label,
              kind: window.kind,
              window: window.label,
              windowId: window.id,
              remainingPercent: 100 - used,
              usedPercent: used,
              resetsAt: window.resetsAt ?? null,
              priority: priorities.get(account.id) ?? null,
            };
          }),
    ),
  );
}

// Only strings cross into the context and only a string comes out, even for errors, so the host
// never touches an object the script made. `codeGeneration` also blocks eval and `new Function`.
const HARNESS_HEAD = `(() => { "use strict"; try {
const __in = JSON.parse(__input);
const __state = JSON.parse(__stateJson);
const __priorities = new Map();
let __checkAgainIn = null;
const setPriority = (accountId, priority) => { __priorities.set(String(accountId), priority); };
const checkAgainIn = (seconds) => {
  if (typeof seconds === "number" && Number.isFinite(seconds))
    __checkAgainIn = __checkAgainIn === null ? seconds : Math.min(__checkAgainIn, seconds);
};
const __out = (function (usage, runs, now, state) {
`;
const HARNESS_TAIL = `
})(__in.usage, __in.runs, new Date(__in.nowMs), __state) ?? [];
if (!Array.isArray(__out)) throw new Error("Return an array of runs to stop, or nothing.");
return JSON.stringify({
  stops: __out.map((stop) => typeof stop === "string" ? { runId: stop } : {
    runId: stop.runId,
    resumeAt: stop.resumeAt instanceof Date ? stop.resumeAt.getTime() : stop.resumeAt,
    message: stop.message,
  }),
  priorities: [...__priorities].map(([accountId, priority]) => ({ accountId, priority })),
  checkAgainInSeconds: __checkAgainIn,
  state: JSON.stringify(__state),
});
} catch (error) {
  try { return JSON.stringify({ error: String((error && error.stack) || error) }); }
  catch { return '{"error":"The script threw a value that cannot be shown."}'; }
} })()`;
const HARNESS_HEAD_LINES = HARNESS_HEAD.split("\n").length - 1;

let compiled: { readonly source: string; readonly program: NodeVM.Script } | null = null;

function compile(script: string): NodeVM.Script {
  if (compiled?.source === script) return compiled.program;
  const program = new NodeVM.Script(`${HARNESS_HEAD}${script}${HARNESS_TAIL}`, {
    filename: "usage-pause-script.js",
    lineOffset: -HARNESS_HEAD_LINES,
  });
  compiled = { source: script, program };
  return program;
}

/**
 * Runs the user's script body with `usage`, `runs`, `now` and `state` in scope, plus
 * `setPriority(accountId, priority)` and `checkAgainIn(seconds)`. It returns the runs to stop;
 * `state` is any JSON the script keeps between ticks. Throws on any script error.
 */
export function runUsagePauseScript(
  script: string,
  input: {
    readonly usage: ReadonlyArray<ScriptUsageWindow>;
    readonly runs: ReadonlyArray<ScriptRun>;
    readonly nowMs: number;
  },
  stateJson: string,
): ScriptDecision {
  const context = NodeVM.createContext(
    { __input: JSON.stringify(input), __stateJson: stateJson },
    { codeGeneration: { strings: false, wasm: false }, microtaskMode: "afterEvaluate" },
  );
  const result: unknown = compile(script).runInContext(context, { timeout: TIMEOUT_MS });
  if (typeof result !== "string") throw new Error("The script returned an unreadable result.");
  const output = decodeOutput(result);
  if ("error" in output) throw new Error(output.error);
  return {
    stateJson: output.state,
    priorities: output.priorities,
    checkAgainInSeconds: output.checkAgainInSeconds,
    stops: output.stops.map(({ runId, resumeAt, message }) => ({
      runId,
      ...(resumeAt === undefined ? {} : { resumeAt: normalizeResumeAt(resumeAt) }),
      ...(message === undefined ? {} : { message }),
    })),
  };
}

function normalizeResumeAt(value: string | number | null): string | null {
  if (value === null) return null;
  const ms = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error(`resumeAt is not a time: ${String(value)}`);
  return DateTime.formatIso(DateTime.makeUnsafe(ms));
}

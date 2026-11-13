// @effect-diagnostics nodeBuiltinImport:off -- the bridge listens on a local socket the omp extension dials.
import * as NodeNet from "node:net";

import type { OrchestrationV2PendingBackgroundTask } from "@t3tools/contracts";
import type {
  AcpAdapterV2ExtensionContext,
  AcpAdapterV2SubagentUpdate,
} from "@t3tools/provider-acp/server/adapter";
import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import type { AcpToolCallState } from "@t3tools/provider-acp/server/runtimeModel";
import type { BackgroundWorkReport } from "@t3tools/provider-core/server/notification";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import type * as AcpSchema from "effect-acp/compat";

import {
  OMP_BRIDGE_EXTENSION_SOURCE,
  OMP_BRIDGE_PROTOCOL_VERSION,
  OMP_BRIDGE_SOCKET_ENV,
} from "./ompBridgeExtension.ts";

type Runtime = AcpSessionRuntime.AcpSessionRuntime["Service"];

/** omp is not in the ACP registry; local installs run `omp` or a wrapper named `omp-*`. */
export function isOmpCommand(commandPath: string): boolean {
  return /^omp(?:-[\w.-]+)?(?:\.exe|\.cmd)?$/i.test(commandPath.split(/[\\/]/).pop() ?? "");
}

const CHILD_SESSION_PREFIX = "omp:";
const MAIN_AGENT_PREFIX = "acp:";

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

const string = (value: unknown) => (typeof value === "string" ? value : undefined);

const PROGRESS_STATUS: Record<string, AcpAdapterV2SubagentUpdate["status"]> = {
  pending: "pending",
  running: "running",
  completed: "completed",
  failed: "failed",
  aborted: "cancelled",
};

/**
 * One card per `task` child. The tool call id keys a card, so a resumed agent in a later call
 * gets its own card; the agent id (`progress[].id`) links the card to the bridge's child events.
 */
export function extractOmpSubagentUpdates(
  tool: AcpToolCallState,
  bridged: boolean,
): ReadonlyArray<AcpAdapterV2SubagentUpdate> | undefined {
  if (tool.data.name !== "task") return undefined;
  const input = record(tool.data.rawInput);
  if (input === undefined) return undefined;
  const items = Array.isArray(input.tasks) ? input.tasks.map(record) : [input];
  const context = string(input.context)?.trim() || undefined;
  const details = record(record(tool.data.rawOutput)?.details);
  const progress = (Array.isArray(details?.progress) ? details.progress : []).map(record);
  const results = (Array.isArray(details?.results) ? details.results : []).map(record);
  return items.flatMap((item, index) => {
    const task = string(item?.task);
    if (task === undefined) return [];
    const live = progress.find((entry) => entry?.index === index);
    const settled = results.find((entry) => entry?.index === index);
    const agentId = string(live?.id) ?? string(settled?.id);
    const status =
      (live === undefined ? undefined : PROGRESS_STATUS[string(live.status) ?? ""]) ??
      (settled !== undefined
        ? settled.aborted === true
          ? "cancelled"
          : settled.exitCode === 0
            ? "completed"
            : "failed"
        : tool.status === "failed"
          ? "failed"
          : live === undefined
            ? "pending"
            : "running");
    const active = status === "pending" || status === "running";
    return [
      {
        nativeTaskId: `${tool.toolCallId}:${index}`,
        childSessionId: agentId === undefined ? null : `${CHILD_SESSION_PREFIX}${agentId}`,
        prompt: context === undefined ? task : `${context}\n\n${task}`,
        title: agentId ?? string(item?.name) ?? null,
        model: string(live?.resolvedModel) ?? string(settled?.resolvedModel) ?? null,
        status,
        result: active ? null : (string(settled?.output) ?? string(settled?.error) ?? null),
        stoppable: bridged && active && agentId !== undefined,
      },
    ];
  });
}

const BridgeAgent = Schema.Struct({
  id: Schema.String,
  parentId: Schema.NullOr(Schema.String),
  kind: Schema.String,
});
const BridgeJob = Schema.Struct({
  id: Schema.String,
  type: Schema.String,
  status: Schema.String,
  label: Schema.String,
  endTime: Schema.NullOr(Schema.Number),
});
const BridgeMessage = Schema.Union([
  Schema.Struct({ t: Schema.Literal("hello"), version: Schema.Number }),
  Schema.Struct({ t: Schema.Literal("closed") }),
  Schema.Struct({
    t: Schema.Literal("message"),
    agent: BridgeAgent,
    id: Schema.String,
    text: Schema.String,
  }),
  Schema.Struct({
    t: Schema.Literal("tool"),
    agent: BridgeAgent,
    phase: Schema.Literals(["start", "end"]),
    id: Schema.String,
    name: Schema.String,
    title: Schema.optional(Schema.String),
    args: Schema.optional(Schema.Unknown),
    output: Schema.optional(Schema.String),
    isError: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    t: Schema.Literal("end"),
    agent: BridgeAgent,
    status: Schema.Literals(["completed", "failed", "cancelled"]),
    result: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({
    t: Schema.Literal("jobs"),
    agent: BridgeAgent,
    running: Schema.Array(BridgeJob),
    recent: Schema.Array(BridgeJob),
    /** When omp's main agent last went idle; null while it runs a turn. */
    idleSince: Schema.NullOr(Schema.Number),
  }),
]);
type BridgeMessage = typeof BridgeMessage.Type;
type BridgeJob = typeof BridgeJob.Type;
const decodeBridgeLine = Schema.decodeUnknownOption(Schema.fromJsonString(BridgeMessage));
const CLOSED_LINE = '{"t":"closed"}';
const encodeCancel = Schema.encodeSync(
  Schema.fromJsonString(Schema.Struct({ t: Schema.Literal("cancel"), agentId: Schema.String })),
);

const TOOL_KINDS: Record<string, AcpSchema.ToolKind> = {
  bash: "execute",
  eval: "execute",
  read: "read",
  write: "edit",
  edit: "edit",
  delete: "delete",
  move: "move",
  grep: "search",
  glob: "search",
  web_search: "fetch",
};

interface OmpBridge {
  readonly extensionPath: string;
  readonly socketPath: string;
  readonly scope: Scope.Scope;
  readonly lines: Queue.Queue<string>;
  readonly sockets: Set<NodeNet.Socket>;
  connected: boolean;
  bound: boolean;
}

interface OmpSessionJobs {
  running: ReadonlyMap<string, BridgeJob>;
  readonly unseen: Map<string, BackgroundWorkReport>;
}

interface OmpConsumerState {
  readonly jobs: Map<string, OmpSessionJobs>;
  /** Direct children seen since their start, keyed by agent id, with their root session. */
  readonly liveChildren: Map<string, string>;
  readonly toolStarts: Map<
    string,
    { readonly title: string; readonly kind: AcpSchema.ToolKind; readonly rawInput: unknown }
  >;
}

function jobReport(job: BridgeJob, settled: BridgeJob | undefined): BackgroundWorkReport {
  const outcome =
    settled?.status === "completed" ||
    settled?.status === "failed" ||
    settled?.status === "cancelled"
      ? settled.status
      : "unknown";
  return job.type === "task"
    ? { kind: "subagent", label: job.label, outcome }
    : { kind: "command", label: job.label, outcome };
}

/** Prepares one omp launch: the spawn to run and how to tie the started runtime to its bridge. */
export type OmpLaunch = (spawn: AcpSessionRuntime.AcpSpawnInput) => Effect.Effect<
  {
    readonly spawn: AcpSessionRuntime.AcpSpawnInput;
    readonly attach: (runtime: Runtime) => void;
  },
  never,
  Scope.Scope
>;

/**
 * One bridge per omp process: T3 writes the extension next to a socket, passes both on the
 * command line, and maps what the extension reports onto the root session's child threads
 * and background roster. Without a connected bridge omp still works from ACP data alone.
 */
export function makeOmpBridgeHost(testHooks?: {
  /** Runs after each bridge message is applied. */
  readonly onHandled?: (type: BridgeMessage["t"]) => Effect.Effect<void>;
}) {
  const bridges = new WeakMap<Runtime, OmpBridge>();

  const open = Effect.fn("OmpBridge.open")(function* (
    fileSystem: FileSystem.FileSystem,
    path: Path.Path,
  ) {
    const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-omp-" });
    const extensionPath = path.join(directory, "t3-bridge.mjs");
    yield* fileSystem.writeFileString(extensionPath, OMP_BRIDGE_EXTENSION_SOURCE);
    // Unix socket only: the fork targets Linux.
    const socketPath = path.join(directory, "bridge.sock");
    const lines = yield* Queue.unbounded<string>();
    const bridge: OmpBridge = {
      extensionPath,
      socketPath,
      scope: yield* Effect.scope,
      lines,
      sockets: new Set(),
      connected: false,
      bound: false,
    };
    const server = NodeNet.createServer((socket) => {
      bridge.sockets.add(socket);
      socket.setEncoding("utf8");
      let pending = "";
      socket.on("data", (chunk: string) => {
        pending += chunk;
        let index: number;
        while ((index = pending.indexOf("\n")) >= 0) {
          Queue.offerUnsafe(lines, pending.slice(0, index));
          pending = pending.slice(index + 1);
        }
      });
      socket.on("error", () => socket.destroy());
      socket.on("close", () => {
        bridge.sockets.delete(socket);
        if (bridge.sockets.size === 0) Queue.offerUnsafe(lines, CLOSED_LINE);
      });
    });
    yield* Effect.acquireRelease(
      Effect.callback<void, Error>((resume) => {
        server.once("error", (error) => resume(Effect.fail(error)));
        server.listen(socketPath, () => resume(Effect.void));
      }),
      () =>
        Effect.sync(() => {
          for (const socket of bridge.sockets) socket.destroy();
          server.close();
        }),
    );
    return bridge;
  });

  const connected = (runtime: Runtime | undefined) =>
    runtime !== undefined && bridges.get(runtime)?.connected === true;

  const publishJobs = Effect.fn("OmpBridge.publishJobs")(function* (
    context: AcpAdapterV2ExtensionContext,
    jobs: Map<string, OmpSessionJobs>,
    sessionId: string,
    message: Extract<BridgeMessage, { readonly t: "jobs" }>,
  ) {
    const state = jobs.get(sessionId) ?? { running: new Map(), unseen: new Map() };
    jobs.set(sessionId, state);
    // omp never wakes itself over ACP. A job that ends during omp's turn is drained into it;
    // one that ends after the turn waits for the next prompt, so T3 sends one.
    const idleSince = message.idleSince;
    if (idleSince === null) state.unseen.clear();
    const running = new Map(message.running.map((job) => [job.id, job] as const));
    for (const [id, job] of state.running) {
      if (running.has(id) || idleSince === null) continue;
      const settled = message.recent.find((recent) => recent.id === id);
      // shortcut: a result omp drains right after its turn ends still gets one extra wake turn; upgrade if omp reports per-job delivery.
      if (settled?.endTime != null && settled.endTime < idleSince) continue;
      state.unseen.set(id, jobReport(job, settled));
    }
    state.running = running;
    const tasks: Array<OrchestrationV2PendingBackgroundTask> = message.running.map((job) => {
      const description = job.label.trim();
      return {
        taskId: job.id,
        kind: job.type === "task" ? "subagent" : "command",
        ...(description.length === 0 ? {} : { description }),
        // omp delivers every job's result and resumes from it, so each one holds the thread.
        awaited: true,
      };
    });
    yield* context.publishBackgroundTasks({ sessionId, tasks });
    if (running.size > 0 || state.unseen.size === 0) return;
    const settled = [...state.unseen];
    state.unseen.clear();
    const labels = settled.flatMap(([, report]) => (report.label ? [report.label] : []));
    yield* context.requestWakeTurn({
      sessionId,
      detail: `Background work finished${labels.length === 0 ? "" : `: ${labels.join(", ")}`}. Continue with its results.`,
      // A task job's card reports its own outcome; omp records an aborted job as failed.
      reports: settled.filter(([, report]) => report.kind !== "subagent"),
    });
  });

  const handle = Effect.fn("OmpBridge.handle")(function* (
    bridge: OmpBridge,
    context: AcpAdapterV2ExtensionContext,
    state: OmpConsumerState,
    message: BridgeMessage,
  ) {
    if (message.t === "hello") {
      bridge.connected = message.version === OMP_BRIDGE_PROTOCOL_VERSION;
      if (!bridge.connected) {
        yield* Effect.logWarning("omp bridge protocol mismatch; using ACP data only", {
          version: message.version,
        });
      }
      return;
    }
    if (message.t === "closed") {
      if (!bridge.connected) return;
      bridge.connected = false;
      // Nothing will report these children again; do not leave the turn waiting on them.
      for (const [agentId, sessionId] of state.liveChildren) {
        yield* context.finishSubagent({
          sessionId,
          childSessionId: `${CHILD_SESSION_PREFIX}${agentId}`,
          status: "failed",
          result: "Lost contact with omp.",
        });
      }
      state.liveChildren.clear();
      state.toolStarts.clear();
      for (const sessionId of state.jobs.keys()) {
        yield* context.publishBackgroundTasks({ sessionId, tasks: [] });
      }
      state.jobs.clear();
      return;
    }
    if (!bridge.connected) return;
    if (message.t === "jobs") {
      if (!message.agent.id.startsWith(MAIN_AGENT_PREFIX)) return;
      const sessionId = message.agent.id.slice(MAIN_AGENT_PREFIX.length);
      return yield* publishJobs(context, state.jobs, sessionId, message);
    }
    // Cards exist only for direct children of the ACP session; deeper agents show in their parent's rows.
    const parentId = message.agent.parentId;
    if (message.agent.kind !== "sub" || parentId?.startsWith(MAIN_AGENT_PREFIX) !== true) return;
    const sessionId = parentId.slice(MAIN_AGENT_PREFIX.length);
    const childSessionId = `${CHILD_SESSION_PREFIX}${message.agent.id}`;
    if (message.t === "end") {
      state.liveChildren.delete(message.agent.id);
      return yield* context.finishSubagent({
        sessionId,
        childSessionId,
        status: message.status,
        result: message.result,
      });
    }
    state.liveChildren.set(message.agent.id, sessionId);
    if (message.t === "message") {
      return yield* context.injectSessionUpdate({
        sessionId: childSessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: message.id,
          content: { type: "text", text: message.text },
        },
      });
    }
    const key = `${message.agent.id}:${message.id}`;
    // The adapter re-derives a row's title from each update, so the end repeats the start's fields.
    const start =
      message.phase === "start"
        ? {
            title: message.title ?? message.name,
            kind: TOOL_KINDS[message.name] ?? "other",
            rawInput: message.args,
          }
        : (state.toolStarts.get(key) ?? {
            title: message.title ?? message.name,
            kind: TOOL_KINDS[message.name] ?? "other",
            rawInput: undefined,
          });
    if (message.phase === "start") state.toolStarts.set(key, start);
    else state.toolStarts.delete(key);
    yield* context.injectSessionUpdate({
      sessionId: childSessionId,
      update:
        message.phase === "start"
          ? { sessionUpdate: "tool_call", toolCallId: message.id, status: "in_progress", ...start }
          : {
              sessionUpdate: "tool_call_update",
              toolCallId: message.id,
              ...start,
              status: message.isError === true ? "failed" : "completed",
              ...(message.output === undefined || message.output.length === 0
                ? {}
                : {
                    content: [{ type: "content", content: { type: "text", text: message.output } }],
                  }),
            },
    });
  });

  const consume = (bridge: OmpBridge, context: AcpAdapterV2ExtensionContext) => {
    const state: OmpConsumerState = {
      jobs: new Map(),
      liveChildren: new Map(),
      toolStarts: new Map(),
    };
    return Queue.take(bridge.lines).pipe(
      Effect.flatMap((line) =>
        Option.match(decodeBridgeLine(line), {
          onNone: () => Effect.void,
          onSome: (message) =>
            handle(bridge, context, state, message).pipe(
              Effect.andThen(testHooks?.onHandled?.(message.t) ?? Effect.void),
            ),
        }),
      ),
      Effect.catchCause((cause) => Effect.logWarning("omp bridge message failed", { cause })),
      Effect.forever,
    );
  };

  return {
    /** Opens a bridge for one omp launch; it closes with the launch scope. Without it omp still starts. */
    launch:
      (fileSystem: FileSystem.FileSystem, path: Path.Path): OmpLaunch =>
      (spawn) =>
        open(fileSystem, path).pipe(
          Effect.map((bridge) => ({
            spawn: {
              ...spawn,
              args: [...spawn.args, "--extension", bridge.extensionPath],
              env: { ...spawn.env, [OMP_BRIDGE_SOCKET_ENV]: bridge.socketPath },
            },
            attach: (runtime: Runtime) => {
              bridges.set(runtime, bridge);
            },
          })),
          Effect.catchCause((cause) =>
            Effect.logWarning("omp bridge unavailable; using ACP data only", { cause }).pipe(
              Effect.as({ spawn, attach: () => {} }),
            ),
          ),
        ),
    connected,
    registerExtensions: (context: AcpAdapterV2ExtensionContext) => {
      const bridge = bridges.get(context.runtime);
      if (bridge === undefined || bridge.bound) return Effect.void;
      bridge.bound = true;
      return consume(bridge, context).pipe(Effect.forkIn(bridge.scope), Effect.asVoid);
    },
    extractSubagentUpdate: (tool: AcpToolCallState, runtime?: Runtime) =>
      extractOmpSubagentUpdates(tool, connected(runtime)),
    stopSubagent: (input: { readonly runtime: Runtime; readonly childSessionId: string }) =>
      Effect.sync(() => {
        const bridge = bridges.get(input.runtime);
        if (bridge?.connected !== true || !input.childSessionId.startsWith(CHILD_SESSION_PREFIX)) {
          return false;
        }
        const line = `${encodeCancel({
          t: "cancel",
          agentId: input.childSessionId.slice(CHILD_SESSION_PREFIX.length),
        })}\n`;
        for (const socket of bridge.sockets) socket.write(line);
        return bridge.sockets.size > 0;
      }),
  };
}

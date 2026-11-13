/**
 * Bumped on any wire change; T3 ignores a bridge that says another version.
 * The extension source is embedded so it ships inside every server build, single executables included.
 */
export const OMP_BRIDGE_PROTOCOL_VERSION = 1;

/** Environment variable that tells the extension where T3's bridge socket listens. */
export const OMP_BRIDGE_SOCKET_ENV = "T3_OMP_BRIDGE_SOCKET";

// Plain ESM for omp's extension loader. omp loads one module per process and binds the
// factory to every session in it (main and each subagent), so module state is shared.
export const OMP_BRIDGE_EXTENSION_SOURCE = `import * as net from "node:net";

const VERSION = ${OMP_BRIDGE_PROTOCOL_VERSION};
const OUTPUT_LIMIT = 16000;
const socketPath = process.env.${OMP_BRIDGE_SOCKET_ENV};
const children = new Map();
let socket;
let pending = "";

function send(message) {
  if (socket !== undefined) socket.write(JSON.stringify(message) + "\\n");
}

function connect() {
  if (socket !== undefined || !socketPath) return;
  socket = net.createConnection(socketPath);
  socket.setEncoding("utf8");
  socket.unref();
  socket.on("error", () => {});
  socket.on("close", () => {
    socket = undefined;
  });
  socket.on("data", (chunk) => {
    pending += chunk;
    let index;
    while ((index = pending.indexOf("\\n")) >= 0) {
      const line = pending.slice(0, index);
      pending = pending.slice(index + 1);
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message && message.t === "cancel") {
        const ctx = children.get(message.agentId);
        if (ctx !== undefined) Promise.resolve(ctx.abort()).catch(() => {});
      }
    }
  });
  send({ t: "hello", version: VERSION });
}

function who(ctx) {
  const agent = ctx.agent;
  return { id: agent.id, parentId: agent.parentId ?? null, kind: agent.kind };
}

function text(value) {
  const content = value && value.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

function clip(value) {
  return value.length > OUTPUT_LIMIT ? value.slice(0, OUTPUT_LIMIT) + "\\n[truncated]" : value;
}

function job(item) {
  return {
    id: item.id,
    type: item.type,
    status: item.status,
    label: item.label ?? "",
    endTime: item.endTime ?? null,
  };
}

let nextMessage = 0;

export default function t3Bridge(pi) {
  connect();
  // The main agent's turn state: a job that ends while it is idle waits for the next prompt.
  let mainRunning = false;
  let idleSince = Date.now();

  pi.on("session_start", (_event, ctx) => {
    if (ctx.agent.kind === "sub") {
      children.set(ctx.agent.id, ctx);
      return;
    }
    if (ctx.agent.kind !== "main") return;
    // omp reports no event when a background job settles, so watch the roster.
    let last = "";
    ctx.setInterval(() => {
      const snapshot = ctx.getAsyncJobSnapshot();
      if (!snapshot) return;
      const running = snapshot.running.map(job);
      const key = JSON.stringify(running);
      if (key === last) return;
      last = key;
      send({
        t: "jobs",
        agent: who(ctx),
        running,
        recent: snapshot.recent.map(job),
        idleSince: mainRunning ? null : idleSince,
      });
    }, 1000);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx.agent.kind === "sub") children.delete(ctx.agent.id);
  });

  pi.on("agent_start", (_event, ctx) => {
    if (ctx.agent.kind === "main") mainRunning = true;
    if (ctx.agent.kind === "sub") children.set(ctx.agent.id, ctx);
  });

  pi.on("message_end", (event, ctx) => {
    if (ctx.agent.kind !== "sub" || event.message.role !== "assistant") return;
    const body = text(event.message);
    if (body.trim().length === 0) return;
    nextMessage += 1;
    send({ t: "message", agent: who(ctx), id: "m" + nextMessage, text: body });
  });

  pi.on("tool_execution_start", (event, ctx) => {
    if (ctx.agent.kind !== "sub") return;
    send({
      t: "tool",
      agent: who(ctx),
      phase: "start",
      id: event.toolCallId,
      name: event.toolName,
      title: event.intent ?? event.toolName,
      args: event.args,
    });
  });

  pi.on("tool_execution_end", (event, ctx) => {
    if (ctx.agent.kind !== "sub") return;
    send({
      t: "tool",
      agent: who(ctx),
      phase: "end",
      id: event.toolCallId,
      name: event.toolName,
      output: clip(text(event.result)),
      isError: event.isError === true,
    });
  });

  pi.on("agent_end", (event, ctx) => {
    if (ctx.agent.kind === "main") {
      mainRunning = false;
      idleSince = Date.now();
      return;
    }
    // A settle that waits on the child's own background jobs is a pause, not its end.
    if (ctx.agent.kind !== "sub" || event.willContinue === true) return;
    const last = [...event.messages].reverse().find((message) => message.role === "assistant");
    const status =
      last && last.stopReason === "aborted"
        ? "cancelled"
        : last && last.stopReason === "error"
          ? "failed"
          : "completed";
    const result = last ? text(last) || last.errorMessage || null : null;
    send({ t: "end", agent: who(ctx), status, result: result === null ? null : clip(result) });
  });
}
`;

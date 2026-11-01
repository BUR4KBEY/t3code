// @effect-diagnostics nodeBuiltinImport:off -- One bounded synchronous /proc read, like the cgroup helpers in AcpSessionRuntime.ts.
import type { OrchestrationV2AgentDevenv } from "@t3tools/contracts";
import * as NodeFS from "node:fs";

/**
 * Reads the devenv shell from the environment `pid` was exec'd with, which
 * excludes variables the agent later loads for its subprocesses. `undefined`:
 * unreadable (no /proc, process gone); `null`: neither DEVENV_ROOT nor
 * DEVSHELL_NAME is set.
 */
export function readAgentDevenv(
  pid: number | undefined,
): OrchestrationV2AgentDevenv | null | undefined {
  if (pid === undefined || !Number.isInteger(pid) || pid <= 0) return undefined;
  let environ: string;
  try {
    environ = NodeFS.readFileSync(`/proc/${pid}/environ`, "utf8");
  } catch {
    return undefined;
  }
  let root: string | null = null;
  let name: string | null = null;
  for (const entry of environ.split("\0")) {
    const separator = entry.indexOf("=");
    if (separator < 0) continue;
    const value = entry.slice(separator + 1).trim();
    if (value.length === 0) continue;
    const key = entry.slice(0, separator);
    if (key === "DEVENV_ROOT") root = value;
    else if (key === "DEVSHELL_NAME") name = value;
  }
  return root === null && name === null ? null : { name };
}

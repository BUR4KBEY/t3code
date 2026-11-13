import { assert, describe, it } from "@effect/vitest";
import type { AcpToolCallState } from "@t3tools/provider-acp/server/runtimeModel";

import { extractOmpSubagentUpdates, isOmpCommand } from "./ompAcp.ts";

const taskCall = (
  toolCallId: string,
  data: { readonly rawInput: unknown; readonly rawOutput?: unknown },
  status?: AcpToolCallState["status"],
): AcpToolCallState => ({
  toolCallId,
  ...(status === undefined ? {} : { status }),
  data: { name: "task", ...data },
});

describe("extractOmpSubagentUpdates", () => {
  it("maps each batch child to its own card from rawInput and progress", () => {
    const rawInput = {
      context: "Shared brief.",
      tasks: [
        { name: "Alpha", agent: "task", task: "Do A." },
        { name: "Beta", agent: "task", task: "Do B." },
        { name: "Gamma", agent: "task", task: "Do C." },
      ],
    };
    // Before omp reports progress, cards exist with no agent link yet.
    assert.deepEqual(
      extractOmpSubagentUpdates(taskCall("call-1", { rawInput }, "pending"), true)?.map(
        (update) => [update.nativeTaskId, update.childSessionId, update.title, update.status],
      ),
      [
        ["call-1:0", null, "Alpha", "pending"],
        ["call-1:1", null, "Beta", "pending"],
        ["call-1:2", null, "Gamma", "pending"],
      ],
    );

    const updates = extractOmpSubagentUpdates(
      taskCall(
        "call-1",
        {
          rawInput,
          rawOutput: {
            details: {
              async: { state: "running", jobId: "Alpha", type: "task" },
              progress: [
                { index: 0, id: "Alpha", status: "running", resolvedModel: "anthropic/haiku" },
                { index: 1, id: "Beta", status: "completed" },
                { index: 2, id: "Gamma", status: "aborted" },
              ],
              results: [
                { index: 1, id: "Beta", exitCode: 0, output: "BETA" },
                { index: 2, id: "Gamma", exitCode: 1, aborted: true, output: "" },
              ],
            },
          },
        },
        // omp marks the async call completed while its children still run.
        "completed",
      ),
      true,
    );
    assert.deepEqual(
      updates?.map((update) => ({
        id: update.nativeTaskId,
        child: update.childSessionId,
        prompt: update.prompt,
        model: update.model,
        status: update.status,
        result: update.result,
        stoppable: update.stoppable,
      })),
      [
        {
          id: "call-1:0",
          child: "omp:Alpha",
          prompt: "Shared brief.\n\nDo A.",
          model: "anthropic/haiku",
          status: "running",
          result: null,
          stoppable: true,
        },
        {
          id: "call-1:1",
          child: "omp:Beta",
          prompt: "Shared brief.\n\nDo B.",
          model: null,
          status: "completed",
          result: "BETA",
          stoppable: false,
        },
        {
          id: "call-1:2",
          child: "omp:Gamma",
          prompt: "Shared brief.\n\nDo C.",
          model: null,
          status: "cancelled",
          result: "",
          stoppable: false,
        },
      ],
    );
  });

  it("gives a resumed agent a new card and offers Stop only with the bridge", () => {
    const resumed = (toolCallId: string, bridged: boolean) =>
      extractOmpSubagentUpdates(
        taskCall(toolCallId, {
          rawInput: { agent: "task", task: "Continue." },
          rawOutput: { details: { progress: [{ index: 0, id: "Alpha", status: "running" }] } },
        }),
        bridged,
      )?.[0];
    const first = resumed("call-1", true);
    const second = resumed("call-2", false);
    assert.equal(first?.childSessionId, second?.childSessionId);
    assert.notEqual(first?.nativeTaskId, second?.nativeTaskId);
    assert.isTrue(first?.stoppable);
    assert.isFalse(second?.stoppable);
    assert.isUndefined(
      extractOmpSubagentUpdates(
        { toolCallId: "bash-1", data: { name: "bash", rawInput: { task: "ls" } } },
        true,
      ),
    );
  });
});

describe("isOmpCommand", () => {
  it("recognizes omp and its wrappers by executable name", () => {
    assert.deepEqual(
      ["omp", "/usr/bin/omp", "/home/u/.local/bin/omp-devenv", "C:\\bin\\omp.exe", "omp.cmd"].map(
        isOmpCommand,
      ),
      [true, true, true, true, true],
    );
    assert.deepEqual(["opencode", "comp", "/bin/ompx", "pi"].map(isOmpCommand), [
      false,
      false,
      false,
      false,
    ]);
  });
});

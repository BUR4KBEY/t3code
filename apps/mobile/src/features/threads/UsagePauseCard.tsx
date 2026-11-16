import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { AsyncResult } from "effect/reactivity";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { activeUsagePause } from "@t3tools/client-runtime/state/thread-execution";
import type { EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";
import { Pressable, View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";

export function UsagePauseCard({
  thread,
  environmentId,
}: {
  thread: EnvironmentThreadShell;
  environmentId: EnvironmentId;
}) {
  const updateMetadata = useAtomCommand(threadEnvironment.updateMetadata);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pause = activeUsagePause(thread.source);
  if (pause === null) return null;
  async function cancel() {
    setPending(true);
    setError(null);
    const result = await updateMetadata({
      environmentId,
      input: { threadId: thread.id, usagePause: null },
    });
    setPending(false);
    if (AsyncResult.isFailure(result)) {
      const cause = squashAtomCommandFailure(result);
      setError(cause instanceof Error ? cause.message : "Could not cancel automatic continuation.");
    }
  }
  return (
    <View className="mx-3 mb-2 gap-1 rounded-xl border border-warning-foreground/25 bg-screen p-3">
      <Text className="text-sm text-warning-foreground">
        {pause.resumeAt === null
          ? "Paused at your usage threshold. No reset time is known; continue when you're ready."
          : `Paused at your usage threshold. Continues automatically ${new Date(
              pause.resumeAt,
            ).toLocaleString(undefined, {
              month: "short",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
            })}.`}
      </Text>
      {pause.resumeAt === null ? null : (
        // The margins cancel the 44pt touch height so the link sits 8pt under the text.
        <View className="-mb-3 -mt-2 flex-row">
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: pending }}
            disabled={pending}
            hitSlop={{ left: 8, right: 8 }}
            onPress={() => void cancel()}
            className="min-h-11 justify-center active:opacity-70"
          >
            <Text
              className={
                pending
                  ? "text-sm font-t3-medium text-foreground-muted"
                  : "text-sm font-t3-medium text-primary"
              }
            >
              Don't continue automatically
            </Text>
          </Pressable>
        </View>
      )}
      {error ? (
        <Text accessibilityRole="alert" className="text-sm text-destructive">
          {error}
        </Text>
      ) : null}
    </View>
  );
}

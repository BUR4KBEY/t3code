import { type OrchestrationV2UsagePause } from "@t3tools/contracts";
import { type TimestampFormat } from "@t3tools/contracts/settings";
import { PauseCircleIcon } from "lucide-react";
import { useState } from "react";
import { InlineButton } from "../ui/button";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import { toastManager } from "../ui/toast";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

export function usagePauseBannerItem(props: {
  pause: OrchestrationV2UsagePause;
  timestampFormat: TimestampFormat;
  onCancel: () => Promise<void>;
}): ComposerBannerStackItem {
  const { pause, timestampFormat, onCancel } = props;
  return {
    id: `usage-pause:${pause.runId}`,
    variant: "warning",
    group: "environment",
    icon: <PauseCircleIcon />,
    title: "Paused at your usage threshold",
    description:
      pause.resumeAt === null
        ? "No reset time is known; continue when you're ready."
        : `Continues automatically ${formatUpcomingTimestamp(pause.resumeAt, timestampFormat)}.`,
    actions: pause.resumeAt === null ? null : <CancelAction onCancel={onCancel} />,
  };
}

function CancelAction({ onCancel }: { onCancel: () => Promise<void> }) {
  const [pending, setPending] = useState(false);
  async function cancel() {
    setPending(true);
    try {
      await onCancel();
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: "Could not cancel automatic continuation",
        description: cause instanceof Error ? cause.message : "An error occurred.",
      });
    }
    setPending(false);
  }
  return (
    <span className="px-1">
      <InlineButton touchTarget="padded" disabled={pending} onClick={() => void cancel()}>
        {pending ? "Saving..." : "Don't continue automatically"}
      </InlineButton>
    </span>
  );
}

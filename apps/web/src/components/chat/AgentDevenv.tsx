import type { OrchestrationV2AgentDevenv } from "@t3tools/contracts";

import { DevenvIcon } from "../Icons";
import { Badge } from "../ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LABEL_CLASS,
  THREAD_DETAILS_PANEL_LOCKED_ROW_CLASS,
} from "./threadDetailsPanelStyles";

function describeAgentDevenv(devenv: OrchestrationV2AgentDevenv) {
  return devenv.name
    ? `The agent process runs in devenv with DEVSHELL_NAME=${devenv.name}`
    : "The agent process runs in devenv";
}

/** The thread's own agent process, as a thread details row. */
export function AgentDevenvRow({ devenv }: { devenv: OrchestrationV2AgentDevenv }) {
  return (
    <Tooltip>
      <TooltipTrigger
        delay={200}
        render={
          <span
            className={`flex items-center ${THREAD_DETAILS_PANEL_LOCKED_ROW_CLASS}`}
            data-agent-devenv
          />
        }
      >
        <DevenvIcon aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />
        <span className={`min-w-0 truncate ${THREAD_DETAILS_PANEL_LABEL_CLASS}`}>
          {devenv.name ? `devenv · ${devenv.name}` : "devenv"}
        </span>
      </TooltipTrigger>
      <TooltipPopup side="left">{describeAgentDevenv(devenv)}</TooltipPopup>
    </Tooltip>
  );
}

/** A related thread's agent process, inside its lineage row. The row's own hover card stays the tooltip. */
export function AgentDevenvPill({ devenv }: { devenv: OrchestrationV2AgentDevenv }) {
  return (
    <Badge variant="outline" size="sm" className="min-w-0 max-w-24 shrink" data-agent-devenv>
      <DevenvIcon role="img" aria-label="devenv" className="size-3.5" />
      {devenv.name ? <span className="truncate">{devenv.name}</span> : null}
    </Badge>
  );
}

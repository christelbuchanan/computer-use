import type { TaskEvent } from "../../../shared/types";
import { ChevronDown, ChevronRight } from "lucide-react";
import { getEffectiveTaskEventType } from "../../utils/task-event-compat";

export interface ActionBlockSummary {
  /** Short summary for collapsed header, e.g. "Explored 7 files, 6 searches" */
  summary: string;
  /** Total number of actions in the block */
  actionCount: number;
}

/**
 * Build a human-readable summary for a block of tool/step events.
 */
export function buildActionBlockSummary(events: TaskEvent[]): ActionBlockSummary {
  const toolCounts = new Map<string, number>();
  let stepCount = 0;

  for (const event of events) {
    const effectiveType = getEffectiveTaskEventType(event);
    const payload = event.payload && typeof event.payload === "object" ? event.payload : {};
    const tool = typeof (payload as Record<string, unknown>).tool === "string"
      ? ((payload as Record<string, unknown>).tool as string)
      : "";

    if (effectiveType === "tool_call" && tool) {
      toolCounts.set(tool, (toolCounts.get(tool) || 0) + 1);
    } else if (
      effectiveType === "step_started" ||
      effectiveType === "step_completed" ||
      effectiveType === "step_failed" ||
      event.type === "timeline_step_started" ||
      event.type === "timeline_step_updated" ||
      event.type === "timeline_step_finished"
    ) {
      stepCount += 1;
    }
  }

  const parts: string[] = [];
  const readFiles = (toolCounts.get("read_file") || 0) + (toolCounts.get("list_directory") || 0);
  const searches = (toolCounts.get("grep") || 0) + (toolCounts.get("search_files") || 0);
  const writes = (toolCounts.get("write_file") || 0) + (toolCounts.get("edit_file") || 0);

  if (readFiles > 0 && searches > 0) {
    parts.push(`Explored ${readFiles} file${readFiles === 1 ? "" : "s"}, ${searches} search${searches === 1 ? "" : "es"}`);
  } else if (readFiles > 0) {
    parts.push(`${readFiles} file${readFiles === 1 ? "" : "s"} read`);
  } else if (searches > 0) {
    parts.push(`${searches} search${searches === 1 ? "" : "es"}`);
  }
  if (writes > 0) parts.push(`${writes} file${writes === 1 ? "" : "s"} modified`);
  if (stepCount > 0 && parts.length === 0) parts.push(`${stepCount} step${stepCount === 1 ? "" : "s"}`);

  const totalTools = Array.from(toolCounts.values()).reduce((a, b) => a + b, 0);
  const summary =
    parts.length > 0
      ? parts.join(", ")
      : totalTools > 0
        ? `${totalTools} action${totalTools === 1 ? "" : "s"}`
        : `${events.length} step${events.length === 1 ? "" : "s"}`;

  return {
    summary,
    actionCount: totalTools + stepCount || events.length,
  };
}

interface ActionBlockProps {
  blockId: string;
  summary: string;
  actionCount: number;
  isActive: boolean;
  expanded: boolean;
  onToggle: () => void;
  showConnectorAbove?: boolean;
  showConnectorBelow?: boolean;
  children: React.ReactNode;
}

/**
 * Collapsible block for actions (tool calls, steps) between assistant messages.
 * Cursor-style: expanded while active, collapsed when next assistant message arrives.
 */
export function ActionBlock({
  blockId,
  summary,
  actionCount,
  isActive,
  expanded,
  onToggle,
  showConnectorAbove = false,
  showConnectorBelow = false,
  children,
}: ActionBlockProps) {
  return (
    <div className={`action-block timeline-event ${expanded ? "expanded" : "collapsed"} ${isActive ? "active" : ""}`}>
      <div className="event-indicator action-block-indicator">
        {showConnectorAbove && <span className="event-connector event-connector-above" aria-hidden="true" />}
        <span className="action-block-dot" aria-hidden="true" />
        {showConnectorBelow && <span className="event-connector event-connector-below" aria-hidden="true" />}
      </div>
      <div className="action-block-body event-content">
      <button
        type="button"
        className="action-block-header"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-controls={`action-block-content-${blockId}`}
        id={`action-block-toggle-${blockId}`}
      >
        <span className="action-block-chevron" aria-hidden="true">
          {expanded ? (
            <ChevronDown size={14} strokeWidth={2.5} />
          ) : (
            <ChevronRight size={14} strokeWidth={2.5} />
          )}
        </span>
        <span className="action-block-summary">{summary}</span>
        {actionCount > 0 && (
          <span className="action-block-count">
            {actionCount} action{actionCount === 1 ? "" : "s"}
          </span>
        )}
      </button>
      <div
        id={`action-block-content-${blockId}`}
        className="action-block-content"
        role="region"
        aria-labelledby={`action-block-toggle-${blockId}`}
        hidden={!expanded}
      >
        {expanded && <div className="action-block-events">{children}</div>}
      </div>
      </div>
    </div>
  );
}

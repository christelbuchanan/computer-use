import { describe, expect, it, vi } from "vitest";

import { createTimelineEmitter } from "../timeline-emitter";

describe("TimelineEmitter", () => {
  it("emits grouped tool-lane start events with maxParallel metadata", () => {
    const emit = vi.fn();
    const timeline = createTimelineEmitter("task-1", emit);

    timeline.startGroupLane("tools:step-1:batch-1", {
      label: "Tool batch (3)",
      maxParallel: 3,
      actor: "tool",
    });

    expect(emit).toHaveBeenCalledWith(
      "timeline_group_started",
      expect.objectContaining({
        groupId: "tools:step-1:batch-1",
        groupLabel: "Tool batch (3)",
        maxParallel: 3,
        actor: "tool",
        status: "in_progress",
      }),
    );
  });

  it("emits grouped tool-lane finish events with failed status when requested", () => {
    const emit = vi.fn();
    const timeline = createTimelineEmitter("task-1", emit);

    timeline.finishGroupLane("tools:step-1:batch-1", {
      label: "Tool batch",
      status: "failed",
      actor: "tool",
    });

    expect(emit).toHaveBeenCalledWith(
      "timeline_group_finished",
      expect.objectContaining({
        groupId: "tools:step-1:batch-1",
        groupLabel: "Tool batch",
        status: "failed",
        legacyType: "step_failed",
      }),
    );
  });
});


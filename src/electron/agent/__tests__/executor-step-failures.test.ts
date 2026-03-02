/**
 * Tests for step failure/verification behavior in TaskExecutor.executeStep
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { TaskExecutor } from "../executor";
import type { LLMResponse } from "../llm";

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn().mockReturnValue("/tmp"),
  },
}));

vi.mock("../../settings/personality-manager", () => ({
  PersonalityManager: {
    getPersonalityPrompt: vi.fn().mockReturnValue(""),
    getIdentityPrompt: vi.fn().mockReturnValue(""),
  },
}));

vi.mock("../../memory/MemoryService", () => ({
  MemoryService: {
    getContextForInjection: vi.fn().mockReturnValue(""),
  },
}));

function toolUseResponse(name: string, input: Record<string, Any>): LLMResponse {
  return {
    stopReason: "tool_use",
    content: [
      {
        type: "tool_use",
        id: `tool-${name}`,
        name,
        input,
      },
    ],
  };
}

function textResponse(text: string): LLMResponse {
  return {
    stopReason: "end_turn",
    content: [
      {
        type: "text",
        text,
      },
    ],
  };
}

function applyExecutorFieldDefaults(executor: Any): void {
  executor.testRunObserved = false;
  executor.executionToolRunObserved = false;
  executor.executionToolAttemptObserved = false;
  executor.executionToolLastError = "";
  executor.allowExecutionWithoutShell = false;
  executor.totalToolCallCount = 0;
  executor.webSearchToolCallCount = 0;
  executor.webSearchMode = "live";
  executor.webSearchMaxUsesPerTask = 8;
  executor.webSearchMaxUsesPerStep = 3;
  executor.webSearchAllowedDomains = [];
  executor.webSearchBlockedDomains = [];
  executor.toolSemanticsV2Enabled = true;
  executor.mutationEvidenceV2Enabled = true;
  executor.providerRetryV2Enabled = true;
  executor.mutationLoopStopV2Enabled = true;
  executor.planCompletedEffectively = false;
  executor.cancelled = false;
  executor.cancelReason = null;
  executor.paused = false;
  executor.taskCompleted = false;
  executor.waitingForUserInput = false;
  executor.workspacePreflightAcknowledged = false;
  executor.lastPauseReason = null;
  executor.conversationHistory = [];
  executor.systemPrompt = "";
  executor.recoveryRequestActive = false;
  executor.capabilityUpgradeRequested = false;
  executor.toolResultMemory = [];
  executor.toolUsageCounts = new Map();
  executor.toolUsageEventsSinceDecay = 0;
  executor.toolSelectionEpoch = 0;
  executor.lastAssistantOutput = null;
  executor.lastNonVerificationOutput = null;
  executor.filesReadTracker = new Map();
  executor.currentStepId = null;
  executor.lastRecoveryFailureSignature = "";
  executor.recoveredFailureStepIds = new Set();
  executor.budgetConstrainedFailedStepIds = new Set();
  executor.nonBlockingVerificationFailedStepIds = new Set();
  executor.blockingVerificationFailedStepIds = new Set();
  executor.crossStepToolFailures = new Map();
  executor.dispatchedMentionedAgents = false;
  executor.lastAssistantText = null;
  executor.lastPreCompactionFlushAt = 0;
  executor.lastPreCompactionFlushTokenCount = 0;
  executor.observedOutputTokensPerSecond = null;
  executor.unifiedCompatModeNotified = false;
  executor.journalIntervalHandle = undefined;
  executor.journalEntryCount = 0;
  executor.pendingFollowUps = [];
  executor._suppressNextUserMessageEvent = false;
  executor.planRevisionCount = 0;
  executor.maxPlanRevisions = 5;
  executor.failedApproaches = new Set();
  executor.totalInputTokens = 0;
  executor.totalOutputTokens = 0;
  executor.totalCost = 0;
  executor.usageOffsetInputTokens = 0;
  executor.usageOffsetOutputTokens = 0;
  executor.usageOffsetCost = 0;
  executor.iterationCount = 0;
  executor.globalTurnCount = 0;
  executor.maxGlobalTurns = 100;
  executor.turnSoftLandingReserve = 2;
  executor.budgetSoftLandingInjected = false;
  executor.llmCallSequence = 0;
  executor.softDeadlineTriggered = false;
  executor.wrapUpRequested = false;
  executor.useUnifiedTurnLoop = false;
  executor.logTag = "[Executor:test]";
  executor.infraContextProvider = {
    getStatus: () => ({ enabled: false }),
  };
}

function createExecutorWithStubs(responses: LLMResponse[], toolResults: Record<string, Any>) {
  const executor = Object.create(TaskExecutor.prototype) as Any;

  executor.task = {
    id: "task-1",
    title: "Test Task",
    prompt: "Test prompt",
    createdAt: Date.now() - 1000,
  };
  executor.workspace = {
    id: "workspace-1",
    path: "/tmp",
    permissions: { read: true, write: true, delete: true, network: true, shell: true },
  };
  executor.daemon = { logEvent: vi.fn() };
  applyExecutorFieldDefaults(executor);
  executor.contextManager = {
    compactMessagesWithMeta: vi.fn((messages: Any) => ({
      messages,
      meta: {
        availableTokens: 1_000_000,
        originalTokens: 0,
        truncatedToolResults: { didTruncate: false, count: 0, tokensAfter: 0 },
        removedMessages: { didRemove: false, count: 0, tokensAfter: 0, messages: [] },
        kind: "none",
      },
    })),
    getContextUtilization: vi.fn().mockReturnValue({ utilization: 0 }),
    getAvailableTokens: vi.fn().mockReturnValue(1_000_000),
  };
  executor.checkBudgets = vi.fn();
  executor.updateTracking = vi.fn();
  executor.getAvailableTools = vi.fn().mockReturnValue([
    { name: "run_command", description: "", input_schema: { type: "object", properties: {} } },
    { name: "glob", description: "", input_schema: { type: "object", properties: {} } },
    { name: "read_file", description: "", input_schema: { type: "object", properties: {} } },
    { name: "list_directory", description: "", input_schema: { type: "object", properties: {} } },
    { name: "get_file_info", description: "", input_schema: { type: "object", properties: {} } },
    { name: "system_info", description: "", input_schema: { type: "object", properties: {} } },
    { name: "infra_status", description: "", input_schema: { type: "object", properties: {} } },
    { name: "web_search", description: "", input_schema: { type: "object", properties: {} } },
    { name: "web_fetch", description: "", input_schema: { type: "object", properties: {} } },
    { name: "write_file", description: "", input_schema: { type: "object", properties: {} } },
    { name: "create_document", description: "", input_schema: { type: "object", properties: {} } },
    {
      name: "generate_document",
      description: "",
      input_schema: { type: "object", properties: {} },
    },
    {
      name: "create_spreadsheet",
      description: "",
      input_schema: { type: "object", properties: {} },
    },
    {
      name: "generate_spreadsheet",
      description: "",
      input_schema: { type: "object", properties: {} },
    },
    {
      name: "create_presentation",
      description: "",
      input_schema: { type: "object", properties: {} },
    },
    {
      name: "generate_presentation",
      description: "",
      input_schema: { type: "object", properties: {} },
    },
    { name: "edit_file", description: "", input_schema: { type: "object", properties: {} } },
  ]);
  executor.handleCanvasPushFallback = vi.fn();
  executor.getToolTimeoutMs = vi.fn().mockReturnValue(1000);
  executor.checkFileOperation = vi.fn().mockReturnValue({ blocked: false });
  executor.recordFileOperation = vi.fn();
  executor.recordCommandExecution = vi.fn();
  executor.fileOperationTracker = {
    getKnowledgeSummary: vi.fn().mockReturnValue(""),
    getCreatedFiles: vi.fn().mockReturnValue([]),
  };
  executor.toolFailureTracker = {
    isDisabled: vi.fn().mockReturnValue(false),
    getLastError: vi.fn().mockReturnValue(""),
    recordSuccess: vi.fn(),
    recordFailure: vi.fn().mockReturnValue(false),
  };
  executor.toolCallDeduplicator = {
    checkDuplicate: vi.fn().mockReturnValue({ isDuplicate: false }),
    recordCall: vi.fn(),
  };
  executor.toolResultMemoryLimit = 8;
  executor.toolRegistry = {
    executeTool: vi.fn(async (name: string) => {
      if (name in toolResults) return toolResults[name];
      return { success: true };
    }),
  };
  executor.callLLMWithRetry = vi.fn().mockImplementation(async () => {
    const response = responses.shift();
    if (!response) {
      throw new Error("No more LLM responses configured");
    }
    return response;
  });
  executor.abortController = new AbortController();

  return executor as TaskExecutor & {
    daemon: { logEvent: ReturnType<typeof vi.fn> };
    toolRegistry: { executeTool: ReturnType<typeof vi.fn> };
  };
}

function createExecutorWithLLMHandler(handler: (messages: Any[]) => LLMResponse) {
  const executor = Object.create(TaskExecutor.prototype) as Any;

  executor.task = {
    id: "task-1",
    title: "Today F1 news",
    prompt: "Search for the latest Formula 1 news from today and summarize.",
    createdAt: Date.now() - 1000,
  };
  executor.workspace = {
    id: "workspace-1",
    path: "/tmp",
    permissions: { read: true, write: true, delete: true, network: true, shell: true },
  };
  executor.daemon = { logEvent: vi.fn() };
  applyExecutorFieldDefaults(executor);
  executor.contextManager = {
    compactMessagesWithMeta: vi.fn((messages: Any) => ({
      messages,
      meta: {
        availableTokens: 1_000_000,
        originalTokens: 0,
        truncatedToolResults: { didTruncate: false, count: 0, tokensAfter: 0 },
        removedMessages: { didRemove: false, count: 0, tokensAfter: 0, messages: [] },
        kind: "none",
      },
    })),
    getContextUtilization: vi.fn().mockReturnValue({ utilization: 0 }),
    getAvailableTokens: vi.fn().mockReturnValue(1_000_000),
  };
  executor.checkBudgets = vi.fn();
  executor.updateTracking = vi.fn();
  executor.getAvailableTools = vi.fn().mockReturnValue([]);
  executor.handleCanvasPushFallback = vi.fn();
  executor.getToolTimeoutMs = vi.fn().mockReturnValue(1000);
  executor.checkFileOperation = vi.fn().mockReturnValue({ blocked: false });
  executor.recordFileOperation = vi.fn();
  executor.recordCommandExecution = vi.fn();
  executor.fileOperationTracker = {
    getKnowledgeSummary: vi.fn().mockReturnValue(""),
    getCreatedFiles: vi.fn().mockReturnValue([]),
  };
  executor.toolFailureTracker = {
    isDisabled: vi.fn().mockReturnValue(false),
    getLastError: vi.fn().mockReturnValue(""),
    recordSuccess: vi.fn(),
    recordFailure: vi.fn().mockReturnValue(false),
  };
  executor.toolCallDeduplicator = {
    checkDuplicate: vi.fn().mockReturnValue({ isDuplicate: false }),
    recordCall: vi.fn(),
  };
  executor.toolResultMemoryLimit = 8;
  executor.toolRegistry = {
    executeTool: vi.fn(async () => ({ success: true })),
  };
  executor.provider = {
    createMessage: vi.fn(async (args: Any) => handler(args.messages)),
  };
  executor.callLLMWithRetry = vi.fn().mockImplementation(async (requestFn: Any) => {
    return requestFn();
  });
  executor.abortController = new AbortController();

  return executor as TaskExecutor & {
    daemon: { logEvent: ReturnType<typeof vi.fn> };
  };
}

describe("TaskExecutor executeStep failure handling", () => {
  let executor: ReturnType<typeof createExecutorWithStubs>;
  let originalConsoleLog: typeof console.log;
  let originalConsoleError: typeof console.error;

  beforeAll(() => {
    originalConsoleLog = console.log;
    originalConsoleError = console.error;
    console.log = () => {};
    console.error = () => {};
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterAll(() => {
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
  });

  it("keeps the step completed when run_command fails but a direct completion text follows", async () => {
    executor = createExecutorWithStubs(
      [toolUseResponse("run_command", { command: "exit 1" }), textResponse("done")],
      {
        run_command: { success: false, exitCode: 1 },
      },
    );

    const step: Any = { id: "1", description: "Execute a command", status: "pending" };

    await (executor as Any).executeStep(step);

    expect(step.status).toBe("completed");
    expect(step.error).toBeUndefined();
  });

  it("returns a direct completion response after duplicate non-idempotent tool calls are blocked", async () => {
    executor = createExecutorWithStubs(
      [
        toolUseResponse("run_command", { command: "echo test" }),
        textResponse("Completed with existing context after duplicate tool call was blocked."),
      ],
      {},
    );
    (executor as Any).toolCallDeduplicator.checkDuplicate = vi.fn().mockReturnValue({
      isDuplicate: true,
      reason: "duplicate_call",
      cachedResult: null,
    });

    const step: Any = { id: "1b", description: "Execute command once", status: "pending" };

    await (executor as Any).executeStep(step);

    expect(step.status).toBe("completed");
    expect(step.error).toBeUndefined();
  });

  it("blocks create_document for watch-skip recommendation prompts and continues with a text answer", async () => {
    executor = createExecutorWithStubs(
      [
        toolUseResponse("create_document", {
          filename: "Dan_Koe_Video_Review.docx",
          format: "docx",
          content: [{ type: "paragraph", text: "placeholder" }],
        }),
        textResponse(
          "Watch it only if you want to improve your creator-economy positioning; otherwise skip it.",
        ),
      ],
      {},
    );
    (executor as Any).task.title = "Video review";
    (executor as Any).task.prompt =
      "Transcribe this YouTube video and create a document so I can review it, then tell me if I should watch it.";

    const step: Any = {
      id: "watch-skip-1",
      description: "Transcribe and decide watchability",
      status: "pending",
    };

    await (executor as Any).executeStep(step);

    expect(step.status).toBe("completed");
    expect(executor.daemon.logEvent).toHaveBeenCalledWith(
      "task-1",
      "tool_blocked",
      expect.objectContaining({
        tool: "create_document",
        reason: "watch_skip_recommendation_task",
      }),
    );
    expect(executor.toolRegistry.executeTool).not.toHaveBeenCalled();
  });

  it("does not reference follow-up lock state when step tool calls are soft-blocked by turn budget", async () => {
    executor = createExecutorWithStubs(
      [
        toolUseResponse("web_search", { query: "latest nokia earnings" }),
        textResponse("Using current evidence only."),
      ],
      {},
    );
    (executor as Any).guardrailPhaseAEnabled = true;
    (executor as Any).getRemainingTurnBudget = vi.fn().mockReturnValue(0);
    (executor as Any).crossStepToolFailures = new Map();
    (executor as Any).pendingFollowUps = [];

    const step: Any = { id: "step-turn-budget", description: "Search for source links", status: "pending" };

    await expect((executor as Any).executeStep(step)).resolves.toBeUndefined();
    expect(String(step.error || "")).not.toContain("followUpToolCallsLocked");
  });

  it("fails fast after repeated policy-blocked tool-only turns with no text output", async () => {
    executor = createExecutorWithStubs(
      [
        toolUseResponse("web_search", { query: "first blocked call" }),
        toolUseResponse("web_search", { query: "second blocked call" }),
      ],
      {},
    );
    (executor as Any).guardrailPhaseAEnabled = true;
    (executor as Any).getRemainingTurnBudget = vi.fn().mockReturnValue(0);
    (executor as Any).crossStepToolFailures = new Map();
    (executor as Any).pendingFollowUps = [];

    const step: Any = {
      id: "step-blocked-loop",
      description: "Find sources",
      status: "pending",
    };

    await expect((executor as Any).executeStep(step)).resolves.toBeUndefined();
    expect(step.status).toBe("failed");
    expect(String(step.error || "")).toContain("repeated tool-only turns");
  });

  it("marks verification step failed when no new image is found", async () => {
    const oldTimestamp = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    executor = createExecutorWithStubs(
      [toolUseResponse("glob", { pattern: "**/*.{png,jpg,jpeg,webp}" }), textResponse("checked")],
      {
        glob: {
          success: true,
          matches: [{ path: "old.png", modified: oldTimestamp }],
        },
      },
    );

    const step: Any = {
      id: "2",
      description: "Verify: Confirm the generated image file exists and report the result",
      status: "pending",
    };

    await (executor as Any).executeStep(step);

    expect(step.status).toBe("failed");
    expect(step.error).toContain("no newly generated image");
  });

  it("accepts artifact verification evidence from file inspection tools when step text is generic", async () => {
    executor = createExecutorWithStubs(
      [
        toolUseResponse("get_file_info", { path: "inner_world.docx" }),
        toolUseResponse("read_file", { path: "inner_world.docx" }),
        textResponse("OK"),
      ],
      {
        get_file_info: { success: true, path: "inner_world.docx", size: 1234 },
        read_file: { success: true, path: "inner_world.docx", content: "The Quiet Atlas" },
      },
    );
    (executor as Any).fileOperationTracker = {
      getKnowledgeSummary: vi.fn().mockReturnValue(""),
      getCreatedFiles: vi.fn().mockReturnValue(["inner_world.docx"]),
    };

    const step: Any = {
      id: "verify-artifact-generic",
      description:
        "Verify completion: ensure file exists, is DOCX, content length matches short target (roughly 120–160 words), and report the final path to the user.",
      status: "pending",
    };
    (executor as Any).plan = { description: "Plan", steps: [step] };

    await (executor as Any).executeStep(step);

    expect(step.status).toBe("completed");
    expect(String(step.error || "")).toBe("");
  });

  it("rejects unrelated artifact inspection for generic verification steps", async () => {
    executor = createExecutorWithStubs(
      [toolUseResponse("read_file", { path: "other.docx" }), textResponse("OK")],
      {
        read_file: { success: true, path: "other.docx", content: "Unrelated content" },
      },
    );
    (executor as Any).fileOperationTracker = {
      getKnowledgeSummary: vi.fn().mockReturnValue(""),
      getCreatedFiles: vi.fn().mockReturnValue(["inner_world.docx"]),
    };

    const step: Any = {
      id: "verify-artifact-unrelated",
      description:
        "Verify completion: ensure file exists, is DOCX, content length matches short target (roughly 120–160 words), and report the final path to the user.",
      status: "pending",
    };
    (executor as Any).plan = { description: "Plan", steps: [step] };

    await (executor as Any).executeStep(step);

    expect(step.status).toBe("failed");
    expect(String(step.error || "")).toContain("expected artifact file evidence");
  });

  it("rejects same-basename artifact inspection from a different directory", async () => {
    executor = createExecutorWithStubs(
      [toolUseResponse("read_file", { path: "tmp/report.docx" }), textResponse("OK")],
      {
        read_file: { success: true, path: "tmp/report.docx", content: "Wrong artifact" },
      },
    );
    (executor as Any).fileOperationTracker = {
      getKnowledgeSummary: vi.fn().mockReturnValue(""),
      getCreatedFiles: vi.fn().mockReturnValue(["deliverables/report.docx"]),
    };

    const step: Any = {
      id: "verify-artifact-same-name-different-dir",
      description: "Verify completion: ensure the Word document is present and readable.",
      status: "pending",
    };
    (executor as Any).plan = { description: "Plan", steps: [step] };

    await (executor as Any).executeStep(step);

    expect(step.status).toBe("failed");
    expect(String(step.error || "")).toContain("expected artifact file evidence");
  });

  it("requires all prompt-required artifact types during artifact verification", async () => {
    executor = createExecutorWithStubs(
      [toolUseResponse("read_file", { path: "report.csv" }), textResponse("OK")],
      {
        read_file: { success: true, path: "report.csv", content: "col\n1" },
      },
    );
    (executor as Any).task.prompt = "Create both a CSV and JSON report file from this data.";
    expect((executor as Any).inferRequiredArtifactExtensions()).toEqual(
      expect.arrayContaining([".csv", ".json"]),
    );
    (executor as Any).fileOperationTracker = {
      getKnowledgeSummary: vi.fn().mockReturnValue(""),
      getCreatedFiles: vi.fn().mockReturnValue(["misc.json", "report.csv"]),
    };

    const step: Any = {
      id: "verify-artifact-missing-type",
      description:
        "Verify completion: ensure all requested artifact files were produced and are readable.",
      status: "pending",
    };
    (executor as Any).plan = { description: "Plan", steps: [step] };

    await (executor as Any).executeStep(step);

    expect(step.status).toBe("failed");
    expect(String(step.error || "")).toContain("missing required artifact types");
    expect(String(step.error || "")).toContain(".json");
  });

  it("ignores strategy-context docx cues when inferring required artifact types", () => {
    executor = createExecutorWithStubs([textResponse("OK")], {});
    (executor as Any).task.prompt = `Create a fully working website simulating the Windows 95 UI.

[AGENT_STRATEGY_CONTEXT_V1]
relationship_memory:
- Completed task: create a short word document ... Outcome: inner_world.docx created.
[/AGENT_STRATEGY_CONTEXT_V1]`;

    expect((executor as Any).inferRequiredArtifactExtensions()).not.toContain(".docx");
  });

  it("still infers docx when the user explicitly requests a DOCX report", () => {
    executor = createExecutorWithStubs([textResponse("OK")], {});
    (executor as Any).task.prompt =
      "Create a DOCX report for this quarter and include a short executive summary.";

    expect((executor as Any).inferRequiredArtifactExtensions()).toContain(".docx");
  });

  it("does not require in-app canvas tools for app-internal canvas gameplay wording", () => {
    executor = createExecutorWithStubs([textResponse("OK")], {});
    const step: Any = {
      id: "mini-app-canvas-wording",
      kind: "primary",
      description:
        "Implement Paint-lite or Minesweeper-style mini app with interactive canvas/grid gameplay.",
      status: "pending",
    };

    const contract = (executor as Any).resolveStepExecutionContract(step);
    expect(Array.from(contract.requiredTools)).not.toContain("canvas_create");
    expect(Array.from(contract.requiredTools)).not.toContain("canvas_push");
  });

  it("does not classify canvas/web verification wording as image verification", () => {
    executor = createExecutorWithStubs([textResponse("OK")], {});
    const step: Any = {
      id: "verify-canvas-mode",
      kind: "primary",
      description:
        "Verify: run through at least one full test attempt to confirm timer behavior, scoring accuracy, results rendering, and restart/reset functionality.",
      status: "pending",
    };

    expect((executor as Any).stepRequiresImageVerification(step)).toBe(false);
    expect((executor as Any).resolveVerificationModeForStep(step)).toBe("canvas_session");
  });

  it("detects follow-up requests that require an in-app canvas action", () => {
    executor = createExecutorWithStubs([textResponse("OK")], {});
    expect(
      (executor as Any).followUpRequiresCanvasAction(
        "open the generated html inside this app canvas, not outside",
      ),
    ).toBe(true);
    expect((executor as Any).followUpRequiresCanvasAction("show it in app canvas")).toBe(true);
  });

  it("does not classify informational canvas follow-ups as required canvas actions", () => {
    executor = createExecutorWithStubs([textResponse("OK")], {});
    expect((executor as Any).followUpRequiresCanvasAction("what is in-app canvas?")).toBe(false);
    expect((executor as Any).followUpRequiresCanvasAction("ok thanks")).toBe(false);
  });

  it("enforces required-tool contract when create_document is required but never called", async () => {
    executor = createExecutorWithStubs([textResponse("Draft ready, final text prepared.")], {});
    const step: Any = {
      id: "doc-contract",
      description:
        "Generate the DOCX via create_document with filename sample_inner_world.docx and validated content.",
      status: "pending",
    };

    await (executor as Any).executeStep(step);

    expect(step.status).toBe("failed");
    expect(String(step.error || "")).toContain("Missing successful calls for: create_document");
  });

  it("accepts generate_document when create_document is required by step wording", async () => {
    executor = createExecutorWithStubs(
      [
        toolUseResponse("generate_document", {
          filename: "sample_inner_world.docx",
          markdown: "# Sample\n\nBody",
        }),
        textResponse("Generated sample_inner_world.docx"),
      ],
      {
        generate_document: {
          success: true,
          path: "sample_inner_world.docx",
          size: 1024,
        },
      },
    );
    const tempDir = fs.mkdtempSync("/tmp/cowork-doc-alias-");
    (executor as Any).workspace.path = tempDir;
    fs.writeFileSync(path.join(tempDir, "sample_inner_world.docx"), "docx-bytes");

    const step: Any = {
      id: "doc-contract-generate-alias",
      description:
        "Generate the DOCX via create_document with filename sample_inner_world.docx and validated content.",
      status: "pending",
    };

    try {
      await (executor as Any).executeStep(step);
      expect(step.status).toBe("completed");
      expect(String(step.error || "")).toBe("");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("accepts canvas verification via canvas evidence without requiring image files", async () => {
    executor = createExecutorWithStubs(
      [
        toolUseResponse("canvas_create", { title: "Mental Agility Test" }),
        toolUseResponse("canvas_push", {
          session_id: "session-1",
          content: "<!DOCTYPE html><html><body>app</body></html>",
        }),
        textResponse("OK"),
      ],
      {
        canvas_create: { success: true, session_id: "session-1" },
        canvas_push: { success: true },
      },
    );

    (executor as Any).getAvailableTools = vi.fn().mockReturnValue([
      { name: "canvas_create", description: "", input_schema: { type: "object", properties: {} } },
      { name: "canvas_push", description: "", input_schema: { type: "object", properties: {} } },
      { name: "read_file", description: "", input_schema: { type: "object", properties: {} } },
      { name: "glob", description: "", input_schema: { type: "object", properties: {} } },
    ]);

    const step: Any = {
      id: "verify-canvas-interaction",
      description:
        "Verify: run through at least one full test attempt to confirm timer behavior, scoring accuracy, results rendering, and restart/reset functionality.",
      status: "pending",
    };

    await (executor as Any).executeStep(step);

    expect(step.status).toBe("completed");
    expect(String(step.error || "")).toBe("");
    expect((executor as Any).toolRegistry.executeTool).toHaveBeenCalledWith(
      "canvas_push",
      expect.any(Object),
    );
  });

  it("fails executePlan when a step remains unfinished", async () => {
    executor = createExecutorWithStubs([textResponse("done")], {});
    const step: Any = { id: "plan-1", description: "Do the work", status: "pending" };
    (executor as Any).plan = { description: "Plan", steps: [step] };
    (executor as Any).executeStep = vi.fn(async (target: Any) => {
      // Simulate a broken executor path that never finalizes to completed/failed.
      target.status = "in_progress";
    });

    await expect((executor as Any).executePlan()).rejects.toThrow("Task incomplete");
  });

  it("emits failed-step progress instead of completed-step progress when step execution fails", async () => {
    executor = createExecutorWithStubs([textResponse("done")], {});
    const step: Any = { id: "plan-2", description: "Fetch transcript", status: "pending" };
    (executor as Any).plan = { description: "Plan", steps: [step] };
    (executor as Any).executeStep = vi.fn(async (target: Any) => {
      target.status = "failed";
      target.error = "All required tools are unavailable or failed. Unable to complete this step.";
      target.completedAt = Date.now();
    });

    await expect((executor as Any).executePlan()).rejects.toThrow("Task failed");

    const progressMessages = (executor as Any).daemon.logEvent.mock.calls
      .filter((call: Any[]) => call[1] === "progress_update")
      .map((call: Any[]) => String(call[2]?.message || ""));

    expect(progressMessages.some((message: string) => message.includes("Step failed"))).toBe(true);
    expect(progressMessages.some((message: string) => message.includes("Completed step"))).toBe(
      false,
    );
  });

  it("fails executePlan when a verification-labeled step fails", async () => {
    executor = createExecutorWithStubs([textResponse("done")], {});
    const step: Any = {
      id: "plan-verify-1",
      description: "Verify: Read the created document and present recommendation",
      status: "pending",
    };
    (executor as Any).plan = { description: "Plan", steps: [step] };
    (executor as Any).executeStep = vi.fn(async (target: Any) => {
      target.status = "failed";
      target.error = "Verification failed";
      target.completedAt = Date.now();
    });

    await expect((executor as Any).executePlan()).rejects.toThrow("Task failed");
  });

  it("requires a direct answer when prompt asks for a decision and summary is artifact-only", () => {
    executor = createExecutorWithStubs([textResponse("done")], {});
    (executor as Any).task.title = "Review YouTube video";
    (executor as Any).task.prompt =
      "Transcribe this YouTube video and let me know if I should spend my time watching it or skip it.";
    (executor as Any).fileOperationTracker.getCreatedFiles.mockReturnValue([
      "Dan_Koe_Video_Review.pdf",
    ]);
    (executor as Any).lastNonVerificationOutput = "Created: Dan_Koe_Video_Review.pdf";
    (executor as Any).lastAssistantOutput = "Created document successfully.";

    const guardError = (executor as Any).getFinalResponseGuardError();
    expect(guardError).toContain("missing direct answer");
  });

  it("allows completion when recommendation is explicitly present for decision prompts", () => {
    executor = createExecutorWithStubs([textResponse("done")], {});
    (executor as Any).task.title = "Review YouTube video";
    (executor as Any).task.prompt =
      "Transcribe this YouTube video and let me know if I should spend my time watching it or skip it.";
    (executor as Any).fileOperationTracker.getCreatedFiles.mockReturnValue([
      "Dan_Koe_Video_Review.pdf",
    ]);
    (executor as Any).lastNonVerificationOutput =
      "Recommendation: Skip this video unless you are new to creator-economy basics; it is likely not worth your time.";
    (executor as Any).plan = {
      description: "Plan",
      steps: [{ id: "1", description: "Review transcript and recommend", status: "completed" }],
    };

    const guardError = (executor as Any).getFinalResponseGuardError();
    expect(guardError).toBeNull();
  });

  it("does not require direct answer for artifact-only tasks without question intent", () => {
    executor = createExecutorWithStubs([textResponse("done")], {});
    (executor as Any).task.title = "Generate PDF report";
    (executor as Any).task.prompt = "Create a PDF report from the attached data.";
    (executor as Any).fileOperationTracker.getCreatedFiles.mockReturnValue(["report.pdf"]);
    (executor as Any).lastNonVerificationOutput = "Created: report.pdf";

    const guardError = (executor as Any).getFinalResponseGuardError();
    expect(guardError).toBeNull();
  });

  it("requires direct answer for non-video advisory prompts too", () => {
    executor = createExecutorWithStubs([textResponse("done")], {});
    (executor as Any).task.title = "Stack choice";
    (executor as Any).task.prompt =
      "Compare option A and option B and tell me which one I should choose.";
    (executor as Any).lastNonVerificationOutput = "Created: comparison.md";

    const guardError = (executor as Any).getFinalResponseGuardError();
    expect(guardError).toContain("missing direct answer");
  });

  it("pauses when assistant asks blocking questions", async () => {
    executor = createExecutorWithStubs(
      [
        textResponse(
          "Please choose the required input file path:\n1) inputs/demand-letter.txt\n2) inputs/buyer-demand-letter.txt\nReply with 1 or 2.",
        ),
      ],
      {},
    );
    (executor as Any).shouldPauseForQuestions = true;

    const step: Any = { id: "3", description: "Clarify requirements", status: "pending" };

    await expect((executor as Any).executeStep(step)).rejects.toMatchObject({
      name: "AwaitingUserInputError",
    });
  });

  it("fails with user_action_required when required-input pauses are disabled", async () => {
    executor = createExecutorWithStubs(
      [
        textResponse(
          "Please choose the required input file path:\n1) inputs/demand-letter.txt\n2) inputs/buyer-demand-letter.txt\nReply with 1 or 2.",
        ),
      ],
      {},
    );
    (executor as Any).shouldPauseForQuestions = false;
    (executor as Any).shouldPauseForRequiredDecision = false;

    const step: Any = { id: "3b", description: "Clarify requirements", status: "pending" };

    await (executor as Any).executeStep(step);

    expect(step.status).toBe("failed");
    expect(String(step.error || "")).toContain("User action required");
  });

  it("does not treat non-blocking exploratory questions as required-decision blockers", async () => {
    executor = createExecutorWithStubs(
      [textResponse("Who is the primary user for this feature and what outcomes matter most?")],
      {},
    );
    (executor as Any).shouldPauseForQuestions = false;
    (executor as Any).shouldPauseForRequiredDecision = true;

    const step: Any = { id: "3d", description: "Explore product context", status: "pending" };

    await (executor as Any).executeStep(step);
    expect(step.status).toBe("completed");
  });

  it("does not pause on optional follow-up offers phrased as questions", async () => {
    executor = createExecutorWithStubs(
      [
        textResponse(
          "I finished the scaffold and can keep going. If you want, I can run a quick compile-safety pass next.",
        ),
      ],
      {},
    );
    (executor as Any).shouldPauseForQuestions = true;
    (executor as Any).shouldPauseForRequiredDecision = true;

    const step: Any = { id: "3d2", description: "Continue implementation", status: "pending" };

    await (executor as Any).executeStep(step);
    expect(step.status).toBe("completed");
  });

  it("pauses when the assistant explicitly states it cannot continue without required input", async () => {
    executor = createExecutorWithStubs(
      [
        textResponse(
          "I cannot continue until you provide the required App Group ID. Reply with the value to proceed.",
        ),
      ],
      {},
    );
    (executor as Any).shouldPauseForQuestions = true;
    (executor as Any).shouldPauseForRequiredDecision = true;

    const step: Any = { id: "3d3", description: "Configure app group", status: "pending" };

    await expect((executor as Any).executeStep(step)).rejects.toMatchObject({
      name: "AwaitingUserInputError",
    });
  });

  it("does not pause on non-question progress text that mentions integration availability", async () => {
    executor = createExecutorWithStubs(
      [
        textResponse(
          "Captured command context and integration availability scope. Ready to proceed with the lightweight health checks.",
        ),
      ],
      {},
    );
    (executor as Any).shouldPauseForQuestions = true;
    (executor as Any).shouldPauseForRequiredDecision = true;

    const step: Any = { id: "3e", description: "Capture mention context", status: "pending" };

    await (executor as Any).executeStep(step);
    expect(step.status).toBe("completed");
  });

  it("pauses for required decisions even when autonomous question pausing is disabled", async () => {
    executor = createExecutorWithStubs(
      [
        textResponse(
          "1) Which counterparty demand file should I use?\n2) Confirm the agreement path.",
        ),
      ],
      {},
    );
    (executor as Any).shouldPauseForQuestions = false;
    (executor as Any).shouldPauseForRequiredDecision = true;

    const step: Any = { id: "3c", description: "Resolve required documents", status: "pending" };

    await expect((executor as Any).executeStep(step)).rejects.toMatchObject({
      name: "AwaitingUserInputError",
    });
  });

  it("does not fail a step as limitation-only when tools already ran and only input-dependent errors occurred", async () => {
    executor = createExecutorWithStubs(
      [
        toolUseResponse("glob", { pattern: "**/*" }),
        toolUseResponse("read_file", { path: "." }),
        textResponse(
          "I cannot run deeper telemetry in this environment, but fallback checks completed with current evidence.",
        ),
      ],
      {
        glob: { success: true, matches: ["tmp.txt"] },
      },
    );
    (executor as Any).toolRegistry.executeTool = vi.fn(async (name: string) => {
      if (name === "read_file") {
        throw new Error("Failed to read file: EISDIR: illegal operation on a directory, read");
      }
      if (name === "glob") {
        return { success: true, matches: ["tmp.txt"] };
      }
      return { success: true };
    });

    const step: Any = { id: "3f", description: "Fallback lane checks", status: "pending" };

    await (executor as Any).executeStep(step);
    expect(step.status).toBe("completed");
    expect(String(step.error || "")).not.toContain("limitation statement");
  });

  it("skips quality refine passes for recovery steps even when qualityPasses=2", async () => {
    executor = createExecutorWithStubs([textResponse("Fallback path complete.")], {});
    (executor as Any).task.agentConfig = { qualityPasses: 2 };
    const step: Any = {
      id: "3g",
      description: "Summary fallback lane outcome",
      status: "pending",
      kind: "recovery",
    };
    (executor as Any).plan = { description: "Plan", steps: [step] };

    await (executor as Any).executeStep(step);

    expect(step.status).toBe("completed");
    expect((executor as Any).callLLMWithRetry).toHaveBeenCalledTimes(1);
  });

  it("skips workspace preflight pauses when user input is disabled", () => {
    executor = createExecutorWithStubs([textResponse("done")], {});
    (executor as Any).shouldPauseForQuestions = false;
    (executor as Any).classifyWorkspaceNeed = vi.fn().mockReturnValue("needs_existing");
    (executor as Any).pauseForUserInput = vi.fn();

    const shouldPause = (executor as Any).preflightWorkspaceCheck();

    expect(shouldPause).toBe(false);
    expect((executor as Any).pauseForUserInput).not.toHaveBeenCalled();
  });

  it("treats provider cancellation messages as abort-like errors", () => {
    executor = createExecutorWithStubs([textResponse("done")], {});

    expect((executor as Any).isAbortLikeError(new Error("Request cancelled"))).toBe(true);
    expect((executor as Any).isAbortLikeError(new Error("Request canceled"))).toBe(true);
  });

  it("does not infer write_file content from assistant narration fallback", () => {
    executor = createExecutorWithStubs([textResponse("done")], {});
    (executor as Any).lastAssistantText = "Now let me write the full whitepaper:";
    (executor as Any).lastNonVerificationOutput = "Now let me write the full whitepaper:";
    (executor as Any).lastAssistantOutput = "Now let me write the full whitepaper:";

    const inferred = (executor as Any).inferMissingParameters("write_file", {
      path: "NexusChain-Whitepaper.md",
    });

    expect(inferred.input.content).toBeUndefined();
  });

  it("does not infer create_document content from assistant narration fallback", () => {
    executor = createExecutorWithStubs([textResponse("done")], {});
    (executor as Any).lastAssistantText = "Now let me write the full whitepaper:";
    (executor as Any).lastNonVerificationOutput = "Now let me write the full whitepaper:";
    (executor as Any).lastAssistantOutput = "Now let me write the full whitepaper:";

    const inferred = (executor as Any).inferMissingParameters("create_document", {
      filename: "spec.docx",
      format: "docx",
    });

    expect(inferred.input.content).toBeUndefined();
  });

  it("fails write/create deliverable steps when no file mutation evidence exists", async () => {
    executor = createExecutorWithStubs(
      [textResponse("I wrote the complete whitepaper and it is ready.")],
      {},
    );

    const step: Any = {
      id: "artifact-1",
      description: "Write the complete KARU founding whitepaper document",
      status: "pending",
    };

    await (executor as Any).executeStep(step);

    expect(step.status).toBe("failed");
    expect(step.error).toContain("written artifact");
  });

  it("does not treat reported artifact path alone as successful mutation evidence", async () => {
    executor = createExecutorWithStubs(
      [
        toolUseResponse("generate_presentation", {
          filename: "contract_negotiation_training.pptx",
          slides: [{ title: "Intro", bullets: ["A"] }],
        }),
        textResponse("Saved contract_negotiation_training.pptx"),
      ],
      {
        generate_presentation: {
          success: true,
          path: "contract_negotiation_training.pptx",
          slideCount: 1,
        },
      },
    );
    const tempDir = fs.mkdtempSync("/tmp/cowork-pptx-missing-");
    (executor as Any).workspace.path = tempDir;

    const step: Any = {
      id: "artifact-generate-pptx-missing",
      description:
        "Create output file contract_negotiation_training.pptx and ensure the presentation is written",
      status: "pending",
    };

    try {
      await (executor as Any).executeStep(step);
      expect(step.status).toBe("failed");
      expect(String(step.error || "")).toMatch(
        /artifact_write_checkpoint_failed|written artifact/i,
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps write/create deliverable steps completed when a file mutation succeeds", async () => {
    executor = createExecutorWithStubs(
      [
        toolUseResponse("write_file", { path: "KARU_Whitepaper.md", content: "# KARU" }),
        textResponse("Saved the complete whitepaper to KARU_Whitepaper.md"),
      ],
      {
        write_file: { success: true, path: "KARU_Whitepaper.md" },
      },
    );
    const tempDir = fs.mkdtempSync("/tmp/cowork-write-file-");
    (executor as Any).workspace.path = tempDir;
    fs.writeFileSync(path.join(tempDir, "KARU_Whitepaper.md"), "# KARU");

    const step: Any = {
      id: "artifact-2",
      description: "Write the complete KARU founding whitepaper document",
      status: "pending",
    };

    try {
      await (executor as Any).executeStep(step);
      expect(step.status).toBe("completed");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("treats generate_presentation as valid mutation evidence for write-required steps", async () => {
    executor = createExecutorWithStubs(
      [
        toolUseResponse("generate_presentation", {
          filename: "contract_negotiation_training.pptx",
          slides: [{ title: "Intro", bullets: ["A"] }],
        }),
        textResponse("Saved contract_negotiation_training.pptx"),
      ],
      {
        generate_presentation: {
          success: true,
          path: "contract_negotiation_training.pptx",
          slideCount: 1,
        },
      },
    );
    const tempDir = fs.mkdtempSync("/tmp/cowork-pptx-alias-");
    (executor as Any).workspace.path = tempDir;
    fs.writeFileSync(path.join(tempDir, "contract_negotiation_training.pptx"), "pptx-bytes");

    const step: Any = {
      id: "artifact-generate-pptx-1",
      description:
        "Create output file contract_negotiation_training.pptx and ensure the presentation is written",
      status: "pending",
    };

    try {
      await (executor as Any).executeStep(step);
      expect(step.status).toBe("completed");
      expect(String(step.error || "")).not.toContain("artifact_write_checkpoint_failed");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("does not trigger first-write checkpoint failure after repeated successful generate_presentation calls", async () => {
    executor = createExecutorWithStubs(
      [
        toolUseResponse("generate_presentation", {
          filename: "contract_negotiation_training_v1.pptx",
          slides: [{ title: "Intro", bullets: ["A"] }],
        }),
        toolUseResponse("generate_presentation", {
          filename: "contract_negotiation_training_v2.pptx",
          slides: [{ title: "Scope", bullets: ["B"] }],
        }),
        toolUseResponse("generate_presentation", {
          filename: "contract_negotiation_training_v3.pptx",
          slides: [{ title: "Close", bullets: ["C"] }],
        }),
        textResponse("Completed the presentation outline and generated the deck."),
      ],
      {
        generate_presentation: {
          success: true,
          path: "contract_negotiation_training.pptx",
          slideCount: 3,
        },
      },
    );
    const tempDir = fs.mkdtempSync("/tmp/cowork-pptx-retry-");
    (executor as Any).workspace.path = tempDir;
    fs.writeFileSync(path.join(tempDir, "contract_negotiation_training.pptx"), "pptx-bytes");

    const step: Any = {
      id: "artifact-generate-pptx-2",
      description:
        "Set up workspace and create output file contract_negotiation_training.pptx with a full presentation draft",
      status: "pending",
    };

    try {
      await (executor as Any).executeStep(step);
      expect(step.status).toBe("completed");
      expect(String(step.error || "")).not.toContain("first_write_checkpoint_no_attempt");
      expect(String(step.error || "")).not.toContain("artifact_write_checkpoint_failed");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("allows distinct file writes after first mutation success in the same step", async () => {
    executor = createExecutorWithStubs(
      [
        toolUseResponse("write_file", {
          path: "win95-ui/scripts/main.js",
          content: "export const start = true;\n",
        }),
        toolUseResponse("write_file", {
          path: "win95-ui/scripts/apps.js",
          content: "export const apps = [];\n",
        }),
        textResponse("Scaffolded launcher scripts."),
      ],
      {},
    );

    const tempDir = fs.mkdtempSync("/tmp/cowork-multi-write-");
    (executor as Any).workspace.path = tempDir;
    (executor as Any).toolRegistry.executeTool = vi.fn(async (name: string, input: Any) => {
      if (name === "write_file") {
        const relPath = String(input?.path || "").trim();
        const absolutePath = path.resolve(tempDir, relPath);
        fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
        fs.writeFileSync(absolutePath, String(input?.content || ""), "utf8");
        return { success: true, path: relPath };
      }
      return { success: true };
    });

    const step: Any = {
      id: "artifact-multi-write-1",
      description: "Create `win95-ui/scripts/main.js` and `win95-ui/scripts/apps.js` with starter code.",
      status: "pending",
    };

    try {
      await (executor as Any).executeStep(step);
      expect(step.status).toBe("completed");
      const writeCalls = ((executor as Any).toolRegistry.executeTool as Any).mock.calls.filter(
        (call: Any[]) => call[0] === "write_file",
      );
      expect(writeCalls.length).toBe(2);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("accepts artifact presence for compile/summary steps without requiring new writes", async () => {
    executor = createExecutorWithStubs([textResponse("Compiled summary is complete.")], {});
    const existingArtifact = "/tmp/KARU_Whitepaper.md";
    fs.writeFileSync(existingArtifact, "# Existing artifact\n");
    (executor as Any).fileOperationTracker = {
      getKnowledgeSummary: vi.fn().mockReturnValue(""),
      getCreatedFiles: vi.fn().mockReturnValue(["KARU_Whitepaper.md"]),
    };

    const step: Any = {
      id: "artifact-presence-1",
      description: "Prepare final summary document for KARU_Whitepaper.md",
      status: "pending",
    };

    try {
      await (executor as Any).executeStep(step);
      expect(step.status).toBe("completed");
    } finally {
      try {
        fs.unlinkSync(existingArtifact);
      } catch {
        // Ignore cleanup failures in test env.
      }
    }
  });

  it("requires step-local artifact evidence for compile/summary steps", async () => {
    executor = createExecutorWithStubs([textResponse("Prepared final summary.")], {});
    (executor as Any).fileOperationTracker = {
      getKnowledgeSummary: vi.fn().mockReturnValue(""),
      // Simulate a previously created file from earlier steps, with no new writes in this step.
      getCreatedFiles: vi.fn().mockReturnValue(["earlier_artifact.md"]),
    };

    const step: Any = {
      id: "artifact-presence-2",
      description: "Prepare final summary document",
      status: "pending",
    };

    await (executor as Any).executeStep(step);

    expect(step.status).toBe("failed");
    expect(step.error).toContain("artifact reference/presence");
  });

  it("does not require artifact evidence when step explicitly allows inline output", async () => {
    executor = createExecutorWithStubs([textResponse("Here is the inventory inline.")], {});

    const step: Any = {
      id: "artifact-inline-1",
      description: "Compile final output into artifacts/box_file_inventory.md (or return inline)",
      status: "pending",
    };

    await (executor as Any).executeStep(step);

    expect(step.status).toBe("completed");
    expect(step.error).toBeUndefined();
  });

  it("enforces hard tool-call budget contracts", () => {
    executor = createExecutorWithStubs([], {});
    (executor as Any).budgetContractsEnabled = true;
    (executor as Any).budgetContract = {
      maxTurns: 20,
      maxToolCalls: 1,
      maxWebSearchCalls: 1,
      maxConsecutiveSearchSteps: 2,
      maxAutoRecoverySteps: 1,
    };
    (executor as Any).totalToolCallCount = 1;
    (executor as Any).webSearchToolCallCount = 1;
    (executor as Any).webSearchMaxUsesPerTask = 4;
    (executor as Any).webSearchMaxUsesPerStep = 3;

    expect(() => (executor as Any).enforceToolBudget("write_file")).toThrow("Tool-call budget");
    (executor as Any).totalToolCallCount = 0;
    expect(() => (executor as Any).enforceToolBudget("web_search")).not.toThrow();
    const webSearchBudgetCheck = (executor as Any).evaluateWebSearchPolicyAndBudget({ query: "x" }, 0);
    expect(webSearchBudgetCheck.blocked).toBe(true);
    expect(webSearchBudgetCheck.failureClass).toBe("budget_exhausted");
    expect(webSearchBudgetCheck.scope).toBe("task");
  });

  it("clamps per-call web_search maxUses by task and step policy limits", () => {
    executor = createExecutorWithStubs([], {});
    (executor as Any).budgetContractsEnabled = true;
    (executor as Any).budgetContract = {
      maxTurns: 20,
      maxToolCalls: 10,
      maxWebSearchCalls: 4,
      maxConsecutiveSearchSteps: 2,
      maxAutoRecoverySteps: 1,
    };
    (executor as Any).webSearchMaxUsesPerTask = 5;
    (executor as Any).webSearchMaxUsesPerStep = 3;

    const taskLimit = (executor as Any).getEffectiveWebSearchTaskLimit({ maxUses: 10 });
    const stepLimit = (executor as Any).getEffectiveWebSearchStepLimit({ maxUses: 10 });

    expect(taskLimit).toBe(4);
    expect(stepLimit).toBe(3);
  });

  it("fails final verification steps unless the response is exactly OK", async () => {
    executor = createExecutorWithStubs(
      [textResponse("The whitepaper is missing required sections.")],
      {},
    );

    const step: Any = {
      id: "verify-1",
      description: "Final verification: Review the completed whitepaper for completeness",
      status: "pending",
    };
    (executor as Any).plan = { description: "Plan", steps: [step] };

    await (executor as Any).executeStep(step);

    expect(step.status).toBe("failed");
    expect(step.error).toContain("Verification failed");
  });

  it("rethrows abort-like errors without marking step as failed inside executeStep", async () => {
    executor = createExecutorWithStubs([], {});
    (executor as Any).callLLMWithRetry = vi.fn(async () => {
      throw new Error("Request cancelled");
    });

    const step: Any = {
      id: "abort-1",
      description: "Generate a large document",
      status: "pending",
    };

    await expect((executor as Any).executeStep(step)).rejects.toThrow("Request cancelled");
    expect(step.status).not.toBe("failed");
    expect(step.error).toBeUndefined();
    expect((executor as Any).daemon.logEvent).not.toHaveBeenCalledWith(
      "task-1",
      "step_failed",
      expect.objectContaining({ reason: "Request cancelled" }),
    );
  });

  it("does not fail step when only web_search errors occur after a successful tool", async () => {
    executor = createExecutorWithStubs(
      [
        toolUseResponse("glob", { pattern: "**/*.md" }),
        toolUseResponse("web_search", { query: "test", searchType: "web" }),
        textResponse("summary"),
      ],
      {
        glob: { success: true, matches: [], totalMatches: 0 },
        web_search: { success: false, error: "timeout" },
      },
    );

    const step: Any = { id: "4", description: "Search and summarize", status: "pending" };

    await (executor as Any).executeStep(step);

    expect(step.status).toBe("completed");
  });

  it("soft-blocks web_search on budget exhaustion and still completes the step with prior evidence", async () => {
    executor = createExecutorWithStubs(
      [
        toolUseResponse("run_command", { command: "echo ready" }),
        toolUseResponse("web_search", { query: "latest news", maxUses: 2 }),
        toolUseResponse("list_directory", { path: "." }),
        textResponse("Completed from existing evidence."),
      ],
      {
        run_command: { success: true, output: "ready" },
        list_directory: { success: true, path: ".", items: [] },
      },
    );
    (executor as Any).webSearchMaxUsesPerTask = 1;
    (executor as Any).webSearchMaxUsesPerStep = 1;
    (executor as Any).webSearchToolCallCount = 1; // Exhaust before the requested call

    const step: Any = { id: "budget-soft-1", description: "Research and summarize", status: "pending" };

    await (executor as Any).executeStep(step);

    expect(step.status).toBe("completed");
    expect((executor as Any).toolRegistry.executeTool).toHaveBeenCalledWith("list_directory", {
      path: ".",
    });
    expect((executor as Any).toolRegistry.executeTool).not.toHaveBeenCalledWith("web_search", expect.anything());
    expect(executor.daemon.logEvent).toHaveBeenCalledWith(
      "task-1",
      "log",
      expect.objectContaining({
        metric: "web_search_budget_hit",
      }),
    );
  });

  it("blocks autonomous web_fetch in cached mode when user did not explicitly request a URL", async () => {
    executor = createExecutorWithStubs(
      [
        toolUseResponse("list_directory", { path: "." }),
        toolUseResponse("web_fetch", { url: "https://example.com/article" }),
        textResponse("Completed from local evidence."),
      ],
      {
        list_directory: { success: true, path: ".", items: [] },
      },
    );
    (executor as Any).webSearchMode = "cached";
    (executor as Any).task.prompt = "Research the latest updates and summarize findings.";
    (executor as Any).lastUserMessage = "Research the latest updates and summarize findings.";

    const step: Any = { id: "cached-fetch-1", description: "Research and summarize", status: "pending" };

    await (executor as Any).executeStep(step);

    expect(step.status).toBe("completed");
    expect((executor as Any).toolRegistry.executeTool).toHaveBeenCalledWith("list_directory", {
      path: ".",
    });
    expect((executor as Any).toolRegistry.executeTool).not.toHaveBeenCalledWith(
      "web_fetch",
      expect.anything(),
    );
    expect(executor.daemon.logEvent).toHaveBeenCalledWith(
      "task-1",
      "tool_error",
      expect.objectContaining({
        tool: "web_fetch",
        blocked: true,
        scope: "mode",
      }),
    );
  });

  it("allows web_fetch in cached mode when user explicitly requested the exact URL", async () => {
    const targetUrl = "https://example.com/article";
    executor = createExecutorWithStubs(
      [toolUseResponse("web_fetch", { url: targetUrl }), textResponse("Fetched requested URL.")],
      {
        web_fetch: { success: true, url: targetUrl, content: "Article body" },
      },
    );
    (executor as Any).webSearchMode = "cached";
    (executor as Any).task.prompt = `Read this exact URL and summarize it: ${targetUrl}`;
    (executor as Any).lastUserMessage = `Read this exact URL and summarize it: ${targetUrl}`;

    const step: Any = { id: "cached-fetch-2", description: "Fetch requested page", status: "pending" };

    await (executor as Any).executeStep(step);

    expect(step.status).toBe("completed");
    expect((executor as Any).toolRegistry.executeTool).toHaveBeenCalledWith("web_fetch", {
      url: targetUrl,
    });
  });

  it("fails fast when tool returns unrecoverable failure (use_skill not currently executable)", async () => {
    const executorWithTools = createExecutorWithStubs(
      [
        toolUseResponse("use_skill", {
          skill_id: "audio-transcribe",
          parameters: { inputPath: "/tmp/audio.mp3" },
        }),
      ],
      {
        use_skill: {
          success: false,
          error: "Skill 'audio-transcribe' is not currently executable",
          reason: "Missing or invalid skill prerequisites.",
          missing_requirements: {
            bins: ["ffmpeg"],
          },
        },
      },
    );
    executorWithTools.getAvailableTools = vi.fn().mockReturnValue([
      { name: "run_command", description: "", input_schema: { type: "object", properties: {} } },
      { name: "glob", description: "", input_schema: { type: "object", properties: {} } },
      { name: "use_skill", description: "", input_schema: { type: "object", properties: {} } },
    ]);

    const step: Any = { id: "7", description: "Create transcript and summary", status: "pending" };

    await (executorWithTools as Any).executeStep(step);

    expect(step.status).toBe("failed");
    expect((executorWithTools as Any).callLLMWithRetry).toHaveBeenCalledTimes(1);
    expect(step.error).toMatch(
      /not currently executable|All required tools are unavailable or failed/,
    );
  });

  it("normalizes namespaced tool names like functions.web_search", async () => {
    const toolSpy = vi.fn(async () => ({ success: true, results: [] }));
    executor = createExecutorWithStubs(
      [
        toolUseResponse("functions.web_search", { query: "test", searchType: "web" }),
        textResponse("summary"),
      ],
      {
        web_search: { success: true, results: [] },
      },
    );
    (executor as Any).toolRegistry.executeTool = toolSpy;

    const step: Any = { id: "5", description: "Search for info", status: "pending" };

    await (executor as Any).executeStep(step);

    expect(toolSpy).toHaveBeenCalledWith("web_search", { query: "test", searchType: "web" });
    expect(step.status).toBe("completed");
  });

  it("includes recap context for final verify step in today news tasks", async () => {
    let callCount = 0;
    let verifyContextHasFinalStep = false;
    let verifyContextHasDeliverable = false;
    let verifyContextIncludesSummary = false;

    const executor = createExecutorWithLLMHandler((messages) => {
      callCount += 1;
      const stepContext = String(messages?.[0]?.content || "");

      if (callCount === 1) {
        return textResponse("Summary: Key F1 headlines from today.");
      }

      verifyContextHasFinalStep = stepContext.includes("FINAL step");
      verifyContextHasDeliverable = stepContext.includes("MOST RECENT DELIVERABLE");
      verifyContextIncludesSummary = stepContext.includes("Summary: Key F1 headlines from today.");

      return textResponse(
        "Recap: Summary: Key F1 headlines from today. Verification: Sources dated today.",
      );
    });

    const summaryStep: Any = {
      id: "1",
      description: "Write a concise summary of today’s F1 news",
      status: "pending",
    };
    const verifyStep: Any = {
      id: "2",
      description: "Verify: Ensure all summary items are from today’s news",
      status: "pending",
    };

    (executor as Any).plan = { description: "Plan", steps: [summaryStep, verifyStep] };

    await (executor as Any).executeStep(summaryStep);
    await (executor as Any).executeStep(verifyStep);

    expect((executor as Any).lastNonVerificationOutput).toContain(
      "Summary: Key F1 headlines from today.",
    );
    expect(verifyContextHasFinalStep).toBe(true);
    expect(verifyContextHasDeliverable).toBe(true);
    expect(verifyContextIncludesSummary).toBe(true);
  });

  it("detects recovery intent from user messaging in simple phrases", () => {
    const executor = createExecutorWithStubs([textResponse("done")], {});
    expect((executor as Any).isRecoveryIntent("I need you to find another way")).toBe(true);
    expect((executor as Any).isRecoveryIntent("Can't do this in this environment")).toBe(true);
    expect((executor as Any).isRecoveryIntent("Please continue")).toBe(false);
  });

  it("does not treat unrelated phrases as recovery intent", () => {
    const executor = createExecutorWithStubs([textResponse("done")], {});
    expect(
      (executor as Any).isRecoveryIntent(
        "Consider an alternative approach for this design, then resume",
      ),
    ).toBe(false);
    expect(
      (executor as Any).isRecoveryIntent("This is not possible with the current configuration"),
    ).toBe(false);
    expect((executor as Any).isRecoveryIntent("Another approach may be better later")).toBe(false);
  });

  it("resets attempt-level plan revision state on retry", () => {
    const executor = createExecutorWithStubs([textResponse("done")], {});
    (executor as Any).conversationHistory = [];
    const stepOne: Any = {
      id: "1",
      description: "Step one",
      status: "completed",
      startedAt: 1,
      completedAt: 2,
      error: "old",
    };
    const stepTwo: Any = {
      id: "2",
      description: "Step two",
      status: "failed",
      startedAt: 1,
      completedAt: 2,
      error: "old",
    };
    executor.task.currentAttempt = 2;
    executor.plan = { description: "Plan", steps: [stepOne, stepTwo] };
    executor.lastAssistantOutput = "summary";
    executor.lastNonVerificationOutput = "summary";
    executor.planRevisionCount = 3;

    (executor as Any).resetForRetry();

    expect(executor.plan!.steps[0].status).toBe("pending");
    expect(executor.plan!.steps[0].startedAt).toBeUndefined();
    expect(executor.plan!.steps[0].error).toBeUndefined();
    expect(executor.plan!.steps[1].status).toBe("pending");
    expect(executor.toolResultMemory).toEqual([]);
    expect(executor.lastAssistantOutput).toBeNull();
    expect(executor.lastNonVerificationOutput).toBeNull();
    expect(executor.planRevisionCount).toBe(0);
    expect((executor as Any).conversationHistory.at(-1)?.content).toContain("This is attempt 2");
  });

  it("does not auto-insert recovery plan steps for repeated failure signatures", async () => {
    const executor = createExecutorWithStubs(
      [
        toolUseResponse("run_command", { command: "exit 1" }),
        textResponse(""),
        toolUseResponse("run_command", { command: "exit 1" }),
        textResponse(""),
      ],
      {
        run_command: { success: false, error: "cannot complete this task without a workaround" },
      },
    );
    const handlePlanRevisionSpy = vi.spyOn(executor as Any, "handlePlanRevision");
    const failedStep: Any = { id: "1", description: "Run baseline task", status: "pending" };
    const retainedPendingStep: Any = { id: "2", description: "Validate output", status: "pending" };

    executor.plan = { description: "Plan", steps: [failedStep, retainedPendingStep] };
    executor.maxPlanRevisions = 5;
    executor.planRevisionCount = 0;
    executor.recoveryRequestActive = true;

    await (executor as Any).executeStep(failedStep);
    await (executor as Any).executeStep(failedStep);

    expect(handlePlanRevisionSpy).not.toHaveBeenCalled();
    expect(executor.planRevisionCount).toBe(0);
    const planDescriptions = executor.plan.steps.map((step: Any) => step.description);
    expect(
      planDescriptions.some((desc: string) => desc.includes("alternative toolchain")),
    ).toBe(false);
    expect(planDescriptions.length).toBe(2);
  });

  it("does not auto-insert recovery steps even when failure reason changes between retries", async () => {
    const executor = createExecutorWithStubs(
      [
        toolUseResponse("run_command", { command: "exit 1" }),
        textResponse(""),
        toolUseResponse("run_command", { command: "exit 1" }),
        textResponse(""),
      ],
      {},
    );

    let runAttempt = 0;
    (executor as Any).toolRegistry.executeTool = vi.fn(async () => {
      runAttempt += 1;
      return {
        success: false,
        exitCode: 1,
        error:
          runAttempt === 1
            ? "cannot complete this task because of a temporary blocker"
            : "cannot complete this task because a different blocker appeared",
      };
    });

    const handlePlanRevisionSpy = vi.spyOn(executor as Any, "handlePlanRevision");
    const failedStep: Any = { id: "1", description: "Run baseline task", status: "pending" };
    const retainedPendingStep: Any = { id: "2", description: "Validate output", status: "pending" };
    executor.plan = { description: "Plan", steps: [failedStep, retainedPendingStep] };
    executor.maxPlanRevisions = 5;
    executor.planRevisionCount = 0;
    executor.recoveryRequestActive = true;

    await (executor as Any).executeStep(failedStep);
    await (executor as Any).executeStep(failedStep);

    expect(handlePlanRevisionSpy).not.toHaveBeenCalled();
    const planDescriptions = executor.plan.steps.map((step: Any) => step.description);
    expect(
      planDescriptions.some((desc: string) => desc.includes("alternative toolchain")),
    ).toBe(false);
    expect(planDescriptions.length).toBe(2);
    expect(executor.planRevisionCount).toBe(0);
  });

  it("keeps existing plan steps unchanged when recovery insertion is not triggered", async () => {
    const executor = createExecutorWithStubs(
      [toolUseResponse("run_command", { command: "exit 1" }), textResponse("")],
      {
        run_command: { success: false, error: "exit code 1" },
      },
    );

    const failedStep: Any = { id: "1", description: "Run baseline task", status: "pending" };
    const retainedPendingStep: Any = { id: "2", description: "Validate output", status: "pending" };
    executor.plan = { description: "Plan", steps: [failedStep, retainedPendingStep] };
    executor.maxPlanRevisions = 5;
    executor.recoveryRequestActive = true;
    executor.planRevisionCount = 0;

    await (executor as Any).executeStep(failedStep);

    expect(failedStep.status).toBe("completed");
    const planDescriptions = executor.plan.steps.map((step: Any) => step.description);
    expect(
      planDescriptions.some((desc: string) => desc.includes("alternative toolchain")),
    ).toBe(false);
    expect(planDescriptions).toContain("Validate output");
    expect(planDescriptions.length).toBe(2);
  });

  it("does not auto-trigger recovery planning when user did not explicitly request recovery", async () => {
    const executor = createExecutorWithStubs(
      [toolUseResponse("run_command", { command: "exit 1" }), textResponse("")],
      {
        run_command: { success: false, error: "cannot complete this task without a workaround" },
      },
    );
    executor.recoveryRequestActive = false;
    const failedStep: Any = { id: "1", description: "Run baseline task", status: "pending" };
    const retainedPendingStep: Any = { id: "2", description: "Validate output", status: "pending" };
    executor.plan = { description: "Plan", steps: [failedStep, retainedPendingStep] };
    executor.maxPlanRevisions = 5;
    executor.planRevisionCount = 0;
    (executor as Any).isRecoveryIntent = vi.fn((reason: string) =>
      reason.includes("cannot complete this task"),
    );

    await (executor as Any).executeStep(failedStep);

    const planDescriptions = executor.plan.steps.map((step: Any) => step.description);
    expect(
      planDescriptions.some((desc: string) => desc.includes("alternative toolchain")),
    ).toBe(false);
    expect(failedStep.status).toBe("completed");
    expect(executor.planRevisionCount).toBe(0);
  });
});

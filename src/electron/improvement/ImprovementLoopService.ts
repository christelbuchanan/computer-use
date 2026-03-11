import type Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import type { AgentDaemon } from "../agent/daemon";
import { TaskRepository, WorkspaceRepository } from "../database/repositories";
import type {
  ImprovementCandidate,
  ImprovementLoopSettings,
  ImprovementReviewStatus,
  ImprovementRun,
  NotificationType,
  Task,
  Workspace,
} from "../../shared/types";
import { buildImprovementExperimentPrompt } from "./ExperimentPromptBuilder";
import { ImprovementCandidateService } from "./ImprovementCandidateService";
import { ExperimentEvaluationService } from "./ExperimentEvaluationService";
import { ImprovementCandidateRepository, ImprovementRunRepository } from "./ImprovementRepositories";
import { ImprovementSettingsManager } from "./ImprovementSettingsManager";

interface ImprovementLoopServiceDeps {
  notify?: (params: {
    type: NotificationType;
    title: string;
    message: string;
    taskId?: string;
    workspaceId?: string;
  }) => Promise<void> | void;
}

export class ImprovementLoopService {
  private readonly workspaceRepo: WorkspaceRepository;
  private readonly taskRepo: TaskRepository;
  private readonly candidateRepo: ImprovementCandidateRepository;
  private readonly runRepo: ImprovementRunRepository;
  private readonly evaluationService: ExperimentEvaluationService;
  private agentDaemon: AgentDaemon | null = null;
  private intervalHandle?: ReturnType<typeof setInterval>;
  private worktreeCreatedListener?: (evt: Any) => void;
  private taskCompletedListener?: (evt: Any) => void;
  private taskStatusListener?: (evt: Any) => void;
  private readonly finalizingRunIds = new Set<string>();
  private started = false;

  constructor(
    private readonly db: Database.Database,
    private readonly candidateService: ImprovementCandidateService,
    private readonly deps: ImprovementLoopServiceDeps = {},
  ) {
    this.workspaceRepo = new WorkspaceRepository(db);
    this.taskRepo = new TaskRepository(db);
    this.candidateRepo = new ImprovementCandidateRepository(db);
    this.runRepo = new ImprovementRunRepository(db);
    this.evaluationService = new ExperimentEvaluationService(db);
  }

  async start(agentDaemon: AgentDaemon): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.agentDaemon = agentDaemon;

    this.worktreeCreatedListener = (evt: Any) => {
      const taskId = typeof evt?.taskId === "string" ? evt.taskId : "";
      if (!taskId) return;
      const run = this.runRepo.findByTaskId(taskId);
      if (!run) return;
      const branch =
        typeof evt?.payload?.branch === "string"
          ? evt.payload.branch
          : typeof evt?.branch === "string"
            ? evt.branch
            : "";
      if (branch) {
        this.runRepo.update(run.id, { branchName: branch });
      }
    };
    agentDaemon.on("worktree_created", this.worktreeCreatedListener);

    const finalize = (taskId: string) => {
      const run = this.runRepo.findByTaskId(taskId);
      if (!run || (run.status !== "queued" && run.status !== "running")) return;
      void this.finalizeRun(run.id, taskId);
    };

    this.taskCompletedListener = (evt: Any) => {
      const taskId = typeof evt?.taskId === "string" ? evt.taskId : "";
      if (taskId) finalize(taskId);
    };
    agentDaemon.on("task_completed", this.taskCompletedListener);

    this.taskStatusListener = (evt: Any) => {
      const taskId = typeof evt?.taskId === "string" ? evt.taskId : "";
      if (taskId) finalize(taskId);
    };
    agentDaemon.on("task_status", this.taskStatusListener);

    await this.refreshCandidates();
    await this.reconcileActiveRuns();
    this.resetInterval();
    const settings = this.getSettings();
    if (settings.enabled && settings.autoRun) {
      await this.runNextExperiment();
    }
  }

  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = undefined;
    }
    if (this.agentDaemon && this.worktreeCreatedListener) {
      this.agentDaemon.removeListener("worktree_created", this.worktreeCreatedListener);
    }
    if (this.agentDaemon && this.taskCompletedListener) {
      this.agentDaemon.removeListener("task_completed", this.taskCompletedListener);
    }
    if (this.agentDaemon && this.taskStatusListener) {
      this.agentDaemon.removeListener("task_status", this.taskStatusListener);
    }
    this.worktreeCreatedListener = undefined;
    this.taskCompletedListener = undefined;
    this.taskStatusListener = undefined;
    this.agentDaemon = null;
    this.started = false;
  }

  getSettings(): ImprovementLoopSettings {
    return ImprovementSettingsManager.loadSettings();
  }

  saveSettings(settings: ImprovementLoopSettings): ImprovementLoopSettings {
    ImprovementSettingsManager.saveSettings(settings);
    const next = ImprovementSettingsManager.loadSettings();
    this.resetInterval();
    return next;
  }

  listCandidates(workspaceId?: string): ImprovementCandidate[] {
    return this.candidateRepo.list({ workspaceId });
  }

  listRuns(workspaceId?: string): ImprovementRun[] {
    return this.runRepo.list({ workspaceId });
  }

  async listRunsFresh(workspaceId?: string): Promise<ImprovementRun[]> {
    await this.reconcileActiveRuns();
    return this.enrichRunsWithExecutionWorkspace(this.runRepo.list({ workspaceId }));
  }

  async refreshCandidates(): Promise<{ candidateCount: number }> {
    return this.candidateService.refresh();
  }

  dismissCandidate(candidateId: string): ImprovementCandidate | undefined {
    return this.candidateService.dismissCandidate(candidateId);
  }

  async reviewRun(
    runId: string,
    reviewStatus: ImprovementReviewStatus,
  ): Promise<ImprovementRun | undefined> {
    const run = this.runRepo.findById(runId);
    if (!run) return undefined;

    if (reviewStatus === "dismissed") {
      this.runRepo.update(runId, {
        reviewStatus,
        promotionStatus:
          run.promotionStatus === "merged" || run.promotionStatus === "pr_opened"
            ? run.promotionStatus
            : "idle",
        promotionError: undefined,
      });
      this.candidateService.reopenCandidate(run.candidateId);
      void this.notify({
        type: "info",
        title: "Improvement dismissed",
        message: run.verdictSummary || "A self-improvement run was dismissed from the review queue.",
        taskId: run.taskId,
        workspaceId: run.workspaceId,
      });
      return this.runRepo.findById(runId);
    }

    if (run.status !== "passed" || !run.taskId) {
      this.runRepo.update(runId, {
        promotionStatus: "promotion_failed",
        promotionError: "Only successful improvement runs with a task worktree can be promoted.",
      });
      void this.notify({
        type: "warning",
        title: "Improvement could not be promoted",
        message: "Only successful improvement runs with a task worktree can be promoted.",
        taskId: run.taskId,
        workspaceId: run.workspaceId,
      });
      return this.runRepo.findById(runId);
    }

    const task = this.taskRepo.findById(run.taskId);
    if (!this.canPromoteRun(run, task)) {
      this.runRepo.update(runId, {
        reviewStatus,
        promotionStatus: "applied",
        promotionError: undefined,
        promotedAt: Date.now(),
      });
      this.candidateService.markCandidateResolved(run.candidateId);
      void this.notify({
        type: "task_completed",
        title: "Improvement applied",
        message: run.verdictSummary || "Accepted reviewed improvement run and kept the change in the workspace.",
        taskId: run.taskId,
        workspaceId: run.workspaceId,
      });
      return this.runRepo.findById(runId);
    }

    return await this.promoteRun(runId, run.taskId, reviewStatus);
  }

  private async promoteRun(
    runId: string,
    taskId: string,
    reviewStatus: ImprovementReviewStatus = "accepted",
  ): Promise<ImprovementRun | undefined> {
    const run = this.runRepo.findById(runId);
    if (!run) return undefined;
    const candidate = this.candidateRepo.findById(run.candidateId);
    const promotionMode = this.getSettings().promotionMode;

    this.runRepo.update(runId, {
      promotionStatus: "promoting",
      promotionError: undefined,
    });

    if (!this.agentDaemon) {
      this.runRepo.update(runId, {
        reviewStatus: "pending",
        promotionStatus: "promotion_failed",
        promotionError: "Agent daemon unavailable",
      });
      void this.notify({
        type: "error",
        title: "Improvement promotion failed",
        message: "Agent daemon unavailable.",
        taskId: run.taskId,
        workspaceId: run.workspaceId,
      });
      return this.runRepo.findById(runId);
    }

    if (promotionMode === "github_pr") {
      const pullRequest = await this.agentDaemon.getWorktreeManager().openPullRequest(taskId, {
        title: this.buildPullRequestTitle(candidate, run),
        body: this.buildPullRequestBody(candidate, run),
      });
      if (pullRequest.success) {
        this.runRepo.update(runId, {
          reviewStatus,
          promotionStatus: "pr_opened",
          pullRequest,
          mergeResult: undefined,
          promotionError: undefined,
          promotedAt: Date.now(),
        });
        this.candidateService.markCandidateResolved(run.candidateId);
        void this.notify({
          type: "task_completed",
          title: "Improvement PR created",
          message: pullRequest.url
            ? `Opened PR for "${candidate?.title || run.verdictSummary || "self-improvement run"}".`
            : "A self-improvement run was promoted as a pull request.",
          taskId: run.taskId,
          workspaceId: run.workspaceId,
        });
        return this.runRepo.findById(runId);
      }

      this.runRepo.update(runId, {
        reviewStatus: "pending",
        promotionStatus: "promotion_failed",
        pullRequest,
        promotionError: pullRequest.error || "Failed to open pull request",
      });
      this.candidateService.markCandidateReview(run.candidateId);
      void this.notify({
        type: "warning",
        title: "Improvement PR failed",
        message: pullRequest.error || "Failed to open pull request.",
        taskId: run.taskId,
        workspaceId: run.workspaceId,
      });
      return this.runRepo.findById(runId);
    }

    const mergeResult = await this.agentDaemon.getWorktreeManager().mergeToBase(taskId);
    if (mergeResult.success) {
      this.runRepo.update(runId, {
        reviewStatus,
        promotionStatus: "merged",
        mergeResult,
        pullRequest: undefined,
        promotionError: undefined,
        promotedAt: Date.now(),
      });
      this.candidateService.markCandidateResolved(run.candidateId);
      void this.notify({
        type: "task_completed",
        title: "Improvement merged",
        message: `Merged "${candidate?.title || run.verdictSummary || "self-improvement run"}" into the base branch.`,
        taskId: run.taskId,
        workspaceId: run.workspaceId,
      });
      return this.runRepo.findById(runId);
    }

    this.runRepo.update(runId, {
      reviewStatus: "pending",
      promotionStatus: "promotion_failed",
      mergeResult,
      promotionError: mergeResult?.error || "Merge failed",
    });
    this.candidateService.markCandidateReview(run.candidateId);
    void this.notify({
      type: "warning",
      title: "Improvement merge failed",
      message: mergeResult?.error || "Merge failed.",
      taskId: run.taskId,
      workspaceId: run.workspaceId,
    });
    return this.runRepo.findById(runId);
  }

  async runNextExperiment(): Promise<ImprovementRun | null> {
    const settings = this.getSettings();
    if (!settings.enabled) return null;
    await this.reconcileActiveRuns();
    if (this.runRepo.countActive() >= settings.maxConcurrentExperiments) {
      return null;
    }

    const candidate = await this.pickNextCandidate(settings.requireWorktree);
    if (!candidate) return null;
    return await this.startExperimentForCandidate(candidate, settings);
  }

  async retryRun(runId: string): Promise<ImprovementRun | null> {
    const settings = this.getSettings();
    if (!settings.enabled) {
      throw new Error("Retry could not start because the self-improvement loop is disabled.");
    }
    await this.reconcileActiveRuns();
    if (this.runRepo.countActive() >= settings.maxConcurrentExperiments) {
      throw new Error("Retry could not start because the maximum number of active improvement runs is already in progress.");
    }

    const priorRun = this.runRepo.findById(runId);
    if (!priorRun) {
      throw new Error("Retry could not start because the previous run no longer exists.");
    }
    if (priorRun.status !== "failed" && priorRun.status !== "cancelled") {
      throw new Error("Retry is only available for failed or cancelled improvement runs.");
    }

    const candidate = this.candidateRepo.findById(priorRun.candidateId);
    if (!candidate) {
      throw new Error("Retry could not start because the original candidate was merged into another record or removed.");
    }
    if (candidate.status !== "open") {
      throw new Error(`Retry could not start because the candidate is now ${candidate.status.replace(/_/g, " ")}.`);
    }
    return await this.startExperimentForCandidate(candidate, settings);
  }

  private async startExperimentForCandidate(
    candidate: ImprovementCandidate,
    settings: ImprovementLoopSettings,
  ): Promise<ImprovementRun | null> {
    const sourceWorkspace = this.workspaceRepo.findById(candidate.workspaceId);
    if (!sourceWorkspace) return null;
    const executionWorkspace = this.resolveExecutionWorkspace(candidate, sourceWorkspace);
    const shouldRequireWorktree = await this.shouldRequireWorktreeForWorkspace(
      executionWorkspace.path,
      executionWorkspace.isTemp,
      settings.requireWorktree,
    );

    const baselineMetrics = this.evaluationService.snapshot(settings.evalWindowDays);
    const run = this.runRepo.create({
      candidateId: candidate.id,
      workspaceId: candidate.workspaceId,
      status: "queued",
      reviewStatus: "pending",
      baselineMetrics,
    });

    this.candidateService.markCandidateRunning(candidate.id);

    try {
      if (!this.agentDaemon) {
        throw new Error("Agent daemon unavailable");
      }
      const task = await this.agentDaemon.createTask({
        title: `Improve: ${candidate.title}`,
        prompt: buildImprovementExperimentPrompt(candidate, {
          sourceWorkspace,
          executionWorkspace,
          relevantLogPaths: this.collectRelevantLogPaths(sourceWorkspace, executionWorkspace),
        }),
        workspaceId: executionWorkspace.id,
        source: "improvement",
        agentConfig: {
          autonomousMode: true,
          allowUserInput: false,
          requireWorktree: shouldRequireWorktree,
          autoApproveTypes: ["run_command"],
          pauseForRequiredDecision: false,
          executionMode: "verified",
          taskDomain: "code",
          reviewPolicy: "strict",
          verificationAgent: true,
          deepWorkMode: true,
          autoContinueOnTurnLimit: true,
          maxAutoContinuations: 1,
          progressJournalEnabled: true,
          gatewayContext: "private",
        },
      });

      this.runRepo.update(run.id, {
        taskId: task.id,
        status: "running",
        startedAt: Date.now(),
      });
      void this.notify({
        type: "info",
        title: "Improvement run started",
        message: `Started autonomous improvement task for "${candidate.title}".`,
        taskId: task.id,
        workspaceId: candidate.workspaceId,
      });
    } catch (error) {
      this.runRepo.update(run.id, {
        status: "failed",
        completedAt: Date.now(),
        verdictSummary: String((error as Error)?.message || error),
      });
      this.candidateService.reopenCandidate(candidate.id);
      void this.notify({
        type: "task_failed",
        title: "Improvement run failed to start",
        message: String((error as Error)?.message || error),
        workspaceId: candidate.workspaceId,
      });
    }

    const latestRun = this.runRepo.findById(run.id);
    return this.enrichRunWithExecutionWorkspace(latestRun) || null;
  }

  private async finalizeRun(runId: string, taskId: string): Promise<void> {
    if (this.finalizingRunIds.has(runId)) return;
    this.finalizingRunIds.add(runId);
    try {
      const run = this.runRepo.findById(runId);
      if (!run) return;
      const task = this.taskRepo.findById(taskId);
      if (!task || !["completed", "failed", "cancelled"].includes(task.status)) {
        return;
      }

      const settings = this.getSettings();
      const baselineMetrics =
        run.baselineMetrics || this.evaluationService.snapshot(settings.evalWindowDays);
      const evaluation = this.evaluationService.evaluateRun({
        runId,
        taskId,
        baselineMetrics,
        evalWindowDays: settings.evalWindowDays,
      });

      this.runRepo.update(runId, {
        status:
          task.status === "cancelled"
            ? "cancelled"
            : evaluation.passed
              ? "passed"
              : "failed",
        completedAt: Date.now(),
        outcomeMetrics: evaluation.outcomeMetrics,
        verdictSummary: evaluation.summary,
        evaluationNotes: evaluation.notes.join("\n"),
      });

      if (evaluation.passed) {
        const canPromote = this.canPromoteRun(run, task);
        if (settings.reviewRequired) {
          this.candidateService.markCandidateReview(run.candidateId);
          void this.notify({
            type: "task_completed",
            title: canPromote ? "Improvement ready for review" : "Improvement ready for review before apply",
            message: evaluation.summary,
            taskId,
            workspaceId: run.workspaceId,
          });
        } else if (!canPromote) {
          this.runRepo.update(runId, {
            reviewStatus: "accepted",
            promotionStatus: "applied",
            promotionError: undefined,
            promotedAt: Date.now(),
          });
          this.candidateService.markCandidateResolved(run.candidateId);
          void this.notify({
            type: "task_completed",
            title: "Improvement applied",
            message: evaluation.summary,
            taskId,
            workspaceId: run.workspaceId,
          });
        } else {
          await this.promoteRun(runId, taskId, "accepted");
        }
      } else {
        this.candidateService.reopenCandidate(run.candidateId);
        void this.notify({
          type: "task_failed",
          title: "Improvement experiment failed",
          message: evaluation.summary,
          taskId,
          workspaceId: run.workspaceId,
        });
      }
    } finally {
      this.finalizingRunIds.delete(runId);
    }
  }

  private async pickNextCandidate(requireWorktree: boolean): Promise<ImprovementCandidate | undefined> {
    const workspaces = this.workspaceRepo.findAll();
    const ranked: Array<{ candidate: ImprovementCandidate; promotable: boolean }> = [];
    const worktreeManager = this.agentDaemon?.getWorktreeManager();
    for (const workspace of workspaces) {
      const candidate = this.candidateService.getTopCandidateForWorkspace(workspace.id);
      if (!candidate) continue;
      const promotable =
        !!worktreeManager &&
        requireWorktree &&
        (await worktreeManager.shouldUseWorktree(workspace.path, workspace.isTemp));
      ranked.push({ candidate, promotable });
    }
    ranked.sort(
      (a, b) =>
        Number(b.promotable) - Number(a.promotable) ||
        b.candidate.priorityScore - a.candidate.priorityScore ||
        b.candidate.lastSeenAt - a.candidate.lastSeenAt,
    );
    return ranked[0]?.candidate;
  }

  private resolveExecutionWorkspace(candidate: ImprovementCandidate, sourceWorkspace: Workspace): Workspace {
    if (this.isLikelyCoworkCodeWorkspace(sourceWorkspace)) {
      return sourceWorkspace;
    }
    if (!this.candidateExplicitlyTargetsCowork(candidate)) {
      return sourceWorkspace;
    }

    const alternatives = this.workspaceRepo
      .findAll()
      .filter((workspace) => workspace.id !== sourceWorkspace.id)
      .map((workspace) => ({ workspace, score: this.scoreExecutionWorkspace(workspace, candidate) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score);

    return alternatives[0]?.workspace || sourceWorkspace;
  }

  private scoreExecutionWorkspace(workspace: Workspace, candidate: ImprovementCandidate): number {
    let score = 0;
    if (workspace.isTemp) score -= 5;

    const workspaceName = workspace.name.toLowerCase();
    const workspacePath = workspace.path.toLowerCase();
    const candidateText = `${candidate.title} ${candidate.summary}`.toLowerCase();
    const packageJson = this.readPackageMetadata(workspace.path);
    const packageName = packageJson?.name?.toLowerCase?.() || "";

    if (workspaceName.includes("cowork")) score += 6;
    if (workspacePath.includes("/cowork")) score += 6;
    if (packageName.includes("cowork")) score += 10;
    if (fs.existsSync(path.join(workspace.path, "src", "electron"))) score += 4;
    if (fs.existsSync(path.join(workspace.path, "src", "renderer"))) score += 4;
    if (fs.existsSync(path.join(workspace.path, "logs", "dev-latest.log"))) score += 2;
    if (fs.existsSync(path.join(workspace.path, ".git"))) score += 1;
    if (candidateText.includes("cowork") && (workspaceName.includes("cowork") || packageName.includes("cowork"))) {
      score += 4;
    }

    return score;
  }

  private candidateExplicitlyTargetsCowork(candidate: ImprovementCandidate): boolean {
    const parts = [
      candidate.title,
      candidate.summary,
      ...candidate.evidence.flatMap((evidence) => [evidence.summary, evidence.details]),
    ];
    const text = parts
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .join(" ")
      .toLowerCase();

    if (!text) return false;
    return /\bcowork\b|\bcowork os\b|src\/electron|src\/renderer|dev-latest\.log|electron app|renderer\b/.test(
      text,
    );
  }

  private isLikelyCoworkCodeWorkspace(workspace: Workspace): boolean {
    const score = this.scoreExecutionWorkspace(workspace, {
      id: "",
      workspaceId: workspace.id,
      fingerprint: "",
      source: "task_failure",
      status: "open",
      title: "",
      summary: "",
      severity: 0,
      recurrenceCount: 0,
      fixabilityScore: 0,
      priorityScore: 0,
      evidence: [],
      firstSeenAt: 0,
      lastSeenAt: 0,
    });
    return score >= 18;
  }

  private readPackageMetadata(workspacePath: string): { name?: string } | null {
    const packageJsonPath = path.join(workspacePath, "package.json");
    if (!fs.existsSync(packageJsonPath)) return null;
    try {
      return JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as { name?: string };
    } catch {
      return null;
    }
  }

  private collectRelevantLogPaths(sourceWorkspace: Workspace, executionWorkspace: Workspace): string[] {
    const logPaths = new Set<string>();
    for (const workspace of [executionWorkspace, sourceWorkspace]) {
      const logPath = path.join(workspace.path, "logs", "dev-latest.log");
      if (fs.existsSync(logPath)) {
        logPaths.add(logPath);
      }
    }
    return [...logPaths];
  }

  private enrichRunsWithExecutionWorkspace(runs: ImprovementRun[]): ImprovementRun[] {
    return runs.map((run) => this.enrichRunWithExecutionWorkspace(run) || run);
  }

  private enrichRunWithExecutionWorkspace(run: ImprovementRun | undefined): ImprovementRun | undefined {
    if (!run) return undefined;
    if (!run.taskId) {
      return {
        ...run,
        executionWorkspaceId: run.executionWorkspaceId || run.workspaceId,
      };
    }
    const task = this.taskRepo.findById(run.taskId);
    return {
      ...run,
      executionWorkspaceId: task?.workspaceId || run.executionWorkspaceId || run.workspaceId,
    };
  }

  private async reconcileActiveRuns(): Promise<void> {
    const activeRuns = this.runRepo.list({ status: ["queued", "running"] });
    for (const run of activeRuns) {
      if (!run.taskId) {
        this.runRepo.update(run.id, {
          status: "failed",
          completedAt: Date.now(),
          verdictSummary: "Improvement run had no linked task and was marked failed during reconciliation.",
        });
        this.candidateService.reopenCandidate(run.candidateId);
        continue;
      }
      const task = this.taskRepo.findById(run.taskId);
      if (!task) {
        this.runRepo.update(run.id, {
          status: "failed",
          completedAt: Date.now(),
          verdictSummary: "Improvement task record was missing and the run was marked failed during reconciliation.",
        });
        this.candidateService.reopenCandidate(run.candidateId);
        continue;
      }
      if (["completed", "failed", "cancelled"].includes(task.status)) {
        await this.finalizeRun(run.id, run.taskId);
      }
    }
  }

  private async shouldRequireWorktreeForWorkspace(
    workspacePath: string,
    isTemp: boolean | undefined,
    requireWorktree: boolean,
  ): Promise<boolean> {
    if (!requireWorktree) return false;
    const worktreeManager = this.agentDaemon?.getWorktreeManager();
    if (!worktreeManager) return false;
    return await worktreeManager.shouldUseWorktree(workspacePath, isTemp);
  }

  private canPromoteRun(run: ImprovementRun, task: Task | undefined): boolean {
    return Boolean(run.branchName || task?.worktreePath);
  }

  private resetInterval(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = undefined;
    }

    const settings = this.getSettings();
    if (!settings.enabled || !settings.autoRun) return;
    this.intervalHandle = setInterval(() => {
      void this.refreshCandidates().then(() => this.runNextExperiment());
    }, settings.intervalMinutes * 60 * 1000);
  }

  private buildPullRequestTitle(
    candidate: ImprovementCandidate | undefined,
    run: ImprovementRun,
  ): string {
    if (candidate?.title?.trim()) {
      return `Self-improvement: ${candidate.title.trim()}`;
    }
    return `Self-improvement run ${run.id.slice(0, 8)}`;
  }

  private buildPullRequestBody(
    candidate: ImprovementCandidate | undefined,
    run: ImprovementRun,
  ): string {
    const lines = [
      "## Summary",
      `- ${candidate?.summary?.trim() || run.verdictSummary || "Autonomous improvement run."}`,
      run.verdictSummary ? `- Evaluation: ${run.verdictSummary}` : "",
      candidate?.recurrenceCount ? `- Recurrence count: ${candidate.recurrenceCount}` : "",
      "",
      "## Context",
      `- Improvement run: ${run.id}`,
      run.taskId ? `- Task: ${run.taskId}` : "",
      run.branchName ? `- Branch: ${run.branchName}` : "",
      "",
      "## Notes",
      run.evaluationNotes || "Generated by Cowork self-improvement loop.",
    ].filter(Boolean);
    return lines.join("\n");
  }

  private async notify(params: {
    type: NotificationType;
    title: string;
    message: string;
    taskId?: string;
    workspaceId?: string;
  }): Promise<void> {
    try {
      await this.deps.notify?.(params);
    } catch (error) {
      console.error("[ImprovementLoopService] Failed to emit notification:", error);
    }
  }

}

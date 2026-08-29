import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import { isArkConfigured } from "./config.js";
import { HttpError } from "./errors.js";
import { JsonStore } from "./store.js";
import type {
  Agent,
  AgentRunner,
  CreateTeamTaskInput,
  Database,
  JsonValue,
  RunnerResult,
  TeamTask,
  TeamTaskEvent,
  TeamTaskEventType,
} from "./types.js";
import { WorkspaceManager } from "./workspace.js";

const MAX_TURNS = 30;
const MAX_CONTRIBUTION_LENGTH = 20_000;
const MAX_HISTORY_LENGTH = 60_000;
const now = () => new Date().toISOString();

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

const leadDecisionSchema = z.object({
  message: z.string().trim().min(1).max(MAX_CONTRIBUTION_LENGTH),
  statePatch: z.record(z.string(), jsonValueSchema).default({}),
  decision: z.discriminatedUnion("type", [
    z.object({
      type: z.literal("delegate"),
      assignment: z.string().trim().min(1).max(10_000),
    }),
    z.object({
      type: z.literal("complete"),
      summary: z.string().trim().min(1).max(MAX_CONTRIBUTION_LENGTH),
    }),
  ]),
});

type LeadDecision = z.infer<typeof leadDecisionSchema>;

export class TeamTaskService {
  private readonly activeExecutions = new Map<string, Promise<void>>();

  constructor(
    private readonly config: AppConfig,
    private readonly store: JsonStore,
    private readonly workspaces: WorkspaceManager,
    private readonly runner: AgentRunner,
  ) {}

  async initialize(): Promise<void> {
    await this.store.mutate((database) => {
      for (const task of database.teamTasks) {
        if (task.status !== "running") continue;
        task.status = "paused";
        task.currentAgentId = null;
        task.lastError = "Server restarted while this Team Task was active";
        task.updatedAt = now();
        this.releaseAgents(database, task);
        this.addEvent(database, task, "task_paused", null, task.lastError);
      }
    });
  }

  listTasks(): TeamTask[] {
    return this.store
      .snapshot()
      .teamTasks.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  getTask(id: string): TeamTask {
    const task = this.store.snapshot().teamTasks.find((item) => item.id === id);
    if (!task) throw new HttpError(404, "Team Task not found");
    return task;
  }

  getEvents(taskId: string): TeamTaskEvent[] {
    this.getTask(taskId);
    return this.store
      .snapshot()
      .teamTaskEvents.filter((event) => event.taskId === taskId)
      .sort((left, right) => left.sequence - right.sequence);
  }

  async createTask(input: CreateTeamTaskInput): Promise<TeamTask> {
    if (!isArkConfigured(this.config)) {
      throw new HttpError(503, "Ark is not configured. Set ARK_API_KEY and ARK_MODEL, then restart.");
    }
    const specialistIds = [...new Set(input.specialistAgentIds)];
    if (specialistIds.length !== input.specialistAgentIds.length) {
      throw new HttpError(400, "Select each specialist only once");
    }
    if (specialistIds.includes(input.leadAgentId)) {
      throw new HttpError(400, "The Lead cannot also be selected as a specialist");
    }
    if (specialistIds.length < 1) {
      throw new HttpError(400, "Select at least one specialist");
    }

    const timestamp = now();
    const id = randomUUID();
    const participantIds = [input.leadAgentId, ...specialistIds];
    const task: TeamTask = {
      id,
      objective: input.objective.trim(),
      leadAgentId: input.leadAgentId,
      specialistAgentIds: specialistIds,
      status: "running",
      workspacePath: this.workspaces.teamTaskWorkspacePath(id),
      currentAgentId: input.leadAgentId,
      currentAssignment: "Review the objective and delegate the first useful assignment.",
      turnCount: 0,
      maxTurns: MAX_TURNS,
      sharedState: { phase: "starting" },
      stateVersion: 0,
      threadIds: Object.fromEntries(participantIds.map((agentId) => [agentId, null])),
      completionSummary: null,
      lastError: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      completedAt: null,
    };

    if (this.store.snapshot().teamTasks.some((item) => ["running", "paused"].includes(item.status))) {
      throw new HttpError(409, "Finish or stop the existing Team Task first");
    }
    this.validateAvailableAgents(participantIds);
    await this.workspaces.createTeamTaskWorkspace(task);
    await this.store.mutate((database) => {
      if (database.teamTasks.some((item) => ["running", "paused"].includes(item.status))) {
        throw new HttpError(409, "Finish or stop the existing Team Task first");
      }
      this.reserveAgents(database, task);
      database.teamTasks.push(task);
      this.addEvent(database, task, "task_started", null, "Team Task started");
    });
    this.schedule(task.id);
    return task;
  }

  async stopTask(id: string): Promise<TeamTask> {
    const activeAgentId = this.getTask(id).currentAgentId;
    const task = await this.store.mutate((database) => {
      const stored = this.findTask(database, id);
      if (!["running", "paused"].includes(stored.status)) {
        throw new HttpError(409, "This Team Task is not active");
      }
      stored.status = "stopped";
      stored.currentAgentId = null;
      stored.currentAssignment = null;
      stored.completedAt = now();
      stored.updatedAt = stored.completedAt;
      this.releaseAgents(database, stored);
      this.addEvent(database, stored, "task_stopped", null, "Team Task stopped by the user");
      return structuredClone(stored);
    });
    if (activeAgentId) await this.runner.cancel(activeAgentId);
    await this.activeExecutions.get(id)?.catch(() => undefined);
    return task;
  }

  async resumeTask(id: string): Promise<TeamTask> {
    const task = await this.store.mutate((database) => {
      const stored = this.findTask(database, id);
      if (stored.status !== "paused") throw new HttpError(409, "Only a paused Team Task can resume");
      if (database.teamTasks.some((item) => item.id !== id && item.status === "running")) {
        throw new HttpError(409, "Another Team Task is already running");
      }
      this.reserveAgents(database, stored);
      stored.status = "running";
      stored.currentAgentId = stored.leadAgentId;
      stored.currentAssignment = "Review the interruption and decide how the team should continue.";
      stored.lastError = null;
      stored.updatedAt = now();
      this.addEvent(database, stored, "task_resumed", null, "Team Task resumed through the Lead");
      return structuredClone(stored);
    });
    this.schedule(id);
    return task;
  }

  private schedule(taskId: string): void {
    if (this.activeExecutions.has(taskId)) return;
    const execution = this.runLoop(taskId)
      .catch(async (error) => {
        await this.pauseUnexpectedly(taskId, error instanceof Error ? error.message : String(error));
      })
      .finally(() => this.activeExecutions.delete(taskId));
    this.activeExecutions.set(taskId, execution);
  }

  private async runLoop(taskId: string): Promise<void> {
    while (true) {
      const task = this.getTask(taskId);
      if (task.status !== "running" || !task.currentAgentId) return;
      if (task.turnCount >= task.maxTurns) {
        await this.failTask(taskId, "The Team Task reached its 30-turn safety limit");
        return;
      }
      const actingAgent = this.getAgent(task.currentAgentId);
      const isLead = actingAgent.id === task.leadAgentId;
      const outcome = await this.executeWithRetry(task, actingAgent, isLead);
      if (!outcome) continue;
      if (isLead) {
        await this.applyLeadDecision(taskId, actingAgent.id, outcome.result, outcome.decision!);
      } else {
        await this.applySpecialistResult(taskId, actingAgent.id, outcome.result);
      }
    }
  }

  private async executeWithRetry(
    initialTask: TeamTask,
    agent: Agent,
    isLead: boolean,
  ): Promise<{ result: RunnerResult; decision: LeadDecision | null } | null> {
    let lastError = "Agent turn failed";
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const task = this.getTask(initialTask.id);
      if (task.status !== "running") return null;
      if (task.turnCount >= task.maxTurns) {
        await this.failTask(task.id, "The Team Task reached its 30-turn safety limit");
        return null;
      }
      const mayRun = await this.store.mutate((database) => {
        const stored = this.findTask(database, task.id);
        if (stored.status !== "running" || stored.currentAgentId !== agent.id) return false;
        stored.turnCount += 1;
        stored.updatedAt = now();
        return true;
      });
      if (!mayRun) return null;
      try {
        const result = await this.runner.run({
          agentId: agent.id,
          workspacePath: task.workspacePath,
          prompt: this.buildPrompt(task, agent, isLead),
          threadId: task.threadIds[agent.id] ?? null,
        });
        if (result.output.length > MAX_CONTRIBUTION_LENGTH) {
          throw new Error("Agent contribution exceeded 20,000 characters");
        }
        const decision = isLead ? this.parseLeadDecision(result.output) : null;
        if (decision?.decision.type === "complete" && !this.allSpecialistsInvoked(task)) {
          throw new Error("Lead cannot complete the Team Task before every selected specialist has been invoked");
        }
        return { result, decision };
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        if (this.getTask(task.id).status !== "running") return null;
        if (attempt === 1 && this.getTask(task.id).turnCount < task.maxTurns) {
          await this.store.mutate((database) => {
            const stored = this.findTask(database, task.id);
            this.addEvent(database, stored, "turn_retry", agent.id, lastError, stored.currentAssignment, attempt + 1);
          });
        }
      }
    }

    if (isLead) {
      await this.pauseTask(initialTask.id, "Lead Agent failed twice: " + lastError);
    } else {
      await this.store.mutate((database) => {
        const task = this.findTask(database, initialTask.id);
        this.addEvent(database, task, "turn_failed", agent.id, lastError, task.currentAssignment, 2);
        task.currentAgentId = task.leadAgentId;
        task.currentAssignment = agent.name + " could not complete the assignment. Choose how to continue.";
        task.lastError = lastError;
        task.updatedAt = now();
      });
    }
    return null;
  }

  private async applyLeadDecision(
    taskId: string,
    leadAgentId: string,
    result: RunnerResult,
    response: LeadDecision,
  ): Promise<void> {
    await this.store.mutate((database) => {
      const task = this.findRunningTask(database, taskId, leadAgentId);
      task.threadIds[leadAgentId] = result.threadId;
      Object.assign(task.sharedState, response.statePatch);
      if (Object.keys(response.statePatch).length > 0) task.stateVersion += 1;
      this.addEvent(database, task, "lead_decision", leadAgentId, response.message, null, null, response.statePatch);
      if (response.decision.type === "complete") {
        task.status = "completed";
        task.currentAgentId = null;
        task.currentAssignment = null;
        task.completionSummary = response.decision.summary;
        task.completedAt = now();
        task.updatedAt = task.completedAt;
        this.addEvent(database, task, "task_completed", leadAgentId, response.decision.summary);
        this.releaseAgents(database, task);
        return;
      }
      const delegation = response.decision;
      const specialistId = this.nextSpecialistId(database, task);
      task.currentAgentId = specialistId;
      task.currentAssignment = delegation.assignment;
      task.lastError = null;
      task.updatedAt = now();
      const specialist = database.agents.find((agent) => agent.id === specialistId);
      this.addEvent(
        database,
        task,
        "delegated",
        leadAgentId,
        "Delegated the next assignment to " + (specialist?.name ?? "the selected specialist") + ".",
        delegation.assignment,
      );
    });
  }

  private async applySpecialistResult(taskId: string, agentId: string, result: RunnerResult): Promise<void> {
    await this.store.mutate((database) => {
      const task = this.findRunningTask(database, taskId, agentId);
      const assignment = task.currentAssignment;
      task.threadIds[agentId] = result.threadId;
      this.addEvent(database, task, "specialist_result", agentId, result.output.trim(), assignment);
      task.currentAgentId = task.leadAgentId;
      task.currentAssignment = "Review the specialist result and decide the next step.";
      task.lastError = null;
      task.updatedAt = now();
    });
  }

  private buildPrompt(task: TeamTask, agent: Agent, isLead: boolean): string {
    const database = this.store.snapshot();
    const participants = [task.leadAgentId, ...task.specialistAgentIds]
      .map((id) => database.agents.find((item) => item.id === id))
      .filter((item): item is Agent => Boolean(item))
      .map((item) => "- " + item.name + " (" + item.id + "): " + (item.description || "No description"))
      .join("\n");
    const history = database.teamTaskEvents
      .filter((event) => event.taskId === task.id)
      .sort((left, right) => left.sequence - right.sequence)
      .map((event) => "#" + event.sequence + " [" + event.type + "] " + event.content)
      .join("\n")
      .slice(-MAX_HISTORY_LENGTH);
    const identity = [
      "You are " + agent.name + ".",
      agent.description ? "Role: " + agent.description : "",
      agent.instructions ? "Agent instructions: " + agent.instructions : "",
    ].filter(Boolean).join("\n");
    const common = [
      identity,
      "You are participating in a platform-managed Team Task.",
      "Shared objective: " + task.objective,
      "Current assignment: " + (task.currentAssignment ?? "None"),
      "Shared state version " + task.stateVersion + ": " + JSON.stringify(task.sharedState),
      "Participants:\n" + participants,
      "Shared event history:\n" + (history || "No earlier events"),
    ].join("\n\n");
    if (!isLead) {
      return common + `\n\nComplete exactly the current assignment and reply with a concise result for the Lead. Follow the assignment's intent:\n- For a direct conversational action, return the requested result directly. Do not create a file or script merely to produce that result.\n- Create code or another workspace artifact only when the objective or assignment explicitly requests it.\n- When execution is explicitly requested, run the artifact, verify it, and include the actual output in your result.\nDo not choose the next Agent.`;
    }
    const nextSpecialist = database.agents.find((item) => item.id === this.nextSpecialistId(database, task));
    const remainingInvocations = Math.max(0, task.specialistAgentIds.length - this.delegationCount(database, task.id));
    return common + `\n\nYou are the Lead Agent. You may inspect or edit the shared workspace before deciding. The coordinator, not you, selects specialists in strict round-robin order. Your next delegated assignment will go to ${nextSpecialist?.name ?? "the next specialist"}. Every selected specialist must be invoked before completion${remainingInvocations > 0 ? `; ${remainingInvocations} initial specialist invocation(s) remain` : ""}.\n\nMake each assignment specific to that specialist and faithful to the objective. For collaborative sequences such as a countdown, delegate exactly one atomic visible contribution per turn (for example, one number), use shared state to track progress, and continue until the entire sequence is complete. Direct conversational actions should request the literal result; request code, files, or execution only when the objective calls for them.\n\nReply with JSON only, without markdown fences, using one of these shapes:\n{"message":"progress update","statePatch":{"phase":"next phase"},"decision":{"type":"delegate","assignment":"specific work for the next specialist"}}\n{"message":"completion update","statePatch":{"phase":"complete"},"decision":{"type":"complete","summary":"final outcome and artifact locations, when applicable"}}`;
  }

  private delegationCount(database: Database, taskId: string): number {
    return database.teamTaskEvents.filter(
      (event) => event.taskId === taskId && event.type === "delegated",
    ).length;
  }

  private nextSpecialistId(database: Database, task: TeamTask): string {
    const index = this.delegationCount(database, task.id) % task.specialistAgentIds.length;
    const specialistId = task.specialistAgentIds[index];
    if (!specialistId) throw new Error("Team Task has no specialist available for delegation");
    return specialistId;
  }

  private allSpecialistsInvoked(task: TeamTask): boolean {
    return this.delegationCount(this.store.snapshot(), task.id) >= task.specialistAgentIds.length;
  }

  private parseLeadDecision(output: string): LeadDecision {
    const trimmed = output.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error("Lead Agent returned invalid JSON");
    }
    const result = leadDecisionSchema.safeParse(parsed);
    if (!result.success) throw new Error("Lead Agent returned an invalid delegation decision");
    return result.data;
  }

  private validateAvailableAgents(ids: string[]): void {
    const database = this.store.snapshot();
    for (const id of ids) {
      const agent = database.agents.find((item) => item.id === id);
      if (!agent) throw new HttpError(404, "Selected Agent not found");
      if (agent.status !== "ready" || agent.activeTeamTaskId) {
        throw new HttpError(409, agent.name + " is not ready for a Team Task");
      }
    }
  }

  private reserveAgents(database: Database, task: TeamTask): void {
    for (const id of [task.leadAgentId, ...task.specialistAgentIds]) {
      const agent = database.agents.find((item) => item.id === id);
      if (!agent) throw new HttpError(404, "Selected Agent not found");
      if (agent.status !== "ready" || agent.activeTeamTaskId) {
        throw new HttpError(409, agent.name + " is not ready for a Team Task");
      }
      agent.status = "busy";
      agent.activeTeamTaskId = task.id;
      agent.updatedAt = now();
    }
  }

  private releaseAgents(database: Database, task: TeamTask): void {
    for (const agent of database.agents) {
      if (agent.activeTeamTaskId !== task.id) continue;
      agent.activeTeamTaskId = null;
      if (agent.status === "busy") agent.status = "ready";
      agent.updatedAt = now();
    }
  }

  private getAgent(id: string): Agent {
    const agent = this.store.snapshot().agents.find((item) => item.id === id);
    if (!agent) throw new Error("Team Task Agent no longer exists");
    return agent;
  }

  private findTask(database: Database, id: string): TeamTask {
    const task = database.teamTasks.find((item) => item.id === id);
    if (!task) throw new HttpError(404, "Team Task not found");
    return task;
  }

  private findRunningTask(database: Database, id: string, agentId: string): TeamTask {
    const task = this.findTask(database, id);
    if (task.status !== "running" || task.currentAgentId !== agentId) {
      throw new Error("Team Task turn changed before the Agent result was committed");
    }
    return task;
  }

  private addEvent(
    database: Database,
    task: TeamTask,
    type: TeamTaskEventType,
    agentId: string | null,
    content: string,
    assignment: string | null = null,
    attempt: number | null = null,
    statePatch: Record<string, JsonValue> | null = null,
  ): void {
    const sequence = database.teamTaskEvents
      .filter((event) => event.taskId === task.id)
      .reduce((maximum, event) => Math.max(maximum, event.sequence), 0) + 1;
    database.teamTaskEvents.push({
      id: randomUUID(), taskId: task.id, sequence, type, agentId,
      content, assignment, attempt, statePatch, createdAt: now(),
    });
  }

  private async pauseTask(id: string, reason: string): Promise<void> {
    await this.store.mutate((database) => {
      const task = this.findTask(database, id);
      if (task.status !== "running") return;
      task.status = "paused";
      task.currentAgentId = null;
      task.lastError = reason;
      task.updatedAt = now();
      this.releaseAgents(database, task);
      this.addEvent(database, task, "task_paused", null, reason);
    });
  }

  private async failTask(id: string, reason: string): Promise<void> {
    await this.store.mutate((database) => {
      const task = this.findTask(database, id);
      if (task.status !== "running") return;
      task.status = "failed";
      task.currentAgentId = null;
      task.currentAssignment = null;
      task.lastError = reason;
      task.completedAt = now();
      task.updatedAt = task.completedAt;
      this.releaseAgents(database, task);
      this.addEvent(database, task, "turn_failed", null, reason);
    });
  }

  private async pauseUnexpectedly(id: string, reason: string): Promise<void> {
    try {
      await this.pauseTask(id, "Coordinator error: " + reason);
    } catch {
      // Preserve the original coordinator failure if persistence also fails.
    }
  }
}

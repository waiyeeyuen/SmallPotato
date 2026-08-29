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
const MAX_COLLABORATION_ROUNDS = 12;
const MAX_CONTRIBUTION_LENGTH = 20_000;
const MAX_HISTORY_LENGTH = 32_000;
const MAX_HISTORY_EVENTS = 80;
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
      agentId: z.string().uuid(),
      assignment: z.string().trim().min(1).max(10_000),
    }),
    z.object({
      type: z.literal("complete"),
      summary: z.string().trim().min(1).max(MAX_CONTRIBUTION_LENGTH),
    }),
  ]),
});

type LeadDecision = z.infer<typeof leadDecisionSchema>;

const specialistResultSchema = z.object({
  message: z.string().trim().min(1).max(MAX_CONTRIBUTION_LENGTH),
  activity: z.string().trim().min(1).max(MAX_CONTRIBUTION_LENGTH),
});

type SpecialistResult = z.infer<typeof specialistResultSchema>;

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
        task.assignmentQueue = [];
        task.activeTurnStartedAt = null;
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
      .map((event) => ({ ...event, chatContent: event.chatContent ?? null }))
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
      currentAssignment: "Review the objective and dynamically select the most relevant first specialist turn.",
      assignmentQueue: [],
      activeTurnStartedAt: null,
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
      stored.assignmentQueue = [];
      stored.activeTurnStartedAt = null;
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
      stored.assignmentQueue = [];
      stored.activeTurnStartedAt = null;
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
        await this.applySpecialistResult(taskId, actingAgent.id, outcome.result, outcome.specialistResult!);
      }
    }
  }

  private async executeWithRetry(
    initialTask: TeamTask,
    agent: Agent,
    isLead: boolean,
  ): Promise<{
    result: RunnerResult;
    decision: LeadDecision | null;
    specialistResult: SpecialistResult | null;
  } | null> {
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
        stored.activeTurnStartedAt = now();
        stored.updatedAt = now();
        this.addEvent(
          database,
          stored,
          "turn_started",
          agent.id,
          agent.name + " started a coordinator turn.",
          stored.currentAssignment,
          attempt,
        );
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
        const specialistResult = isLead ? null : this.parseSpecialistResult(result.output);
        if (decision?.decision.type === "delegate") {
          this.validateDelegation(task, decision.decision.agentId);
          if (this.specialistContributionCount(task.id) >= MAX_COLLABORATION_ROUNDS) {
            throw new Error("The collaboration round limit was reached; the Lead must complete with the available evidence");
          }
        }
        if (decision?.decision.type === "complete" && !this.minimumCollaborationReached(task)) {
          const minimum = Math.min(2, task.specialistAgentIds.length);
          throw new Error(
            "Lead cannot complete the Team Task before " + minimum +
              " distinct specialist" + (minimum === 1 ? " has" : "s have") + " contributed",
          );
        }
        return { result, decision, specialistResult };
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
        task.activeTurnStartedAt = null;
        task.currentAgentId = task.leadAgentId;
        task.currentAssignment = agent.name +
          " could not complete the assignment. Review the failure and dynamically choose the best next step.";
        task.assignmentQueue = [];
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
      task.activeTurnStartedAt = null;
      task.threadIds[leadAgentId] = result.threadId;
      Object.assign(task.sharedState, response.statePatch);
      if (Object.keys(response.statePatch).length > 0) task.stateVersion += 1;
      this.addEvent(database, task, "lead_decision", leadAgentId, response.message, null, null, response.statePatch);
      if (response.decision.type === "complete") {
        task.status = "completed";
        task.currentAgentId = null;
        task.currentAssignment = null;
        task.assignmentQueue = [];
        task.completionSummary = response.decision.summary;
        task.completedAt = now();
        task.updatedAt = task.completedAt;
        this.addEvent(database, task, "task_completed", leadAgentId, response.decision.summary);
        this.releaseAgents(database, task);
        return;
      }
      const delegation = response.decision;
      task.currentAgentId = delegation.agentId;
      task.currentAssignment = delegation.assignment;
      task.assignmentQueue = [];
      task.lastError = null;
      task.updatedAt = now();
      const specialist = database.agents.find((agent) => agent.id === delegation.agentId);
      this.addEvent(
        database,
        task,
        "delegated",
        leadAgentId,
        "Selected " + (specialist?.name ?? "the specialist") + " for the next collaborative turn.",
        delegation.assignment,
      );
    });
  }

  private async applySpecialistResult(
    taskId: string,
    agentId: string,
    result: RunnerResult,
    response: SpecialistResult,
  ): Promise<void> {
    await this.store.mutate((database) => {
      const task = this.findRunningTask(database, taskId, agentId);
      const assignment = task.currentAssignment;
      task.activeTurnStartedAt = null;
      task.threadIds[agentId] = result.threadId;
      this.addEvent(database, task, "specialist_result", agentId, response.activity, assignment, null, null, response.message);
      task.currentAgentId = task.leadAgentId;
      task.currentAssignment = "Review the latest contribution in the shared conversation and dynamically choose the next specialist or complete.";
      task.assignmentQueue = [];
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
      .filter((event) => event.taskId === task.id && event.type !== "turn_started")
      .sort((left, right) => left.sequence - right.sequence)
      .slice(-MAX_HISTORY_EVENTS)
      .map((event) => {
        const actor = event.agentId
          ? database.agents.find((item) => item.id === event.agentId)?.name ?? "Unknown Agent"
          : "Coordinator";
        const role = event.agentId === task.leadAgentId
          ? "Lead"
          : event.agentId && task.specialistAgentIds.includes(event.agentId)
            ? "Specialist"
            : "System";
        return [
          "#" + event.sequence + " [" + event.type + "] " + actor + " (" + role + ")",
          event.assignment ? "Assignment: " + event.assignment : "",
          event.chatContent ? "Conversation message: " + event.chatContent : "",
          "Activity: " + event.content,
        ].filter(Boolean).join("\n");
      })
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
      "Shared conversation transcript, oldest to newest:\n" + (history || "No earlier turns"),
    ].join("\n\n");
    if (!isLead) {
      return common + `\n\nAct as one turn in a continuing multi-Agent conversation, not as an isolated solver. Complete exactly the current assignment and use the transcript above as authoritative context:\n- Explicitly build on, refine, test, or challenge the latest relevant contribution instead of repeating it.\n- Advance only the next useful step. Do not restart the objective from scratch or produce a premature final synthesis unless the assignment asks for one.\n- For a direct conversational action, return the requested result directly. Do not create, edit, or persist a file or script merely to produce that result.\n- Create code or another workspace artifact only when the objective or assignment explicitly requests a file, implementation, or persisted deliverable.\n- When execution is explicitly requested, inspect the existing shared workspace, run the artifact, verify it, and record the actual output in activity.\n- Put only the concise contribution that belongs in the shared conversation in message. Put file operations, commands, verification, and other process detail in activity.\nDo not choose the next Agent. Reply with JSON only, without markdown fences, using this shape:\n{"message":"concise contribution that responds to the shared conversation","activity":"operational result for the Lead and Activity logs"}`;
    }
    const contributedIds = this.contributedSpecialistIds(task.id);
    const collaborationRounds = this.specialistContributionCount(task.id);
    const minimumContributors = Math.min(2, task.specialistAgentIds.length);
    const remainingRequiredContributors = Math.max(0, minimumContributors - contributedIds.size);
    const specialistCatalog = task.specialistAgentIds
      .map((id) => database.agents.find((item) => item.id === id))
      .filter((item): item is Agent => Boolean(item))
      .map((item) => `- ${item.name}: ${item.id} — ${item.description || "No description"}${contributedIds.has(item.id) ? " (has contributed)" : ""}`)
      .join("\n");
    const stoppingInstruction = collaborationRounds >= MAX_COLLABORATION_ROUNDS
      ? `The ${MAX_COLLABORATION_ROUNDS}-round collaboration limit has been reached. You must complete now using the best available evidence.`
      : `${MAX_COLLABORATION_ROUNDS - collaborationRounds} specialist conversation turn(s) remain before the hard collaboration limit.`;
    return common + `\n\nYou are the Lead Agent and dynamic conversation facilitator. After every specialist turn, you receive the updated transcript and must make exactly one decision:\n- If the objective is genuinely satisfied, complete it with a consolidated answer grounded in the specialists' conversation.\n- Otherwise, select the single most relevant specialist for the next incremental turn by explicit Agent ID. Choose by role and by what the conversation needs now, not by list order or a fixed rotation.\n- Tell the selected specialist what earlier contribution to build on, refine, verify, or challenge. Do not pre-plan later specialist turns because later decisions must use the new output.\n- You may select a specialist again when their expertise is still the best fit, but use another relevant voice when it would add useful challenge or refinement.\n- Keep statePatch as concise shared progress, decisions, or unresolved questions; do not copy the whole transcript.\n- For conversational objectives, request a direct contribution and do not ask specialists to create files. Request files or execution only when the objective explicitly requires artifacts.\n\nA minimum of ${minimumContributors} distinct specialist${minimumContributors === 1 ? "" : "s"} must contribute before completion${remainingRequiredContributors > 0 ? `; ${remainingRequiredContributors} more distinct contributor${remainingRequiredContributors === 1 ? " is" : "s are"} required` : ""}. ${stoppingInstruction}\n\nAuthorized specialist pool:\n${specialistCatalog}\n\nReply with JSON only, without markdown fences, using one of these shapes:\n{"message":"why this Agent is the best next contributor","statePatch":{"phase":"discussion","progress":"concise progress"},"decision":{"type":"delegate","agentId":"authorized specialist UUID","assignment":"one context-aware next contribution"}}\n{"message":"the objective is satisfied","statePatch":{"phase":"complete"},"decision":{"type":"complete","summary":"consolidated final answer and artifact locations when applicable"}}`;
  }

  private validateDelegation(task: TeamTask, agentId: string): void {
    if (!task.specialistAgentIds.includes(agentId)) {
      throw new Error("Lead selected an Agent outside the authorized specialist pool");
    }
  }

  private contributedSpecialistIds(taskId: string): Set<string> {
    return new Set(
      this.store.snapshot().teamTaskEvents
        .filter((event) =>
          event.taskId === taskId &&
          event.agentId &&
          event.type === "specialist_result",
        )
        .map((event) => event.agentId!),
    );
  }

  private specialistContributionCount(taskId: string): number {
    return this.store.snapshot().teamTaskEvents.filter(
      (event) => event.taskId === taskId && event.type === "specialist_result",
    ).length;
  }

  private minimumCollaborationReached(task: TeamTask): boolean {
    const contributed = this.contributedSpecialistIds(task.id);
    return contributed.size >= Math.min(2, task.specialistAgentIds.length);
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

  private parseSpecialistResult(output: string): SpecialistResult {
    const trimmed = output.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error("Specialist returned invalid JSON");
    }
    const result = specialistResultSchema.safeParse(parsed);
    if (!result.success) throw new Error("Specialist returned an invalid structured result");
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
    chatContent: string | null = null,
  ): void {
    const sequence = database.teamTaskEvents
      .filter((event) => event.taskId === task.id)
      .reduce((maximum, event) => Math.max(maximum, event.sequence), 0) + 1;
    database.teamTaskEvents.push({
      id: randomUUID(), taskId: task.id, sequence, type, agentId,
      content, chatContent, assignment, attempt, statePatch, createdAt: now(),
    });
  }

  private async pauseTask(id: string, reason: string): Promise<void> {
    await this.store.mutate((database) => {
      const task = this.findTask(database, id);
      if (task.status !== "running") return;
      task.status = "paused";
      task.currentAgentId = null;
      task.assignmentQueue = [];
      task.activeTurnStartedAt = null;
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
      task.assignmentQueue = [];
      task.activeTurnStartedAt = null;
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

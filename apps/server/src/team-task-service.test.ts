import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { loadConfig } from "./config.js";
import { JsonStore } from "./store.js";
import { TeamTaskService } from "./team-task-service.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "./types.js";
import { WorkspaceManager } from "./workspace.js";

class ScriptedRunner implements AgentRunner {
  readonly requests: RunnerRequest[] = [];
  readonly script: Array<string | Error | Promise<string>> = [];

  async run(request: RunnerRequest): Promise<RunnerResult> {
    this.requests.push(request);
    const output = this.script.shift();
    if (output instanceof Error) throw output;
    if (output === undefined) throw new Error("No scripted response");
    return { output: await output, threadId: "team-thread-" + request.agentId, usage: null };
  }

  async cancel(): Promise<boolean> { return false; }
  async isAvailable(): Promise<boolean> { return true; }
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function makeServices(runner: AgentRunner) {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-team-test-"));
  temporaryDirectories.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    ARK_API_KEY: "test-key",
    ARK_MODEL: "ep-test",
  });
  const store = new JsonStore(path.join(root, "data", "db.json"));
  const workspaces = new WorkspaceManager(path.join(root, "workspaces"));
  const agents = new AgentService(config, store, workspaces, runner);
  await agents.initialize();
  const teamTasks = new TeamTaskService(config, store, workspaces, runner);
  await teamTasks.initialize();
  return { agents, teamTasks, config, store, workspaces };
}

const delegate = (assignment: string, statePatch = {}) => JSON.stringify({
  message: "Delegating the next step.",
  statePatch,
  decision: { type: "delegate", assignment },
});

const complete = (summary: string) => JSON.stringify({
  message: "The shared objective is complete.",
  statePatch: { phase: "complete" },
  decision: { type: "complete", summary },
});

const specialist = (message: string, activity = "Returned the requested contribution.") => JSON.stringify({
  message,
  activity,
});

describe("TeamTaskService", () => {
  it("pauses an interrupted task on startup and releases its Agents", async () => {
    let rejectRun!: (reason: Error) => void;
    const requests: RunnerRequest[] = [];
    const runner: AgentRunner = {
      run: (request) => {
        requests.push(request);
        return new Promise<RunnerResult>((_resolve, reject) => { rejectRun = reject; });
      },
      cancel: async () => { rejectRun?.(new Error("cancelled")); return true; },
      isAvailable: async () => true,
    };
    const { agents, teamTasks, config, store, workspaces } = await makeServices(runner);
    const lead = await agents.createAgent({ name: "Lead" });
    const specialist = await agents.createAgent({ name: "Specialist" });
    const task = await teamTasks.createTask({ objective: "Survive a restart", leadAgentId: lead.id, specialistAgentIds: [specialist.id] });
    await expect.poll(() => requests.length).toBe(1);

    const recovered = new TeamTaskService(config, store, workspaces, runner);
    await recovered.initialize();
    expect(recovered.getTask(task.id)).toMatchObject({ status: "paused", currentAgentId: null });
    expect(agents.getAgent(lead.id)).toMatchObject({ status: "ready", activeTeamTaskId: null });
    expect(recovered.getEvents(task.id).at(-1)?.type).toBe("task_paused");
    await runner.cancel(lead.id);
  });

  it("reserves existing Agents and releases them when the task is stopped", async () => {
    let rejectRun!: (reason: Error) => void;
    const requests: RunnerRequest[] = [];
    const runner: AgentRunner = {
      run: (request) => {
        requests.push(request);
        return new Promise<RunnerResult>((_resolve, reject) => { rejectRun = reject; });
      },
      cancel: async () => { rejectRun?.(new Error("cancelled")); return true; },
      isAvailable: async () => true,
    };
    const { agents, teamTasks } = await makeServices(runner);
    const lead = await agents.createAgent({ name: "Lead" });
    const specialist = await agents.createAgent({ name: "Specialist" });
    const task = await teamTasks.createTask({ objective: "Wait for work", leadAgentId: lead.id, specialistAgentIds: [specialist.id] });
    await expect.poll(() => requests.length).toBe(1);
    expect(agents.getAgent(lead.id)).toMatchObject({ status: "busy", activeTeamTaskId: task.id });
    await expect(agents.sendMessage(specialist.id, "conflicting work")).rejects.toMatchObject({ statusCode: 409 });
    await teamTasks.stopTask(task.id);
    expect(teamTasks.getTask(task.id).status).toBe("stopped");
    expect(agents.getAgent(lead.id)).toMatchObject({ status: "ready", activeTeamTaskId: null });
    expect(agents.getAgent(specialist.id)).toMatchObject({ status: "ready", activeTeamTaskId: null });
  });

  it("coordinates Lead, Builder, and Reviewer in one shared workspace", async () => {
    const runner = new ScriptedRunner();
    const { agents, teamTasks } = await makeServices(runner);
    const lead = await agents.createAgent({ name: "Lead" });
    const builder = await agents.createAgent({ name: "Builder" });
    const reviewer = await agents.createAgent({ name: "Reviewer" });
    runner.script.push(
      delegate("Build the requested artifact", { phase: "build" }),
      specialist("The artifact is ready for review.", "Built the artifact and ran its tests."),
      delegate("Review the implementation", { phase: "review" }),
      specialist("The artifact is ready.", "Reviewed the artifact; it is ready."),
      complete("Artifact built, tested, and reviewed."),
    );

    const task = await teamTasks.createTask({
      objective: "Create and review a small artifact",
      leadAgentId: lead.id,
      specialistAgentIds: [builder.id, reviewer.id],
    });
    await expect.poll(() => teamTasks.getTask(task.id).status).toBe("completed");

    const finished = teamTasks.getTask(task.id);
    expect(finished.completionSummary).toContain("built, tested, and reviewed");
    expect(runner.requests.map((request) => request.agentId)).toEqual([
      lead.id, builder.id, lead.id, reviewer.id, lead.id,
    ]);
    expect(new Set(runner.requests.map((request) => request.workspacePath))).toEqual(new Set([task.workspacePath]));
    expect(runner.requests[0]?.threadId).toBeNull();
    expect(runner.requests[2]?.threadId).toBe("team-thread-" + lead.id);
    expect(agents.getAgent(lead.id).codexThreadId).toBeNull();
    expect(agents.getAgent(builder.id).activeTeamTaskId).toBeNull();
    expect(teamTasks.getEvents(task.id).map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("retries a specialist twice and returns the failure to the Lead", async () => {
    const runner = new ScriptedRunner();
    const { agents, teamTasks } = await makeServices(runner);
    const lead = await agents.createAgent({ name: "Lead" });
    const specialist = await agents.createAgent({ name: "Specialist" });
    runner.script.push(
      delegate("Perform the risky step"),
      new Error("temporary failure"),
      new Error("still unavailable"),
      complete("Completed after reviewing the specialist failure."),
    );
    const task = await teamTasks.createTask({
      objective: "Handle a failed contribution",
      leadAgentId: lead.id,
      specialistAgentIds: [specialist.id],
    });
    await expect.poll(() => teamTasks.getTask(task.id).status).toBe("completed");
    const types = teamTasks.getEvents(task.id).map((event) => event.type);
    expect(types).toContain("turn_retry");
    expect(types).toContain("turn_failed");
    expect(runner.requests.map((request) => request.agentId)).toEqual([
      lead.id, specialist.id, specialist.id, lead.id,
    ]);
  });

  it("rotates after a specialist failure and prevents premature completion", async () => {
    const runner = new ScriptedRunner();
    const { agents, teamTasks } = await makeServices(runner);
    const lead = await agents.createAgent({ name: "Lead" });
    const first = await agents.createAgent({ name: "First" });
    const second = await agents.createAgent({ name: "Second" });
    runner.script.push(
      delegate("Attempt the first contribution"),
      new Error("temporary failure"),
      new Error("still unavailable"),
      complete("This is too early."),
      delegate("Provide the second contribution"),
      specialist("Second contribution complete."),
      complete("Finished after every specialist was invoked."),
    );

    const task = await teamTasks.createTask({
      objective: "Use both specialists even if one fails",
      leadAgentId: lead.id,
      specialistAgentIds: [first.id, second.id],
    });
    await expect.poll(() => teamTasks.getTask(task.id).status).toBe("completed");

    expect(runner.requests.map((request) => request.agentId)).toEqual([
      lead.id, first.id, first.id, lead.id, lead.id, second.id, lead.id,
    ]);
    expect(teamTasks.getEvents(task.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "turn_retry",
        content: "Lead cannot complete the Team Task before every selected specialist has been invoked",
      }),
    ]));
  });

  it("continues the persisted rotation after a restart and resume", async () => {
    const runner = new ScriptedRunner();
    const { agents, teamTasks, config, store, workspaces } = await makeServices(runner);
    const lead = await agents.createAgent({ name: "Lead" });
    const first = await agents.createAgent({ name: "First" });
    const second = await agents.createAgent({ name: "Second" });
    let releaseInterruptedLead!: (output: string) => void;
    const interruptedLead = new Promise<string>((resolve) => { releaseInterruptedLead = resolve; });
    runner.script.push(
      delegate("Provide the first contribution"),
      specialist("First contribution complete."),
      interruptedLead,
    );

    const task = await teamTasks.createTask({
      objective: "Continue in order after restart",
      leadAgentId: lead.id,
      specialistAgentIds: [first.id, second.id],
    });
    await expect.poll(() => runner.requests.length).toBe(3);

    const recovered = new TeamTaskService(config, store, workspaces, runner);
    await recovered.initialize();
    expect(recovered.getTask(task.id).status).toBe("paused");
    releaseInterruptedLead(delegate("Discarded interrupted assignment"));
    await new Promise((resolve) => setTimeout(resolve, 0));

    runner.script.push(
      delegate("Provide the second contribution"),
      specialist("Second contribution complete."),
      complete("Both contributions completed in order."),
    );
    await recovered.resumeTask(task.id);
    await expect.poll(() => recovered.getTask(task.id).status).toBe("completed");

    expect(runner.requests.map((request) => request.agentId)).toEqual([
      lead.id, first.id, lead.id, lead.id, second.id, lead.id,
    ]);
  });

  it("coordinates a 10-to-1 countdown across three specialists in strict rotation", async () => {
    const runner = new ScriptedRunner();
    const { agents, teamTasks } = await makeServices(runner);
    const lead = await agents.createAgent({ name: "Lead" });
    const counterA = await agents.createAgent({ name: "Counter A" });
    const counterB = await agents.createAgent({ name: "Counter B" });
    const counterC = await agents.createAgent({ name: "Counter C" });
    for (let number = 10; number >= 1; number -= 1) {
      runner.script.push(delegate("Return only the number " + number, { currentNumber: number }));
      runner.script.push(specialist(String(number), "Returned countdown value " + number + "."));
    }
    runner.script.push(complete("Countdown finished."));
    const task = await teamTasks.createTask({
      objective: "Count down from 10 to 1",
      leadAgentId: lead.id,
      specialistAgentIds: [counterA.id, counterB.id, counterC.id],
    });
    await expect.poll(() => teamTasks.getTask(task.id).status).toBe("completed");
    const allEvents = teamTasks.getEvents(task.id);
    const specialistEvents = allEvents
      .filter((event) => event.type === "specialist_result");
    const outputs = specialistEvents.map((event) => Number(event.chatContent));
    expect(outputs).toEqual([10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
    expect(specialistEvents.map((event) => event.content)).toEqual(
      Array.from({ length: 10 }, (_, index) => "Returned countdown value " + (10 - index) + "."),
    );
    expect(allEvents
      .filter((event) => event.type !== "specialist_result")
      .every((event) => event.chatContent === null)).toBe(true);
    expect(runner.requests.map((request) => request.agentId)).toEqual([
      lead.id, counterA.id,
      lead.id, counterB.id,
      lead.id, counterC.id,
      lead.id, counterA.id,
      lead.id, counterB.id,
      lead.id, counterC.id,
      lead.id, counterA.id,
      lead.id, counterB.id,
      lead.id, counterC.id,
      lead.id, counterA.id,
      lead.id,
    ]);
    expect(runner.requests[0]?.prompt).toContain("strict round-robin order");
    expect(runner.requests[1]?.prompt).toContain("return the requested result directly");
    expect(runner.requests[0]?.prompt).toContain("do not ask specialists to create, edit, or persist files");
    expect(runner.requests[1]?.prompt).toContain("Do not create, edit, or persist a file or script merely to produce that result");
    expect(runner.requests[1]?.prompt).toContain("only when the objective or assignment explicitly requests a file");
    expect(runner.requests[1]?.prompt).toContain("When execution is explicitly requested, run the artifact");
    expect(runner.requests[1]?.prompt).toContain("Put file operations, commands, verification, and other process detail in activity");
    expect(teamTasks.getTask(task.id).sharedState.currentNumber).toBe(1);
  });
});

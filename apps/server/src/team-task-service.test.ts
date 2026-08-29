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

const delegate = (agentId: string, assignment: string, statePatch = {}) => JSON.stringify({
  message: "Delegating the next step.",
  statePatch,
  decision: { type: "delegate", agentId, assignment },
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
      delegate(builder.id, "Build the requested artifact", { phase: "build" }),
      specialist("The artifact is ready for review.", "Built the artifact and ran its tests."),
      delegate(reviewer.id, "Review the implementation and respond to the Builder result", { phase: "review" }),
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
    expect(teamTasks.getEvents(task.id).map((event) => event.sequence)).toEqual(
      Array.from({ length: 14 }, (_, index) => index + 1),
    );
    expect(teamTasks.getEvents(task.id).filter((event) => event.type === "turn_started"))
      .toHaveLength(5);
  });

  it("dynamically chooses relevant specialists and shares earlier opinions", async () => {
    const runner = new ScriptedRunner();
    const { agents, teamTasks } = await makeServices(runner);
    const lead = await agents.createAgent({ name: "Lead" });
    const stylist = await agents.createAgent({ name: "Stylist", description: "Color and presentation specialist" });
    const critic = await agents.createAgent({ name: "Practical Critic", description: "Challenges recommendations using context and tradeoffs" });
    const engineer = await agents.createAgent({ name: "Engineer", description: "Software implementation specialist" });
    runner.script.push(
      delegate(stylist.id, "Recommend red or black and explain the visual effect", { phase: "discussion" }),
      specialist("Wear red when you want energy and visibility; choose black for calm versatility.", "Compared the two colors."),
      delegate(critic.id, "Challenge the Stylist's recommendation using the exact prior opinion and identify the deciding context"),
      specialist("Building on the Stylist: choose red for a social statement, but black wins when the setting is unknown because it is easier to adapt.", "Pressure-tested the prior opinion."),
      complete("Wear red for a bold social setting; otherwise choose black for adaptable confidence."),
    );

    const task = await teamTasks.createTask({
      objective: "Discuss and come up with a reason why I should wear red or black today",
      leadAgentId: lead.id,
      specialistAgentIds: [engineer.id, stylist.id, critic.id],
    });
    await expect.poll(() => teamTasks.getTask(task.id).status).toBe("completed");

    expect(runner.requests.map((request) => request.agentId)).toEqual([
      lead.id,
      stylist.id,
      lead.id,
      critic.id,
      lead.id,
    ]);
    expect(runner.requests[2]?.prompt).toContain("Wear red when you want energy and visibility");
    expect(runner.requests[3]?.prompt).toContain("Wear red when you want energy and visibility");
    expect(runner.requests[3]?.prompt).toContain("Stylist (Specialist)");
    expect(teamTasks.getTask(task.id)).toMatchObject({
      assignmentQueue: [],
      activeTurnStartedAt: null,
      completionSummary: "Wear red for a bold social setting; otherwise choose black for adaptable confidence.",
    });
    expect(teamTasks.getEvents(task.id).filter((event) => event.type === "delegated"))
      .toHaveLength(2);
  });

  it("allows a fresh Team Task immediately after completion", async () => {
    const runner = new ScriptedRunner();
    const { agents, teamTasks } = await makeServices(runner);
    const lead = await agents.createAgent({ name: "Lead" });
    const specialistAgent = await agents.createAgent({ name: "Specialist" });
    runner.script.push(
      delegate(specialistAgent.id, "Complete the first task"),
      specialist("First result"),
      complete("First task complete"),
    );
    const first = await teamTasks.createTask({
      objective: "First objective",
      leadAgentId: lead.id,
      specialistAgentIds: [specialistAgent.id],
    });
    await expect.poll(() => teamTasks.getTask(first.id).status).toBe("completed");

    runner.script.push(
      delegate(specialistAgent.id, "Complete the second task"),
      specialist("Second result"),
      complete("Second task complete"),
    );
    const second = await teamTasks.createTask({
      objective: "Second objective",
      leadAgentId: lead.id,
      specialistAgentIds: [specialistAgent.id],
    });
    await expect.poll(() => teamTasks.getTask(second.id).status).toBe("completed");
    expect(second.id).not.toBe(first.id);
    expect(teamTasks.listTasks()).toHaveLength(2);
  });

  it("retries a specialist twice and returns the failure to the Lead", async () => {
    const runner = new ScriptedRunner();
    const { agents, teamTasks } = await makeServices(runner);
    const lead = await agents.createAgent({ name: "Lead" });
    const specialistAgent = await agents.createAgent({ name: "Specialist" });
    runner.script.push(
      delegate(specialistAgent.id, "Perform the risky step"),
      new Error("temporary failure"),
      new Error("still unavailable"),
      delegate(specialistAgent.id, "Retry with a safer alternative after reviewing the recorded failure"),
      specialist("Recovered contribution."),
      complete("Completed after reviewing and recovering from the specialist failure."),
    );
    const task = await teamTasks.createTask({
      objective: "Handle a failed contribution",
      leadAgentId: lead.id,
      specialistAgentIds: [specialistAgent.id],
    });
    await expect.poll(() => teamTasks.getTask(task.id).status).toBe("completed");
    const types = teamTasks.getEvents(task.id).map((event) => event.type);
    expect(types).toContain("turn_retry");
    expect(types).toContain("turn_failed");
    expect(runner.requests.map((request) => request.agentId)).toEqual([
      lead.id, specialistAgent.id, specialistAgent.id, lead.id, specialistAgent.id, lead.id,
    ]);
  });

  it("requires distinct successful collaborators before completion", async () => {
    const runner = new ScriptedRunner();
    const { agents, teamTasks } = await makeServices(runner);
    const lead = await agents.createAgent({ name: "Lead" });
    const first = await agents.createAgent({ name: "First" });
    const second = await agents.createAgent({ name: "Second" });
    runner.script.push(
      delegate(first.id, "Attempt the first contribution"),
      new Error("temporary failure"),
      new Error("still unavailable"),
      complete("This is too early."),
      delegate(second.id, "Respond to the recorded failure with an alternative"),
      specialist("Second contribution complete."),
      delegate(first.id, "Build on the second contribution now that the alternative is available"),
      specialist("First specialist recovered and refined the alternative."),
      complete("Finished after two distinct specialists collaborated successfully."),
    );

    const task = await teamTasks.createTask({
      objective: "Use both specialists even if one fails",
      leadAgentId: lead.id,
      specialistAgentIds: [first.id, second.id],
    });
    await expect.poll(() => teamTasks.getTask(task.id).status).toBe("completed");

    expect(runner.requests.map((request) => request.agentId)).toEqual([
      lead.id, first.id, first.id, lead.id, lead.id, second.id, lead.id, first.id, lead.id,
    ]);
    expect(teamTasks.getEvents(task.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "turn_retry",
        content: "Lead cannot complete the Team Task before 2 distinct specialists have contributed",
      }),
    ]));
  });

  it("continues dynamic selection after a restart and resume", async () => {
    const runner = new ScriptedRunner();
    const { agents, teamTasks, config, store, workspaces } = await makeServices(runner);
    const lead = await agents.createAgent({ name: "Lead" });
    const first = await agents.createAgent({ name: "First" });
    const second = await agents.createAgent({ name: "Second" });
    let releaseInterruptedLead!: (output: string) => void;
    const interruptedLead = new Promise<string>((resolve) => { releaseInterruptedLead = resolve; });
    runner.script.push(
      delegate(first.id, "Provide the first contribution"),
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
    releaseInterruptedLead(delegate(second.id, "Discarded interrupted assignment"));
    await new Promise((resolve) => setTimeout(resolve, 0));

    runner.script.push(
      delegate(second.id, "Build on the first contribution after recovery"),
      specialist("Second contribution complete."),
      complete("Both contributions completed in order."),
    );
    await recovered.resumeTask(task.id);
    await expect.poll(() => recovered.getTask(task.id).status).toBe("completed");

    expect(runner.requests.map((request) => request.agentId)).toEqual([
      lead.id, first.id, lead.id, lead.id, second.id, lead.id,
    ]);
  });

  it("coordinates a transcript-aware 10-to-1 countdown with dynamic Agent selection", async () => {
    const runner = new ScriptedRunner();
    const { agents, teamTasks } = await makeServices(runner);
    const lead = await agents.createAgent({ name: "Lead" });
    const counterA = await agents.createAgent({ name: "Counter A" });
    const counterB = await agents.createAgent({ name: "Counter B" });
    const counterC = await agents.createAgent({ name: "Counter C" });
    const dynamicOrder = [counterC.id, counterA.id, counterC.id, counterB.id, counterA.id, counterB.id, counterC.id, counterA.id, counterC.id, counterB.id];
    for (let number = 10; number >= 1; number -= 1) {
      runner.script.push(delegate(
        dynamicOrder[10 - number]!,
        number === 10 ? "Start with 10" : "Read the previous number and continue with exactly " + number,
        { currentNumber: number },
      ));
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
      lead.id, counterC.id,
      lead.id, counterA.id,
      lead.id, counterC.id,
      lead.id, counterB.id,
      lead.id, counterA.id,
      lead.id, counterB.id,
      lead.id, counterC.id,
      lead.id, counterA.id,
      lead.id, counterC.id,
      lead.id, counterB.id,
      lead.id,
    ]);
    expect(runner.requests[0]?.prompt).toContain("dynamic conversation facilitator");
    expect(runner.requests[0]?.prompt).toContain("not by list order or a fixed rotation");
    expect(runner.requests[1]?.prompt).toContain("Act as one turn in a continuing multi-Agent conversation");
    expect(runner.requests[2]?.prompt).toContain("Conversation message: 10");
    expect(runner.requests[3]?.prompt).toContain("Conversation message: 10");
    expect(runner.requests[0]?.prompt).toContain("do not ask specialists to create files");
    expect(runner.requests[1]?.prompt).toContain("Do not create, edit, or persist a file or script merely to produce that result");
    expect(runner.requests[1]?.prompt).toContain("only when the objective or assignment explicitly requests a file");
    expect(runner.requests[1]?.prompt).toContain("When execution is explicitly requested, inspect the existing shared workspace, run the artifact");
    expect(runner.requests[1]?.prompt).toContain("Put file operations, commands, verification, and other process detail in activity");
    expect(teamTasks.getTask(task.id).sharedState.currentNumber).toBe(1);
  });

  it("rejects a Lead selection outside the authorized specialist pool", async () => {
    const runner = new ScriptedRunner();
    const { agents, teamTasks } = await makeServices(runner);
    const lead = await agents.createAgent({ name: "Lead" });
    const selected = await agents.createAgent({ name: "Selected Specialist" });
    const outsider = await agents.createAgent({ name: "Unselected Outsider" });
    runner.script.push(
      delegate(outsider.id, "Attempt unauthorized work"),
      delegate(outsider.id, "Attempt unauthorized work again"),
    );

    const task = await teamTasks.createTask({
      objective: "Use only the authorized specialist pool",
      leadAgentId: lead.id,
      specialistAgentIds: [selected.id],
    });
    await expect.poll(() => teamTasks.getTask(task.id).status).toBe("paused");
    expect(teamTasks.getTask(task.id).lastError).toContain(
      "Lead selected an Agent outside the authorized specialist pool",
    );
    expect(runner.requests.map((request) => request.agentId)).toEqual([lead.id, lead.id]);
  });

  it("stops unnecessary collaboration after twelve specialist rounds", async () => {
    const runner = new ScriptedRunner();
    const { agents, teamTasks } = await makeServices(runner);
    const lead = await agents.createAgent({ name: "Lead" });
    const first = await agents.createAgent({ name: "First" });
    const second = await agents.createAgent({ name: "Second" });
    for (let round = 1; round <= 12; round += 1) {
      const agentId = round % 2 === 1 ? first.id : second.id;
      runner.script.push(delegate(agentId, "Advance discussion round " + round));
      runner.script.push(specialist("Contribution " + round));
    }
    runner.script.push(
      delegate(first.id, "Continue unnecessarily"),
      delegate(second.id, "Continue unnecessarily again"),
    );

    const task = await teamTasks.createTask({
      objective: "Reach a decision without looping forever",
      leadAgentId: lead.id,
      specialistAgentIds: [first.id, second.id],
    });
    await expect.poll(() => teamTasks.getTask(task.id).status).toBe("paused");
    expect(teamTasks.getTask(task.id).lastError).toContain(
      "collaboration round limit was reached",
    );
    expect(teamTasks.getEvents(task.id).filter((event) => event.type === "specialist_result"))
      .toHaveLength(12);
    expect(teamTasks.getTask(task.id).turnCount).toBe(26);
  });
});

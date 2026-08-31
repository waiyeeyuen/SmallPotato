import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { loadConfig } from "./config.js";
import { JsonStore } from "./store.js";
import { SecurityService } from "./security-service.js";
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
const actor = { userId: "user-alice", username: "alice", displayName: "Alice Tan" };
const bob = { userId: "user-bob", username: "bob", displayName: "Bob Lim" };

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function makeServices(runner: AgentRunner, extraEnv: Record<string, string> = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-team-test-"));
  temporaryDirectories.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    ARK_API_KEY: "test-key",
    ARK_MODEL: "ep-test",
    ...extraEnv,
  });
  const store = new JsonStore(path.join(root, "data", "db.json"));
  const workspaces = new WorkspaceManager(path.join(root, "workspaces"));
  const security = new SecurityService(store, config.dataDirectory);
  const agents = new AgentService(config, store, workspaces, runner, security);
  await agents.initialize();
  await security.initialize();
  const teamTasks = new TeamTaskService(config, store, workspaces, runner, security);
  await teamTasks.initialize();
  return { agents, teamTasks, config, store, workspaces, security };
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

// A Lead "delegate" decision for a sequential task (turns 2+): no agentId — the
// platform owns rotation, the Lead only supplies the assignment text.
const sequentialDelegate = (assignment: string, statePatch = {}) => JSON.stringify({
  message: "Advancing the sequence.",
  statePatch,
  decision: { type: "delegate", assignment },
});

// The Lead's first turn: commit a coordination mode, then make the first hand-off.
const planFacilitated = (
  agentId: string,
  assignment: string,
  opts: { statePatch?: Record<string, unknown>; rosterAgentIds?: string[] } = {},
) => JSON.stringify({
  message: "Facilitated coordination fits this open-ended objective.",
  plan: {
    turnPolicy: "facilitated",
    ...(opts.rosterAgentIds ? { rosterAgentIds: opts.rosterAgentIds } : {}),
  },
  statePatch: opts.statePatch ?? {},
  decision: { type: "delegate", agentId, assignment },
});

const planSequential = (
  assignment: string,
  opts: { statePatch?: Record<string, unknown>; rosterAgentIds?: string[] } = {},
) => JSON.stringify({
  message: "This is an ordered sequence, so the platform should rotate the roster.",
  plan: {
    turnPolicy: "sequential",
    ...(opts.rosterAgentIds ? { rosterAgentIds: opts.rosterAgentIds } : {}),
  },
  statePatch: opts.statePatch ?? {},
  decision: { type: "delegate", assignment },
});

describe("TeamTaskService", () => {
  it("isolates Team Task data and controls by signed-in user", async () => {
    const runner = new ScriptedRunner();
    const { agents, teamTasks } = await makeServices(runner);
    const lead = await agents.createAgent(actor, { name: "Alice Lead" });
    const specialistAgent = await agents.createAgent(actor, { name: "Alice Specialist" });
    runner.script.push(
      planFacilitated(specialistAgent.id, "Contribute"),
      specialist("Alice-only result"),
      complete("Alice-only task complete"),
    );
    const task = await teamTasks.createTask(actor, {
      objective: "Alice private coordination",
      leadAgentId: lead.id,
      specialistAgentIds: [specialistAgent.id],
    });
    await expect.poll(() => teamTasks.getTask(actor, task.id).status).toBe("ready");

    expect(teamTasks.listTasks(bob)).toEqual([]);
    expect(() => teamTasks.getTask(bob, task.id)).toThrowError();
    expect(() => teamTasks.getEvents(bob, task.id)).toThrowError();
    expect(() => teamTasks.verifyEventChain(bob, task.id)).toThrowError();
    await expect(teamTasks.stopTask(bob, task.id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(teamTasks.resumeTask(bob, task.id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(teamTasks.createTask(bob, {
      objective: "Try to coordinate Alice's Agents",
      leadAgentId: lead.id,
      specialistAgentIds: [specialistAgent.id],
    })).rejects.toMatchObject({ statusCode: 404 });
  });

  it("pauses an interrupted task on startup and keeps its Agents reserved", async () => {
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
    const { agents, teamTasks, config, store, workspaces, security } = await makeServices(runner);
    const lead = await agents.createAgent(actor, { name: "Lead" });
    const specialist = await agents.createAgent(actor, { name: "Specialist" });
    const task = await teamTasks.createTask(actor, { objective: "Survive a restart", leadAgentId: lead.id, specialistAgentIds: [specialist.id] });
    await expect.poll(() => requests.length).toBe(1);

    const recovered = new TeamTaskService(config, store, workspaces, runner, security);
    await recovered.initialize();
    expect(recovered.getTask(actor, task.id)).toMatchObject({ status: "paused", currentAgentId: null });
    expect(agents.getAgent(actor, lead.id)).toMatchObject({ status: "busy", activeTeamTaskId: task.id });
    expect(recovered.getEvents(actor, task.id).at(-1)?.type).toBe("task_paused");
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
    const lead = await agents.createAgent(actor, { name: "Lead" });
    const specialist = await agents.createAgent(actor, { name: "Specialist" });
    const task = await teamTasks.createTask(actor, { objective: "Wait for work", leadAgentId: lead.id, specialistAgentIds: [specialist.id] });
    await expect.poll(() => requests.length).toBe(1);
    expect(agents.getAgent(actor, lead.id)).toMatchObject({ status: "busy", activeTeamTaskId: task.id });
    await expect(agents.sendMessage(actor, specialist.id, "conflicting work")).rejects.toMatchObject({ statusCode: 409 });
    await teamTasks.stopTask(actor, task.id);
    expect(teamTasks.getTask(actor, task.id).status).toBe("stopped");
    expect(agents.getAgent(actor, lead.id)).toMatchObject({ status: "ready", activeTeamTaskId: null });
    expect(agents.getAgent(actor, specialist.id)).toMatchObject({ status: "ready", activeTeamTaskId: null });
  });

  it("cancels only the active request and keeps the Team ready and reserved", async () => {
    let rejectRun!: (reason: Error) => void;
    const runner: AgentRunner = {
      run: () => new Promise<RunnerResult>((_resolve, reject) => { rejectRun = reject; }),
      cancel: async () => { rejectRun(new Error("cancelled")); return true; },
      isAvailable: async () => true,
    };
    const { agents, teamTasks } = await makeServices(runner);
    const lead = await agents.createAgent(actor, { name: "Lead" });
    const specialistAgent = await agents.createAgent(actor, { name: "Specialist" });
    const task = await teamTasks.createTask(actor, {
      objective: "Long-running request",
      leadAgentId: lead.id,
      specialistAgentIds: [specialistAgent.id],
    });
    await expect.poll(() => teamTasks.getTask(actor, task.id).activeTurnStartedAt).not.toBeNull();
    await expect(teamTasks.sendMessage(actor, task.id, "Too soon")).rejects.toMatchObject({ statusCode: 409 });

    await teamTasks.cancelRequest(actor, task.id);

    expect(teamTasks.getTask(actor, task.id)).toMatchObject({
      status: "ready",
      activeRequestSequence: null,
      currentAgentId: null,
    });
    expect(teamTasks.getEvents(actor, task.id).at(-1)?.type).toBe("request_cancelled");
    expect(agents.getAgent(actor, lead.id)).toMatchObject({ status: "busy", activeTeamTaskId: task.id });
  });

  it("coordinates Lead, Builder, and Reviewer in one shared workspace", async () => {
    const runner = new ScriptedRunner();
    const { agents, teamTasks } = await makeServices(runner);
    const lead = await agents.createAgent(actor, { name: "Lead" });
    const builder = await agents.createAgent(actor, { name: "Builder" });
    const reviewer = await agents.createAgent(actor, { name: "Reviewer" });
    runner.script.push(
      planFacilitated(builder.id, "Build the requested artifact", { statePatch: { phase: "build" } }),
      specialist("The artifact is ready for review.", "Built the artifact and ran its tests."),
      delegate(reviewer.id, "Review the implementation and respond to the Builder result", { phase: "review" }),
      specialist("The artifact is ready.", "Reviewed the artifact; it is ready."),
      complete("Artifact built, tested, and reviewed."),
    );

    const task = await teamTasks.createTask(actor, {
      objective: "Create and review a small artifact",
      leadAgentId: lead.id,
      specialistAgentIds: [builder.id, reviewer.id],
    });
    await expect.poll(() => teamTasks.getTask(actor, task.id).status).toBe("ready");

    const finished = teamTasks.getTask(actor, task.id);
    expect(finished.completionSummary).toContain("built, tested, and reviewed");
    expect(runner.requests.map((request) => request.agentId)).toEqual([
      lead.id, builder.id, lead.id, reviewer.id, lead.id,
    ]);
    expect(new Set(runner.requests.map((request) => request.workspacePath))).toEqual(new Set([task.workspacePath]));
    expect(runner.requests[0]?.threadId).toBeNull();
    expect(runner.requests[2]?.threadId).toBe("team-thread-" + lead.id);
    expect(agents.getAgent(actor, lead.id).codexThreadId).toBeNull();
    expect(agents.getAgent(actor, builder.id).activeTeamTaskId).toBe(task.id);
    // The persistent transcript includes the user message and the Lead's coordination plan.
    expect(teamTasks.getEvents(actor, task.id).map((event) => event.sequence)).toEqual(
      Array.from({ length: 16 }, (_, index) => index + 1),
    );
    expect(teamTasks.getEvents(actor, task.id).filter((event) => event.type === "turn_started"))
      .toHaveLength(5);
    expect(teamTasks.getEvents(actor, task.id).filter((event) => event.type === "coordination_plan"))
      .toHaveLength(1);
  });

  it("dynamically chooses relevant specialists and shares earlier opinions", async () => {
    const runner = new ScriptedRunner();
    const { agents, teamTasks } = await makeServices(runner);
    const lead = await agents.createAgent(actor, { name: "Lead" });
    const stylist = await agents.createAgent(actor, { name: "Stylist", description: "Color and presentation specialist" });
    const critic = await agents.createAgent(actor, { name: "Practical Critic", description: "Challenges recommendations using context and tradeoffs" });
    const engineer = await agents.createAgent(actor, { name: "Engineer", description: "Software implementation specialist" });
    runner.script.push(
      planFacilitated(stylist.id, "Recommend red or black and explain the visual effect", { statePatch: { phase: "discussion" } }),
      specialist("Wear red when you want energy and visibility; choose black for calm versatility.", "Compared the two colors."),
      delegate(critic.id, "Challenge the Stylist's recommendation using the exact prior opinion and identify the deciding context"),
      specialist("Building on the Stylist: choose red for a social statement, but black wins when the setting is unknown because it is easier to adapt.", "Pressure-tested the prior opinion."),
      complete("Wear red for a bold social setting; otherwise choose black for adaptable confidence."),
    );

    const task = await teamTasks.createTask(actor, {
      objective: "Discuss and come up with a reason why I should wear red or black today",
      leadAgentId: lead.id,
      specialistAgentIds: [engineer.id, stylist.id, critic.id],
    });
    await expect.poll(() => teamTasks.getTask(actor, task.id).status).toBe("ready");

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
    expect(teamTasks.getTask(actor, task.id)).toMatchObject({
      assignmentQueue: [],
      activeTurnStartedAt: null,
      completionSummary: "Wear red for a bold social setting; otherwise choose black for adaptable confidence.",
    });
    expect(teamTasks.getEvents(actor, task.id).filter((event) => event.type === "delegated"))
      .toHaveLength(2);
  });

  it("keeps one Team conversation ready for another request", async () => {
    const runner = new ScriptedRunner();
    const { agents, teamTasks } = await makeServices(runner);
    const lead = await agents.createAgent(actor, { name: "Lead" });
    const specialistAgent = await agents.createAgent(actor, { name: "Specialist" });
    runner.script.push(
      planFacilitated(specialistAgent.id, "Complete the first task"),
      specialist("First result"),
      complete("First task complete"),
    );
    const task = await teamTasks.createTask(actor, {
      objective: "First objective",
      leadAgentId: lead.id,
      specialistAgentIds: [specialistAgent.id],
    });
    await expect.poll(() => teamTasks.getTask(actor, task.id).status).toBe("ready");
    expect(agents.getAgent(actor, lead.id)).toMatchObject({ status: "busy", activeTeamTaskId: task.id });
    expect(agents.getAgent(actor, specialistAgent.id)).toMatchObject({ status: "busy", activeTeamTaskId: task.id });
    const otherActor = { userId: "user-bob", username: "bob", displayName: "Bob" };
    expect(teamTasks.listTasks(otherActor)).toEqual([]);
    await expect(teamTasks.sendMessage(otherActor, task.id, "Not mine"))
      .rejects.toMatchObject({ statusCode: 404 });

    runner.script.push(
      planFacilitated(specialistAgent.id, "Complete the second task"),
      specialist("Second result"),
      complete("Second task complete"),
    );
    const second = await teamTasks.sendMessage(actor, task.id, "Second objective");
    expect(second.id).toBe(task.id);
    await expect.poll(() => teamTasks.getTask(actor, task.id).status).toBe("ready");
    expect(teamTasks.listTasks(actor)).toHaveLength(1);
    expect(teamTasks.getTask(actor, task.id)).toMatchObject({
      objective: "Second objective",
      completionSummary: "Second task complete",
      turnCount: 3,
    });
    await expect.poll(() => teamTasks.getTask(actor, second.id).status).toBe("ready");
    expect(second.id).toBe(task.id);
    expect(teamTasks.listTasks(actor)).toHaveLength(1);
  });

  it("keeps each user's Agents and Team Tasks private to their own account", async () => {
    const bob = { userId: "user-bob", username: "bob", displayName: "Bob Lim" };
    const runner = new ScriptedRunner();
    const { agents, teamTasks } = await makeServices(runner);
    const lead = await agents.createAgent(actor, { name: "Alice Lead" });
    const specialistAgent = await agents.createAgent(actor, { name: "Alice Specialist" });
    runner.script.push(
      planFacilitated(specialistAgent.id, "Do the work"),
      specialist("Done"),
      complete("Complete"),
    );
    const task = await teamTasks.createTask(actor, {
      objective: "Alice's private objective",
      leadAgentId: lead.id,
      specialistAgentIds: [specialistAgent.id],
    });
    await expect.poll(() => teamTasks.getTask(actor, task.id).status).toBe("ready");

    // Bob cannot see or touch Alice's task or its transcript. The stop/resume
    // routes gate on this same check before mutating.
    expect(teamTasks.listTasks(bob)).toHaveLength(0);
    expect(teamTasks.listTasks(actor).map((item) => item.id)).toContain(task.id);
    expect(() => teamTasks.assertTaskOwner(bob, task.id)).toThrow(/not found/);
    expect(teamTasks.assertTaskOwner(actor, task.id).id).toBe(task.id);

    // Bob cannot build a task out of Alice's Agents.
    await expect(
      teamTasks.createTask(bob, {
        objective: "Borrow Alice's Agents",
        leadAgentId: lead.id,
        specialistAgentIds: [specialistAgent.id],
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("retries a specialist twice and returns the failure to the Lead", async () => {
    const runner = new ScriptedRunner();
    const { agents, teamTasks } = await makeServices(runner);
    const lead = await agents.createAgent(actor, { name: "Lead" });
    const specialistAgent = await agents.createAgent(actor, { name: "Specialist" });
    runner.script.push(
      planFacilitated(specialistAgent.id, "Perform the risky step"),
      new Error("temporary failure"),
      new Error("still unavailable"),
      delegate(specialistAgent.id, "Retry with a safer alternative after reviewing the recorded failure"),
      specialist("Recovered contribution."),
      complete("Completed after reviewing and recovering from the specialist failure."),
    );
    const task = await teamTasks.createTask(actor, {
      objective: "Handle a failed contribution",
      leadAgentId: lead.id,
      specialistAgentIds: [specialistAgent.id],
    });
    await expect.poll(() => teamTasks.getTask(actor, task.id).status).toBe("ready");
    const types = teamTasks.getEvents(actor, task.id).map((event) => event.type);
    expect(types).toContain("turn_retry");
    expect(types).toContain("turn_failed");
    expect(runner.requests.map((request) => request.agentId)).toEqual([
      lead.id, specialistAgent.id, specialistAgent.id, lead.id, specialistAgent.id, lead.id,
    ]);
  });

  it("requires distinct successful collaborators before completion", async () => {
    const runner = new ScriptedRunner();
    const { agents, teamTasks } = await makeServices(runner);
    const lead = await agents.createAgent(actor, { name: "Lead" });
    const first = await agents.createAgent(actor, { name: "First" });
    const second = await agents.createAgent(actor, { name: "Second" });
    runner.script.push(
      planFacilitated(first.id, "Attempt the first contribution"),
      new Error("temporary failure"),
      new Error("still unavailable"),
      complete("This is too early."),
      delegate(second.id, "Respond to the recorded failure with an alternative"),
      specialist("Second contribution complete."),
      delegate(first.id, "Build on the second contribution now that the alternative is available"),
      specialist("First specialist recovered and refined the alternative."),
      complete("Finished after two distinct specialists collaborated successfully."),
    );

    const task = await teamTasks.createTask(actor, {
      objective: "Use both specialists even if one fails",
      leadAgentId: lead.id,
      specialistAgentIds: [first.id, second.id],
    });
    await expect.poll(() => teamTasks.getTask(actor, task.id).status).toBe("ready");

    expect(runner.requests.map((request) => request.agentId)).toEqual([
      lead.id, first.id, first.id, lead.id, lead.id, second.id, lead.id, first.id, lead.id,
    ]);
    expect(teamTasks.getEvents(actor, task.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "turn_retry",
        content: "Lead cannot complete the Team Task before 2 distinct specialists have contributed",
      }),
    ]));
  });

  it("continues dynamic selection after a restart and resume", async () => {
    const runner = new ScriptedRunner();
    const { agents, teamTasks, config, store, workspaces, security } = await makeServices(runner);
    const lead = await agents.createAgent(actor, { name: "Lead" });
    const first = await agents.createAgent(actor, { name: "First" });
    const second = await agents.createAgent(actor, { name: "Second" });
    let releaseInterruptedLead!: (output: string) => void;
    const interruptedLead = new Promise<string>((resolve) => { releaseInterruptedLead = resolve; });
    runner.script.push(
      planFacilitated(first.id, "Provide the first contribution"),
      specialist("First contribution complete."),
      interruptedLead,
    );

    const task = await teamTasks.createTask(actor, {
      objective: "Continue in order after restart",
      leadAgentId: lead.id,
      specialistAgentIds: [first.id, second.id],
    });
    await expect.poll(() => runner.requests.length).toBe(3);

    const recovered = new TeamTaskService(config, store, workspaces, runner, security);
    await recovered.initialize();
    expect(recovered.getTask(actor, task.id).status).toBe("paused");
    releaseInterruptedLead(delegate(second.id, "Discarded interrupted assignment"));
    await new Promise((resolve) => setTimeout(resolve, 0));

    runner.script.push(
      delegate(second.id, "Build on the first contribution after recovery"),
      specialist("Second contribution complete."),
      complete("Both contributions completed in order."),
    );
    await recovered.resumeTask(actor, task.id);
    await expect.poll(() => recovered.getTask(actor, task.id).status).toBe("ready");

    expect(runner.requests.map((request) => request.agentId)).toEqual([
      lead.id, first.id, lead.id, lead.id, second.id, lead.id,
    ]);
  });

  it("runs a deterministic 10-to-1 countdown under the sequential turn policy", async () => {
    const runner = new ScriptedRunner();
    const { agents, teamTasks } = await makeServices(runner);
    const lead = await agents.createAgent(actor, { name: "Lead" });
    const counterA = await agents.createAgent(actor, { name: "Counter A" });
    const counterB = await agents.createAgent(actor, { name: "Counter B" });
    const counterC = await agents.createAgent(actor, { name: "Counter C" });
    // The Lead picks "sequential" on turn 1 and never names an agent afterwards —
    // the platform rotates A -> B -> C -> A ...
    for (let number = 10; number >= 1; number -= 1) {
      const assignment = number === 10
        ? "Start the sequence with the first value, 10"
        : "The last number was " + (number + 1) + "; reply with exactly " + number;
      runner.script.push(
        number === 10
          ? planSequential(assignment, { statePatch: { currentNumber: 10 } })
          : sequentialDelegate(assignment, { currentNumber: number }),
      );
      runner.script.push(specialist(String(number), "Returned countdown value " + number + "."));
    }
    runner.script.push(complete("Countdown finished at 1."));
    const task = await teamTasks.createTask(actor, {
      objective: "Count down from 10 to 1, one number per turn",
      leadAgentId: lead.id,
      specialistAgentIds: [counterA.id, counterB.id, counterC.id],
    });
    await expect.poll(() => teamTasks.getTask(actor, task.id).status).toBe("ready");

    const allEvents = teamTasks.getEvents(actor, task.id);
    const specialistEvents = allEvents.filter((event) => event.type === "specialist_result");
    const outputs = specialistEvents.map((event) => Number(event.chatContent));

    // Exact sequence, in order, terminating at exactly 1.
    expect(outputs).toEqual([10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
    expect(specialistEvents).toHaveLength(10);

    // Turn-taking is decided by the engine, not the Lead: strict A/B/C rotation.
    expect(specialistEvents.map((event) => event.agentId)).toEqual([
      counterA.id, counterB.id, counterC.id,
      counterA.id, counterB.id, counterC.id,
      counterA.id, counterB.id, counterC.id,
      counterA.id,
    ]);
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

    // The run terminated on its own (no infinite loop) well under the safety cap.
    expect(teamTasks.getTask(actor, task.id).turnCount).toBe(21);
    expect(teamTasks.getTask(actor, task.id).sharedState.currentNumber).toBe(1);

    // First specialist contribution is the sequence's starting value, not 9.
    expect(outputs[0]).toBe(10);
    expect(allEvents.filter((event) => event.type === "coordination_plan")).toHaveLength(1);

    // Turn 1 is the planning prompt; the real sequential Lead prompt starts turn 3.
    expect(runner.requests[0]?.prompt).toContain("This is your first turn as Lead");
    expect(runner.requests[0]?.prompt).toContain("the first value is 10, not 9");
    expect(runner.requests[1]?.prompt).toContain("This is a turn-by-turn sequential task");
    expect(runner.requests[2]?.prompt).toContain("coordinating a turn-by-turn sequential task");
    expect(runner.requests[2]?.prompt).toContain("rotates through the specialist pool in the fixed order");
    expect(runner.requests[2]?.prompt).toContain("Conversation message: 10");
    expect(teamTasks.verifyEventChain(actor, task.id)).toBe(true);
  });

  it("generalises the sequential policy to a different range and two agents", async () => {
    const runner = new ScriptedRunner();
    const { agents, teamTasks } = await makeServices(runner);
    const lead = await agents.createAgent(actor, { name: "Lead" });
    const first = await agents.createAgent(actor, { name: "First" });
    const second = await agents.createAgent(actor, { name: "Second" });
    for (let number = 20; number >= 15; number -= 1) {
      runner.script.push(
        number === 20
          ? planSequential("Reply with exactly 20", { statePatch: { currentNumber: 20 } })
          : sequentialDelegate("Reply with exactly " + number, { currentNumber: number }),
      );
      runner.script.push(specialist(String(number), "Value " + number));
    }
    runner.script.push(complete("Reached 15."));
    const task = await teamTasks.createTask(actor, {
      objective: "Count down from 20 to 15",
      leadAgentId: lead.id,
      specialistAgentIds: [first.id, second.id],
    });
    await expect.poll(() => teamTasks.getTask(actor, task.id).status).toBe("ready");
    const specialistEvents = teamTasks.getEvents(actor, task.id).filter((event) => event.type === "specialist_result");
    expect(specialistEvents.map((event) => Number(event.chatContent))).toEqual([20, 19, 18, 17, 16, 15]);
    expect(specialistEvents.map((event) => event.agentId)).toEqual([
      first.id, second.id, first.id, second.id, first.id, second.id,
    ]);
  });

  it("recovers from a specialist error mid-sequence without hanging or skipping", async () => {
    const runner = new ScriptedRunner();
    const { agents, teamTasks } = await makeServices(runner);
    const lead = await agents.createAgent(actor, { name: "Lead" });
    const counterA = await agents.createAgent(actor, { name: "Counter A" });
    const counterB = await agents.createAgent(actor, { name: "Counter B" });
    runner.script.push(
      planSequential("Start the sequence with the first value, 4", { statePatch: { currentNumber: 4 } }),
      specialist("4", "Returned 4."),
      sequentialDelegate("The last number was 4; reply with exactly 3", { currentNumber: 3 }),
      new Error("model timeout"),
      new Error("model timeout again"),
      // Turn failed twice -> control returns to the Lead, which re-issues the step.
      sequentialDelegate("Recover: the last number was 4; reply with exactly 3", { currentNumber: 3 }),
      specialist("3", "Returned 3."),
      sequentialDelegate("The last number was 3; reply with exactly 2", { currentNumber: 2 }),
      specialist("2", "Returned 2."),
      sequentialDelegate("The last number was 2; reply with exactly 1", { currentNumber: 1 }),
      specialist("1", "Returned 1."),
      complete("Countdown recovered and finished at 1."),
    );
    const task = await teamTasks.createTask(actor, {
      objective: "Count down from 4 to 1",
      leadAgentId: lead.id,
      specialistAgentIds: [counterA.id, counterB.id],
      turnPolicy: "sequential",
    });
    await expect.poll(() => teamTasks.getTask(actor, task.id).status).toBe("ready");
    const types = teamTasks.getEvents(actor, task.id).map((event) => event.type);
    expect(types).toContain("turn_retry");
    expect(types).toContain("turn_failed");
    const outputs = teamTasks.getEvents(actor, task.id)
      .filter((event) => event.type === "specialist_result")
      .map((event) => Number(event.chatContent));
    expect(outputs).toEqual([4, 3, 2, 1]);
    expect(teamTasks.getTask(actor, task.id).sharedState.currentNumber).toBe(1);
    expect(teamTasks.verifyEventChain(actor, task.id)).toBe(true);
  });

  it("lets the Lead delegate open-ended work to relevant specialists under the facilitated policy", async () => {
    const runner = new ScriptedRunner();
    const { agents, teamTasks } = await makeServices(runner);
    const lead = await agents.createAgent(actor, { name: "Lead", description: "Event planning coordinator" });
    const venue = await agents.createAgent(actor, { name: "Venue Scout", description: "Finds and books venues" });
    const catering = await agents.createAgent(actor, { name: "Caterer", description: "Plans food and drink" });
    const budget = await agents.createAgent(actor, { name: "Budget Analyst", description: "Tracks spend against budget" });
    runner.script.push(
      planFacilitated(venue.id, "Propose a venue for 40 people", { statePatch: { phase: "venue" } }),
      specialist("Community hall, capacity 60, available next Friday.", "Checked three venues."),
      delegate(catering.id, "Plan catering for 40 at the proposed hall", { phase: "catering" }),
      specialist("Buffet for 40 with vegetarian options, delivered on site.", "Priced two caterers."),
      delegate(budget.id, "Check the venue and catering plan against a $2000 budget", { phase: "budget" }),
      specialist("Venue $600 + catering $1100 = $1700, within budget.", "Reconciled quotes."),
      complete("Booked the community hall with a $1700 buffet plan, $300 under budget."),
    );
    const task = await teamTasks.createTask(actor, {
      objective: "Plan a 40-person team offsite within a $2000 budget",
      leadAgentId: lead.id,
      specialistAgentIds: [venue.id, catering.id, budget.id],
    });
    await expect.poll(() => teamTasks.getTask(actor, task.id).status).toBe("ready");
    expect(teamTasks.getTask(actor, task.id).turnPolicy).toBe("facilitated");
    expect(runner.requests.map((request) => request.agentId)).toEqual([
      lead.id, venue.id, lead.id, catering.id, lead.id, budget.id, lead.id,
    ]);
    expect(teamTasks.getTask(actor, task.id).completionSummary).toContain("under budget");
    expect(runner.requests[0]?.prompt).toContain("This is your first turn as Lead");
    expect(runner.requests[2]?.prompt).toContain("dynamic conversation facilitator");
    expect(teamTasks.verifyEventChain(actor, task.id)).toBe(true);
  });

  it("detects tampering in the coordination event hash-chain", async () => {
    const runner = new ScriptedRunner();
    const { agents, teamTasks, store } = await makeServices(runner);
    const lead = await agents.createAgent(actor, { name: "Lead" });
    const specialistAgent = await agents.createAgent(actor, { name: "Specialist" });
    runner.script.push(
      planFacilitated(specialistAgent.id, "Do the thing"),
      specialist("Done."),
      complete("Complete."),
    );
    const task = await teamTasks.createTask(actor, {
      objective: "Produce a verifiable trail",
      leadAgentId: lead.id,
      specialistAgentIds: [specialistAgent.id],
    });
    await expect.poll(() => teamTasks.getTask(actor, task.id).status).toBe("ready");
    expect(teamTasks.verifyEventChain(actor, task.id)).toBe(true);

    await store.mutate((database) => {
      const target = database.teamTaskEvents.find(
        (event) => event.taskId === task.id && event.type === "specialist_result",
      );
      if (target) target.chatContent = "Tampered.";
    });
    expect(teamTasks.verifyEventChain(actor, task.id)).toBe(false);
  });

  it("rejects a Lead selection outside the authorized specialist pool", async () => {
    const runner = new ScriptedRunner();
    const { agents, teamTasks } = await makeServices(runner);
    const lead = await agents.createAgent(actor, { name: "Lead" });
    const selected = await agents.createAgent(actor, { name: "Selected Specialist" });
    const outsider = await agents.createAgent(actor, { name: "Unselected Outsider" });
    runner.script.push(
      planFacilitated(outsider.id, "Attempt unauthorized work"),
      planFacilitated(outsider.id, "Attempt unauthorized work again"),
    );

    const task = await teamTasks.createTask(actor, {
      objective: "Use only the authorized specialist pool",
      leadAgentId: lead.id,
      specialistAgentIds: [selected.id],
    });
    await expect.poll(() => teamTasks.getTask(actor, task.id).status).toBe("paused");
    // The retry between the two failures is steered with the exact pool.
    expect(teamTasks.getTask(actor, task.id).lastError).toContain("not one of your authorized specialists");
    expect(teamTasks.getTask(actor, task.id).lastError).toContain("Selected Specialist (id: " + selected.id + ")");
    expect(runner.requests.map((request) => request.agentId)).toEqual([lead.id, lead.id]);
  });

  it("recovers when the Lead names an authorized specialist with a decorated name", async () => {
    const runner = new ScriptedRunner();
    const { agents, teamTasks } = await makeServices(runner);
    const lead = await agents.createAgent(actor, { name: "Trip Coordinator" });
    const scout = await agents.createAgent(actor, { name: "Flight & Hotel Scout" });
    const budget = await agents.createAgent(actor, { name: "Budget Analyst" });
    runner.script.push(
      // decorated / punctuation-variant name instead of the UUID
      planFacilitated("the Flight and Hotel Scout (travel)", "Find a flight and a place to stay"),
      specialist("Fly Fri, stay in Shibuja, ~$180/night.", "Compared routes and areas."),
      delegate("Budget Analyst", "Cost the trip for two against the budget"),
      specialist("Two nights + flights ≈ $980, under budget.", "Totalled the line items."),
      complete("Itinerary and budget are ready."),
    );

    const task = await teamTasks.createTask(actor, {
      objective: "Plan a short weekend trip within budget",
      leadAgentId: lead.id,
      specialistAgentIds: [scout.id, budget.id],
    });
    await expect.poll(() => teamTasks.getTask(actor, task.id).status).toBe("ready");
    // No pause, no wasted retry — the decorated name resolved on the first try.
    expect(runner.requests.map((request) => request.agentId)).toEqual([
      lead.id, scout.id, lead.id, budget.id, lead.id,
    ]);
    expect(teamTasks.verifyEventChain(actor, task.id)).toBe(true);
  });

  it("stops unnecessary collaboration after twelve specialist rounds", async () => {
    const runner = new ScriptedRunner();
    const { agents, teamTasks } = await makeServices(runner);
    const lead = await agents.createAgent(actor, { name: "Lead" });
    const first = await agents.createAgent(actor, { name: "First" });
    const second = await agents.createAgent(actor, { name: "Second" });
    for (let round = 1; round <= 12; round += 1) {
      const agentId = round % 2 === 1 ? first.id : second.id;
      runner.script.push(
        round === 1
          ? planFacilitated(agentId, "Advance discussion round 1")
          : delegate(agentId, "Advance discussion round " + round),
      );
      runner.script.push(specialist("Contribution " + round));
    }
    runner.script.push(
      delegate(first.id, "Continue unnecessarily"),
      delegate(second.id, "Continue unnecessarily again"),
    );

    const task = await teamTasks.createTask(actor, {
      objective: "Reach a decision without looping forever",
      leadAgentId: lead.id,
      specialistAgentIds: [first.id, second.id],
    });
    await expect.poll(() => teamTasks.getTask(actor, task.id).status).toBe("paused");
    expect(teamTasks.getTask(actor, task.id).lastError).toContain(
      "collaboration round limit was reached",
    );
    expect(teamTasks.getEvents(actor, task.id).filter((event) => event.type === "specialist_result"))
      .toHaveLength(12);
    expect(teamTasks.getTask(actor, task.id).turnCount).toBe(26);
  });

  it("lets the Lead commit the coordination mode on its first turn and locks it", async () => {
    const runner = new ScriptedRunner();
    const { agents, teamTasks } = await makeServices(runner);
    const lead = await agents.createAgent(actor, { name: "Lead" });
    const counterA = await agents.createAgent(actor, { name: "Counter A" });
    const counterB = await agents.createAgent(actor, { name: "Counter B" });
    runner.script.push(
      planSequential("Start the sequence with the first value, 3", { statePatch: { currentNumber: 3 } }),
      specialist("3", "Returned 3."),
      // A later turn tries to switch to facilitated — the platform must ignore it.
      JSON.stringify({
        message: "Trying to change my mind.",
        plan: { turnPolicy: "facilitated" },
        statePatch: { currentNumber: 2 },
        decision: { type: "delegate", assignment: "The last number was 3; reply with exactly 2" },
      }),
      specialist("2", "Returned 2."),
      sequentialDelegate("The last number was 2; reply with exactly 1", { currentNumber: 1 }),
      specialist("1", "Returned 1."),
      complete("Counted down to 1."),
    );
    const task = await teamTasks.createTask(actor, {
      objective: "Count down from 3 to 1",
      leadAgentId: lead.id,
      specialistAgentIds: [counterA.id, counterB.id],
    });
    await expect.poll(() => teamTasks.getTask(actor, task.id).status).toBe("ready");

    expect(teamTasks.getTask(actor, task.id).turnPolicy).toBe("sequential");
    expect(teamTasks.getEvents(actor, task.id).filter((event) => event.type === "coordination_plan"))
      .toHaveLength(1);
    const specialistEvents = teamTasks.getEvents(actor, task.id).filter((event) => event.type === "specialist_result");
    expect(specialistEvents.map((event) => Number(event.chatContent))).toEqual([3, 2, 1]);
    // Rotation kept going even though a later turn tried to change modes.
    expect(specialistEvents.map((event) => event.agentId)).toEqual([counterA.id, counterB.id, counterA.id]);
  });

  it("reserves the whole ready pool then releases the Agents the Lead leaves out", async () => {
    const runner = new ScriptedRunner();
    const { agents, teamTasks } = await makeServices(runner);
    const lead = await agents.createAgent(actor, { name: "Lead" });
    const used = await agents.createAgent(actor, { name: "Used One", description: "Relevant" });
    const alsoUsed = await agents.createAgent(actor, { name: "Used Two", description: "Also relevant" });
    const unused = await agents.createAgent(actor, { name: "Unused", description: "Not relevant here" });
    runner.script.push(
      planFacilitated(used.id, "Handle the relevant part", { rosterAgentIds: [used.id, alsoUsed.id] }),
      specialist("First part done."),
      delegate(alsoUsed.id, "Handle the rest"),
      specialist("Second part done."),
      complete("Both relevant specialists contributed."),
    );
    const task = await teamTasks.createTask(actor, {
      objective: "Do a two-part job with only the relevant Agents",
      leadAgentId: lead.id,
      specialistAgentIds: [],
      agentSelection: "lead",
    });
    // Every ready Agent is reserved up front.
    expect(agents.getAgent(actor, unused.id)).toMatchObject({ status: "busy", activeTeamTaskId: task.id });

    await expect.poll(() => teamTasks.getTask(actor, task.id).status).toBe("ready");

    // The Lead's roster is now the task's specialist list; the unused Agent was released.
    expect(teamTasks.getTask(actor, task.id).specialistAgentIds).toEqual([used.id, alsoUsed.id]);
    expect(agents.getAgent(actor, unused.id)).toMatchObject({ status: "ready", activeTeamTaskId: null });
    expect(agents.getAgent(actor, used.id)).toMatchObject({ status: "busy", activeTeamTaskId: task.id });
    const planEvent = teamTasks.getEvents(actor, task.id).find((event) => event.type === "coordination_plan");
    expect(planEvent?.content).toContain("2 specialists");
  });

  it("accepts a Lead roster and delegate target given by Agent name, not id", async () => {
    const runner = new ScriptedRunner();
    const { agents, teamTasks } = await makeServices(runner);
    const lead = await agents.createAgent(actor, { name: "Lead" });
    const alpha = await agents.createAgent(actor, { name: "Alpha", description: "relevant" });
    const bravo = await agents.createAgent(actor, { name: "Bravo", description: "relevant" });
    const spare = await agents.createAgent(actor, { name: "Spare", description: "not relevant" });
    runner.script.push(
      planFacilitated("Alpha", "Kick off the work", { rosterAgentIds: ["Alpha", "Bravo"] }),
      specialist("Alpha done."),
      delegate("Bravo", "Continue the work"),
      specialist("Bravo done."),
      complete("Finished with the two named Agents."),
    );
    const task = await teamTasks.createTask(actor, {
      objective: "Use Agents referred to by name",
      leadAgentId: lead.id,
      specialistAgentIds: [],
      agentSelection: "lead",
    });
    await expect.poll(() => teamTasks.getTask(actor, task.id).status).toBe("ready");
    expect(teamTasks.getTask(actor, task.id).specialistAgentIds).toEqual([alpha.id, bravo.id]);
    expect(agents.getAgent(actor, spare.id)).toMatchObject({ status: "ready", activeTeamTaskId: null });
    expect(
      teamTasks.getEvents(actor, task.id).filter((event) => event.type === "specialist_result").map((event) => event.agentId),
    ).toEqual([alpha.id, bravo.id]);
  });

  it("tolerates odd casing and a null agentId in the sequential first-turn plan", async () => {
    const runner = new ScriptedRunner();
    const { agents, teamTasks } = await makeServices(runner);
    const lead = await agents.createAgent(actor, { name: "Lead" });
    const a = await agents.createAgent(actor, { name: "A" });
    const b = await agents.createAgent(actor, { name: "B" });
    runner.script.push(
      JSON.stringify({
        message: "This is a sequence.",
        plan: { turnPolicy: " SEQUENTIAL " },
        statePatch: { currentNumber: 2 },
        decision: { type: "delegate", agentId: null, assignment: "Start with the first value, 2" },
      }),
      specialist("2", "Returned 2."),
      sequentialDelegate("The last number was 2; reply with exactly 1", { currentNumber: 1 }),
      specialist("1", "Returned 1."),
      complete("Counted down to 1."),
    );
    const task = await teamTasks.createTask(actor, {
      objective: "Count down from 2 to 1",
      leadAgentId: lead.id,
      specialistAgentIds: [a.id, b.id],
    });
    await expect.poll(() => teamTasks.getTask(actor, task.id).status).toBe("ready");
    expect(teamTasks.getTask(actor, task.id).turnPolicy).toBe("sequential");
    expect(
      teamTasks.getEvents(actor, task.id).filter((event) => event.type === "specialist_result").map((event) => Number(event.chatContent)),
    ).toEqual([2, 1]);
  });

  it("trims a chatty sequential reply down to the bare value in the chat", async () => {
    const runner = new ScriptedRunner();
    const { agents, teamTasks } = await makeServices(runner);
    const lead = await agents.createAgent(actor, { name: "Lead" });
    const research = await agents.createAgent(actor, { name: "Research", description: "Confirms facts" });
    const check = await agents.createAgent(actor, { name: "Check" });
    runner.script.push(
      planSequential("Reply with only: 3", { statePatch: { currentNumber: 3 } }),
      specialist("Research confirms the countdown starts at 3 — the first value is 3.", "Verified."),
      sequentialDelegate("The last number was 3. Reply with only: 2", { currentNumber: 2 }),
      specialist("The next number is 2.", "Counted down."),
      sequentialDelegate("The last number was 2. Reply with only: 1", { currentNumber: 1 }),
      specialist("1", "Done."),
      complete("Counted down to 1."),
    );
    const task = await teamTasks.createTask(actor, {
      objective: "Count down from 3 to 1",
      leadAgentId: lead.id,
      specialistAgentIds: [research.id, check.id],
    });
    await expect.poll(() => teamTasks.getTask(actor, task.id).status).toBe("ready");
    expect(
      teamTasks.getEvents(actor, task.id).filter((event) => event.type === "specialist_result").map((event) => event.chatContent),
    ).toEqual(["3", "2", "1"]);
  });

  it("reports the specific problem when the Lead's first turn is malformed", async () => {
    const runner = new ScriptedRunner();
    const { agents, teamTasks } = await makeServices(runner);
    const lead = await agents.createAgent(actor, { name: "Lead" });
    const a = await agents.createAgent(actor, { name: "A" });
    const b = await agents.createAgent(actor, { name: "B" });
    const noPlan = JSON.stringify({
      message: "Forgot the plan.",
      statePatch: {},
      decision: { type: "delegate", agentId: a.id, assignment: "go" },
    });
    runner.script.push(noPlan, noPlan);
    const task = await teamTasks.createTask(actor, {
      objective: "Malformed first turn",
      leadAgentId: lead.id,
      specialistAgentIds: [a.id, b.id],
    });
    await expect.poll(() => teamTasks.getTask(actor, task.id).status).toBe("paused");
    expect(teamTasks.getTask(actor, task.id).lastError).toContain("first turn must include a coordination plan");
    expect(b.id).toBeDefined();
  });

  it("drops an unresolvable roster entry (e.g. the Lead naming itself) and proceeds", async () => {
    const runner = new ScriptedRunner();
    const { agents, teamTasks } = await makeServices(runner);
    const lead = await agents.createAgent(actor, { name: "Lead" });
    const alpha = await agents.createAgent(actor, { name: "Alpha" });
    const bravo = await agents.createAgent(actor, { name: "Bravo" });
    const spare = await agents.createAgent(actor, { name: "Spare" });
    runner.script.push(
      // "Lead" is not a roster member; it should be ignored, leaving Alpha + Bravo.
      planFacilitated("Alpha", "Kick off", { rosterAgentIds: ["Lead", "Alpha", "Bravo"] }),
      specialist("Alpha done."),
      delegate("Bravo", "Continue"),
      specialist("Bravo done."),
      complete("Done with Alpha and Bravo."),
    );
    const task = await teamTasks.createTask(actor, {
      objective: "Ignore a bad roster entry",
      leadAgentId: lead.id,
      specialistAgentIds: [],
      agentSelection: "lead",
    });
    await expect.poll(() => teamTasks.getTask(actor, task.id).status).toBe("ready");
    expect(teamTasks.getTask(actor, task.id).specialistAgentIds).toEqual([alpha.id, bravo.id]);
    expect(agents.getAgent(actor, spare.id)).toMatchObject({ status: "ready", activeTeamTaskId: null });
  });

  it("pauses only when the Lead's roster has too few valid Agents", async () => {
    const runner = new ScriptedRunner();
    const { agents, teamTasks } = await makeServices(runner);
    const lead = await agents.createAgent(actor, { name: "Lead" });
    const a = await agents.createAgent(actor, { name: "A" });
    const b = await agents.createAgent(actor, { name: "B" });
    runner.script.push(
      planFacilitated("A", "work", { rosterAgentIds: ["A", "Ghost Agent"] }),
      planFacilitated("A", "work again", { rosterAgentIds: ["A", "Ghost Agent"] }),
    );
    const task = await teamTasks.createTask(actor, {
      objective: "Only one valid roster Agent",
      leadAgentId: lead.id,
      specialistAgentIds: [],
      agentSelection: "lead",
    });
    await expect.poll(() => teamTasks.getTask(actor, task.id).status).toBe("paused");
    expect(teamTasks.getTask(actor, task.id).lastError).toContain("at least 2 of these exact Agents");
    expect(agents.getAgent(actor, b.id)).toMatchObject({ status: "busy", activeTeamTaskId: task.id });
  });

  it("pauses inline before Runtime and resumes automatically after a one-turn approval", async () => {
    const runner = new ScriptedRunner();
    const { agents, teamTasks, security } = await makeServices(runner, { RUNTIME_PROVIDER: "container" });
    const lead = await agents.createAgent(actor, { name: "Lead" });
    const analyst = await agents.createAgent(actor, { name: "Analyst" });
    const resource = await security.createResource(actor, {
      name: "Launch Plan",
      description: "Protected launch checklist",
      content: "Priority one: ship the Runtime boundary.",
    });

    runner.script.push(planFacilitated(analyst.id, "Read the protected brief and summarize it"));
    const task = await teamTasks.createTask(actor, {
      objective: "Summarize the protected brief",
      leadAgentId: lead.id,
      specialistAgentIds: [analyst.id],
      resourceId: resource.id,
      resourceAccessMode: "manual",
    });
    await expect.poll(() => teamTasks.getTask(actor, task.id).status).toBe("paused");
    const paused = teamTasks.getTask(actor, task.id);
    expect(paused.pendingAccessApproval).toMatchObject({
      agentId: analyst.id,
      resourceId: resource.id,
      action: "read",
      assignment: "Read the protected brief and summarize it",
    });
    // The Lead planned, but the denied specialist never reached the Runtime.
    expect(runner.requests.map((request) => request.agentId)).toEqual([lead.id]);
    expect(security.listDecisions(actor, agents.getAgent(actor, analyst.id))[0]).toMatchObject({
      outcome: "deny",
      reason: "GRANT_MISSING",
    });

    runner.script.push(
      specialist("Priority one is the Runtime boundary.", "Read the approved brief."),
      complete("The brief prioritises the Runtime boundary."),
    );
    await teamTasks.resolveAccessApproval(
      actor,
      task.id,
      paused.pendingAccessApproval!.id,
      "allow_once",
    );
    await expect.poll(() => teamTasks.getTask(actor, task.id).status).toBe("ready");
    expect(runner.requests.map((request) => request.agentId)).toEqual([lead.id, analyst.id, lead.id]);
    expect(runner.requests[1]?.mounts).toEqual([
      { sourcePath: expect.any(String), targetPath: `/authorized-resources/${resource.id}.txt`, readOnly: true },
    ]);
    expect(security.listGrants(actor, agents.getAgent(actor, analyst.id))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "team_task", teamTaskId: task.id, state: "revoked" }),
      ]),
    );
    expect(teamTasks.getEvents(actor, task.id).map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "access_approval_requested",
        "access_approval_granted",
        "access_approval_consumed",
      ]),
    );
  });

  it("lets the Lead choose a protected-task roster before task capabilities are issued", async () => {
    const runner = new ScriptedRunner();
    const { agents, teamTasks, security } = await makeServices(runner, { RUNTIME_PROVIDER: "container" });
    const lead = await agents.createAgent(actor, { name: "Lead" });
    const analyst = await agents.createAgent(actor, { name: "Analyst" });
    const reviewer = await agents.createAgent(actor, { name: "Reviewer" });
    const resource = await security.createResource(actor, {
      name: "Travel Profile",
      description: "Private constraints",
      content: "Budget: SGD 2,800.",
    });
    runner.script.push(
      planFacilitated(analyst.id, "Read the profile", {
        rosterAgentIds: [analyst.name, reviewer.name],
      }),
      specialist("The budget is SGD 2,800."),
      delegate(reviewer.id, "Check the budget constraint"),
      specialist("The budget constraint is confirmed."),
      complete("The protected profile was checked by both specialists."),
    );

    const task = await teamTasks.createTask(actor, {
      objective: "Review the protected travel profile",
      leadAgentId: lead.id,
      specialistAgentIds: [],
      agentSelection: "lead",
      resourceId: resource.id,
      resourceAccessMode: "task",
    });
    await expect.poll(() => teamTasks.getTask(actor, task.id).status).toBe("ready");

    const finished = teamTasks.getTask(actor, task.id);
    expect(finished.specialistAgentIds).toEqual([analyst.id, reviewer.id]);
    expect(
      runner.requests
        .filter((request) => request.agentId === lead.id)
        .every((request) => request.mounts === undefined),
    ).toBe(true);
    const eventTypes = teamTasks.getEvents(actor, task.id).map((event) => event.type);
    expect(eventTypes.indexOf("coordination_plan")).toBeLessThan(eventTypes.indexOf("task_access_granted"));
    expect(eventTypes.indexOf("task_access_granted")).toBeLessThan(eventTypes.indexOf("resource_authorization"));
    for (const specialistAgent of [analyst, reviewer]) {
      expect(security.listGrants(actor, agents.getAgent(actor, specialistAgent.id))).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ source: "team_task", teamTaskId: task.id, state: "active" }),
        ]),
      );
    }
  });

  it("can approve the current roster once and avoids repeated inline prompts", async () => {
    const runner = new ScriptedRunner();
    const { agents, teamTasks, security } = await makeServices(runner, { RUNTIME_PROVIDER: "container" });
    const lead = await agents.createAgent(actor, { name: "Lead" });
    const analyst = await agents.createAgent(actor, { name: "Analyst" });
    const reviewer = await agents.createAgent(actor, { name: "Reviewer" });
    const resource = await security.createResource(actor, {
      name: "Launch Plan",
      description: "Private plan",
      content: "Launch on Friday.",
    });
    runner.script.push(planFacilitated(analyst.id, "Read the launch date"));
    const task = await teamTasks.createTask(actor, {
      objective: "Review the launch plan",
      leadAgentId: lead.id,
      specialistAgentIds: [analyst.id, reviewer.id],
      resourceId: resource.id,
      resourceAccessMode: "manual",
    });
    await expect.poll(() => teamTasks.getTask(actor, task.id).status).toBe("paused");
    const approval = teamTasks.getTask(actor, task.id).pendingAccessApproval!;

    runner.script.push(
      specialist("The launch is Friday."),
      delegate(reviewer.id, "Verify the launch date"),
      specialist("Friday is confirmed."),
      complete("Both specialists confirmed Friday."),
    );
    await teamTasks.resolveAccessApproval(actor, task.id, approval.id, "allow_roster_task");
    await expect.poll(() => teamTasks.getTask(actor, task.id).status).toBe("ready");
    expect(teamTasks.getEvents(actor, task.id).filter((event) => event.type === "access_approval_requested"))
      .toHaveLength(1);
    expect(runner.requests.filter((request) => [analyst.id, reviewer.id].includes(request.agentId)))
      .toHaveLength(2);
  });

  it("denies inline access without starting the specialist Runtime and rejects a stale click", async () => {
    const runner = new ScriptedRunner();
    const { agents, teamTasks, security } = await makeServices(runner, { RUNTIME_PROVIDER: "container" });
    const lead = await agents.createAgent(actor, { name: "Lead" });
    const analyst = await agents.createAgent(actor, { name: "Analyst" });
    const resource = await security.createResource(actor, {
      name: "Sensitive Brief",
      description: "Private brief",
      content: "Restricted.",
    });
    runner.script.push(planFacilitated(analyst.id, "Read the sensitive brief"));
    const task = await teamTasks.createTask(actor, {
      objective: "Review the sensitive brief",
      leadAgentId: lead.id,
      specialistAgentIds: [analyst.id],
      resourceId: resource.id,
      resourceAccessMode: "manual",
    });
    await expect.poll(() => teamTasks.getTask(actor, task.id).status).toBe("paused");
    const approval = teamTasks.getTask(actor, task.id).pendingAccessApproval!;
    const denied = await teamTasks.resolveAccessApproval(actor, task.id, approval.id, "deny");
    expect(denied).toMatchObject({ status: "ready", pendingAccessApproval: null });
    expect(runner.requests.map((request) => request.agentId)).toEqual([lead.id]);
    expect(teamTasks.getEvents(actor, task.id).map((event) => event.type)).toEqual(
      expect.arrayContaining(["access_approval_denied", "request_failed"]),
    );
    await expect(
      teamTasks.resolveAccessApproval(actor, task.id, approval.id, "allow_once"),
    ).rejects.toMatchObject({ statusCode: 409, details: { code: "ACCESS_APPROVAL_STALE" } });
  });

  it("mounts the protected resource read-only for an authorized specialist turn only", async () => {
    const runner = new ScriptedRunner();
    const { agents, teamTasks, security } = await makeServices(runner, { RUNTIME_PROVIDER: "container" });
    const lead = await agents.createAgent(actor, { name: "Lead" });
    const analyst = await agents.createAgent(actor, { name: "Analyst" });
    const resource = await security.createResource(actor, {
      name: "Launch Plan",
      description: "Protected launch checklist",
      content: "Priority one: ship the Runtime boundary.",
    });
    await security.createGrant(actor, agents.getAgent(actor, analyst.id), resource.id, "Summarize for the team", 300);
    const secondResource = await security.createResource(actor, {
      name: "Budget Notes",
      description: "Protected budget details",
      content: "The approved budget is 42 credits.",
    });
    await security.createGrant(actor, agents.getAgent(actor, analyst.id), secondResource.id, "Summarize for the team", 300);
    runner.script.push(
      planFacilitated(analyst.id, "Read the protected brief and summarize its priorities"),
      specialist("Priority one is the Runtime boundary.", "Read the brief and summarized it."),
      complete("The brief prioritises the Runtime boundary."),
    );

    const task = await teamTasks.createTask(actor, {
      objective: "Summarize the protected brief",
      leadAgentId: lead.id,
      specialistAgentIds: [analyst.id],
      resourceId: resource.id,
    });
    await expect.poll(() => teamTasks.getTask(actor, task.id).status).toBe("ready");

    const specialistRequest = runner.requests.find((request) => request.agentId === analyst.id);
    expect(specialistRequest?.mounts).toEqual([
      { sourcePath: expect.any(String), targetPath: "/authorized-resources/" + resource.id + ".txt", readOnly: true },
    ]);
    expect(specialistRequest?.prompt).toContain("/authorized-resources/" + resource.id + ".txt");
    // The Lead coordinates without the document, so delegation cannot widen access.
    expect(runner.requests.filter((request) => request.agentId === lead.id).every((request) => request.mounts === undefined)).toBe(true);
    const allow = teamTasks.getEvents(actor, task.id).find((event) => event.type === "resource_authorization");
    expect(allow?.content).toContain("ALLOW");
    expect(teamTasks.verifyEventChain(actor, task.id)).toBe(true);
  });

  it("keeps task-scoped read access between requests and revokes it when the team ends", async () => {
    const runner = new ScriptedRunner();
    const { agents, teamTasks, security } = await makeServices(runner, { RUNTIME_PROVIDER: "container" });
    const lead = await agents.createAgent(actor, { name: "Lead" });
    const analyst = await agents.createAgent(actor, { name: "Analyst" });
    const resource = await security.createResource(actor, {
      name: "Travel Profile",
      description: "Protected dates and budget",
      content: "Dates: 14-18 September. Budget: SGD 2,800.",
    });
    runner.script.push(
      planFacilitated(analyst.id, "Read the profile and propose a plan"),
      specialist("The plan uses 14-18 September and stays within SGD 2,800."),
      complete("A budget-aware September plan is ready."),
    );

    const task = await teamTasks.createTask(actor, {
      objective: "Plan a trip from the protected profile",
      leadAgentId: lead.id,
      specialistAgentIds: [analyst.id],
      resourceId: resource.id,
      resourceAccessMode: "task",
    });
    await expect.poll(() => teamTasks.getTask(actor, task.id).status).toBe("ready");

    const specialistRequest = runner.requests.find((request) => request.agentId === analyst.id);
    expect(specialistRequest?.mounts).toEqual([
      { sourcePath: expect.any(String), targetPath: `/authorized-resources/${resource.id}.txt`, readOnly: true },
    ]);
    let grants = security.listGrants(actor, agents.getAgent(actor, analyst.id));
    expect(grants).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "team_task", teamTaskId: task.id, state: "active" }),
    ]));
    const decision = security.listDecisions(actor, agents.getAgent(actor, analyst.id))[0];
    expect(decision).toMatchObject({ outcome: "allow", teamTaskId: task.id });
    let eventTypes = teamTasks.getEvents(actor, task.id).map((event) => event.type);
    expect(eventTypes).toEqual(expect.arrayContaining([
      "task_access_granted",
      "resource_authorization",
    ]));
    expect(teamTasks.verifyEventChain(actor, task.id)).toBe(true);

    const leaked = await security.authorizeResourceRead(actor, agents.getAgent(actor, analyst.id), resource.id);
    expect(leaked.decision).toMatchObject({ outcome: "deny", reason: "GRANT_MISSING", teamTaskId: null });

    await teamTasks.stopTask(actor, task.id);
    grants = security.listGrants(actor, agents.getAgent(actor, analyst.id));
    expect(grants).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "team_task", teamTaskId: task.id, state: "revoked" }),
    ]));
    eventTypes = teamTasks.getEvents(actor, task.id).map((event) => event.type);
    expect(eventTypes).toContain("task_access_revoked");
  });

  it("authorizes a specialist turn against another user's resource via a cross-user share", async () => {
    const bobActor = { userId: "user-bob", username: "bob", displayName: "Bob Lim" };
    const runner = new ScriptedRunner();
    const { agents, teamTasks, security } = await makeServices(runner, { RUNTIME_PROVIDER: "container" });
    const lead = await agents.createAgent(actor, { name: "Lead" });
    const analyst = await agents.createAgent(actor, { name: "Analyst" });
    // Bob owns the file; Alice's Agents hold no lease on it.
    const resource = await security.createResource(bobActor, {
      name: "Partner Shortlist",
      description: "Bob's protected shortlist",
      content: "Option A, Option B, Option C.",
    });

    // Not shared yet ⇒ the task is refused before it starts, no hand-off.
    await expect(
      teamTasks.createTask(actor, {
        objective: "Summarize Bob's shortlist",
        leadAgentId: lead.id,
        specialistAgentIds: [analyst.id],
        resourceId: resource.id,
      }),
    ).rejects.toMatchObject({ statusCode: 403, details: { reason: "SHARE_MISSING" } });
    expect(teamTasks.listTasks(actor)).toHaveLength(0);
    expect(runner.requests).toHaveLength(0);

    // Bob shares it with Alice — no per-Agent lease needed after that.
    await security.createShare(bobActor, resource.id, actor.userId, "Team review", null);
    runner.script.push(
      planFacilitated(analyst.id, "Read the shared shortlist and summarize the options"),
      specialist("Three partner options are on the table.", "Read and summarized the shortlist."),
      complete("The shortlist has three partner options."),
    );

    const task = await teamTasks.createTask(actor, {
      objective: "Summarize Bob's shortlist",
      leadAgentId: lead.id,
      specialistAgentIds: [analyst.id],
      resourceId: resource.id,
    });
    await expect.poll(() => teamTasks.getTask(actor, task.id).status).toBe("ready");
    const specialistRequest = runner.requests.find((request) => request.agentId === analyst.id);
    expect(specialistRequest?.mounts).toEqual([
      { sourcePath: expect.any(String), targetPath: "/authorized-resources/" + resource.id + ".txt", readOnly: true },
    ]);
    expect(teamTasks.verifyEventChain(actor, task.id)).toBe(true);
  });

  it("stops before any hand-off when the objective names a protected resource the user cannot access", async () => {
    const bobActor = { userId: "user-bob", username: "bob", displayName: "Bob Lim" };
    const runner = new ScriptedRunner();
    const { agents, teamTasks, security } = await makeServices(runner, { RUNTIME_PROVIDER: "container" });
    const lead = await agents.createAgent(actor, { name: "Lead" });
    const analyst = await agents.createAgent(actor, { name: "Analyst" });
    await security.createResource(bobActor, {
      name: "Quarterly Revenue Memo",
      description: "Bob's numbers",
      content: "Fictional revenue figures.",
    });

    // No resourceId attached, but the objective clearly names Bob's memo.
    await expect(
      teamTasks.createTask(actor, {
        objective: "Summarise the Quarterly Revenue Memo for the leadership review",
        leadAgentId: lead.id,
        specialistAgentIds: [analyst.id],
      }),
    ).rejects.toMatchObject({ statusCode: 403, details: { code: "RESOURCE_ACCESS_DENIED", reason: "SHARE_MISSING" } });
    expect(teamTasks.listTasks(actor)).toHaveLength(0);
    expect(runner.requests).toHaveLength(0);
  });

  it("stops when the objective mentions a protected document but none is attached", async () => {
    const runner = new ScriptedRunner();
    const { agents, teamTasks } = await makeServices(runner, { RUNTIME_PROVIDER: "container" });
    const lead = await agents.createAgent(actor, { name: "Lead" });
    const analyst = await agents.createAgent(actor, { name: "Analyst" });

    await expect(
      teamTasks.createTask(actor, {
        objective: "Tell me what is in Bob's document and summarise it",
        leadAgentId: lead.id,
        specialistAgentIds: [analyst.id],
      }),
    ).rejects.toMatchObject({ statusCode: 422, details: { code: "RESOURCE_NOT_ATTACHED" } });
    expect(runner.requests).toHaveLength(0);
  });

  it("stops at the start when the objective names an accessible resource (plural-tolerant) that wasn't attached", async () => {
    const runner = new ScriptedRunner();
    const { agents, teamTasks } = await makeServices(runner, { RUNTIME_PROVIDER: "container" });
    const lead = await agents.createAgent(actor, { name: "Lead" });
    const analyst = await agents.createAgent(actor, { name: "Analyst" });
    // The seeded "Partnerships Brief" is owned by Bob and shared with Alice.
    // The prompt says "partnership brief" (singular) and attaches nothing.
    await expect(
      teamTasks.createTask(actor, {
        objective: "what's in the partnership brief",
        leadAgentId: lead.id,
        specialistAgentIds: [analyst.id],
      }),
    ).rejects.toMatchObject({
      statusCode: 422,
      details: {
        code: "RESOURCE_NOT_ATTACHED",
        resourceId: "resource-bob-partnerships-brief",
        resourceName: "Partnerships Brief",
      },
    });
    expect(teamTasks.listTasks(actor)).toHaveLength(0);
    expect(runner.requests).toHaveLength(0);

    // Attaching it lets the task run — the active share covers every specialist,
    // no per-Agent lease needed.
    runner.script.push(
      planFacilitated(analyst.id, "Read the partnerships brief and list the options"),
      specialist("Three options are on the table.", "Read the brief."),
      complete("The brief lists three partner options."),
    );
    const task = await teamTasks.createTask(actor, {
      objective: "what's in the partnership brief",
      leadAgentId: lead.id,
      specialistAgentIds: [analyst.id],
      resourceId: "resource-bob-partnerships-brief",
    });
    await expect.poll(() => teamTasks.getTask(actor, task.id).status).toBe("ready");
  });
});

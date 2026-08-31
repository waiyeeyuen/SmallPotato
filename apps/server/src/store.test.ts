import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonStore } from "./store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("JsonStore", () => {
  it("backs up and safely downgrades newer Team Task databases", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-store-test-"));
    temporaryDirectories.push(root);
    const filePath = path.join(root, "db.json");
    const timestamp = new Date().toISOString();
    await writeFile(filePath, JSON.stringify({
      version: 4,
      agents: [], messages: [], runs: [], teamTaskEvents: [{
        id: "event-1", taskId: "task-1", sequence: 1, type: "task_started",
        agentId: null, content: "Started", chatContent: null, assignment: null,
        attempt: null, statePatch: null, previousReceiptHash: null,
        receiptHash: "legacy-receipt", createdAt: timestamp,
      }],
      teamTasks: [{
        id: "task-1", objective: "Existing council", mode: "council",
        leadAgentId: "lead", specialistAgentIds: ["specialist"], status: "completed",
        workspacePath: "/tmp/task", currentAgentId: null, currentAssignment: null,
        turnCount: 2, maxTurns: 30, contributionCount: 2, contributionLimit: 2,
        responseWordTarget: 25, sharedState: {}, stateVersion: 0,
        lastHandledInstructionSequence: 0, threadIds: {}, completionSummary: "Done",
        lastError: null, createdAt: timestamp, updatedAt: timestamp, completedAt: timestamp,
      }],
    }));

    const store = new JsonStore(filePath);
    await store.initialize();
    expect(store.snapshot().version).toBe(6);
    expect((store.snapshot().teamTasks[0] as unknown as { mode: string }).mode).toBe("council");
    expect(store.snapshot().teamTasks[0]?.assignmentQueue).toEqual([]);
    expect(store.snapshot().teamTasks[0]?.activeTurnStartedAt).toBeNull();
    expect(store.snapshot().teamTasks[0]?.turnPolicy).toBeNull();
    expect(store.snapshot().teamTasks[0]?.agentSelection).toBe("user");
    expect(store.snapshot().teamTasks[0]?.resourceAccessMode).toBe("manual");
    expect(store.snapshot().teamTasks[0]?.rosterLocked).toBe(true);
    expect(store.snapshot().teamTasks[0]?.activeRequestSequence).toBeNull();
    expect(store.snapshot().teamTaskEvents[0]?.receiptHash).toBe("legacy-receipt");
    expect(JSON.parse(await readFile(filePath + ".v4.backup", "utf8")).version).toBe(4);
    expect(JSON.parse(await readFile(filePath, "utf8")).version).toBe(6);
  });

  it("backs up version 5 data before adding task-scoped authorization fields", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-store-test-"));
    temporaryDirectories.push(root);
    const filePath = path.join(root, "db.json");
    await writeFile(filePath, JSON.stringify({
      version: 5,
      users: [], sessions: [], resources: [], agents: [], grants: [], decisions: [],
      messages: [], runs: [], teamTasks: [], teamTaskEvents: [],
    }));

    const store = new JsonStore(filePath);
    await store.initialize();

    expect(store.snapshot().version).toBe(6);
    expect(JSON.parse(await readFile(filePath + ".v5.backup", "utf8")).version).toBe(5);
    expect(JSON.parse(await readFile(filePath, "utf8")).version).toBe(6);
  });

  it("migrates version 1 data without losing Agents, messages, or runs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-store-test-"));
    temporaryDirectories.push(root);
    const filePath = path.join(root, "db.json");
    const timestamp = new Date().toISOString();
    await writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        agents: [{
          id: "agent-1", name: "Lead", description: "", instructions: "",
          status: "ready", workspacePath: "/tmp/agent-1", codexThreadId: null,
          lastError: null, createdAt: timestamp, updatedAt: timestamp,
        }],
        messages: [{ id: "message-1", agentId: "agent-1", runId: "run-1", role: "user", content: "hello", createdAt: timestamp }],
        runs: [{ id: "run-1", agentId: "agent-1", status: "completed", prompt: "hello", output: "hi", error: null, usage: null, startedAt: timestamp, completedAt: timestamp, createdAt: timestamp }],
      }),
    );

    const store = new JsonStore(filePath);
    await store.initialize();
    const database = store.snapshot();
    expect(database.version).toBe(6);
    expect(database.agents[0]?.activeTeamTaskId).toBeNull();
    expect(database.messages).toHaveLength(1);
    expect(database.runs).toHaveLength(1);
    expect(database.teamTasks).toEqual([]);
    expect(database.teamTaskEvents).toEqual([]);
    expect(JSON.parse(await readFile(filePath, "utf8")).version).toBe(6);
  });

  it("backs up AgentGuard version 3 data and preserves shared Agent history", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-store-test-"));
    temporaryDirectories.push(root);
    const filePath = path.join(root, "db.json");
    const timestamp = new Date().toISOString();
    await writeFile(filePath, JSON.stringify({
      version: 3,
      users: [{ id: "user-1" }], sessions: [], resources: [], grants: [], decisions: [],
      agents: [{
        id: "agent-1", ownerUserId: "user-1", principalId: "principal-1",
        name: "Lead", description: "", instructions: "", status: "ready",
        workspacePath: "/tmp/agent-1", codexThreadId: null, lastError: null,
        createdAt: timestamp, updatedAt: timestamp,
      }],
      messages: [{ id: "message-1", agentId: "agent-1", runId: "run-1", role: "user", content: "hello", createdAt: timestamp }],
      runs: [{ id: "run-1", agentId: "agent-1", status: "completed", prompt: "hello", output: "hi", error: null, usage: null, resourceId: null, policyDecisionId: null, startedAt: timestamp, completedAt: timestamp, createdAt: timestamp }],
    }));

    const store = new JsonStore(filePath);
    await store.initialize();
    const database = store.snapshot();
    expect(database.version).toBe(6);
    expect(database.agents[0]?.activeTeamTaskId).toBeNull();
    expect(database.messages).toHaveLength(1);
    expect(database.runs).toHaveLength(1);
    expect(database.teamTasks).toEqual([]);
    expect(database.teamTaskEvents).toEqual([]);
    expect(JSON.parse(await readFile(filePath + ".v3-agentguard.backup", "utf8")).version).toBe(3);
  });

  it("migrates version 5 data by adding the shares table and backfilling receipt owners", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-store-test-"));
    temporaryDirectories.push(root);
    const filePath = path.join(root, "db.json");
    const timestamp = new Date().toISOString();
    await writeFile(filePath, JSON.stringify({
      version: 5,
      users: [{ id: "user-alice" }, { id: "user-bob" }],
      sessions: [], agents: [], messages: [], runs: [], grants: [],
      teamTasks: [], teamTaskEvents: [],
      resources: [{
        id: "resource-bob-1", ownerUserId: "user-bob", name: "Brief", description: "",
        filePath: "/tmp/brief.txt", sizeBytes: 10, isDemo: false, deletedAt: null,
        createdAt: timestamp, updatedAt: timestamp,
      }],
      decisions: [{
        id: "decision-1", humanUserId: "user-alice", humanName: "Alice Tan",
        agentId: "agent-1", agentName: "Agent", agentPrincipalId: "principal-1",
        action: "read", resourceId: "resource-bob-1", resourceName: "Brief",
        outcome: "deny", reason: "RESOURCE_NOT_OWNED", grantId: null, runId: null,
        previousReceiptHash: null, receiptHash: "stale", createdAt: timestamp,
      }],
    }));

    const store = new JsonStore(filePath);
    await store.initialize();
    const database = store.snapshot();
    expect(database.version).toBe(6);
    expect(database.shares).toEqual([]);
    expect(database.decisions[0]?.resourceOwnerUserId).toBe("user-bob");
    expect(database.decisions[0]?.receiptHash).not.toBe("stale");
    expect(JSON.parse(await readFile(filePath, "utf8")).version).toBe(6);
  });

  it("does not publish a mutation in memory when persistence fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-store-test-"));
    temporaryDirectories.push(root);
    const originalPath = path.join(root, "db.json");
    const store = new JsonStore(originalPath);
    await store.initialize();

    const mutableStore = store as unknown as { filePath: string };
    mutableStore.filePath = path.join(root, "missing-directory", "db.json");
    await expect(
      store.mutate((database) => {
        database.messages.push({
          id: "message-1",
          agentId: "agent-1",
          runId: "run-1",
          role: "user",
          content: "must not become visible",
          createdAt: new Date().toISOString(),
        });
      }),
    ).rejects.toThrow();
    expect(store.snapshot().messages).toEqual([]);

    mutableStore.filePath = originalPath;
    await store.mutate((database) => {
      database.messages.push({
        id: "message-2",
        agentId: "agent-1",
        runId: "run-2",
        role: "user",
        content: "queue recovered",
        createdAt: new Date().toISOString(),
      });
    });
    expect(store.snapshot().messages.map((message) => message.content)).toEqual([
      "queue recovered",
    ]);
  });
});

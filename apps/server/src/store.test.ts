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
      agents: [], messages: [], runs: [], teamTaskEvents: [],
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
    expect(store.snapshot().version).toBe(2);
    expect((store.snapshot().teamTasks[0] as unknown as { mode: string }).mode).toBe("council");
    expect(JSON.parse(await readFile(filePath + ".v4.backup", "utf8")).version).toBe(4);
    expect(JSON.parse(await readFile(filePath, "utf8")).version).toBe(2);
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
    expect(database.version).toBe(2);
    expect(database.agents[0]?.activeTeamTaskId).toBeNull();
    expect(database.messages).toHaveLength(1);
    expect(database.runs).toHaveLength(1);
    expect(database.teamTasks).toEqual([]);
    expect(database.teamTaskEvents).toEqual([]);
    expect(JSON.parse(await readFile(filePath, "utf8")).version).toBe(2);
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

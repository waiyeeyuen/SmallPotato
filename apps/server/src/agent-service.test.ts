import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { loadConfig } from "./config.js";
import { JsonStore } from "./store.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "./types.js";
import { WorkspaceManager } from "./workspace.js";
import { SecurityService } from "./security-service.js";
import type { RequestActor } from "./types.js";

const actor: RequestActor = {
  userId: "user-alice",
  username: "alice",
  displayName: "Alice Tan",
};

class FakeRunner implements AgentRunner {
  async run(request: RunnerRequest): Promise<RunnerResult> {
    return {
      output: "Completed: " + request.prompt,
      threadId: request.threadId ?? "fake-thread",
      usage: { inputTokens: 12, outputTokens: 5 },
    };
  }
  async cancel(): Promise<boolean> {
    return false;
  }
  async isAvailable(): Promise<boolean> {
    return true;
  }
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function makeStack(runner: AgentRunner = new FakeRunner()) {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-test-"));
  temporaryDirectories.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    ARK_API_KEY: "test-key",
    ARK_MODEL: "ep-test",
    RUNTIME_PROVIDER: "container",
  });
  const store = new JsonStore(path.join(root, "data", "db.json"));
  const security = new SecurityService(store, path.join(root, "data"));
  const service = new AgentService(
    config,
    store,
    new WorkspaceManager(path.join(root, "workspaces")),
    runner,
    security,
  );
  await service.initialize();
  await security.initialize();
  return { service, security };
}

async function makeService(runner: AgentRunner = new FakeRunner()): Promise<AgentService> {
  return (await makeStack(runner)).service;
}

describe("Agent lifecycle", () => {
  it("creates, updates, stops, starts and deletes an Agent", async () => {
    const service = await makeService();
    const agent = await service.createAgent(actor, { name: "Builder" });
    expect(service.listAgents(actor)).toHaveLength(1);
    expect((await service.updateAgent(actor, agent.id, { description: "Builds apps" })).description)
      .toBe("Builds apps");
    expect((await service.stopAgent(actor, agent.id)).status).toBe("stopped");
    expect((await service.startAgent(actor, agent.id)).status).toBe("ready");
    await service.deleteAgent(actor, agent.id);
    expect(service.listAgents(actor)).toHaveLength(0);
  });

  it("persists a playground conversation", async () => {
    const service = await makeService();
    const agent = await service.createAgent(actor, { name: "Coder" });
    const { run } = await service.sendMessage(actor, agent.id, "write hello world");
    await expect.poll(() => service.getRun(actor, run.id).status).toBe("completed");
    const messages = service.getMessages(actor, agent.id);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(messages[1]?.content).toContain("write hello world");
    expect(service.getAgent(actor, agent.id).codexThreadId).toBe("fake-thread");
  });

  it("atomically accepts only one concurrent run per Agent", async () => {
    let finish!: (result: RunnerResult) => void;
    const pending = new Promise<RunnerResult>((resolve) => {
      finish = resolve;
    });
    const runner: AgentRunner = {
      run: () => pending,
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const service = await makeService(runner);
    const agent = await service.createAgent(actor, { name: "Concurrent" });
    const attempts = await Promise.allSettled([
      service.sendMessage(actor, agent.id, "first"),
      service.sendMessage(actor, agent.id, "second"),
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find((attempt) => attempt.status === "rejected");
    expect(rejected).toMatchObject({ reason: { statusCode: 409 } });
    expect(service.getMessages(actor, agent.id)).toHaveLength(1);

    finish({ output: "done", threadId: "thread", usage: null });
    const accepted = attempts.find((attempt) => attempt.status === "fulfilled");
    if (accepted?.status === "fulfilled") {
      await expect.poll(() => service.getRun(actor, accepted.value.run.id).status).toBe("completed");
    }
  });

  it("does not let start reset a busy Agent and admit a second run", async () => {
    let finish!: (result: RunnerResult) => void;
    const pending = new Promise<RunnerResult>((resolve) => {
      finish = resolve;
    });
    const service = await makeService({
      run: () => pending,
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent(actor, { name: "Busy" });
    const { run } = await service.sendMessage(actor, agent.id, "first");

    await expect(service.startAgent(actor, agent.id)).rejects.toMatchObject({ statusCode: 409 });
    await expect(service.sendMessage(actor, agent.id, "second")).rejects.toMatchObject({
      statusCode: 409,
    });

    finish({ output: "done", threadId: "thread", usage: null });
    await expect.poll(() => service.getRun(actor, run.id).status).toBe("completed");
  });

  it("mounts only an authorized resource and never invokes the Runner on denial", async () => {
    const requests: RunnerRequest[] = [];
    const runner: AgentRunner = {
      run: async (request) => {
        requests.push(request);
        return { output: "authorized", threadId: "thread", usage: null };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const { service, security } = await makeStack(runner);
    const agent = await service.createAgent(actor, { name: "Guarded" });
    const ownResource = security.listResources(actor).find((resource) => resource.ownedByCurrentUser);
    if (!ownResource) throw new Error("Expected Alice fixture resource");

    await expect(
      service.sendMessage(actor, agent.id, "read it", ownResource.id),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(requests).toHaveLength(0);

    await security.createGrant(actor, agent, ownResource.id, "Test access", 60);
    const { run } = await service.sendMessage(actor, agent.id, "read it", ownResource.id);
    await expect.poll(() => service.getRun(actor, run.id).status).toBe("completed");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.mounts).toEqual([
      expect.objectContaining({
        targetPath: "/authorized-resources/" + ownResource.id + ".txt",
        readOnly: true,
      }),
    ]);
  });
});

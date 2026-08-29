import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import type { AgentService } from "./agent-service.js";
import type { TeamTaskService } from "./team-task-service.js";

const service = {
  listAgents: () => [],
  systemInfo: async () => ({}),
} as unknown as AgentService;

describe("HTTP boundary", () => {
  it("exposes validated Team Task creation and detail routes", async () => {
    const task = { id: "00000000-0000-4000-8000-000000000001", objective: "Ship a feature" };
    const teamTasks = {
      createTask: async () => task,
      listTasks: () => [task],
      getTask: () => task,
      getEvents: () => [],
    } as unknown as TeamTaskService;
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), service, teamTasks);
    const invalid = await app.inject({ method: "POST", url: "/api/team-tasks", payload: { objective: "Ship", leadAgentId: "bad", specialistAgentIds: [] } });
    expect(invalid.statusCode).toBe(400);
    const created = await app.inject({
      method: "POST",
      url: "/api/team-tasks",
      payload: {
        objective: "Ship a feature",
        leadAgentId: "00000000-0000-4000-8000-000000000002",
        specialistAgentIds: ["00000000-0000-4000-8000-000000000003"],
      },
    });
    expect(created.statusCode).toBe(202);
    const detail = await app.inject({ method: "GET", url: "/api/team-tasks/" + task.id });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({ task: { objective: "Ship a feature" }, events: [] });
    await app.close();
  });

  it("protects API routes with the configured shared token", async () => {
    const app = await createApp(
      loadConfig({ NODE_ENV: "test", APP_AUTH_TOKEN: "a-strong-test-token" }),
      service,
    );
    const denied = await app.inject({ method: "GET", url: "/api/agents" });
    expect(denied.statusCode).toBe(401);

    const allowed = await app.inject({
      method: "GET",
      url: "/api/agents",
      headers: { authorization: "Bearer a-strong-test-token" },
    });
    expect(allowed.statusCode).toBe(200);
    await app.close();
  });

  it("preserves Fastify client error status codes", async () => {
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), service);
    const malformed = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { "content-type": "application/json" },
      payload: "{not-json",
    });
    expect(malformed.statusCode).toBe(400);

    const oversized = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ name: "x".repeat(1_100_000) }),
    });
    expect(oversized.statusCode).toBe(413);
    await app.close();
  });
});

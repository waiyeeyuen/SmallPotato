import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { HttpError } from "./errors.js";
import type { AgentService } from "./agent-service.js";
import type { TeamTaskService } from "./team-task-service.js";
import type { SecurityService } from "./security-service.js";

const service = {
  listAgents: () => [],
  systemInfo: async () => ({}),
} as unknown as AgentService;
const security = {
  resolveSession: async () => ({
    userId: "user-alice",
    username: "alice",
    displayName: "Alice Tan",
  }),
} as unknown as SecurityService;

describe("HTTP boundary", () => {
  it("exposes validated Team Task creation and detail routes", async () => {
    const task = { id: "00000000-0000-4000-8000-000000000001", objective: "Ship a feature" };
    const createArgs: unknown[] = [];
    const createActors: unknown[] = [];
    const readActors: unknown[] = [];
    const teamTasks = {
      createTask: async (actor: unknown, input: unknown) => {
        createActors.push(actor);
        createArgs.push(input);
        return task;
      },
      listTasks: (actor: unknown) => { readActors.push(actor); return [task]; },
      assertTaskOwner: (actor: unknown) => { readActors.push(actor); return task; },
      getTask: (actor: unknown) => { readActors.push(actor); return task; },
      getEvents: (actor: unknown) => { readActors.push(actor); return []; },
      verifyEventChain: (actor: unknown) => { readActors.push(actor); return true; },
    } as unknown as TeamTaskService;
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), service, security, teamTasks);
    const invalid = await app.inject({ method: "POST", url: "/api/team-tasks", payload: { objective: "Ship", leadAgentId: "bad", specialistAgentIds: [] } });
    expect(invalid.statusCode).toBe(400);
    const extraField = await app.inject({
      method: "POST",
      url: "/api/team-tasks",
      payload: {
        objective: "Ship a feature",
        leadAgentId: "00000000-0000-4000-8000-000000000002",
        specialistAgentIds: ["00000000-0000-4000-8000-000000000003"],
        currentAgentId: "00000000-0000-4000-8000-000000000004",
      },
    });
    expect(extraField.statusCode).toBe(400);
    const badSelection = await app.inject({
      method: "POST",
      url: "/api/team-tasks",
      payload: {
        objective: "Ship a feature",
        leadAgentId: "00000000-0000-4000-8000-000000000002",
        specialistAgentIds: ["00000000-0000-4000-8000-000000000003"],
        agentSelection: "round-robin",
      },
    });
    expect(badSelection.statusCode).toBe(400);
    const noSpecialists = await app.inject({
      method: "POST",
      url: "/api/team-tasks",
      payload: {
        objective: "Ship a feature",
        leadAgentId: "00000000-0000-4000-8000-000000000002",
        specialistAgentIds: [],
      },
    });
    expect(noSpecialists.statusCode).toBe(400);
    const created = await app.inject({
      method: "POST",
      url: "/api/team-tasks",
      payload: {
        objective: "Ship a feature",
        leadAgentId: "00000000-0000-4000-8000-000000000002",
        agentSelection: "lead",
      },
    });
    expect(created.statusCode).toBe(202);
    expect(createArgs.at(-1)).toMatchObject({ agentSelection: "lead", specialistAgentIds: [] });
    // Ownership of a Team Task comes from the server session, never the payload.
    expect(createActors.at(-1)).toMatchObject({ userId: expect.any(String) });
    const detail = await app.inject({ method: "GET", url: "/api/team-tasks/" + task.id });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      task: { objective: "Ship a feature" },
      events: [],
      eventsVerified: true,
    });
    expect(readActors).toHaveLength(3);
    expect(readActors).toEqual(expect.arrayContaining([
      expect.objectContaining({ userId: "user-alice" }),
    ]));
    await app.close();
  });

  it("requires a valid human session for Team Task data and controls", async () => {
    const unauthorizedSecurity = {
      resolveSession: async () => { throw new HttpError(401, "Sign in required"); },
    } as unknown as SecurityService;
    const teamTasks = {
      listTasks: () => { throw new Error("must not be reached"); },
      getTask: () => { throw new Error("must not be reached"); },
      getEvents: () => { throw new Error("must not be reached"); },
      verifyEventChain: () => { throw new Error("must not be reached"); },
      stopTask: () => { throw new Error("must not be reached"); },
      resumeTask: () => { throw new Error("must not be reached"); },
    } as unknown as TeamTaskService;
    const app = await createApp(
      loadConfig({ NODE_ENV: "test" }),
      service,
      unauthorizedSecurity,
      teamTasks,
    );
    const taskId = "00000000-0000-4000-8000-000000000001";

    for (const request of [
      { method: "GET" as const, url: "/api/team-tasks" },
      { method: "GET" as const, url: `/api/team-tasks/${taskId}` },
      { method: "POST" as const, url: `/api/team-tasks/${taskId}/stop` },
      { method: "POST" as const, url: `/api/team-tasks/${taskId}/resume` },
    ]) {
      const response = await app.inject(request);
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ error: "Sign in required" });
    }
    await app.close();
  });

  it("protects API routes with the configured shared token", async () => {
    const app = await createApp(
      loadConfig({ NODE_ENV: "test", APP_AUTH_TOKEN: "a-strong-test-token" }),
      service,
      security,
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
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), service, security);
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

  it("returns structured policy denial details", async () => {
    const denyingService = {
      listAgents: () => {
        throw new HttpError(403, "Resource access denied", {
          code: "RESOURCE_ACCESS_DENIED",
          decisionId: "decision-1",
          reason: "GRANT_REVOKED",
        });
      },
    } as unknown as AgentService;
    const app = await createApp(
      loadConfig({ NODE_ENV: "test" }),
      denyingService,
      security,
    );

    const response = await app.inject({ method: "GET", url: "/api/agents" });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      error: "Resource access denied",
      code: "RESOURCE_ACCESS_DENIED",
      decisionId: "decision-1",
      reason: "GRANT_REVOKED",
    });
    await app.close();
  });

  it("rejects browser-supplied ownership fields instead of trusting user IDs", async () => {
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), service, security);
    const response = await app.inject({
      method: "POST",
      url: "/api/agents",
      payload: {
        name: "Forged Agent",
        ownerUserId: "user-bob",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      details: [expect.objectContaining({
        code: "unrecognized_keys",
        keys: ["ownerUserId"],
      })],
    });
    await app.close();
  });

  it("routes cross-user share creation and the account receipt feed", async () => {
    const shareArgs: unknown[] = [];
    const sharingSecurity = {
      resolveSession: async () => ({
        userId: "user-bob",
        username: "bob",
        displayName: "Bob Lim",
      }),
      createShare: async (...args: unknown[]) => {
        shareArgs.push(args);
        return { id: "share-1", state: "active", granteeName: "Alice Tan" };
      },
      listAccountReceipts: () => [{ id: "decision-1", action: "share", outcome: "allow" }],
      verifyDecisionChain: () => true,
    } as unknown as SecurityService;
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), service, sharingSecurity);

    const bad = await app.inject({
      method: "POST",
      url: "/api/resources/resource-bob-finance-report/shares",
      payload: { purpose: "no" },
    });
    expect(bad.statusCode).toBe(400);

    const created = await app.inject({
      method: "POST",
      url: "/api/resources/resource-bob-finance-report/shares",
      payload: { granteeUserId: "user-alice", purpose: "Cross-team review" },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ share: { id: "share-1", state: "active" } });
    expect(shareArgs.at(-1)).toMatchObject({
      1: "resource-bob-finance-report",
      2: "user-alice",
    });

    const feed = await app.inject({ method: "GET", url: "/api/account/receipts" });
    expect(feed.statusCode).toBe(200);
    expect(feed.json()).toMatchObject({
      decisions: [{ action: "share" }],
      chainValid: true,
    });
    await app.close();
  });

  it("sets defensive browser headers and prevents API caching", async () => {
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), service, security);
    const response = await app.inject({ method: "GET", url: "/api/health" });

    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["x-frame-options"]).toBe("DENY");
    expect(response.headers["cache-control"]).toBe("no-store");
    await app.close();
  });
});

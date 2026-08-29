import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { HttpError } from "./errors.js";
import type { AgentService } from "./agent-service.js";
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

  it("sets defensive browser headers and prevents API caching", async () => {
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), service, security);
    const response = await app.inject({ method: "GET", url: "/api/health" });

    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["x-frame-options"]).toBe("DENY");
    expect(response.headers["cache-control"]).toBe("no-store");
    await app.close();
  });
});

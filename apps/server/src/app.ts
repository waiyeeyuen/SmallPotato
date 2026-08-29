import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import type { AgentService } from "./agent-service.js";
import type { AppConfig } from "./config.js";
import { HttpError } from "./errors.js";

import { evaluatePolicy } from "./agent-guard/policy-engine.js";
import { executeResourceAction } from "./agent-guard/resource-service.js";
import { resolveAgentToken } from "./agent-guard/agent-auth.js";
import type { AgentPolicy } from "./agent-guard/types.js";

/**
 * Existing Launchpad schemas
 */
const agentIdParams = z.object({
  id: z.string().uuid(),
});

const runIdParams = z.object({
  id: z.string().uuid(),
});

const createAgentBody = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(500).optional(),
  instructions: z.string().max(10_000).optional(),
});

const updateAgentBody = createAgentBody.partial().refine(
  (value) => Object.keys(value).length > 0,
  "At least one field is required",
);

const messageBody = z.object({
  content: z.string().trim().min(1).max(50_000),
});

/**
 * AgentGuard request schema
 */
const guardActionBody = z.object({
  resource: z.string().min(1),
  action: z.enum(["read", "write", "deploy"]),
});

/**
 * Temporary demo policies.
 *
 * Later we will replace these with policies attached
 * to real Agent IDs.
 */
const demoPolicies: AgentPolicy[] = [
  {
    agentId: "agent-a",
    resource: "project-alpha",
    allowedActions: ["read", "write"],
  },
  {
    agentId: "agent-a",
    resource: "project-alpha-production",
    allowedActions: ["deploy"],
  },
];

export async function createApp(
  config: AppConfig,
  service: AgentService,
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: [
        "req.headers.authorization",
        "req.headers.cookie",
      ],
    },
    bodyLimit: 1_048_576,
  });

  /**
   * CORS
   */
  await app.register(cors, {
    origin:
      config.nodeEnv === "development"
        ? [
            "http://localhost:5173",
            "http://127.0.0.1:5173",
          ]
        : false,
  });

  /**
   * Existing Launchpad authentication
   */
  app.addHook("onRequest", async (request, reply) => {
    if (
      !config.authToken ||
      !request.url.startsWith("/api/") ||
      request.url === "/api/health" ||
      request.url === "/api/auth"
    ) {
      return;
    }

    const header = request.headers.authorization ?? "";

    const candidate = header.startsWith("Bearer ")
      ? header.slice(7)
      : "";

    const expectedBuffer = Buffer.from(config.authToken);
    const candidateBuffer = Buffer.from(candidate);

    const valid =
      candidateBuffer.length === expectedBuffer.length &&
      timingSafeEqual(candidateBuffer, expectedBuffer);

    if (!valid) {
      return reply.code(401).send({
        error: "Authentication required",
      });
    }
  });

  /**
   * System routes
   */
  app.get("/api/health", async () => ({
    ok: true,
    service: "volc-agent-launchpad",
  }));

  app.get("/api/auth", async () => ({
    required: config.authToken.length > 0,
  }));

  app.get("/api/system", async () =>
    service.systemInfo(),
  );

  /**
   * ==========================================
   * AGENTGUARD
   * ==========================================
   *
   * Request
   *   ↓
   * Policy Engine
   *   ↓
   * ALLOW / DENY / REQUIRE_APPROVAL
   *   ↓
   * Protected Resource
   */
  app.post("/api/guard/action", async (request, reply) => {
  const body = guardActionBody.parse(request.body);

  /**
   * Agent identity comes from its credential,
   * NOT from the request body.
   */
  const tokenHeader = request.headers["x-agent-token"];

  const token =
    typeof tokenHeader === "string"
      ? tokenHeader
      : undefined;

  const agentId = resolveAgentToken(token);

  /**
   * No valid AgentGuard identity.
   */
  if (!agentId) {
    return reply.code(401).send({
      decision: "DENY",
      reason: "Invalid or missing AgentGuard token",
    });
  }

  /**
   * Now authorization uses the identity
   * resolved by AgentGuard.
   */
  const result = evaluatePolicy(
    demoPolicies,
    agentId,
    body.resource,
    body.action,
  );

  if (result.decision === "deny") {
    return reply.code(403).send({
      decision: "DENY",
      reason: result.reason,
    });
  }

  if (result.decision === "require_approval") {
    return reply.code(409).send({
      decision: "REQUIRE_APPROVAL",
      reason: result.reason,
    });
  }

  const output = executeResourceAction(
    body.resource,
    body.action,
  );

  return reply.code(200).send({
    decision: "ALLOW",
    agentId,
    reason: result.reason,
    output,
  });
});

  /**
   * ==========================================
   * EXISTING AGENT ROUTES
   * ==========================================
   */

  app.get("/api/agents", async () => ({
    agents: service.listAgents(),
  }));

  app.post("/api/agents", async (request, reply) => {
    const body = createAgentBody.parse(request.body);

    const agent = await service.createAgent(body);

    return reply.code(201).send({
      agent,
    });
  });

  app.get("/api/agents/:id", async (request) => {
    const { id } = agentIdParams.parse(request.params);

    return {
      agent: service.getAgent(id),
    };
  });

  app.patch("/api/agents/:id", async (request) => {
    const { id } = agentIdParams.parse(request.params);

    const body = updateAgentBody.parse(request.body);

    return {
      agent: await service.updateAgent(id, body),
    };
  });

  app.delete("/api/agents/:id", async (request) => {
    const { id } = agentIdParams.parse(request.params);

    return service.deleteAgent(id);
  });

  app.post(
    "/api/agents/:id/start",
    async (request) => {
      const { id } = agentIdParams.parse(
        request.params,
      );

      return {
        agent: await service.startAgent(id),
      };
    },
  );

  app.post(
    "/api/agents/:id/stop",
    async (request) => {
      const { id } = agentIdParams.parse(
        request.params,
      );

      return {
        agent: await service.stopAgent(id),
      };
    },
  );

  app.get(
    "/api/agents/:id/messages",
    async (request) => {
      const { id } = agentIdParams.parse(
        request.params,
      );

      return {
        messages: service.getMessages(id),
      };
    },
  );

  app.get(
    "/api/agents/:id/runs",
    async (request) => {
      const { id } = agentIdParams.parse(
        request.params,
      );

      return {
        runs: service.getRuns(id),
      };
    },
  );

  app.post(
    "/api/agents/:id/messages",
    async (request, reply) => {
      const { id } = agentIdParams.parse(
        request.params,
      );

      const body = messageBody.parse(request.body);

      const result = await service.sendMessage(
        id,
        body.content,
      );

      return reply.code(202).send(result);
    },
  );

  app.get("/api/runs/:id", async (request) => {
    const { id } = runIdParams.parse(
      request.params,
    );

    return {
      run: service.getRun(id),
    };
  });

  /**
   * Production frontend
   */
  if (config.nodeEnv === "production") {
    const webRoot = fileURLToPath(
      new URL("../../web/dist", import.meta.url),
    );

    await app.register(fastifyStatic, {
      root: webRoot,
      prefix: "/",
    });

    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/")) {
        return reply.code(404).send({
          error: "API route not found",
        });
      }

      return reply.sendFile("index.html");
    });
  }

  /**
   * Error handling
   */
  app.setErrorHandler((error, request, reply) => {
    const appError =
      error instanceof Error
        ? error
        : new Error(String(error));

    const validationError =
      error instanceof z.ZodError;

    const frameworkStatus =
      typeof (error as { statusCode?: unknown })
        .statusCode === "number"
        ? (error as { statusCode: number })
            .statusCode
        : null;

    const statusCode =
      error instanceof HttpError
        ? error.statusCode
        : validationError
          ? 400
          : frameworkStatus &&
              frameworkStatus >= 400 &&
              frameworkStatus <= 599
            ? frameworkStatus
            : 500;

    if (statusCode >= 500) {
      request.log.error(appError);
    }

    return reply.code(statusCode).send({
      error: appError.message,
      ...(validationError
        ? {
            details: error.issues,
          }
        : {}),
    });
  });

  return app;
}

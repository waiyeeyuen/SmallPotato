import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import { HttpError } from "./errors.js";
import type { AgentService } from "./agent-service.js";
import type { SecurityService } from "./security-service.js";
import type { TeamTaskService } from "./team-task-service.js";

const agentIdParams = z.object({ id: z.string().uuid() });
const runIdParams = z.object({ id: z.string().uuid() });
const grantParams = z.object({ id: z.string().uuid(), grantId: z.string().uuid() });
const createAgentBody = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(500).optional(),
  instructions: z.string().max(10_000).optional(),
}).strict();
const updateAgentBody = createAgentBody.partial().refine(
  (value) => Object.keys(value).length > 0,
  "At least one field is required",
);
const messageBody = z.object({
  content: z.string().trim().min(1).max(50_000),
  resourceId: z.string().trim().min(1).max(120).optional(),
}).strict();
const teamTaskIdParams = z.object({ id: z.string().uuid() });
const createTeamTaskBody = z.object({
  objective: z.string().trim().min(1).max(20_000),
  leadAgentId: z.string().uuid(),
  specialistAgentIds: z.array(z.string().uuid()).max(20).default([]),
  agentSelection: z.enum(["user", "lead"]).optional(),
  resourceId: z.string().trim().min(1).max(120).optional(),
  resourceAccessMode: z.enum(["manual", "task"]).optional(),
}).strict().refine(
  (value) => value.agentSelection === "lead" || value.specialistAgentIds.length >= 1,
  { message: "Select at least one specialist", path: ["specialistAgentIds"] },
);
const loginBody = z.object({
  username: z.string().trim().min(1).max(80),
  password: z.string().min(1).max(200),
}).strict();
const grantBody = z.object({
  resourceId: z.string().trim().min(1).max(120),
  purpose: z.string().trim().min(3).max(240),
  ttlSeconds: z.number().int().min(30).max(3600),
}).strict();
const resourceParams = z.object({ id: z.string().trim().min(1).max(120) });
const shareParams = z.object({
  id: z.string().trim().min(1).max(120),
  shareId: z.string().uuid(),
});
const createShareBody = z.object({
  granteeUserId: z.string().trim().min(1).max(120),
  purpose: z.string().trim().min(3).max(240),
  expiresAt: z.string().datetime().optional(),
}).strict();
const createResourceBody = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).default(""),
  content: z.string().min(1).max(100_000),
}).strict();
const updateResourceBody = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  description: z.string().trim().max(500).optional(),
  content: z.string().min(1).max(100_000).optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "At least one field is required");

const SESSION_COOKIE = "sp_session";

function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return undefined;
}

function sessionCookie(token: string, maxAge: number, secure: boolean): string {
  return [
    SESSION_COOKIE + "=" + encodeURIComponent(token),
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    "Max-Age=" + maxAge,
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

export async function createApp(
  config: AppConfig,
  service: AgentService,
  security: SecurityService,
  teamTasks?: TeamTaskService,
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: ["req.headers.authorization", "req.headers.cookie"],
    },
    bodyLimit: 1_048_576,
  });

  app.setErrorHandler((error, request, reply) => {
    const appError = error instanceof Error ? error : new Error(String(error));
    const validationError = error instanceof z.ZodError;
    const frameworkStatus =
      typeof (error as { statusCode?: unknown }).statusCode === "number"
        ? (error as { statusCode: number }).statusCode
        : null;
    const statusCode =
      error instanceof HttpError
        ? error.statusCode
        : validationError
          ? 400
          : frameworkStatus && frameworkStatus >= 400 && frameworkStatus <= 599
            ? frameworkStatus
            : 500;
    if (statusCode >= 500) {
      request.log.error(appError);
    }
    return reply.code(statusCode).send({
      error: appError.message,
      ...(error instanceof HttpError && error.details ? error.details : {}),
      ...(validationError ? { details: error.issues } : {}),
    });
  });

  app.addHook("onSend", async (request, reply, payload) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    if (request.url.startsWith("/api/")) reply.header("Cache-Control", "no-store");
    if (config.nodeEnv === "production") {
      reply.header(
        "Content-Security-Policy",
        "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      );
    }
    return payload;
  });

  await app.register(cors, {
    origin:
      config.nodeEnv === "development"
        ? ["http://localhost:5173", "http://127.0.0.1:5173"]
        : false,
    credentials: true,
  });

  app.addHook("onRequest", async (request, reply) => {
    if (
      !config.authToken ||
      !request.url.startsWith("/api/") ||
      request.url === "/api/health" ||
      request.url === "/api/auth" ||
      request.url === "/api/login"
    ) {
      return;
    }
    const header = request.headers.authorization ?? "";
    const candidate = header.startsWith("Bearer ") ? header.slice(7) : "";
    const expectedBuffer = Buffer.from(config.authToken);
    const candidateBuffer = Buffer.from(candidate);
    const valid =
      candidateBuffer.length === expectedBuffer.length &&
      timingSafeEqual(candidateBuffer, expectedBuffer);
    if (!valid && !readCookie(request.headers.cookie, SESSION_COOKIE)) {
      return reply.code(401).send({ error: "Authentication required" });
    }
  });

  app.get("/api/health", async () => ({
    ok: true,
    service: "volc-agent-launchpad",
  }));

  app.get("/api/auth", async () => ({ required: config.authToken.length > 0 }));

  const actorFor = (request: FastifyRequest) =>
    security.resolveSession(readCookie(request.headers.cookie, SESSION_COOKIE));

  app.post("/api/login", async (request, reply) => {
    const body = loginBody.parse(request.body);
    const result = await security.login(body.username, body.password);
    reply.header(
      "Set-Cookie",
      sessionCookie(result.token, 8 * 60 * 60, config.nodeEnv === "production"),
    );
    return { user: result.user, expiresAt: result.expiresAt };
  });

  app.get("/api/session", async (request) => ({ user: await actorFor(request) }));

  app.post("/api/logout", async (request, reply) => {
    const token = readCookie(request.headers.cookie, SESSION_COOKIE);
    if (token) await security.logout(token);
    reply.header("Set-Cookie", sessionCookie("", 0, config.nodeEnv === "production"));
    return { ok: true };
  });

  app.get("/api/system", async (request) => {
    await actorFor(request);
    return service.systemInfo();
  });

  app.get("/api/agents", async (request) => ({
    agents: service.listAgents(await actorFor(request)),
  }));

  app.post("/api/agents", async (request, reply) => {
    const body = createAgentBody.parse(request.body);
    const agent = await service.createAgent(await actorFor(request), body);
    return reply.code(201).send({ agent });
  });

  app.get("/api/agents/:id", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { agent: service.getAgent(await actorFor(request), id) };
  });

  app.patch("/api/agents/:id", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    const body = updateAgentBody.parse(request.body);
    return { agent: await service.updateAgent(await actorFor(request), id, body) };
  });

  app.delete("/api/agents/:id", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return service.deleteAgent(await actorFor(request), id);
  });

  app.post("/api/agents/:id/start", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { agent: await service.startAgent(await actorFor(request), id) };
  });

  app.post("/api/agents/:id/stop", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { agent: await service.stopAgent(await actorFor(request), id) };
  });

  app.get("/api/agents/:id/messages", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { messages: service.getMessages(await actorFor(request), id) };
  });

  app.get("/api/agents/:id/runs", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { runs: service.getRuns(await actorFor(request), id) };
  });

  app.post("/api/agents/:id/messages", async (request, reply) => {
    const { id } = agentIdParams.parse(request.params);
    const body = messageBody.parse(request.body);
    const result = await service.sendMessage(
      await actorFor(request),
      id,
      body.content,
      body.resourceId,
    );
    return reply.code(202).send(result);
  });

  app.get("/api/runs/:id", async (request) => {
    const { id } = runIdParams.parse(request.params);
    return { run: service.getRun(await actorFor(request), id) };
  });

  if (teamTasks) {
    app.get("/api/team-tasks", async (request) => ({
      tasks: teamTasks.listTasks(await actorFor(request)),
    }));

    app.post("/api/team-tasks", async (request, reply) => {
      const body = createTeamTaskBody.parse(request.body);
      const actor = await actorFor(request);
      return reply.code(202).send({ task: await teamTasks.createTask(actor, body) });
    });

    app.get("/api/team-tasks/:id", async (request) => {
      const { id } = teamTaskIdParams.parse(request.params);
      const actor = await actorFor(request);
      return {
        task: teamTasks.getTask(actor, id),
        events: teamTasks.getEvents(actor, id),
        eventsVerified: teamTasks.verifyEventChain(actor, id),
      };
    });

    app.post("/api/team-tasks/:id/stop", async (request) => {
      const { id } = teamTaskIdParams.parse(request.params);
      return { task: await teamTasks.stopTask(await actorFor(request), id) };
    });

    app.post("/api/team-tasks/:id/resume", async (request) => {
      const { id } = teamTaskIdParams.parse(request.params);
      return { task: await teamTasks.resumeTask(await actorFor(request), id) };
    });
  }

  app.get("/api/resources", async (request) => ({
    resources: security.listResources(await actorFor(request)),
  }));

  app.post("/api/resources", async (request, reply) => {
    const body = createResourceBody.parse(request.body);
    const resource = await security.createResource(await actorFor(request), body);
    return reply.code(201).send({ resource });
  });

  app.patch("/api/resources/:id", async (request) => {
    const { id } = resourceParams.parse(request.params);
    const body = updateResourceBody.parse(request.body);
    return { resource: await security.updateResource(await actorFor(request), id, body) };
  });

  app.delete("/api/resources/:id", async (request) => {
    const { id } = resourceParams.parse(request.params);
    return security.deleteResource(await actorFor(request), id);
  });

  app.get("/api/users/shareable", async (request) => ({
    users: security.listShareableUsers(await actorFor(request)),
  }));

  app.get("/api/account/shares", async (request) => ({
    shares: security.listSharesForOwner(await actorFor(request)),
  }));

  app.get("/api/resources/:id/shares", async (request) => {
    const { id } = resourceParams.parse(request.params);
    return { shares: security.listSharesForResource(await actorFor(request), id) };
  });

  app.post("/api/resources/:id/shares", async (request, reply) => {
    const { id } = resourceParams.parse(request.params);
    const body = createShareBody.parse(request.body);
    const share = await security.createShare(
      await actorFor(request),
      id,
      body.granteeUserId,
      body.purpose,
      body.expiresAt ?? null,
    );
    return reply.code(201).send({ share });
  });

  app.delete("/api/resources/:id/shares/:shareId", async (request) => {
    const { id, shareId } = shareParams.parse(request.params);
    return { share: await security.revokeShare(await actorFor(request), id, shareId) };
  });

  app.get("/api/account/receipts", async (request) => {
    const actor = await actorFor(request);
    return {
      decisions: security.listAccountReceipts(actor),
      chainValid: security.verifyDecisionChain(),
    };
  });

  app.get("/api/account/receipts.csv", async (request, reply) => {
    const actor = await actorFor(request);
    const decisions = security.listAccountReceipts(actor);
    const escape = (value: unknown) => '"' + String(value ?? "").replaceAll('"', '""') + '"';
    const rows = [
      ["decision_id", "human", "agent", "agent_principal", "action", "resource", "resource_owner", "outcome", "reason", "grant_id", "run_id", "receipt_hash", "created_at"],
      ...decisions.map((decision) => [
        decision.id,
        decision.humanName,
        decision.agentName,
        decision.agentPrincipalId,
        decision.action,
        decision.resourceName,
        decision.resourceOwnerUserId,
        decision.outcome,
        decision.reason,
        decision.grantId,
        decision.runId,
        decision.receiptHash,
        decision.createdAt,
      ]),
    ];
    reply.header("Content-Type", "text/csv; charset=utf-8");
    reply.header("Content-Disposition", 'attachment; filename="sharing-receipts.csv"');
    return rows.map((row) => row.map(escape).join(",")).join("\n") + "\n";
  });

  app.get("/api/agents/:id/permissions", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    const actor = await actorFor(request);
    return { grants: security.listGrants(actor, service.getAgent(actor, id)) };
  });

  app.post("/api/agents/:id/permissions", async (request, reply) => {
    const { id } = agentIdParams.parse(request.params);
    const body = grantBody.parse(request.body);
    const actor = await actorFor(request);
    const grant = await security.createGrant(
      actor,
      service.getAgent(actor, id),
      body.resourceId,
      body.purpose,
      body.ttlSeconds,
    );
    return reply.code(201).send({ grant });
  });

  app.delete("/api/agents/:id/permissions/:grantId", async (request) => {
    const { id, grantId } = grantParams.parse(request.params);
    const actor = await actorFor(request);
    return {
      grant: await security.revokeGrant(actor, service.getAgent(actor, id), grantId),
    };
  });

  app.get("/api/agents/:id/policy-decisions", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    const actor = await actorFor(request);
    return {
      decisions: security.listDecisions(actor, service.getAgent(actor, id)),
      chainValid: security.verifyDecisionChain(),
    };
  });

  app.get("/api/agents/:id/policy-decisions.csv", async (request, reply) => {
    const { id } = agentIdParams.parse(request.params);
    const actor = await actorFor(request);
    const decisions = security.listDecisions(actor, service.getAgent(actor, id));
    const escape = (value: unknown) => '"' + String(value ?? "").replaceAll('"', '""') + '"';
    const rows = [
      ["decision_id", "human", "agent", "agent_principal", "action", "resource", "outcome", "reason", "grant_id", "run_id", "team_task_id", "receipt_hash", "created_at"],
      ...decisions.map((decision) => [
        decision.id,
        decision.humanName,
        decision.agentName,
        decision.agentPrincipalId,
        decision.action,
        decision.resourceName,
        decision.outcome,
        decision.reason,
        decision.grantId,
        decision.runId,
        decision.teamTaskId,
        decision.receiptHash,
        decision.createdAt,
      ]),
    ];
    reply.header("Content-Type", "text/csv; charset=utf-8");
    reply.header("Content-Disposition", 'attachment; filename="access-receipts.csv"');
    return rows.map((row) => row.map(escape).join(",")).join("\n") + "\n";
  });

  if (config.nodeEnv === "production") {
    const webRoot = fileURLToPath(new URL("../../web/dist", import.meta.url));
    await app.register(fastifyStatic, {
      root: webRoot,
      prefix: "/",
    });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/")) {
        return reply.code(404).send({ error: "API route not found" });
      }
      return reply.sendFile("index.html");
    });
  }

  return app;
}

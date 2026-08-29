import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { HttpError } from "./errors.js";
import { receiptHash, verifyReceiptChain } from "./audit.js";
import { JsonStore } from "./store.js";
import type {
  Agent,
  PermissionGrant,
  PolicyDecision,
  PolicyReason,
  ProtectedResource,
  RequestActor,
  User,
} from "./types.js";

const scryptAsync = promisify(scrypt);
const SESSION_LIFETIME_MS = 8 * 60 * 60 * 1000;
const now = () => new Date().toISOString();

export const DEMO_CREDENTIALS = {
  alice: "alice-potato",
  bob: "bob-potato",
} as const;

function publicUser(user: User): RequestActor {
  return { userId: user.id, username: user.username, displayName: user.displayName };
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

async function hashPassword(password: string, salt: string): Promise<string> {
  const derived = (await scryptAsync(password, salt, 64)) as Buffer;
  return derived.toString("hex");
}

async function makeUser(
  id: string,
  username: keyof typeof DEMO_CREDENTIALS,
  displayName: string,
): Promise<User> {
  const salt = randomBytes(16).toString("hex");
  return {
    id,
    username,
    displayName,
    passwordSalt: salt,
    passwordHash: await hashPassword(DEMO_CREDENTIALS[username], salt),
    createdAt: now(),
  };
}

function grantState(grant: PermissionGrant): "active" | "revoked" | "expired" {
  if (grant.revokedAt) return "revoked";
  if (Date.parse(grant.expiresAt) <= Date.now()) return "expired";
  return "active";
}

export class SecurityService {
  private readonly resourceDirectory: string;

  constructor(
    private readonly store: JsonStore,
    dataDirectory: string,
  ) {
    this.resourceDirectory = path.join(dataDirectory, "protected-resources");
  }

  async initialize(): Promise<void> {
    await mkdir(this.resourceDirectory, { recursive: true });
    const alicePath = path.join(this.resourceDirectory, "alice-launch-plan.txt");
    const bobPath = path.join(this.resourceDirectory, "bob-finance-report.txt");
    const aliceContent = [
        "SMALL POTATO — LAUNCH PLAN",
        "Owner: Alice",
        "Priority: Demonstrate just-in-time access before Friday.",
        "Success metric: every protected action has an attributable access receipt.",
        "Launch note: permissions should expire automatically after the task window.",
      ].join("\n");
    const bobContent = [
        "SMALL POTATO — FINANCE REPORT",
        "Owner: Bob",
        "Forecast: fictional confidential planning data for the authorization demo.",
        "Control: Alice and Alice's Agents must never receive this document.",
      ].join("\n");
    await this.writeFixture(alicePath, aliceContent);
    await this.writeFixture(bobPath, bobContent);

    const snapshot = this.store.snapshot();
    const alice = snapshot.users.find((user) => user.id === "user-alice") ??
      (await makeUser("user-alice", "alice", "Alice Tan"));
    const bob = snapshot.users.find((user) => user.id === "user-bob") ??
      (await makeUser("user-bob", "bob", "Bob Lim"));

    await this.store.mutate((database) => {
      if (!database.users.some((user) => user.id === alice.id)) database.users.push(alice);
      if (!database.users.some((user) => user.id === bob.id)) database.users.push(bob);
      for (const agent of database.agents) {
        agent.ownerUserId ||= alice.id;
        agent.principalId ||= randomUUID();
      }
      const resources: ProtectedResource[] = [
        {
          id: "resource-alice-launch-plan",
          ownerUserId: alice.id,
          name: "Launch Plan",
          description: "Alice's protected launch checklist and success metrics.",
          filePath: alicePath,
          sizeBytes: Buffer.byteLength(aliceContent + "\n"),
          isDemo: true,
          deletedAt: null,
          createdAt: now(),
          updatedAt: now(),
        },
        {
          id: "resource-bob-finance-report",
          ownerUserId: bob.id,
          name: "Finance Report",
          description: "Bob's protected fictional finance planning document.",
          filePath: bobPath,
          sizeBytes: Buffer.byteLength(bobContent + "\n"),
          isDemo: true,
          deletedAt: null,
          createdAt: now(),
          updatedAt: now(),
        },
      ];
      for (const resource of resources) {
        if (!database.resources.some((item) => item.id === resource.id)) {
          database.resources.push(resource);
        }
      }
      database.sessions = database.sessions.filter(
        (session) => Date.parse(session.expiresAt) > Date.now(),
      );
    });
  }

  async login(username: string, password: string): Promise<{
    user: RequestActor;
    token: string;
    expiresAt: string;
  }> {
    const normalized = username.trim().toLowerCase();
    const user = this.store.snapshot().users.find((item) => item.username === normalized);
    if (!user) throw new HttpError(401, "Invalid username or password");
    const candidate = Buffer.from(await hashPassword(password, user.passwordSalt), "hex");
    const expected = Buffer.from(user.passwordHash, "hex");
    if (candidate.length !== expected.length || !timingSafeEqual(candidate, expected)) {
      throw new HttpError(401, "Invalid username or password");
    }
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + SESSION_LIFETIME_MS).toISOString();
    await this.store.mutate((database) => {
      database.sessions = database.sessions.filter(
        (session) => Date.parse(session.expiresAt) > Date.now(),
      );
      database.sessions.push({
        tokenHash: tokenHash(token),
        userId: user.id,
        createdAt: now(),
        expiresAt,
      });
    });
    return { user: publicUser(user), token, expiresAt };
  }

  async logout(token: string): Promise<void> {
    const hash = tokenHash(token);
    await this.store.mutate((database) => {
      database.sessions = database.sessions.filter((session) => session.tokenHash !== hash);
    });
  }

  async resolveSession(token: string | undefined): Promise<RequestActor> {
    if (!token) throw new HttpError(401, "Sign in required");
    const hash = tokenHash(token);
    const snapshot = this.store.snapshot();
    const session = snapshot.sessions.find((item) => item.tokenHash === hash);
    if (!session || Date.parse(session.expiresAt) <= Date.now()) {
      throw new HttpError(401, "Session expired or invalid");
    }
    const user = snapshot.users.find((item) => item.id === session.userId);
    if (!user) throw new HttpError(401, "Session user not found");
    return publicUser(user);
  }

  requireAgentOwner(actor: RequestActor, agent: Agent): void {
    if (agent.ownerUserId !== actor.userId) throw new HttpError(404, "Agent not found");
  }

  listResources(actor: RequestActor) {
    const snapshot = this.store.snapshot();
    return snapshot.resources.filter((resource) => !resource.deletedAt).map((resource) => ({
      id: resource.id,
      name: resource.name,
      description: resource.description,
      ownerUserId: resource.ownerUserId,
      ownerName:
        snapshot.users.find((user) => user.id === resource.ownerUserId)?.displayName ??
        "Unknown owner",
      ownedByCurrentUser: resource.ownerUserId === actor.userId,
      sizeBytes: resource.sizeBytes,
      isDemo: resource.isDemo,
      createdAt: resource.createdAt,
      updatedAt: resource.updatedAt,
    }));
  }

  async createResource(
    actor: RequestActor,
    input: { name: string; description: string; content: string },
  ) {
    const id = randomUUID();
    const timestamp = now();
    const normalizedContent = input.content.replace(/\r\n/g, "\n").trimEnd() + "\n";
    const filePath = path.join(this.resourceDirectory, id + ".txt");
    const resource: ProtectedResource = {
      id,
      ownerUserId: actor.userId,
      name: input.name.trim(),
      description: input.description.trim(),
      filePath,
      sizeBytes: Buffer.byteLength(normalizedContent),
      isDemo: false,
      deletedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.writeResourceFile(filePath, normalizedContent);
    try {
      await this.store.mutate((database) => database.resources.push(resource));
    } catch (error) {
      await unlink(filePath).catch(() => undefined);
      throw error;
    }
    return this.listResources(actor).find((item) => item.id === id)!;
  }

  async updateResource(
    actor: RequestActor,
    resourceId: string,
    input: {
      name?: string | undefined;
      description?: string | undefined;
      content?: string | undefined;
    },
  ) {
    const resource = this.store.snapshot().resources.find((item) => item.id === resourceId);
    if (!resource || resource.deletedAt || resource.ownerUserId !== actor.userId) {
      throw new HttpError(404, "Protected resource not found");
    }
    let normalizedContent: string | undefined;
    if (input.content !== undefined) {
      normalizedContent = input.content.replace(/\r\n/g, "\n").trimEnd() + "\n";
      await this.writeResourceFile(resource.filePath, normalizedContent);
    }
    await this.store.mutate((database) => {
      const stored = database.resources.find((item) => item.id === resourceId);
      if (!stored || stored.deletedAt || stored.ownerUserId !== actor.userId) {
        throw new HttpError(404, "Protected resource not found");
      }
      if (input.name !== undefined) stored.name = input.name.trim();
      if (input.description !== undefined) stored.description = input.description.trim();
      if (normalizedContent !== undefined) stored.sizeBytes = Buffer.byteLength(normalizedContent);
      stored.updatedAt = now();
    });
    return this.listResources(actor).find((item) => item.id === resourceId)!;
  }

  async deleteResource(actor: RequestActor, resourceId: string) {
    const filePath = await this.store.mutate((database) => {
      const resource = database.resources.find((item) => item.id === resourceId);
      if (!resource || resource.deletedAt || resource.ownerUserId !== actor.userId) {
        throw new HttpError(404, "Protected resource not found");
      }
      const timestamp = now();
      resource.deletedAt = timestamp;
      resource.updatedAt = timestamp;
      for (const grant of database.grants) {
        if (grant.resourceId === resourceId && !grant.revokedAt) grant.revokedAt = timestamp;
      }
      return resource.filePath;
    });
    await unlink(filePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    return { ok: true as const };
  }

  listGrants(actor: RequestActor, agent: Agent) {
    this.requireAgentOwner(actor, agent);
    const snapshot = this.store.snapshot();
    return snapshot.grants
      .filter((grant) => grant.agentPrincipalId === agent.principalId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((grant) => ({
        ...grant,
        resourceName:
          snapshot.resources.find((resource) => resource.id === grant.resourceId)?.name ??
          "Unknown resource",
        state: grantState(grant),
      }));
  }

  async createGrant(
    actor: RequestActor,
    agent: Agent,
    resourceId: string,
    purpose: string,
    ttlSeconds: number,
  ) {
    this.requireAgentOwner(actor, agent);
    const resource = this.store.snapshot().resources.find((item) => item.id === resourceId);
    if (!resource || resource.deletedAt || resource.ownerUserId !== actor.userId) {
      throw new HttpError(403, "You can grant only resources you own");
    }
    const timestamp = now();
    const grant: PermissionGrant = {
      id: randomUUID(),
      agentPrincipalId: agent.principalId,
      resourceId,
      actions: ["read"],
      purpose: purpose.trim(),
      grantedByUserId: actor.userId,
      createdAt: timestamp,
      expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
      revokedAt: null,
    };
    await this.store.mutate((database) => database.grants.push(grant));
    return { ...grant, resourceName: resource.name, state: "active" as const };
  }

  async revokeGrant(actor: RequestActor, agent: Agent, grantId: string) {
    this.requireAgentOwner(actor, agent);
    return this.store.mutate((database) => {
      const grant = database.grants.find(
        (item) => item.id === grantId && item.agentPrincipalId === agent.principalId,
      );
      if (!grant) throw new HttpError(404, "Permission grant not found");
      grant.revokedAt ??= now();
      return structuredClone(grant);
    });
  }

  async authorizeResourceRead(
    actor: RequestActor,
    agent: Agent,
    resourceId: string,
  ): Promise<{ decision: PolicyDecision; resource: ProtectedResource | null }> {
    return this.store.mutate((database) => {
      const resource = database.resources.find(
        (item) => item.id === resourceId && !item.deletedAt,
      ) ?? null;
      const matching = database.grants
        .filter(
          (grant) =>
            grant.agentPrincipalId === agent.principalId &&
            grant.resourceId === resourceId &&
            grant.actions.includes("read"),
        )
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
      const active = matching.find((grant) => grantState(grant) === "active") ?? null;
      let reason: PolicyReason = "GRANT_MISSING";
      if (agent.ownerUserId !== actor.userId) reason = "AGENT_NOT_OWNED";
      else if (!resource) reason = "RESOURCE_NOT_FOUND";
      else if (resource.ownerUserId !== actor.userId) reason = "RESOURCE_NOT_OWNED";
      else if (active) reason = "GRANT_ACTIVE";
      else if (matching.some((grant) => grantState(grant) === "revoked")) reason = "GRANT_REVOKED";
      else if (matching.some((grant) => grantState(grant) === "expired")) reason = "GRANT_EXPIRED";

      const previousReceiptHash = database.decisions.at(-1)?.receiptHash ?? null;
      const payload = {
        id: randomUUID(),
        humanUserId: actor.userId,
        humanName: actor.displayName,
        agentId: agent.id,
        agentName: agent.name,
        agentPrincipalId: agent.principalId,
        action: "read" as const,
        resourceId,
        resourceName: resource?.name ?? "Unknown resource",
        outcome: reason === "GRANT_ACTIVE" ? "allow" as const : "deny" as const,
        reason,
        grantId: active?.id ?? matching[0]?.id ?? null,
        createdAt: now(),
      };
      const decision: PolicyDecision = {
        ...payload,
        runId: null,
        previousReceiptHash,
        receiptHash: receiptHash(payload, previousReceiptHash),
      };
      database.decisions.push(decision);
      return {
        decision: structuredClone(decision),
        resource: decision.outcome === "allow" && resource ? structuredClone(resource) : null,
      };
    });
  }

  async attachRun(decisionId: string, runId: string): Promise<void> {
    await this.store.mutate((database) => {
      const decision = database.decisions.find((item) => item.id === decisionId);
      if (decision) decision.runId = runId;
    });
  }

  listDecisions(actor: RequestActor, agent: Agent) {
    this.requireAgentOwner(actor, agent);
    const snapshot = this.store.snapshot();
    return snapshot.decisions
      .filter((decision) => decision.agentId === agent.id)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((decision) => ({ ...decision }));
  }

  verifyDecisionChain(): boolean {
    return verifyReceiptChain(this.store.snapshot().decisions);
  }

  private async writeFixture(filePath: string, content: string): Promise<void> {
    try {
      await writeFile(filePath, content + "\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }

  private async writeResourceFile(filePath: string, content: string): Promise<void> {
    const temporaryPath = filePath + "." + randomUUID() + ".tmp";
    await writeFile(temporaryPath, content, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, filePath);
  }
}

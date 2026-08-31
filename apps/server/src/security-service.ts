import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { HttpError } from "./errors.js";
import { receiptHash, verifyReceiptChain } from "./audit.js";
import { JsonStore } from "./store.js";
import type {
  Agent,
  Database,
  PermissionGrant,
  PolicyAction,
  PolicyDecision,
  PolicyReason,
  ProtectedResource,
  RequestActor,
  ResourceShare,
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

function shareState(share: ResourceShare): "active" | "revoked" | "expired" {
  if (share.revokedAt) return "revoked";
  if (share.expiresAt && Date.parse(share.expiresAt) <= Date.now()) return "expired";
  return "active";
}

const MAX_SHARE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

interface DecisionFields {
  actor: RequestActor;
  agent: Agent | null;
  action: PolicyAction;
  resourceId: string;
  resourceName: string;
  resourceOwnerUserId: string;
  outcome: "allow" | "deny";
  reason: PolicyReason;
  grantId: string | null;
  teamTaskId?: string | null;
}

/**
 * Append one hash-chained authorization/management receipt to `database.decisions`
 * and return a clone. The single place a PolicyDecision is minted, shared by the
 * per-read enforcement path and the share create/revoke management actions.
 */
function appendDecision(database: Database, fields: DecisionFields): PolicyDecision {
  const previousReceiptHash = database.decisions.at(-1)?.receiptHash ?? null;
  const payload = {
    id: randomUUID(),
    humanUserId: fields.actor.userId,
    humanName: fields.actor.displayName,
    agentId: fields.agent?.id ?? null,
    agentName: fields.agent?.name ?? null,
    agentPrincipalId: fields.agent?.principalId ?? null,
    action: fields.action,
    resourceId: fields.resourceId,
    resourceName: fields.resourceName,
    resourceOwnerUserId: fields.resourceOwnerUserId,
    outcome: fields.outcome,
    reason: fields.reason,
    grantId: fields.grantId,
    teamTaskId: fields.teamTaskId ?? null,
    createdAt: now(),
  };
  const decision: PolicyDecision = {
    ...payload,
    runId: null,
    previousReceiptHash,
    receiptHash: receiptHash(payload, previousReceiptHash),
  };
  database.decisions.push(decision);
  return structuredClone(decision);
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
    const bobBriefPath = path.join(this.resourceDirectory, "bob-partnerships-brief.txt");
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
    const bobBriefContent = [
        "SMALL POTATO — PARTNERSHIPS BRIEF",
        "Owner: Bob",
        "Status: fictional partner shortlist for the cross-team review demo.",
        "Shared: Bob has granted Alice read access so her Agents can review it.",
        "Ask: summarise the three partner options and the recommended next step.",
      ].join("\n");
    await this.writeFixture(alicePath, aliceContent);
    await this.writeFixture(bobPath, bobContent);
    await this.writeFixture(bobBriefPath, bobBriefContent);

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
        {
          id: "resource-bob-partnerships-brief",
          ownerUserId: bob.id,
          name: "Partnerships Brief",
          description: "Bob's fictional partner shortlist, shared with Alice for review.",
          filePath: bobBriefPath,
          sizeBytes: Buffer.byteLength(bobBriefContent + "\n"),
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

      // Seed one cross-user share (Bob → Alice) so the "granted access" happy
      // path is live on startup. Finance Report is deliberately left un-shared
      // for the immediate-denial demo.
      const sharedResourceId = "resource-bob-partnerships-brief";
      const alreadyShared = database.shares.some(
        (share) =>
          share.resourceId === sharedResourceId &&
          share.granteeUserId === alice.id &&
          !share.revokedAt,
      );
      if (
        !alreadyShared &&
        database.resources.some((item) => item.id === sharedResourceId)
      ) {
        const share: ResourceShare = {
          id: randomUUID(),
          resourceId: sharedResourceId,
          ownerUserId: bob.id,
          granteeUserId: alice.id,
          actions: ["read"],
          purpose: "Cross-team launch review (seeded demo)",
          createdByUserId: bob.id,
          createdAt: now(),
          expiresAt: null,
          revokedAt: null,
        };
        database.shares.push(share);
        appendDecision(database, {
          actor: { userId: bob.id, username: bob.username, displayName: bob.displayName },
          agent: null,
          action: "share",
          resourceId: sharedResourceId,
          resourceName: "Partnerships Brief",
          resourceOwnerUserId: bob.id,
          outcome: "allow",
          reason: "SHARE_CREATED",
          grantId: share.id,
        });
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
    return snapshot.resources.filter((resource) => !resource.deletedAt).map((resource) => {
      const incomingShare = snapshot.shares
        .filter(
          (share) => share.resourceId === resource.id && share.granteeUserId === actor.userId,
        )
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
      const state = incomingShare ? shareState(incomingShare) : null;
      const ownedByCurrentUser = resource.ownerUserId === actor.userId;
      const sharedWithCurrentUser = state === "active";
      const ownerName =
        snapshot.users.find((user) => user.id === resource.ownerUserId)?.displayName ??
        "Unknown owner";
      // Contents and private metadata stay hidden unless the actor owns the
      // resource or has it actively shared to them.
      const visible = ownedByCurrentUser || sharedWithCurrentUser;
      return {
        id: resource.id,
        name: resource.name,
        description: visible
          ? resource.description
          : `Protected resource owned by ${ownerName}. Contents and private metadata are hidden.`,
        ownerUserId: resource.ownerUserId,
        ownerName,
        ownedByCurrentUser,
        sharedWithCurrentUser,
        shareState: state,
        shareExpiresAt: state === "active" ? incomingShare?.expiresAt ?? null : null,
        sizeBytes: visible ? resource.sizeBytes : 0,
        isDemo: resource.isDemo,
        createdAt: resource.createdAt,
        updatedAt: resource.updatedAt,
      };
    });
  }

  requireOwnedResource(actor: RequestActor, resourceId: string): ProtectedResource {
    const resource = this.store.snapshot().resources.find(
      (item) => item.id === resourceId && !item.deletedAt,
    );
    if (!resource || resource.ownerUserId !== actor.userId) {
      throw new HttpError(403, "You can authorize only resources you own");
    }
    return resource;
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
      for (const share of database.shares) {
        if (share.resourceId === resourceId && !share.revokedAt) {
          share.revokedAt = timestamp;
          appendDecision(database, {
            actor,
            agent: null,
            action: "unshare",
            resourceId,
            resourceName: resource.name,
            resourceOwnerUserId: resource.ownerUserId,
            outcome: "allow",
            reason: "SHARE_REVOKED_BY_OWNER",
            grantId: share.id,
          });
        }
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
      source: "manual",
      teamTaskId: null,
      grantedByUserId: actor.userId,
      createdAt: timestamp,
      expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
      revokedAt: null,
    };
    await this.store.mutate((database) => database.grants.push(grant));
    return { ...grant, resourceName: resource.name, state: "active" as const };
  }

  /**
   * Issue one task-scoped read lease per specialist for a Team Task. Idempotent:
   * an active `team_task` grant for the same (task, principal, resource) is
   * reused rather than duplicated. Cleared by `revokeTaskGrants` when the task
   * ends.
   */
  async ensureTaskGrants(
    actor: RequestActor,
    agents: Agent[],
    resourceId: string,
    teamTaskId: string,
    ttlSeconds = 30 * 60,
  ): Promise<{ grants: PermissionGrant[]; issuedCount: number }> {
    this.requireOwnedResource(actor, resourceId);
    for (const agent of agents) this.requireAgentOwner(actor, agent);
    const timestamp = now();
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    return this.store.mutate((database) => {
      const grants: PermissionGrant[] = [];
      let issuedCount = 0;
      for (const agent of agents) {
        const existing = database.grants.find(
          (grant) =>
            grant.source === "team_task" &&
            grant.teamTaskId === teamTaskId &&
            grant.agentPrincipalId === agent.principalId &&
            grant.resourceId === resourceId &&
            grant.actions.includes("read") &&
            grantState(grant) === "active",
        );
        if (existing) {
          grants.push(structuredClone(existing));
          continue;
        }
        const grant: PermissionGrant = {
          id: randomUUID(),
          agentPrincipalId: agent.principalId,
          resourceId,
          actions: ["read"],
          purpose: `Read-only access for Team Task ${teamTaskId}`,
          source: "team_task",
          teamTaskId,
          grantedByUserId: actor.userId,
          createdAt: timestamp,
          expiresAt,
          revokedAt: null,
        };
        database.grants.push(grant);
        grants.push(structuredClone(grant));
        issuedCount += 1;
      }
      return { grants, issuedCount };
    });
  }

  async revokeTaskGrants(teamTaskId: string): Promise<number> {
    return this.store.mutate((database) => {
      const timestamp = now();
      let revoked = 0;
      for (const grant of database.grants) {
        if (grant.source !== "team_task" || grant.teamTaskId !== teamTaskId || grant.revokedAt) {
          continue;
        }
        grant.revokedAt = timestamp;
        revoked += 1;
      }
      return revoked;
    });
  }

  /** Revoke the exact short-lived grants backing a one-turn approval. */
  async revokeGrantIds(grantIds: string[]): Promise<number> {
    const ids = new Set(grantIds);
    if (ids.size === 0) return 0;
    return this.store.mutate((database) => {
      const timestamp = now();
      let revoked = 0;
      for (const grant of database.grants) {
        if (!ids.has(grant.id) || grant.revokedAt) continue;
        grant.revokedAt = timestamp;
        revoked += 1;
      }
      return revoked;
    });
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

  // ── Cross-user resource sharing ──────────────────────────────────────────────

  private enrichShare(snapshot: Database, share: ResourceShare) {
    return {
      ...share,
      resourceName:
        snapshot.resources.find((item) => item.id === share.resourceId)?.name ??
        "Unknown resource",
      granteeName:
        snapshot.users.find((user) => user.id === share.granteeUserId)?.displayName ??
        "Unknown user",
      ownerName:
        snapshot.users.find((user) => user.id === share.ownerUserId)?.displayName ??
        "Unknown user",
      state: shareState(share),
    };
  }

  /** Users the actor could share a resource with (everyone but themselves). */
  listShareableUsers(actor: RequestActor) {
    return this.store
      .snapshot()
      .users.filter((user) => user.id !== actor.userId)
      .map((user) => ({
        userId: user.id,
        username: user.username,
        displayName: user.displayName,
      }));
  }

  /** Every share the actor has issued as a resource owner, newest first. */
  listSharesForOwner(actor: RequestActor) {
    const snapshot = this.store.snapshot();
    return snapshot.shares
      .filter((share) => share.ownerUserId === actor.userId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((share) => this.enrichShare(snapshot, share));
  }

  listSharesForResource(actor: RequestActor, resourceId: string) {
    const snapshot = this.store.snapshot();
    const resource = snapshot.resources.find(
      (item) => item.id === resourceId && !item.deletedAt,
    );
    if (!resource || resource.ownerUserId !== actor.userId) {
      throw new HttpError(404, "Protected resource not found");
    }
    return snapshot.shares
      .filter((share) => share.resourceId === resourceId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((share) => this.enrichShare(snapshot, share));
  }

  async createShare(
    actor: RequestActor,
    resourceId: string,
    granteeUserId: string,
    purpose: string,
    expiresAt?: string | null,
  ) {
    if (granteeUserId === actor.userId) {
      throw new HttpError(400, "You already own this resource");
    }
    let normalizedExpiry: string | null = null;
    if (expiresAt) {
      const parsed = Date.parse(expiresAt);
      if (Number.isNaN(parsed)) throw new HttpError(400, "Invalid expiry");
      if (parsed <= Date.now()) throw new HttpError(400, "Expiry must be in the future");
      if (parsed > Date.now() + MAX_SHARE_TTL_MS) {
        throw new HttpError(400, "Expiry cannot be more than 90 days out");
      }
      normalizedExpiry = new Date(parsed).toISOString();
    }
    return this.store.mutate((database) => {
      const resource = database.resources.find(
        (item) => item.id === resourceId && !item.deletedAt,
      );
      if (!resource || resource.ownerUserId !== actor.userId) {
        throw new HttpError(403, "You can share only resources you own");
      }
      const grantee = database.users.find((user) => user.id === granteeUserId);
      if (!grantee) throw new HttpError(404, "User not found");
      const existing = database.shares.find(
        (share) =>
          share.resourceId === resourceId &&
          share.granteeUserId === granteeUserId &&
          shareState(share) === "active",
      );
      if (existing) {
        throw new HttpError(409, "This resource is already shared with that user");
      }
      const timestamp = now();
      const share: ResourceShare = {
        id: randomUUID(),
        resourceId,
        ownerUserId: actor.userId,
        granteeUserId,
        actions: ["read"],
        purpose: purpose.trim(),
        createdByUserId: actor.userId,
        createdAt: timestamp,
        expiresAt: normalizedExpiry,
        revokedAt: null,
      };
      database.shares.push(share);
      appendDecision(database, {
        actor,
        agent: null,
        action: "share",
        resourceId,
        resourceName: resource.name,
        resourceOwnerUserId: resource.ownerUserId,
        outcome: "allow",
        reason: "SHARE_CREATED",
        grantId: share.id,
      });
      return this.enrichShare(database, share);
    });
  }

  async revokeShare(actor: RequestActor, resourceId: string, shareId: string) {
    return this.store.mutate((database) => {
      const share = database.shares.find((item) => item.id === shareId);
      if (!share || share.resourceId !== resourceId || share.ownerUserId !== actor.userId) {
        throw new HttpError(404, "Share not found");
      }
      if (!share.revokedAt) {
        share.revokedAt = now();
        const resource = database.resources.find((item) => item.id === resourceId);
        appendDecision(database, {
          actor,
          agent: null,
          action: "unshare",
          resourceId,
          resourceName: resource?.name ?? "Unknown resource",
          resourceOwnerUserId: resource?.ownerUserId ?? actor.userId,
          outcome: "allow",
          reason: "SHARE_REVOKED_BY_OWNER",
          grantId: share.id,
        });
      }
      return this.enrichShare(database, share);
    });
  }

  /**
   * Account-level receipt feed: every decision the actor is a party to — reads
   * their own Agents performed, reads other users' Agents performed on the
   * actor's resources, and the actor's own share/revoke management actions.
   */
  listAccountReceipts(actor: RequestActor) {
    return this.store
      .snapshot()
      .decisions.filter(
        (decision) =>
          decision.humanUserId === actor.userId ||
          decision.resourceOwnerUserId === actor.userId,
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((decision) => ({ ...decision }));
  }

  /**
   * The single enforcement boundary for reading a protected file.
   *
   * Two allow paths, checked after Agent ownership and resource existence:
   *  - the actor OWNS the resource ⇒ needs an active per-Agent capability lease
   *    (`GRANT_*`);
   *  - the resource belongs to ANOTHER user ⇒ needs an active cross-user share to
   *    the actor (`SHARE_*`). A share is sufficient on its own: any Agent the
   *    actor owns may then read it, no lease required.
   */
  async authorizeResourceRead(
    actor: RequestActor,
    agent: Agent,
    resourceId: string,
    context: { teamTaskId?: string } = {},
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
            grant.actions.includes("read") &&
            (grant.source === "manual" ||
              (Boolean(context.teamTaskId) && grant.teamTaskId === context.teamTaskId)),
        )
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
      const activeGrant = matching.find((grant) => grantState(grant) === "active") ?? null;
      const shares = database.shares
        .filter(
          (share) =>
            share.resourceId === resourceId &&
            share.granteeUserId === actor.userId &&
            share.actions.includes("read"),
        )
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
      const activeShare = shares.find((share) => shareState(share) === "active") ?? null;

      let reason: PolicyReason;
      if (agent.ownerUserId !== actor.userId) {
        reason = "AGENT_NOT_OWNED";
      } else if (!resource) {
        reason = "RESOURCE_NOT_FOUND";
      } else if (resource.ownerUserId === actor.userId) {
        if (activeGrant) reason = "GRANT_ACTIVE";
        else if (matching.some((grant) => grantState(grant) === "revoked")) reason = "GRANT_REVOKED";
        else if (matching.some((grant) => grantState(grant) === "expired")) reason = "GRANT_EXPIRED";
        else reason = "GRANT_MISSING";
      } else if (activeShare) {
        reason = "SHARE_ACTIVE";
      } else if (shares.some((share) => shareState(share) === "revoked")) {
        reason = "SHARE_REVOKED";
      } else if (shares.some((share) => shareState(share) === "expired")) {
        reason = "SHARE_EXPIRED";
      } else {
        reason = "SHARE_MISSING";
      }

      const outcome = reason === "GRANT_ACTIVE" || reason === "SHARE_ACTIVE" ? "allow" : "deny";
      const decision = appendDecision(database, {
        actor,
        agent,
        action: "read",
        resourceId,
        resourceName: resource?.name ?? "Unknown resource",
        resourceOwnerUserId: resource?.ownerUserId ?? actor.userId,
        outcome,
        reason,
        grantId:
          activeGrant?.id ?? activeShare?.id ?? matching[0]?.id ?? shares[0]?.id ?? null,
        teamTaskId: context.teamTaskId ?? null,
      });
      return {
        decision,
        resource: outcome === "allow" && resource ? structuredClone(resource) : null,
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

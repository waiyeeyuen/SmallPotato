import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SecurityService } from "./security-service.js";
import { JsonStore } from "./store.js";
import type { Agent, RequestActor } from "./types.js";

const temporaryDirectories: string[] = [];
const alice: RequestActor = {
  userId: "user-alice",
  username: "alice",
  displayName: "Alice Tan",
};
const bob: RequestActor = {
  userId: "user-bob",
  username: "bob",
  displayName: "Bob Lim",
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function makeSecurity() {
  const root = await mkdtemp(path.join(tmpdir(), "potatoguard-security-"));
  temporaryDirectories.push(root);
  const store = new JsonStore(path.join(root, "launchpad.json"));
  await store.initialize();
  const security = new SecurityService(store, root);
  await security.initialize();
  return { security, store };
}

function agent(): Agent {
  const timestamp = new Date().toISOString();
  return {
    id: "9f69f8d4-9b8c-4d60-9dbe-8dedadd7d20d",
    ownerUserId: alice.userId,
    principalId: "principal-alice-agent",
    name: "Guarded Agent",
    description: "",
    instructions: "",
    status: "ready",
    workspacePath: "/tmp/workspace",
    codexThreadId: null,
    lastError: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

describe("SecurityService", () => {
  it("authenticates seeded users and resolves an expiring server session", async () => {
    const { security } = await makeSecurity();
    await expect(security.login("alice", "wrong-password")).rejects.toMatchObject({
      statusCode: 401,
    });
    const login = await security.login("alice", "alice-potato");
    expect(login.user).toEqual(alice);
    await expect(security.resolveSession(login.token)).resolves.toEqual(alice);
    await security.logout(login.token);
    await expect(security.resolveSession(login.token)).rejects.toMatchObject({
      statusCode: 401,
    });
  });

  it("denies by default, allows an active lease, and denies after revocation", async () => {
    const { security } = await makeSecurity();
    const guardedAgent = agent();
    const resource = security.listResources(alice).find((item) => item.ownedByCurrentUser);
    if (!resource) throw new Error("Expected Alice fixture resource");

    const missing = await security.authorizeResourceRead(alice, guardedAgent, resource.id);
    expect(missing.decision).toMatchObject({ outcome: "deny", reason: "GRANT_MISSING" });
    expect(missing.resource).toBeNull();

    const grant = await security.createGrant(
      alice,
      guardedAgent,
      resource.id,
      "Summarize for launch review",
      60,
    );
    const allowed = await security.authorizeResourceRead(alice, guardedAgent, resource.id);
    expect(allowed.decision).toMatchObject({
      outcome: "allow",
      reason: "GRANT_ACTIVE",
      grantId: grant.id,
    });
    expect(allowed.resource?.filePath).toContain("alice-launch-plan.txt");

    await security.revokeGrant(alice, guardedAgent, grant.id);
    const revoked = await security.authorizeResourceRead(alice, guardedAgent, resource.id);
    expect(revoked.decision).toMatchObject({ outcome: "deny", reason: "GRANT_REVOKED" });
  });

  it("denies Alice's Agent a read of Bob's resource that has not been shared", async () => {
    const { security } = await makeSecurity();
    const guardedAgent = agent();
    const bobResource = security
      .listResources(alice)
      .find((item) => !item.ownedByCurrentUser && item.id === "resource-bob-finance-report");
    if (!bobResource) throw new Error("Expected Bob finance fixture resource");
    // Alice still cannot mint a per-Agent lease on a resource she does not own.
    await expect(
      security.createGrant(alice, guardedAgent, bobResource.id, "Bypass", 60),
    ).rejects.toMatchObject({ statusCode: 403 });
    const denied = await security.authorizeResourceRead(alice, guardedAgent, bobResource.id);
    expect(denied.decision).toMatchObject({ outcome: "deny", reason: "SHARE_MISSING" });
    expect(denied.resource).toBeNull();
  });

  it("lets Bob share a resource so Alice's Agent can read it, with a receipt", async () => {
    const { security } = await makeSecurity();
    const guardedAgent = agent();
    const bobResource = security
      .listResources(bob)
      .find((item) => item.ownedByCurrentUser && item.id === "resource-bob-finance-report");
    if (!bobResource) throw new Error("Expected Bob finance fixture resource");

    const before = await security.authorizeResourceRead(alice, guardedAgent, bobResource.id);
    expect(before.decision).toMatchObject({ outcome: "deny", reason: "SHARE_MISSING" });

    const share = await security.createShare(
      bob,
      bobResource.id,
      alice.userId,
      "Cross-team review",
      null,
    );
    expect(share).toMatchObject({ state: "active", granteeName: "Alice Tan" });

    const allowed = await security.authorizeResourceRead(alice, guardedAgent, bobResource.id);
    expect(allowed.decision).toMatchObject({
      outcome: "allow",
      reason: "SHARE_ACTIVE",
      grantId: share.id,
      resourceOwnerUserId: bob.userId,
    });
    expect(allowed.resource?.filePath).toContain("bob-finance-report.txt");

    await security.revokeShare(bob, bobResource.id, share.id);
    const revoked = await security.authorizeResourceRead(alice, guardedAgent, bobResource.id);
    expect(revoked.decision).toMatchObject({ outcome: "deny", reason: "SHARE_REVOKED" });
    expect(security.verifyDecisionChain()).toBe(true);
  });

  it("denies a read once the share has expired", async () => {
    const { security, store } = await makeSecurity();
    const guardedAgent = agent();
    const resourceId = "resource-bob-finance-report";
    await store.mutate((database) => {
      database.shares.push({
        id: "share-expired",
        resourceId,
        ownerUserId: bob.userId,
        granteeUserId: alice.userId,
        actions: ["read"],
        purpose: "Stale window",
        createdByUserId: bob.userId,
        createdAt: new Date(Date.now() - 7_200_000).toISOString(),
        expiresAt: new Date(Date.now() - 3_600_000).toISOString(),
        revokedAt: null,
      });
    });
    const denied = await security.authorizeResourceRead(alice, guardedAgent, resourceId);
    expect(denied.decision).toMatchObject({ outcome: "deny", reason: "SHARE_EXPIRED" });
  });

  it("only lets the resource owner create or revoke a share", async () => {
    const { security } = await makeSecurity();
    const resourceId = "resource-bob-finance-report";
    await expect(
      security.createShare(alice, resourceId, bob.userId, "Not my file", null),
    ).rejects.toMatchObject({ statusCode: 403 });
    const share = await security.createShare(bob, resourceId, alice.userId, "Owner share", null);
    await expect(
      security.revokeShare(alice, resourceId, share.id),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      security.createShare(bob, resourceId, alice.userId, "Duplicate", null),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("revokes dependent shares when the owner deletes the resource", async () => {
    const { security } = await makeSecurity();
    const created = await security.createResource(bob, {
      name: "Ephemeral Brief",
      description: "",
      content: "Fictional partner list.",
    });
    const share = await security.createShare(bob, created.id, alice.userId, "Review", null);
    expect(share.state).toBe("active");
    await security.deleteResource(bob, created.id);
    expect(security.listSharesForOwner(bob).find((item) => item.id === share.id)?.state).toBe(
      "revoked",
    );
    const denied = await security.authorizeResourceRead(alice, agent(), created.id);
    expect(denied.decision).toMatchObject({ outcome: "deny", reason: "RESOURCE_NOT_FOUND" });
  });

  it("scopes the account receipt feed to each party without leaking cross-agent audit rows", async () => {
    const { security } = await makeSecurity();
    const aliceAgent = agent();
    const resourceId = "resource-bob-finance-report";
    await security.createShare(bob, resourceId, alice.userId, "Cross-team review", null);
    await security.authorizeResourceRead(alice, aliceAgent, resourceId);

    const bobFeed = security.listAccountReceipts(bob);
    expect(bobFeed.some((item) => item.action === "share")).toBe(true);
    expect(
      bobFeed.some(
        (item) => item.action === "read" && item.humanUserId === alice.userId && item.outcome === "allow",
      ),
    ).toBe(true);

    const aliceFeed = security.listAccountReceipts(alice);
    expect(aliceFeed.some((item) => item.action === "read" && item.resourceOwnerUserId === bob.userId)).toBe(true);

    // Per-Agent audit stays scoped to that Agent's own reads — no share rows.
    const agentAudit = security.listDecisions(alice, aliceAgent);
    expect(agentAudit.every((item) => item.agentId === aliceAgent.id)).toBe(true);
    expect(agentAudit.some((item) => item.action !== "read")).toBe(false);
  });

  it("creates, updates, and deletes an owned resource while revoking its leases", async () => {
    const { security, store } = await makeSecurity();
    const guardedAgent = agent();
    const created = await security.createResource(alice, {
      name: "Incident Brief",
      description: "Initial description",
      content: "Priority: contain the fictional incident.",
    });
    const stored = store.snapshot().resources.find((item) => item.id === created.id);
    if (!stored) throw new Error("Expected protected resource to be persisted");
    expect(await readFile(stored.filePath, "utf8")).toContain("contain the fictional incident");
    expect(created).toMatchObject({
      name: "Incident Brief",
      ownedByCurrentUser: true,
      isDemo: false,
    });

    const updated = await security.updateResource(alice, created.id, {
      name: "Updated Incident Brief",
      description: "Approved fictional response",
      content: "Priority: communicate the all-clear.",
    });
    expect(updated).toMatchObject({
      name: "Updated Incident Brief",
      description: "Approved fictional response",
    });
    expect(await readFile(stored.filePath, "utf8")).toContain("communicate the all-clear");

    const grant = await security.createGrant(
      alice,
      guardedAgent,
      created.id,
      "Review the response",
      60,
    );
    await security.deleteResource(alice, created.id);
    expect(security.listResources(alice).some((item) => item.id === created.id)).toBe(false);
    expect(security.listGrants(alice, guardedAgent).find((item) => item.id === grant.id)?.state)
      .toBe("revoked");
    await expect(access(stored.filePath)).rejects.toMatchObject({ code: "ENOENT" });
    const denied = await security.authorizeResourceRead(alice, guardedAgent, created.id);
    expect(denied.decision).toMatchObject({ outcome: "deny", reason: "RESOURCE_NOT_FOUND" });
  });

  it("preserves attribution snapshots and detects audit receipt tampering", async () => {
    const { security, store } = await makeSecurity();
    const guardedAgent = agent();
    const resource = security.listResources(alice).find((item) => item.ownedByCurrentUser);
    if (!resource) throw new Error("Expected Alice fixture resource");

    await security.authorizeResourceRead(alice, guardedAgent, resource.id);
    expect(security.verifyDecisionChain()).toBe(true);
    expect(security.listDecisions(alice, guardedAgent)[0]).toMatchObject({
      humanName: "Alice Tan",
      agentName: "Guarded Agent",
      resourceName: "Launch Plan",
    });

    await store.mutate((database) => {
      database.decisions[0]!.reason = "GRANT_ACTIVE";
    });
    expect(security.verifyDecisionChain()).toBe(false);
  });
});

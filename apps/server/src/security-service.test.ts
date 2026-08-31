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

  it("does not permit Alice to grant or read Bob's resource", async () => {
    const { security } = await makeSecurity();
    const guardedAgent = agent();
    const bobResource = security.listResources(alice).find((item) => !item.ownedByCurrentUser);
    if (!bobResource) throw new Error("Expected Bob fixture resource");
    await expect(
      security.createGrant(alice, guardedAgent, bobResource.id, "Bypass", 60),
    ).rejects.toMatchObject({ statusCode: 403 });
    const denied = await security.authorizeResourceRead(alice, guardedAgent, bobResource.id);
    expect(denied.decision).toMatchObject({
      outcome: "deny",
      reason: "RESOURCE_NOT_OWNED",
    });
    expect(denied.resource).toBeNull();
  });

  it("redacts another user's protected-resource metadata", async () => {
    const { security } = await makeSecurity();
    const bobResource = security.listResources(alice).find((item) => !item.ownedByCurrentUser);
    expect(bobResource).toMatchObject({
      name: "Finance Report",
      sizeBytes: 0,
      description: "Protected resource owned by Bob Lim. Contents and private metadata are hidden.",
    });
    expect(bobResource?.description).not.toContain("finance planning");
  });

  it("confines automatic grants to one Team Task and revokes them at the boundary", async () => {
    const { security } = await makeSecurity();
    const guardedAgent = agent();
    const resource = security.listResources(alice).find((item) => item.ownedByCurrentUser);
    if (!resource) throw new Error("Expected Alice fixture resource");

    const { grants: [grant], issuedCount } = await security.ensureTaskGrants(
      alice,
      [guardedAgent],
      resource.id,
      "task-authorized",
      300,
    );
    expect(issuedCount).toBe(1);
    expect(grant).toMatchObject({ source: "team_task", teamTaskId: "task-authorized" });

    const outsideTask = await security.authorizeResourceRead(alice, guardedAgent, resource.id);
    expect(outsideTask.decision).toMatchObject({ outcome: "deny", reason: "GRANT_MISSING", teamTaskId: null });
    const wrongTask = await security.authorizeResourceRead(
      alice,
      guardedAgent,
      resource.id,
      { teamTaskId: "task-other" },
    );
    expect(wrongTask.decision).toMatchObject({ outcome: "deny", reason: "GRANT_MISSING", teamTaskId: "task-other" });
    const insideTask = await security.authorizeResourceRead(
      alice,
      guardedAgent,
      resource.id,
      { teamTaskId: "task-authorized" },
    );
    expect(insideTask.decision).toMatchObject({
      outcome: "allow",
      reason: "GRANT_ACTIVE",
      grantId: grant?.id,
      teamTaskId: "task-authorized",
    });

    expect(await security.revokeTaskGrants("task-authorized")).toBe(1);
    const afterRevoke = await security.authorizeResourceRead(
      alice,
      guardedAgent,
      resource.id,
      { teamTaskId: "task-authorized" },
    );
    expect(afterRevoke.decision).toMatchObject({ outcome: "deny", reason: "GRANT_REVOKED" });
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

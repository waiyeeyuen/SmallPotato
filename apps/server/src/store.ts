import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { receiptHash } from "./audit.js";
import type { Database } from "./types.js";

const emptyDatabase = (): Database => ({
  version: 6,
  users: [],
  sessions: [],
  agents: [],
  messages: [],
  runs: [],
  resources: [],
  grants: [],
  decisions: [],
  teamTasks: [],
  teamTaskEvents: [],
});

function normalizeDatabase(database: Database): Database {
  return {
    ...database,
    agents: database.agents.map((agent) => ({
      ...agent,
      activeTeamTaskId: agent.activeTeamTaskId ?? null,
    })),
    teamTasks: (database.teamTasks ?? []).map((task) => ({
      ...task,
      ownerUserId: task.ownerUserId ?? "user-alice",
      resourceId: task.resourceId ?? null,
      agentSelection: task.agentSelection ?? "user",
      rosterLocked:
        task.rosterLocked ??
        !(task.agentSelection === "lead" && task.turnPolicy === null && ["running", "paused"].includes(task.status)),
      turnPolicy: task.turnPolicy ?? null,
      activeRequestSequence: task.activeRequestSequence ?? null,
      assignmentQueue: task.assignmentQueue ?? [],
      activeTurnStartedAt: task.activeTurnStartedAt ?? null,
    })),
    teamTaskEvents: (database.teamTaskEvents ?? []).map((event) => ({
      ...event,
      chatContent: event.chatContent ?? null,
      previousReceiptHash: event.previousReceiptHash ?? null,
      receiptHash: event.receiptHash ?? null,
    })),
  };
}

function migrateDatabase(value: unknown): Database {
  const parsed = value as Partial<Database> & {
    version?: number;
    agents?: Array<Record<string, unknown>>;
  };
  if (!Array.isArray(parsed.agents)) throw new Error("Unsupported database format");
  if (parsed.version === 6) return normalizeDatabase(parsed as Database);
  let base: Record<string, unknown>;
  if (parsed.version === 5) {
    base = parsed as unknown as Record<string, unknown>;
  } else if (parsed.version === 3) {
    const legacy = parsed as Partial<Database>;
    if (Array.isArray(legacy.teamTasks) && !Array.isArray(legacy.users)) {
      base = {
        ...emptyDatabase(),
        ...legacy,
        agents: parsed.agents.map((agent) => ({
          ...agent,
          ownerUserId: agent.ownerUserId ?? "user-alice",
          principalId: agent.principalId ?? randomUUID(),
          activeTeamTaskId: agent.activeTeamTaskId ?? null,
        })),
      };
    } else {
      base = parsed as unknown as Record<string, unknown>;
    }
  } else if (parsed.version === 2 || parsed.version === 4) {
    const legacy = parsed as Partial<Database>;
    if (Array.isArray(legacy.teamTasks) && Array.isArray(legacy.teamTaskEvents)) {
      base = {
        ...emptyDatabase(),
        ...legacy,
        agents: parsed.agents.map((agent) => ({
          ...agent,
          ownerUserId: agent.ownerUserId ?? "user-alice",
          principalId: agent.principalId ?? randomUUID(),
          activeTeamTaskId: agent.activeTeamTaskId ?? null,
        })),
        runs: (Array.isArray(legacy.runs) ? legacy.runs : []).map((run) => ({
          ...run,
          resourceId: run.resourceId ?? null,
          policyDecisionId: run.policyDecisionId ?? null,
        })),
      };
    } else {
      base = parsed as unknown as Record<string, unknown>;
    }
  } else if (parsed.version === 1) {
    base = {
      ...emptyDatabase(),
      version: 2,
      agents: parsed.agents.map((agent) => ({
        ...agent,
        ownerUserId: "user-alice",
        principalId: randomUUID(),
        activeTeamTaskId: null,
      })),
      messages: Array.isArray(parsed.messages) ? parsed.messages : [],
      runs: (Array.isArray(parsed.runs) ? parsed.runs : []).map((run) => ({
        ...run,
        resourceId: null,
        policyDecisionId: null,
      })),
    };
  } else {
    throw new Error("Unsupported database format");
  }

  const users = Array.isArray(base.users) ? base.users as Database["users"] : [];
  const agents = Array.isArray(base.agents) ? base.agents as Database["agents"] : [];
  const timestamp = new Date().toISOString();
  const resources = (Array.isArray(base.resources) ? base.resources : []).map((item) => {
    const resource = item as Partial<Database["resources"][number]> & {
      createdAt?: string;
    };
    return {
      ...resource,
      sizeBytes: resource.sizeBytes ?? 0,
      isDemo: resource.isDemo ?? String(resource.id).startsWith("resource-"),
      deletedAt: resource.deletedAt ?? null,
      createdAt: resource.createdAt ?? timestamp,
      updatedAt: resource.updatedAt ?? resource.createdAt ?? timestamp,
    } as Database["resources"][number];
  });
  let previousReceiptHash: string | null = null;
  const decisions = (Array.isArray(base.decisions) ? base.decisions : []).map((item) => {
    const decision = item as Partial<Database["decisions"][number]> & {
      humanUserId: string;
      agentId: string;
      resourceId: string;
    };
    const payload = {
      id: String(decision.id),
      humanUserId: decision.humanUserId,
      humanName:
        decision.humanName ?? users.find((user) => user.id === decision.humanUserId)?.displayName ?? "Unknown user",
      agentId: decision.agentId,
      agentName:
        decision.agentName ?? agents.find((agent) => agent.id === decision.agentId)?.name ?? "Unknown Agent",
      agentPrincipalId: String(decision.agentPrincipalId),
      action: decision.action ?? "read",
      resourceId: decision.resourceId,
      resourceName:
        decision.resourceName ?? resources.find((resource) => resource.id === decision.resourceId)?.name ?? "Unknown resource",
      outcome: decision.outcome ?? "deny",
      reason: decision.reason ?? "RESOURCE_NOT_FOUND",
      grantId: decision.grantId ?? null,
      createdAt: decision.createdAt ?? timestamp,
    } as const;
    const migrated = {
      ...payload,
      runId: decision.runId ?? null,
      previousReceiptHash,
      receiptHash: receiptHash(payload, previousReceiptHash),
    } as Database["decisions"][number];
    previousReceiptHash = migrated.receiptHash;
    return migrated;
  });

  return normalizeDatabase({
    ...emptyDatabase(),
    ...base,
    version: 6,
    users,
    agents,
    resources,
    decisions,
    teamTasks: Array.isArray(base.teamTasks) ? base.teamTasks : [],
    teamTaskEvents: Array.isArray(base.teamTaskEvents) ? base.teamTaskEvents : [],
  } as Database);
}

export class JsonStore {
  private data: Database = emptyDatabase();
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      const sourceVersion = (parsed as { version?: number }).version;
      if (sourceVersion === 5) {
        await copyFile(this.filePath, this.filePath + ".v5.backup");
      } else if (sourceVersion === 4) {
        await copyFile(this.filePath, this.filePath + ".v4.backup");
      } else if (
        sourceVersion === 3 &&
        Array.isArray((parsed as { users?: unknown }).users)
      ) {
        await copyFile(this.filePath, this.filePath + ".v3-agentguard.backup");
      }
      this.data = migrateDatabase(parsed);
      if (sourceVersion !== 6) await this.persist(this.data);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      await this.persist();
    }
  }

  snapshot(): Database {
    return structuredClone(this.data);
  }

  async mutate<T>(mutation: (database: Database) => T | Promise<T>): Promise<T> {
    let result!: T;
    const operation = this.queue.then(async () => {
      const next = structuredClone(this.data);
      result = await mutation(next);
      await this.persist(next);
      this.data = next;
    });
    this.queue = operation.catch(() => undefined);
    await operation;
    return result;
  }

  private async persist(data: Database = this.data): Promise<void> {
    const temporaryPath = this.filePath + ".tmp";
    await writeFile(temporaryPath, JSON.stringify(data, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, this.filePath);
  }
}

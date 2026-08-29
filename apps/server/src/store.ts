import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { receiptHash } from "./audit.js";
import type { Database } from "./types.js";

const emptyDatabase = (): Database => ({
  version: 3,
  users: [],
  sessions: [],
  agents: [],
  messages: [],
  runs: [],
  resources: [],
  grants: [],
  decisions: [],
});

function migrateDatabase(value: unknown): Database {
  const parsed = value as Partial<Database> & {
    version?: number;
    agents?: Array<Record<string, unknown>>;
  };
  if (!Array.isArray(parsed.agents)) throw new Error("Unsupported database format");
  if (parsed.version === 3) return parsed as Database;
  let base: Record<string, unknown>;
  if (parsed.version === 2) {
    base = parsed as unknown as Record<string, unknown>;
  } else if (parsed.version === 1) {
    base = {
      ...emptyDatabase(),
      version: 2,
      agents: parsed.agents.map((agent) => ({
        ...agent,
        ownerUserId: "user-alice",
        principalId: randomUUID(),
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

  return {
    ...emptyDatabase(),
    ...base,
    version: 3,
    users,
    agents,
    resources,
    decisions,
  } as Database;
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
      this.data = migrateDatabase(parsed);
      if ((parsed as { version?: number }).version !== 3) await this.persist(this.data);
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

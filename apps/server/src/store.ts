import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Agent, AgentRun, Database, Message } from "./types.js";

const emptyDatabase = (): Database => ({
  version: 2,
  agents: [],
  messages: [],
  runs: [],
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
    teamTasks: database.teamTasks.map((task) => ({
      ...task,
      assignmentQueue: task.assignmentQueue ?? [],
      activeTurnStartedAt: task.activeTurnStartedAt ?? null,
    })),
    teamTaskEvents: database.teamTaskEvents.map((event) => ({
      ...event,
      chatContent: event.chatContent ?? null,
    })),
  };
}

interface LegacyDatabase {
  version: 1;
  agents: Array<Omit<Agent, "activeTeamTaskId">>;
  messages: Message[];
  runs: AgentRun[];
}

interface NewerDatabase extends Omit<Database, "version"> {
  version: 3 | 4;
}

interface AgentGuardDatabase {
  version: 3;
  agents: Array<Omit<Agent, "activeTeamTaskId">>;
  messages: Message[];
  runs: AgentRun[];
  users: unknown[];
  sessions: unknown[];
  resources: unknown[];
  grants: unknown[];
  decisions: unknown[];
}

export class JsonStore {
  private data: Database = emptyDatabase();
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as
        | Database
        | LegacyDatabase
        | NewerDatabase
        | AgentGuardDatabase;
      if (!Array.isArray(parsed.agents)) {
        throw new Error("Unsupported database format");
      }
      if (parsed.version === 1) {
        this.data = {
          version: 2,
          agents: parsed.agents.map((agent) => ({
            ...agent,
            activeTeamTaskId: null,
          })),
          messages: parsed.messages,
          runs: parsed.runs,
          teamTasks: [],
          teamTaskEvents: [],
        };
        await this.persist(this.data);
      } else if (
        (parsed.version === 2 || parsed.version === 3 || parsed.version === 4) &&
        Array.isArray(parsed.messages) &&
        Array.isArray(parsed.runs) &&
        Array.isArray((parsed as NewerDatabase).teamTasks) &&
        Array.isArray((parsed as NewerDatabase).teamTaskEvents)
      ) {
        const teamDatabase = parsed as Database | NewerDatabase;
        if (parsed.version === 2) {
          this.data = normalizeDatabase(teamDatabase as Database);
        } else {
          await copyFile(this.filePath, this.filePath + ".v" + parsed.version + ".backup");
          this.data = normalizeDatabase({ ...teamDatabase, version: 2 } as Database);
          await this.persist(this.data);
        }
      } else if (
        parsed.version === 3 &&
        Array.isArray(parsed.messages) &&
        Array.isArray(parsed.runs) &&
        Array.isArray((parsed as AgentGuardDatabase).users) &&
        Array.isArray((parsed as AgentGuardDatabase).resources)
      ) {
        // The AgentGuard branch also used version 3 for a different schema.
        // Preserve its full database, then carry the shared Agent history into
        // this branch's Team Task schema.
        const agentGuardDatabase = parsed as AgentGuardDatabase;
        await copyFile(this.filePath, this.filePath + ".v3-agentguard.backup");
        this.data = {
          version: 2,
          agents: agentGuardDatabase.agents.map((agent) => ({
            ...agent,
            activeTeamTaskId: null,
          })),
          messages: agentGuardDatabase.messages,
          runs: agentGuardDatabase.runs,
          teamTasks: [],
          teamTaskEvents: [],
        };
        await this.persist(this.data);
      } else {
        throw new Error("Unsupported database format");
      }
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

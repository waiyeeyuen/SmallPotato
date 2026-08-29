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

interface LegacyDatabase {
  version: 1;
  agents: Array<Omit<Agent, "activeTeamTaskId">>;
  messages: Message[];
  runs: AgentRun[];
}

interface NewerDatabase extends Omit<Database, "version"> {
  version: 3 | 4;
}

export class JsonStore {
  private data: Database = emptyDatabase();
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Database | LegacyDatabase | NewerDatabase;
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
        Array.isArray(parsed.teamTasks) &&
        Array.isArray(parsed.teamTaskEvents)
      ) {
        if (parsed.version === 2) {
          this.data = parsed;
        } else {
          await copyFile(this.filePath, this.filePath + ".v" + parsed.version + ".backup");
          this.data = { ...parsed, version: 2 };
          await this.persist(this.data);
        }
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

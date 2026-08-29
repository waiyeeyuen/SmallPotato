import path from "node:path";
import { AgentService } from "./agent-service.js";
import { createApp } from "./app.js";
import { loadConfig, writeCodexConfig } from "./config.js";
import { createRunner } from "./runner-factory.js";
import { JsonStore } from "./store.js";
import { WorkspaceManager } from "./workspace.js";
import { TeamTaskService } from "./team-task-service.js";
import { SecurityService } from "./security-service.js";

const config = loadConfig();
await writeCodexConfig(config);

const store = new JsonStore(path.join(config.dataDirectory, "launchpad.json"));
const workspaces = new WorkspaceManager(config.workspaceRoot);
const runner = createRunner(config);
const security = new SecurityService(store, config.dataDirectory);
const service = new AgentService(config, store, workspaces, runner, security);
await service.initialize();
const teamTasks = new TeamTaskService(config, store, workspaces, runner);
await teamTasks.initialize();
await security.initialize();

const app = await createApp(config, service, security, teamTasks);

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "Shutting down");
  await app.close();
  process.exit(0);
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ host: config.host, port: config.port });

#!/usr/bin/env node
/** Prepare a deterministic, non-destructive PotatoGuard recording state. */

import { execFileSync } from "node:child_process";

const BASE = process.env.DEMO_BASE_URL ?? "http://localhost:3000";
const SMOKE = process.argv.includes("--smoke");
const PROFILE = "Tokyo Travel Profile";
const PROFILE_DESCRIPTION = "Alice's protected dates, budget, and travel preferences.";
const PROFILE_CONTENT = [
  "Destination: Tokyo, Japan",
  "Travel dates: 14-18 September 2026 (4 nights)",
  "Travellers: 2 adults",
  "Total ground budget: SGD 2,800 excluding international flights",
  "Stay preference: walkable neighbourhood with direct airport access",
  "Pace: at most two major activities per day; one slow morning",
  "Food: one traveller is pescatarian; reserve one omakase splurge dinner",
  "Interests: design, neighbourhood walks, stationery, and local food",
  "Avoid: theme parks, guided bus tours, and nightlife-heavy plans",
].join("\n");
const TEAM = ["Trip Coordinator", "Flight & Hotel Scout", "Budget Analyst"];

let cookie = "";
const problems = [];
const notes = [];

async function call(path, options = {}) {
  const response = await fetch(BASE + path, {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { cookie } : {}),
    },
  });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${options.method ?? "GET"} ${path} -> ${response.status} ${body.error ?? ""}`);
  }
  return body;
}

const ok = (message) => console.log(`  ok    ${message}`);
const bad = (message) => { console.log(`  FAIL  ${message}`); problems.push(message); };
const note = (message) => { console.log(`  note  ${message}`); notes.push(message); };

function repairRuntimeImageTag(engine, image) {
  const run = (args) => execFileSync(engine, args, { encoding: "utf8", timeout: 10_000 });
  try {
    run(["image", "inspect", image]);
    return "already-ok";
  } catch {
    // Look for an intact untagged image before declaring the Runtime unavailable.
  }
  try {
    const id = run(["images", "--format", "{{.Repository}}:{{.Tag}} {{.ID}}"])
      .split("\n")
      .find((line) => line.startsWith(image + " "))
      ?.split(" ")[1];
    if (!id) return "image-absent";
    run(["tag", id, image]);
    run(["image", "inspect", image]);
    return "repaired";
  } catch {
    return "engine-unreachable";
  }
}

console.log(`\nPotatoGuard demo pre-flight against ${BASE}\n`);

try {
  await call("/api/health");
  ok("server is reachable");
} catch {
  bad(`server is not reachable at ${BASE} - run "npm run poc" first`);
  process.exit(1);
}

await call("/api/login", {
  method: "POST",
  body: JSON.stringify({ username: "alice", password: "alice-potato" }),
});
ok("signed in as Alice");

let system = await call("/api/system");
if (system.arkConfigured) ok(`Ark configuration present (${system.arkModel})`);
else bad("ARK_API_KEY or ARK_MODEL is missing");
if (system.runtimeProvider !== "container") {
  bad(`Runtime provider is ${system.runtimeProvider}; protected files require container`);
} else if (!system.codexAvailable) {
  const image = process.env.CONTAINER_RUNTIME_IMAGE ?? "volc-agent-runtime:local";
  const result = repairRuntimeImageTag(system.containerEngine ?? "docker", image);
  if (result === "repaired") {
    system = await call("/api/system");
    note(`repaired the ${image} tag`);
  }
  if (!system.codexAvailable) bad(`container Runtime unavailable (${result})`);
}
if (system.codexAvailable) ok(`Runtime available (${system.runtime})`);

const { tasks } = await call("/api/team-tasks");
const open = tasks.filter((task) => ["running", "queued", "paused"].includes(task.status));
for (const task of open) {
  await call(`/api/team-tasks/${task.id}/stop`, { method: "POST" });
}
if (open.length) note(`stopped ${open.length} leftover Alice task(s)`);
else ok("no Alice Team Task is open");

let { resources } = await call("/api/resources");
let profile = resources.find((resource) => resource.name === PROFILE && resource.ownedByCurrentUser);
if (!profile) {
  profile = (await call("/api/resources", {
    method: "POST",
    body: JSON.stringify({
      name: PROFILE,
      description: PROFILE_DESCRIPTION,
      content: PROFILE_CONTENT,
    }),
  })).resource;
  note(`created protected resource "${PROFILE}"`);
} else {
  await call(`/api/resources/${profile.id}`, {
    method: "PATCH",
    body: JSON.stringify({
      name: PROFILE,
      description: PROFILE_DESCRIPTION,
      content: PROFILE_CONTENT,
    }),
  });
  ok(`refreshed protected resource "${PROFILE}"`);
}

for (let attempt = 0; attempt < 20; attempt += 1) {
  const agents = (await call("/api/agents")).agents;
  if (TEAM.every((name) => !agents.find((agent) => agent.name === name)?.activeTeamTaskId)) break;
  await new Promise((resolve) => setTimeout(resolve, 500));
}

const agents = (await call("/api/agents")).agents;
for (const name of TEAM) {
  const agent = agents.find((item) => item.name === name);
  if (!agent) bad(`team Agent "${name}" is missing`);
  else if (agent.activeTeamTaskId) bad(`"${name}" is still reserved`);
  else if (agent.status !== "ready") bad(`"${name}" is ${agent.status}, not ready`);
  else ok(`"${name}" is ready`);
}

if (SMOKE && problems.length === 0) {
  let smokeAgent = agents.find((item) => item.name === "Weather Forecaster");
  if (smokeAgent && ["error", "stopped"].includes(smokeAgent.status)) {
    smokeAgent = (await call(`/api/agents/${smokeAgent.id}/start`, { method: "POST" })).agent;
    note("reset Weather Forecaster after its previous smoke run");
  }
  if (!smokeAgent || smokeAgent.status !== "ready") {
    bad("Weather Forecaster cannot run the provider smoke test");
  } else {
    const started = await call(`/api/agents/${smokeAgent.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: "Reply with exactly RUNTIME READY." }),
    });
    let terminal = null;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      const current = (await call(`/api/runs/${started.run.id}`)).run;
      if (["completed", "failed", "cancelled"].includes(current.status)) {
        terminal = current;
        break;
      }
    }
    if (terminal?.status === "completed") {
      ok("live Ark-backed Docker turn completed");
    } else {
      bad(`live provider smoke test failed: ${terminal?.error ?? "timed out"}`);
      await call(`/api/agents/${smokeAgent.id}/start`, { method: "POST" });
      note("returned Weather Forecaster to ready after the failed smoke run");
    }
  }
} else if (!SMOKE) {
  note("provider quota was not exercised; use --smoke immediately before recording");
}

console.log("");
if (problems.length) {
  console.log(`Not ready to record. ${problems.length} problem(s) above.\n`);
  process.exit(1);
}
console.log(`Ready to record${notes.length ? ` (${notes.length} note(s) above)` : ""}.`);
console.log("Open http://localhost:3000 and follow docs/UNIFIED_DEMO.md.\n");

#!/usr/bin/env node
/**
 * Pre-flight for the demo recording.
 *
 * Verifies every precondition the take depends on, and resets the small amount
 * of state a previous take leaves behind. Run this before every recording.
 *
 *   node prepare.mjs           # check, and recreate a specialist if it carries
 *                              # any lease history (required for GRANT_MISSING)
 *   node prepare.mjs --fresh   # recreate both specialists even when clean
 *
 * The demo is ONE workflow: a team task on a protected document that is denied
 * mid-flight, leased, and resumed. There is no separate Playground half, so the
 * old Launch Analyst / Finance Report preconditions are gone.
 */

import { execFileSync } from "node:child_process";

const BASE = process.env.DEMO_BASE_URL ?? "http://localhost:3000";
const FRESH = process.argv.includes("--fresh");

const BRIEF = "Tokyo Trip Brief";
const BRIEF_DESCRIPTION = "Protected trip constraints the team must plan against.";
const BRIEF_CONTENT = [
  "Travellers: 2. Budget: US$3000 all-in.",
  "Avoid the first week of April (company offsite).",
  "Prefer a walkable neighbourhood with fast airport access.",
  "One splurge dinner is approved; no guided tours.",
].join("\n");

const LEAD = "Trip Coordinator";
// Exactly two. Every specialist turn is gated, so each needs its own lease, and
// two is the largest roster you can lease in one visit to the Access leases view.
const SPECIALISTS = ["Flight & Hotel Scout", "Budget Analyst"];

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

function ok(label) { console.log(`  ok    ${label}`); }
function bad(label) { console.log(`  FAIL  ${label}`); problems.push(label); }
function note(label) { console.log(`  note  ${label}`); notes.push(label); }

console.log(`\nPotatoGuard demo pre-flight against ${BASE}\n`);

// 1. Server reachable and signed in as Alice.
try {
  await call("/api/health");
  ok("server is reachable");
} catch {
  bad(`server is not reachable at ${BASE} — run "npm run poc" first`);
  console.log("\nAborting: nothing else can be checked.\n");
  process.exit(1);
}

await call("/api/login", {
  method: "POST",
  body: JSON.stringify({ username: "alice", password: "alice-potato" }),
});
ok("signed in as alice");

// 2. The runtime banner must be clear, or it sits across every frame of the video.
//    A container Runtime is also mandatory here: authorizeSpecialistTurn pauses
//    the task outright when the provider is anything else.
const system = await call("/api/system");
if (system.arkConfigured) ok(`ARK configured (${system.arkModel})`);
else bad("ARK_API_KEY / ARK_MODEL missing — agent runs will fail");

if (system.runtimeProvider !== "container") {
  bad(
    `runtime provider is "${system.runtimeProvider}", not "container".\n` +
    "        Protected resources require the disposable container Runtime; the\n" +
    "        task would pause with a Runtime message instead of a policy denial.",
  );
}

/**
 * Docker Desktop's containerd image store intermittently drops the
 * volc-agent-runtime:local reference: `docker images` still lists the row, but
 * `docker image inspect repo:tag` fails, which is exactly the check the server
 * runs in ContainerCodexRunner.isAvailable(). The image itself is intact and
 * still resolves by ID, so re-applying the tag restores it.
 */
function repairRuntimeImageTag(engine, image) {
  const run = (args) => execFileSync(engine, args, { encoding: "utf8", timeout: 10_000 });
  try {
    run(["image", "inspect", image]);
    return "already-ok";
  } catch {
    // fall through to repair
  }
  let id = "";
  try {
    id = run(["images", "--format", "{{.Repository}}:{{.Tag}} {{.ID}}"])
      .split("\n")
      .find((line) => line.startsWith(image + " "))
      ?.split(" ")[1] ?? "";
  } catch {
    return "engine-unreachable";
  }
  if (!id) return "image-absent";
  try {
    run(["tag", id, image]);
    run(["image", "inspect", image]);
    return "repaired";
  } catch {
    return "repair-failed";
  }
}

if (system.codexAvailable) {
  ok(`runtime available (${system.runtime})`);
} else if (system.runtimeProvider === "container") {
  const engine = system.containerEngine ?? "docker";
  const image = process.env.CONTAINER_RUNTIME_IMAGE ?? "volc-agent-runtime:local";
  const result = repairRuntimeImageTag(engine, image);

  if (result === "repaired") {
    const recheck = await call("/api/system");
    if (recheck.codexAvailable) {
      note(`"${image}" had lost its tag reference — re-tagged it, runtime is available again`);
      ok(`runtime available (${recheck.runtime})`);
    } else {
      bad(`re-tagged "${image}" but the server still reports the runtime unavailable`);
    }
  } else if (result === "image-absent") {
    bad(`runtime image "${image}" does not exist — build it before recording`);
  } else if (result === "engine-unreachable") {
    bad(`${engine} is not reachable — start it before recording`);
  } else {
    bad(
      `runtime unavailable and "${image}" could not be repaired.\n` +
      "        The yellow 'Runtime check' banner would show in every frame.\n" +
      `        Check manually:  ${engine} image inspect ${image}`,
    );
  }
} else {
  bad("runtime unavailable — the yellow 'Runtime check' banner will show in every frame.");
}

// 3. An aborted take leaves its team task behind. A running OR PAUSED task keeps
//    the start form hidden, and this demo ends every failed take in "paused".
const { tasks } = await call("/api/team-tasks");
const open = tasks.filter((t) => ["running", "queued", "paused"].includes(t.status));
if (open.length === 0) {
  ok("no team task is open");
} else {
  for (const task of open) {
    await call("/api/team-tasks/" + task.id + "/stop", { method: "POST" });
  }
  note(`stopped ${open.length} leftover team task(s) (${open.map((t) => t.status).join(", ")})`);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const current = (await call("/api/agents")).agents;
    if ([LEAD, ...SPECIALISTS].every((n) => !current.find((a) => a.name === n)?.activeTeamTaskId)) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

// 4. The protected document the whole task is authorized against.
let { resources } = await call("/api/resources");
let brief = resources.find((r) => r.name === BRIEF && r.ownedByCurrentUser);
if (!brief) {
  const created = await call("/api/resources", {
    method: "POST",
    body: JSON.stringify({ name: BRIEF, description: BRIEF_DESCRIPTION, content: BRIEF_CONTENT }),
  });
  brief = created.resource;
  note(`created protected resource "${BRIEF}"`);
}
ok(`protected resource "${BRIEF}" present and owned by Alice`);

// 5. Specialists must carry NO lease history.
//
//    The opening beat has to read GRANT_MISSING. security-service.ts returns that
//    only when no grant record exists for the agent/resource pair: a revoked one
//    yields GRANT_REVOKED and an expired one yields GRANT_EXPIRED. Revoking a
//    leftover lease is therefore NOT enough — the record has to be gone, and
//    recreating the agent is the only way to drop it. Every take after the first
//    needs this, or the denial quietly shows the wrong reason.
let { agents } = await call("/api/agents");

for (const name of SPECIALISTS) {
  let agent = agents.find((a) => a.name === name);
  if (!agent) {
    bad(`specialist "${name}" is missing — restart the server to reseed the demo Agents`);
    continue;
  }

  const history = (await call("/api/agents/" + agent.id + "/permissions")).grants;
  if (FRESH || history.length > 0) {
    if (agent.status === "busy") {
      bad(`"${name}" is busy — wait for its run to finish, then rerun this script`);
      continue;
    }
    // Preserve the seeded persona: the Lead picks specialists by description.
    const { description, instructions } = agent;
    await call("/api/agents/" + agent.id, { method: "DELETE" });
    const created = await call("/api/agents", {
      method: "POST",
      body: JSON.stringify({ name, description, instructions }),
    });
    agent = created.agent;
    note(
      history.length
        ? `recreated "${name}" — it carried ${history.length} past lease record(s), which would ` +
          `make the denial read "${history.some((g) => g.state === "revoked") ? "Capability was revoked" : "Capability expired"}" ` +
          'instead of "No matching capability"'
        : `recreated "${name}" — --fresh was requested`,
    );
  }

  const { grants } = await call("/api/agents/" + agent.id + "/permissions");
  if (grants.length === 0) ok(`"${name}" has no lease history`);
  else bad(`"${name}" still has ${grants.length} grant record(s) — rerun with --fresh`);
}

// 6. Roster must be ready and unreserved, or Start is disabled.
({ agents } = await call("/api/agents"));
for (const name of [LEAD, ...SPECIALISTS]) {
  const agent = agents.find((a) => a.name === name);
  if (!agent) bad(`team agent "${name}" is missing`);
  else if (agent.activeTeamTaskId) bad(`"${name}" is still reserved by a team task`);
  else if (agent.status !== "ready") bad(`"${name}" is "${agent.status}", not ready`);
  else ok(`team agent "${name}" is ready`);
}

console.log("");
if (problems.length) {
  console.log(`Not ready to record. ${problems.length} problem(s) above.\n`);
  process.exit(1);
}
console.log(`Ready to record${notes.length ? ` (${notes.length} note(s) above)` : ""}.`);
console.log("Next:  npx playwright test --config scripts/demo-video/playwright.config.ts\n");

import { test, expect, type Locator, type Page } from "@playwright/test";

/**
 * Records the PotatoGuard unified demo described in docs/UNIFIED_DEMO.md.
 *
 * ONE workflow: a team task on a protected document is denied mid-flight, the
 * whole task pauses, leases are issued, and the resumed task finishes using the
 * document. Permissioning and coordination are the same run, not two halves.
 *
 * The take is silent on purpose — narration is recorded to picture afterwards
 * using teleprompter.md, so the model's real latency never has to be guessed at
 * in advance.
 *
 * Every claim the narration makes is asserted here. A take that would have
 * recorded the wrong evidence fails loudly instead of looking fine on camera.
 */

const OBJECTIVE = `Plan our Tokyo trip strictly according to the protected brief.
Recommend dates, a neighbourhood, and a day-by-day plan within budget.`;

const BRIEF = "Tokyo Trip Brief";
const LEAD = "Trip Coordinator";
// Exactly two: every specialist turn is gated, so each needs its own lease.
const SPECIALISTS = ["Flight & Hotel Scout", "Budget Analyst"];

/**
 * 300s by default, NOT the 60s a live presenter would use.
 *
 * The lease has to outlive resume -> Lead re-delegates -> specialist reads,
 * which is two real model calls. A 60s lease can expire inside that window and
 * turn the ALLOW beat into a second GRANT_EXPIRED denial, wasting the take.
 * Narrate "five minutes"; the claim is identical and the take stops being a race.
 */
const LEASE_TTL = Number(process.env.DEMO_LEASE_TTL ?? 300);

/** How long to hold on a screen so a viewer can actually read it. */
const READ = Number(process.env.DEMO_READ ?? 4000);

async function hold(page: Page, ms = READ) {
  await page.waitForTimeout(ms);
}

/** Pick a <select> option by substring rather than exact label. */
async function chooseOption(select: Locator, contains: string) {
  const value = await select
    .locator("option", { hasText: contains })
    .first()
    .getAttribute("value");
  expect(value, `no option containing "${contains}"`).toBeTruthy();
  await select.selectOption(value!);
}

/** Sidebar agent card -> selects the agent and switches to Playground. */
async function openAgent(page: Page, name: string) {
  await page
    .locator(".agent-card")
    .filter({ has: page.locator("strong", { hasText: new RegExp(`^${name}$`) }) })
    .first()
    .click();
  await expect(page.locator(".agent-header h1")).toHaveText(name);
}

/** One of the four workspace tabs (only rendered outside the team view). */
async function openTab(page: Page, label: string) {
  await page.locator(".view-tabs button", { hasText: label }).click();
}

/**
 * Open the Activity log panel if it is closed.
 *
 * It is a <details> element, and TeamTaskView remounts every time the view is
 * left for the Playground, which collapses it again. A blind click would toggle
 * an already-open panel shut, so check the open state first.
 */
async function openActivityLog(page: Page) {
  const panel = page
    .locator("details.team-panel")
    .filter({ has: page.locator("summary", { hasText: "Activity log" }) })
    .first();
  await expect(panel).toBeVisible();
  if (!(await panel.evaluate((element) => (element as HTMLDetailsElement).open))) {
    await panel.locator("summary").first().click();
  }
  await expect(panel.locator(".team-log").first()).toBeVisible();
}

async function openTeamView(page: Page) {
  await page.getByRole("button", { name: /Team tasks/ }).click();
  await expect(page.getByRole("heading", { name: "Team Tasks" })).toBeVisible();
}

test("PotatoGuard unified demo", async ({ page, context }) => {
  const outcome: string[] = [];
  const api = async (path: string) => context.request.get(path).then((r) => r.json());

  // ---------------------------------------------------------------- sign in
  await page.goto("/");
  const loginButton = page.getByRole("button", { name: "Open Launchpad" });
  if (await loginButton.isVisible().catch(() => false)) {
    await loginButton.click();
  }
  await expect(page.locator(".app-shell")).toBeVisible();

  // The runtime warning must not be on screen; it would sit in every frame.
  await expect(page.locator(".config-banner")).toHaveCount(0);
  await hold(page, 1500);

  // ------------------------------- 0:00-0:25  start one task that needs the doc
  await openTeamView(page);

  const objective = page.getByLabel("What should the team do?");
  if (!(await objective.isVisible().catch(() => false))) {
    await page.locator(".team-panel summary", { hasText: "Start a task" }).first().click();
  }
  await expect(
    objective,
    "the start form is not showing — a task may still be open, or fewer than two agents are ready",
  ).toBeVisible();

  await objective.fill(OBJECTIVE);
  await hold(page, 800);
  await chooseOption(page.locator(".team-panel select").first(), LEAD);

  await page
    .locator("label.team-choice", { hasText: "You pick them" })
    .locator("input[type=radio]")
    .check();
  await hold(page, 600);

  // The protected document. This is what makes it one workflow rather than two.
  await chooseOption(page.getByLabel("Protected document (optional)"), BRIEF);
  await expect(page.locator(".team-hint", { hasText: "capability lease" })).toBeVisible();
  await hold(page, 1200);

  for (const specialist of SPECIALISTS) {
    await page
      .locator(".team-member-picker label.team-choice", { hasText: specialist })
      .locator("input[type=checkbox]")
      .check();
  }
  await hold(page, 900);

  await page.locator(".team-start-btn").click();

  await expect
    .poll(async () => (await api("/api/team-tasks")).tasks?.[0]?.status ?? "none", {
      timeout: 60_000,
      message: "team task never started",
    })
    .toMatch(/running|queued/);

  const taskId: string = (await api("/api/team-tasks")).tasks[0].id;
  outcome.push(`team task ${taskId} started against "${BRIEF}"`);
  await hold(page, 2500);

  // ------------------------------------------ 0:25-0:55  coordination, then the wall
  //
  // The Lead coordinates, delegates, and the first specialist turn is refused.
  // The task pauses ITSELF — nothing here clicks stop.
  await expect
    .poll(async () => (await api(`/api/team-tasks/${taskId}`)).task?.status ?? "unknown", {
      timeout: 5 * 60 * 1000,
      message: "the task never paused — did a specialist already hold a lease?",
    })
    .toBe("paused");

  const paused = await api(`/api/team-tasks/${taskId}`);
  expect(paused.task.lastError, "the pause was not a policy denial").toContain("GRANT_MISSING");

  const denial = paused.events.find(
    (event: { type: string; content: string }) =>
      event.type === "resource_authorization" && event.content.startsWith("DENY"),
  );
  expect(denial, "no DENY coordination event was written").toBeTruthy();

  const { agents } = await api("/api/agents");
  const deniedName: string = agents.find(
    (agent: { id: string }) => agent.id === denial.agentId,
  )?.name;
  outcome.push(`denied mid-flight: "${deniedName}" refused with GRANT_MISSING, task paused`);

  // Every participant is released, so the roster is selectable again.
  for (const name of [LEAD, ...SPECIALISTS]) {
    const agent = agents.find((item: { name: string }) => item.name === name);
    expect(agent?.activeTeamTaskId, `"${name}" was not released on pause`).toBeNull();
  }

  await hold(page, READ);

  // Show the denial in the coordination log, in colour, beside the handoffs.
  await openActivityLog(page);
  const denyRow = page.locator(".team-log-deny").first();
  await expect(denyRow).toBeVisible();
  await expect(denyRow).toContainText("Access decision");
  await denyRow.locator("summary").click();
  await hold(page, READ + 2000);

  // ------------------------------------------------ 0:55-1:25  grant least privilege
  //
  // Both specialists, or the resumed task can hit the wall a second time.
  for (const name of SPECIALISTS) {
    await openAgent(page, name);
    await openTab(page, "Access leases");
    await chooseOption(page.locator(".capability-card select").first(), BRIEF);
    await page.locator(".capability-card input").fill("Plan the trip from the brief");
    await page.locator(".capability-card select").nth(1).selectOption(String(LEASE_TTL));
    await hold(page, 700);
    await page.getByRole("button", { name: "Issue capability lease" }).click();
    await expect(page.locator(".lease-item.lease-active").first()).toBeVisible();
    await hold(page, 1200);
  }
  outcome.push(`leases issued to both specialists for ${LEASE_TTL}s`);

  // --------------------------------------------------- 1:25-2:15  resume and work
  await openTeamView(page);
  await page.getByRole("button", { name: "Resume" }).click();

  await expect
    .poll(async () => (await api(`/api/team-tasks/${taskId}`)).task?.status ?? "unknown", {
      timeout: 60_000,
      message: "the task did not resume",
    })
    .toBe("running");
  await hold(page, READ);

  // The proof: an ALLOW decision on a specialist turn.
  //
  // A second pause means the resumed turn was refused again — usually the leases
  // did not cover the Agent the Lead picked, or the protected resource changed
  // underneath the task. Fail immediately with the real reason instead of
  // burning ten minutes waiting for an ALLOW that cannot arrive.
  await expect
    .poll(
      async () => {
        const body = await api(`/api/team-tasks/${taskId}`);
        if (body.task?.status === "paused") {
          return `refused again after resume: ${body.task.lastError}`;
        }
        if (["stopped", "failed"].includes(body.task?.status)) {
          return `task ended as ${body.task.status}: ${body.task.lastError}`;
        }
        const allowed = body.events.some(
          (event: { type: string; content: string }) =>
            event.type === "resource_authorization" && event.content.startsWith("ALLOW"),
        );
        return allowed ? "allowed" : "waiting";
      },
      { timeout: 10 * 60 * 1000, message: "no specialist turn was ever authorized" },
    )
    .toBe("allowed");
  outcome.push("resumed task produced an ALLOW on a specialist turn");

  await openActivityLog(page);
  await expect(page.locator(".team-log-allow").first()).toBeVisible({ timeout: 60_000 });
  await hold(page, READ + 2000);

  // Let it finish if it will; the close does not depend on the synthesis.
  const finalStatus = await expect
    .poll(async () => (await api(`/api/team-tasks/${taskId}`)).task?.status ?? "unknown", {
      // The ALLOW already landed above, so this is only the synthesis tail.
      timeout: 5 * 60 * 1000,
      message: "team task never reached a terminal state",
    })
    .toBe("completed")
    .then(() => "completed")
    .catch(() => "unfinished");
  outcome.push(`task ${finalStatus}`);
  await hold(page, READ);

  // ------------------------------------------------ 2:15-3:00  one chain, one close
  const finished = await api(`/api/team-tasks/${taskId}`);
  expect(finished.eventsVerified, "coordination chain failed its tamper check").toBe(true);
  outcome.push(`coordination chain verified across ${finished.events.length} events`);

  await page.reload();
  await openTeamView(page);
  const activityAfter = page.locator(".team-panel summary", { hasText: "Activity log" });
  await expect(activityAfter).toContainText("verified");
  await openActivityLog(page);
  await hold(page, READ);

  // Both decisions, inline with the handoffs that caused them.
  await expect(page.locator(".team-log-deny")).toHaveCount(1);
  await expect(page.locator(".team-log-allow").first()).toBeVisible();
  await hold(page, READ + 2000);

  // The same two decisions, as authorization receipts on their own chain.
  await openAgent(page, deniedName);
  await openTab(page, "Audit receipts");
  await expect(page.locator(".chain-ok")).toHaveText("Hash chain verified");
  const rows = page.locator(".receipt-row").filter({ hasNot: page.locator(".receipt-head") });
  expect(await rows.count(), "expected receipts for this specialist").toBeGreaterThanOrEqual(1);
  outcome.push("authorization chain verified with the matching receipts");
  await hold(page, READ + 4000);

  console.log("\n--- take summary ---");
  for (const line of outcome) console.log("  " + line);
  console.log("--------------------\n");
});

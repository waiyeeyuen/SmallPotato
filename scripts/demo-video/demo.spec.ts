import { expect, test, type Locator, type Page } from "@playwright/test";

const PROFILE = "Tokyo Travel Profile";
const LEAD = "Trip Coordinator";
const SPECIALISTS = ["Flight & Hotel Scout", "Budget Analyst"];
const OBJECTIVE = `Using the protected Tokyo Travel Profile, create a practical 4-day Tokyo itinerary.
Respect every date, budget, dietary, pace, and neighbourhood preference in the file.
The Flight & Hotel Scout should recommend a suitable neighbourhood, airport transfer,
and lodging budget; the Budget Analyst should challenge costs and produce a compact SGD
budget table. The Lead must reconcile both contributions into one final Markdown plan.`;
const READ = Number(process.env.DEMO_READ ?? 3500);

async function chooseOption(select: Locator, contains: string) {
  const value = await select.locator("option", { hasText: contains }).first().getAttribute("value");
  expect(value, `no option containing ${contains}`).toBeTruthy();
  await select.selectOption(value!);
}

async function selectAgent(page: Page, name: string) {
  await page.locator(".agent-card").filter({ hasText: name }).first().click();
  await expect(page.locator(".agent-header h1")).toHaveText(name);
}

test("records the policy-governed Team Task story", async ({ page, context }) => {
  const api = async (path: string) => context.request.get(path).then((response) => response.json());
  await page.goto("/");
  const login = page.getByRole("button", { name: "Open Launchpad" });
  if (await login.isVisible().catch(() => false)) await login.click();
  await expect(page.locator(".app-shell")).toBeVisible();
  await expect(page.locator(".config-banner")).toHaveCount(0);

  // Denial: Alice and her Agent cannot read Bob's document.
  await selectAgent(page, LEAD);
  await chooseOption(page.getByLabel("Protected resource"), "Finance Report");
  await page.locator("form.composer textarea").fill(
    "Read the selected protected document and return its forecast.",
  );
  await page.locator("form.composer").evaluate((form) =>
    (form as HTMLFormElement).requestSubmit(),
  );
  await expect(page.locator(".policy-alert")).toContainText("Resource belongs to another user");
  await expect(page.locator(".chain-ok")).toHaveText("Hash chain verified");
  await page.waitForTimeout(READ);

  // Success: the Lead locks the roster before an inline human approval creates
  // separate task-bound specialist grants.
  await page.getByRole("button", { name: /Team tasks/ }).click();
  await expect(page.getByRole("heading", { name: "Team Tasks" })).toBeVisible();
  const objective = page.getByLabel("What should the team do?");
  await expect(objective).toBeVisible();
  await objective.fill(OBJECTIVE);
  await chooseOption(page.getByLabel("Lead agent"), LEAD);
  await page.getByText("The Lead picks them", { exact: true }).click();
  await page.getByLabel("Protected document (optional)").selectOption({ label: `${PROFILE} · yours` });
  await page.getByText("Ask me when needed", { exact: true }).click();
  await page.waitForTimeout(READ);
  await page.getByRole("button", { name: "Start task" }).click();

  const taskId = await expect.poll(async () => {
    const tasks = (await api("/api/team-tasks")).tasks ?? [];
    return tasks[0]?.id ?? "";
  }, { timeout: 60_000 }).not.toBe("").then(async () => (await api("/api/team-tasks")).tasks[0].id as string);

  const approval = page.locator(".team-access-request");
  await expect(approval).toContainText("blocked before execution", { timeout: 60_000 });
  await expect(approval).toContainText("The document has not been mounted");
  await page.waitForTimeout(READ);
  await approval.getByRole("button", { name: "Allow current roster" }).click();

  await expect.poll(async () => {
    const body = await api(`/api/team-tasks/${taskId}`);
    const types = body.events.map((event: { type: string }) => event.type);
    return types.includes("access_approval_granted") && body.events.some(
      (event: { type: string; content: string }) =>
        event.type === "resource_authorization" && event.content.startsWith("ALLOW"),
    );
  }, { timeout: 10 * 60 * 1000 }).toBe(true);
  await expect(page.locator(".team-note-allow").first()).toBeVisible();
  await page.waitForTimeout(READ);

  await expect.poll(async () => (await api(`/api/team-tasks/${taskId}`)).task.status, {
    timeout: 10 * 60 * 1000,
  }).toBe("ready");
  await page.reload();
  await page.getByRole("button", { name: /Team tasks/ }).click();
  const activity = page.locator("details.team-panel").filter({ hasText: "Activity log" }).first();
  await activity.locator("summary").first().click();
  await expect(activity).toContainText("verified");
  await expect(activity).toContainText("Task access closed");
  await page.waitForTimeout(READ);

  await selectAgent(page, SPECIALISTS[0]);
  await page.getByRole("button", { name: "Access leases" }).click();
  await expect(page.locator(".lease-item").filter({ hasText: "task-scoped" }).first())
    .toContainText("revoked");
  await page.getByRole("button", { name: "Audit receipts" }).click();
  await expect(page.locator(".chain-ok")).toHaveText("Hash chain verified");
  await expect(page.locator(".receipt-row").filter({ hasText: "Team Task" }).first()).toBeVisible();
  await page.waitForTimeout(READ + 2000);
});

# Multi-Agent Coordination Judge Demo

## Demo setup

Run `npm run poc`, open <http://localhost:3000>, and create three ready Agents:

| Agent | Description | Instructions |
| --- | --- | --- |
| Lead | Dynamic facilitator and final synthesizer | Read the latest shared transcript, choose the most relevant next specialist, and finish only when the objective is satisfied. |
| Builder | Implementation specialist | Build on existing shared work, verify requested artifacts, and report exact results. |
| Reviewer | Quality and risk specialist | Respond to earlier contributions, challenge assumptions, run relevant checks, and recommend fixes. |

## Three-minute happy path

1. Select **Team tasks**. Point out that the visual language, navigation, Agent cards,
   controls, and warm paper/purple design match the original Launchpad experience.
2. Enter this objective:

   ```text
   Build a small dependency-free web page in the shared workspace that explains
   three benefits of multi-agent coordination. Include an accessible heading,
   three benefit cards, and a README. Verify the files and review the result.
   ```

3. Choose **Lead** as Lead. Leave **Who picks the specialists? → "I choose"** and select
   **Builder** and **Reviewer**. (Switch it to **"The Lead chooses"** to let the Lead
   pick its own roster from every ready Agent — see the note below.) Start.
4. Show the server-owned workflow in motion: the active Agent, exact assignment,
   elapsed time, conversation-round count, and total turn count. On its **first turn**
   the Lead commits a coordination mode — `facilitated` (it picks the next Agent each
   turn) or `sequential` (the platform rotates the roster) — recorded as a
   `coordination_plan` event and locked for the rest of the task.
5. Conversation panel behaviour depends on the mode the Lead chose. A `facilitated`
   task (this objective) answers one question, so only the objective and the single
   final response appear there. A `sequential` task is a turn-by-turn exchange, so every
   agent's contribution (each number in a countdown) appears as its own message. Either
   way, **Activity and coordination evidence** holds the full hash-chained trail — every
   handoff, turn, attempt, assignment, and state patch.
6. When complete, the final response lands in the conversation; also show the Lead
   synthesis card and the released Agent statuses. Inspect the shared workspace path if
   desired to prove that the Agents created and reviewed a real artifact.
7. Select **Start another task**, enter a short second objective, and start it without
   refreshing. This proves terminal state was cleaned up end to end.

## Reusable conversation checks

### Countdown (Lead chooses the sequential mode)

Use two or three specialists and submit:

```text
Count down from 10 to 1, one number per turn. Each specialist contribution provides
exactly the next number, using the latest previous contribution to continue by one.
Complete only after 1 is contributed.
```

Expected: on its first turn the Lead recognises an ordered sequence and commits
`turnPolicy: "sequential"` (visible as the `coordination_plan` event). From then on the
**platform** — not the Lead — rotates through the roster in a fixed order, so turn-taking
is deterministic regardless of what the model picks. Ten specialist messages display
`10` through `1` in order; the first contribution is `10` (the sequence's starting
value, not `9`); the Lead writes each step's assignment, tracks progress in shared state
(`currentNumber`), and synthesises only after `1`. The mechanism is range- and
pool-size-agnostic: "count down from 25 to 3" or a two-agent pool behave the same way.
Rotation lives in `TeamTaskService.nextSequentialSpecialistId`
(`apps/server/src/team-task-service.ts`); there is no hard-coded `10` anywhere. A
sequence needs `2N+1` turns, so the 30-turn safety cap bounds `sequential` runs at
N ≈ 14 — a documented limitation for longer sequences.

For an open-ended objective (see below) the Lead instead commits
`turnPolicy: "facilitated"` and picks the most relevant Agent by ID every turn.

### Open-ended discussion

Include a practical advisor, a critic, and one deliberately irrelevant specialist:

```text
Discuss and come up with a reason why I should wear red or black today. Have relevant
specialists exchange opinions, respond to each other, and produce one practical
consolidated recommendation.
```

Expected: the Lead selects the advisor and critic based on their descriptions, the
critic receives and challenges the advisor's exact earlier message, the irrelevant
specialist can remain unused, and the Lead combines both viewpoints in the final answer.

### Lead picks only the relevant Agents ("The Lead chooses" mode)

Create a Lead plus six Agents **with real descriptions** — three that fit the objective
and three that clearly do not:

| Agent | Description |
| --- | --- |
| Trip Coordinator | Lead — plans travel and synthesises the itinerary |
| Flight & Hotel Scout | Finds flights, hotels, and neighbourhoods |
| Budget Analyst | Tracks and reconciles spend against a budget |
| Weather Forecaster | Seasonal climate and packing advice |
| Database Administrator | Tunes SQL queries and manages backups |
| Frontend Engineer | Builds React user interfaces |
| Legal Counsel | Reviews contracts and compliance |

Pick **Trip Coordinator** as Lead, set **Who picks the specialists? → "The Lead
chooses"**, and submit:

```text
Plan a 5-day trip to Tokyo in April for two people on a US$3000 budget. Recommend
when in April to go, which neighbourhood to stay in, and a rough day-by-day
itinerary that stays within budget.
```

Expected: the first `coordination_plan` event reads roughly *"Lead chose facilitated
coordination with 3 specialists: Flight & Hotel Scout, Budget Analyst, Weather
Forecaster"*, the Lead's `message` gives a one-line reason per pick, and the
Database Administrator, Frontend Engineer, and Legal Counsel return to **ready** (check
the Agent list or start-another-task form) — they were reserved at start and released
once the Lead named its roster. If Agents have blank descriptions the Lead cannot judge
relevance and will tend to keep everyone.

## Edge-case tests

### Validation and reservation

- Try to start with fewer than two ready Agents. The UI explains what is missing.
- Try to submit without an objective or specialist. The start control remains disabled.
- Start one Team Task, then attempt `POST /api/team-tasks` for another through DevTools.
  The API returns HTTP 409; the first task remains unchanged.
- Send an unrecognized creation field such as `currentAgentId` through DevTools. The
  API returns HTTP 400; workflow ownership cannot be injected by the browser.

### Stop and recovery

- While an Agent is working, choose **Stop task**. The Runtime turn is cancelled, the
  queue is cleared, the event log records the stop, and all participants return ready.
- Start a task, stop the server during a turn, then rerun `npm run poc`. The task appears
  paused with the restart reason. Choose **Resume**; the Lead reviews the interruption
  before coordination continues.
- Give a Lead instructions to emit invalid output for a failure rehearsal. The
  coordinator retries once, then pauses with the error visible. Restore valid Lead
  instructions and resume.
- Give a specialist instructions to emit invalid output. The coordinator retries once,
  records the failure, then returns the updated transcript to the Lead for a dynamic
  recovery decision.

### Consecutive tasks and stale state

- Complete a task and immediately select **Start another task**. The form is usable at
  once and auto-focuses the objective.
- Start the second task. Confirm task history contains both tasks, only the second is
  running, turn counts restart at zero, its queue begins empty, and no first-task
  thread or shared state appears in the detail view.

### Startup behavior

- With Launchpad already running, execute `npm run poc` in another terminal. The
  command exits successfully and points to the existing browser session instead of
  rebuilding and failing with `EADDRINUSE`.
- Occupy the configured port with a different process. The script reports the port
  conflict before doing an expensive build and suggests `PORT=<another-port> npm run poc`.

## Evidence checklist

- Normal end-to-end objective with real model calls and artifacts
- Lead planning, specialist routing, and Lead synthesis
- Live progress and waiting feedback
- Ordered backend event log and versioned shared state
- Retry, pause/resume, stop, and turn-limit safeguards
- Lead commits the coordination mode on turn 1 (`coordination_plan` event, then locked):
  `facilitated` = Lead picks the next Agent each turn; `sequential` = the platform
  rotates the roster deterministically — one coordination engine, chosen by the Lead
- Optional "Lead picks the specialists": the whole ready pool is reserved, then Agents
  the Lead leaves out of its roster are released back to `ready`
- Tamper-evident coordination event log: each event is hash-chained to the previous
  one (`chainHash` in `apps/server/src/audit.ts`, the same primitive as the
  authorization receipt chain); `GET /api/team-tasks/:id` returns `eventsVerified`
- Twelve-round collaboration stopping limit plus the global 30-turn safety limit
- Agent reservation and strict API validation
- Clean second task without page or process restart
- Automated tests and reproducible startup command

## Honest limitation and next step

This submission is intentionally single-user and permits one active Team Task. The
production evolution is multi-tenant identity plus a durable job queue, transactional
event store, and per-workspace locking so independent teams can coordinate concurrently.

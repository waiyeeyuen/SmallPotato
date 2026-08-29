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

3. Choose **Lead** as Lead. Select **Builder** and **Reviewer** as specialists. Start.
4. Show the server-owned workflow in motion: the active Agent, exact assignment,
   elapsed time, conversation-round count, and total turn count. Explain that after
   every specialist response, the Lead reads the new transcript and chooses the next
   relevant Agent instead of following a fixed order.
5. Show how the later specialist explicitly responds to an earlier contribution,
   plus the handoff messages and each distinct response. Expand
   **Activity and coordination evidence** to prove the ordered backend transitions,
   attempts, assignments, and state patches.
6. When complete, show the Lead synthesis and the released Agent statuses. Inspect the
   shared workspace path if desired to prove that the Agents created and reviewed a
   real artifact.
7. Select **Start another task**, enter a short second objective, and start it without
   refreshing. This proves terminal state was cleaned up end to end.

## Reusable conversation checks

### Countdown

Use three specialists with different descriptions and submit:

```text
Count down from 10 to 1 as a turn-by-turn shared conversation. Each specialist
contribution must provide exactly one next number, beginning with 10 and using the
latest previous contribution to continue by one. Complete only after 1 is contributed.
```

Expected: ten specialist messages display `10` through `1` in order. Each assignment
references the current conversation state, the Lead chooses an explicit Agent for every
turn, and final synthesis appears only after `1`. No countdown behavior exists in code.

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
- Dynamic next-Agent selection with a shared actor-labelled transcript
- Twelve-round collaboration stopping limit plus the global 30-turn limit
- Agent reservation and strict API validation
- Clean second task without page or process restart
- Automated tests and reproducible startup command

## Honest limitation and next step

This submission is intentionally single-user and permits one active Team Task. The
production evolution is multi-tenant identity plus a durable job queue, transactional
event store, and per-workspace locking so independent teams can coordinate concurrently.

# PotatoGuard judge runbook

This is the exact start-to-finish validation flow for Track 1 / Bouncer. Use
fictional content only.

## One-time setup

1. From the repository root, run `npm run check`.
   - Expected: typecheck, the full server test suite, and both production builds pass.
   - Show: the final green test/build summary.
2. Ensure `.env` contains valid `ARK_API_KEY` and `ARK_MODEL`, then run
   `npm run poc`.
   - Expected: Runtime image builds if needed; server listens on port 3000.
   - Show: `Local POC is ready` and no error.
3. Open <http://localhost:3000>.
   - Expected: the sign-in screen appears.
   - Show: the app is not usable anonymously.

## Happy path

| Step | You do | System does | Show judges |
| --- | --- | --- | --- |
| 1 | Choose Alice and sign in. | Verifies the scrypt password and sets an HttpOnly session cookie. | Alice's name in the sidebar; no user ID field in requests. |
| 2 | Create **Launch Analyst**. | Persists an Alice-owned Agent and generates a distinct Agent principal UUID. | Alice identity beside a different principal ID. |
| 3 | In Playground choose **No protected resource**, ask it to create `hello.txt`. | Runs an ordinary coding task with no protected mount. | Baseline Agent functionality still works. |
| 4 | Open **Protected resources**, create **Judge Brief** with fictional priorities. | Writes a server-owned `0600` text file under a server-generated name; returns metadata only. | Resource card, ownership, and size; content is not displayed after creation. |
| 5 | Open **Access leases**, select Judge Brief, purpose `Summarize for judges`, duration 60 seconds, and issue. | Creates a lease for exactly Launch Analyst's principal + read + Judge Brief + expiry. | Active state and live countdown. |
| 6 | In Playground select Judge Brief and ask for its priorities. | Records `allow`, mounts only that file read-only, runs the Agent, then links the Run to the receipt. | Real answer based on the document and the completed Run. |
| 7 | Open **Audit receipts**. | Verifies the full receipt hash chain. | Human, Agent principal, action, resource, `ALLOW`, reason, time, Run correlation, and **Hash chain verified**. |
| 8 | Click **Export CSV**. | Downloads the selected Agent's receipt evidence. | Open the CSV if time permits; no protected content is present. |

## Required denial and update cases

### A. Missing permission

1. Select Alice's **Launch Plan** before issuing a lease.
2. Send the protected-document prompt.
3. Expected: HTTP 403, `GRANT_MISSING`; no Run and no mount.
4. Show: automatic jump to Audit, denial banner, receipt ID.

### B. Cross-user resource

1. As Alice, select **Finance Report · Bob Lim · external**.
2. Send the same prompt.
3. Expected: HTTP 403, `RESOURCE_NOT_OWNED`; Bob's file never enters the Runtime.
4. Show: backend receipt naming Alice, her Agent, Bob's resource, read, deny.

### C. Revocation

1. Issue a Launch Plan lease and complete one allowed read.
2. Revoke it under **Access leases**.
3. Retry the read.
4. Expected: `GRANT_REVOKED`; the previous allowed result remains historical,
   but the next Run does not start.

### D. Expiry

1. Issue a 60-second lease and wait for its countdown to expire.
2. Retry the protected read.
3. Expected: `GRANT_EXPIRED`; no mount and no Runtime execution.

### E. Delete a protected resource

1. Create a user resource and grant it to the Agent.
2. Delete it from **Protected resources** and confirm.
3. Expected: the server removes its file, soft-deletes metadata, and revokes its
   active leases; it disappears from selectors.
4. Show: the lease is revoked and the resource is unavailable.

## Team Task authorization

A Team Task may name one protected resource. Every **specialist** turn is then
authorized independently before the Runtime is touched; the Lead is never granted
the document, so delegation cannot widen data access.

| Step | You do | System does | Show judges |
| --- | --- | --- | --- |
| 1 | Create a protected resource the team needs, e.g. **Tokyo Trip Brief**. | Writes a server-owned `0600` file; returns metadata only. | The resource card; content is not displayed. |
| 2 | Start a Team Task with a Lead, two specialists, and that document selected. | Reserves the roster and runs the Lead's first turn. | `coordination_plan`, then the first hand-off. |
| 3 | Wait. | The first specialist turn is refused; the task **pauses**, every Agent returns to `ready`, and a `DENY` event is written. | Paused banner naming the Agent and `GRANT_MISSING`; the red **Access decision** row in the Activity log. |
| 4 | Issue a read lease to **each** specialist for that resource. | Creates one lease per principal + read + resource + expiry. | Active state and countdown. |
| 5 | Press **Resume**. | The Lead reviews the interruption and re-delegates; the authorized turn mounts the file read-only at `/authorized-resources/<id>.txt`. | Green **Access decision · ALLOW** row; the answer quotes the document. |
| 6 | Open the Activity log and Audit receipts. | Verifies both hash chains. | `eventsVerified` true, **Hash chain verified**, and the decisions correlated to the turns that caused them. |

Authorization is per **turn**, not per task: a task with several specialist turns
produces one `ALLOW` receipt per turn, each against a live lease.

### Team Task denial cases

| Case | Action | Expected result |
| --- | --- | --- |
| No lease | Start a task on a resource with no lease issued. | First specialist turn refused, `GRANT_MISSING`, task paused, no container run. |
| Partial leases | Lease only one of two specialists. | The task pauses again when the Lead reaches the un-leased Agent. |
| Revoked mid-task | Revoke a lease while the task is running. | The next specialist turn is refused with `GRANT_REVOKED` and the task pauses. |
| Resource deleted mid-task | Delete the protected resource while a task references it. | The next specialist turn is refused with `RESOURCE_NOT_FOUND` and the task pauses. |
| No container Runtime | Set a non-container runtime provider. | The task pauses with a Runtime message; no policy decision is fabricated. |

## Coordination reliability cases

### Validation and reservation

- Try to start with fewer than two ready Agents. The UI explains what is missing.
- Try to submit without an objective or specialist. The start control stays disabled.
- Start one Team Task, then attempt `POST /api/team-tasks` for another through
  DevTools. The API returns HTTP 409; the first task is unchanged.
- Send an unrecognized creation field such as `currentAgentId` through DevTools.
  The API returns HTTP 400; workflow ownership cannot be injected by the browser.

### Stop and recovery

- While an Agent is working, choose **Stop task**. The Runtime turn is cancelled,
  the queue is cleared, the event log records the stop, and all participants
  return to `ready`.
- Start a task, stop the server during a turn, then rerun `npm run poc`. The task
  appears paused with the restart reason. Choose **Resume**; the Lead reviews the
  interruption before coordination continues.
- Give a Lead instructions to emit invalid output. The coordinator retries once,
  then pauses with the error visible. Restore valid instructions and resume.
- Give a specialist instructions to emit invalid output. The coordinator retries
  once, records the failure, then returns the updated transcript to the Lead for a
  dynamic recovery decision.

### Consecutive tasks and stale state

- Complete a task and immediately select **Start another task**. The form is
  usable at once and auto-focuses the objective.
- Start the second task. Task history contains both, only the second is running,
  turn counts restart at zero, its queue begins empty, and no first-task thread or
  shared state appears in the detail view.

### Coordination modes

On its **first turn** the Lead commits a mode, recorded as a `coordination_plan`
event and locked for the rest of the task:

- `facilitated` — the Lead picks the next Agent by ID every turn, and is rejected
  if it names an Agent outside the authorized pool.
- `sequential` — the platform rotates the roster deterministically
  (`TeamTaskService.nextSequentialSpecialistId`). A sequence needs `2N+1` turns,
  so the 30-turn safety cap bounds these runs at about 14 steps.

To exercise `sequential`, give two or three specialists this objective:

```text
Count down from 10 to 1, one number per turn. Each specialist contribution provides
exactly the next number, using the latest previous contribution to continue by one.
Complete only after 1 is contributed.
```

To exercise the Lead choosing its own roster, set **Who picks the specialists? →
"The Lead chooses"** with a mixed pool of relevant and irrelevant Agents. The
whole ready pool is reserved at start, and the Agents the Lead leaves out are
released back to `ready`. Agents with blank descriptions cannot be judged for
relevance, so the Lead tends to keep everyone.

### Startup behavior

- With Launchpad already running, execute `npm run poc` in another terminal. It
  exits successfully and points at the existing session instead of failing with
  `EADDRINUSE`.
- Occupy the configured port with another process. The script reports the conflict
  before an expensive build and suggests `PORT=<another-port> npm run poc`.

## Browser-ID tampering proof

While signed in as Alice, open browser developer tools and run:

```js
fetch("/api/agents", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "Forged Agent", ownerUserId: "user-bob" })
}).then(async response => console.log(response.status, await response.json()))
```

Expected: `400` with `ownerUserId` reported as an unrecognized key. No Agent is
created. Explain that ownership comes from the server session, not browser
input. The automated HTTP-boundary test proves the same case in `npm run check`.

## Reliability edge cases

| Case | Action | Expected result |
| --- | --- | --- |
| Wrong password | Sign in with any wrong password. | Generic 401; no indication whether a username exists. |
| Anonymous API | Clear site cookies and call `/api/agents`. | 401; UI returns to sign-in. |
| Page reload during Run | Reload while a Run is queued/running. | Session and selected Agent recover; polling resumes until terminal state. |
| Stopped Agent | Stop the Agent, then try to send. | Composer is disabled; start restores it. |
| Foreign Agent URL | As Bob, request an Alice Agent UUID directly. | 404, preventing ownership enumeration. |
| Runtime unavailable | Stop the container engine or omit Ark config. | Visible configuration/runtime warning; protected policy decisions remain server-side. |
| Receipt modification | Change a stored receipt in a test copy. | Hash verification becomes invalid; covered by automated tamper test. |

## What to say if judges ask about production

“The authorization and Runtime mount boundary are real; the identities and
storage are intentionally local hackathon fixtures. The next production step is
OIDC/SSO, transactional policy storage, signed receipts in an external WORM
audit sink, HTTPS/Secure cookies, and hardened per-tenant Runtime isolation.”

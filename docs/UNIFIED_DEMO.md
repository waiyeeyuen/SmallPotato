# PotatoGuard unified three-minute demo

One workflow, start to finish: a team of Agents works on a protected document,
hits the policy wall mid-flight, and continues only after you grant a lease.
Permissioning and coordination are not two halves of this demo — they are the
same run.

The thesis: **an Agent's authority is granted by the server, never claimed by the
Agent — and delegation can never widen it.**

| Authority | Question | Enforced by | Evidence |
| --- | --- | --- | --- |
| **Data** | Which files may this Agent read? | A capability lease, checked before every specialist turn | Authorization receipts |
| **Delegation** | Which Agents may this Lead call? | The authorized specialist pool, checked on every Lead turn | Coordination events |

Both chains use the same primitive: `chainHash` in
[`apps/server/src/audit.ts`](../apps/server/src/audit.ts).

## How the enforcement works

A Team request can name one protected resource from its chat composer. Every **specialist** turn is then
authorized independently through `SecurityService.authorizeResourceRead` before
the Runtime is touched:

- **Allow** — the file is mounted read-only at `/authorized-resources/<id>.txt`
  for that turn only, and an `ALLOW` coordination event is written.
- **Deny** — a `DENY` event is written, the whole task **pauses** with the reason,
  every Agent is released to `ready`, and no container runs.

The Lead is deliberately *not* granted the document. It coordinates without the
data, so a Lead cannot hand out access it does not itself hold. See
`authorizeSpecialistTurn` in
[`apps/server/src/team-task-service.ts`](../apps/server/src/team-task-service.ts).

## Prepare before the timer

1. `npm run poc`, open <http://localhost:3000>, confirm the Runtime banner is clear.
   The container Runtime is required — protected resources are refused otherwise.
2. Sign in as Alice (`alice` / `alice-potato`). Seven Agents are pre-seeded.
3. In **Protected resources**, create **Tokyo Trip Brief** with fictional content
   the team genuinely needs, for example:

   ```text
   Travellers: 2. Budget: US$3000 all-in.
   Avoid the first week of April (company offsite).
   Prefer a walkable neighbourhood with fast airport access.
   One splurge dinner is approved; no guided tours.
   ```

4. Confirm **no Agent holds a lease** for it. Deny-by-default is the opening beat.
5. Fill the **Team tasks** form but do not press Start:
   - Objective: *"Plan our Tokyo trip strictly according to the protected brief.
     Recommend dates, a neighbourhood, and a day-by-day plan within budget."*
   - Lead: **Trip Coordinator**
   - Who picks the members: **You pick them** → **Flight & Hotel Scout** and
     **Budget Analyst**
   - Protected document: **Tokyo Trip Brief**
6. Fictional data only. Do not open `.env`, logs, or the host resource directory.

> **Use exactly two specialists.** Every specialist turn is gated, so each one
> needs its own lease. Two keeps the conversation real while letting you grant
> both leases in one visit to the Access leases view.

## Timed script

### 0:00–0:25 — Start one task that needs protected data

Press Start. While the Lead takes its first turn, set up the whole demo in one
breath:

> "Alice owns these Agents, and each has a principal ID separate from hers. This
> team is planning a trip from a document none of them is allowed to read yet.
> Watch what the platform does about that."

### 0:25–0:55 — Coordination, then the wall

The Lead commits its coordination mode and delegates. Point at the live panel:
active Agent, the exact assignment, the `coordination_plan` event.

Then the first specialist turn is refused and **the task pauses on its own**.

- The banner names the Agent and the reason: `GRANT_MISSING`.
- The Activity log shows a red **Access decision · DENY** row.
- Every Agent has dropped back to **ready**.

> "The Lead has delegation authority — it chose who works next. It does not have
> data authority, and it cannot grant any. That specialist was refused before a
> container started, so the brief was never mounted. The whole workflow stopped
> rather than continuing without the data."

### 0:55–1:25 — Grant least privilege

Open **Access leases**. Issue a **5-minute read lease** for **Tokyo Trip Brief**
to **both** specialists, purpose `Plan the trip from the brief`.

> "One resource, one action, one Agent, and an expiry. Nothing is standing."

> **Why five minutes and not sixty seconds.** The lease has to outlive the resume,
> the Lead's re-delegation, and the specialist's read — two real model calls. A
> 60-second lease can expire inside that window and turn your ALLOW beat into a
> second denial. If you want to show a short countdown, use 60 seconds only when
> you are confident of the model's latency; the optional revoke beat below proves
> immediacy far more reliably than a race against expiry.

### 1:25–2:15 — Resume, and watch it work

Return to **Team tasks** and press **Resume**. The Lead reviews the interruption,
re-delegates, and this time the specialist turn is authorized: a green
**Access decision · ALLOW** row appears and the answer quotes real constraints
from the brief — the offsite week, the US$3000 cap, the walkable neighbourhood.

> "Same team, same objective, same Lead decision. The only thing that changed is
> a lease. The file is mounted read-only for that turn and gone afterwards."

Let it run to the Lead's synthesis if the clock allows.

### 2:15–3:00 — One chain, one close

Split the last stretch across both evidence views:

- **Team tasks → Activity log**: the deny and the allow sit inline with the
  handoffs and assignments that caused them, hash-chained, `eventsVerified` true.
- **Audit receipts**: the same two decisions as authorization receipts — human
  name, Agent principal, resource, action, reason, timestamp, **Hash chain
  verified**.

> "One workflow produced both records. Delegation decided who works; leases
> decided what they could read; neither Agent chose either; and both are written
> to the same tamper-evident chain. That is one control plane."

Click **Export CSV**.

## Timing and failure recovery

- The pause arrives after just **one** model call (the Lead's first turn), so the
  most important beat lands early and cheaply.
- After the resume it is roughly three more calls: Lead re-delegates, specialist
  reads, Lead synthesises. If the clock is short, close on the ALLOW row and the
  two chains rather than waiting for the synthesis.
- **If you selected more than two specialists**, an un-leased one can pause the
  task a second time. Grant every selected specialist a lease at the 0:55 beat.
- If the Lead misbehaves, **Stop task** releases every Agent immediately and the
  Activity log still holds the full chain — the evidence close works from a
  stopped task.
- If the container Runtime is down, the task pauses with a Runtime message
  instead of a policy denial. Fix the engine before starting; this is the one
  failure that has no good narration.

## Optional beat if you have spare time

Revoke a lease while the task is running. The next specialist turn is refused
with `GRANT_REVOKED` and the workflow pauses again mid-flight — the strongest
possible statement that revocation is not advisory.

## What to say about production

The authorization boundary, the Runtime mount, and both hash chains are real.
Identity and storage are local hackathon fixtures. The next steps are OIDC/SSO,
transactional policy storage, signed receipts in an external WORM sink, and
per-tenant Runtime isolation.

## Related documents

- [JUDGE_RUNBOOK.md](JUDGE_RUNBOOK.md) — exhaustive validation: the single-Agent
  happy path, every denial case, Team Task authorization, coordination modes,
  stop/resume, stale state, and browser-ID tampering
- [POTATOGUARD_ARCHITECTURE.md](POTATOGUARD_ARCHITECTURE.md) — trust boundary diagram
- [COORDINATION_ARCHITECTURE.md](COORDINATION_ARCHITECTURE.md) — how the Lead and
  specialists are orchestrated
- [`scripts/demo-video/`](../scripts/demo-video/README.md) — records this exact
  script as a repeatable take

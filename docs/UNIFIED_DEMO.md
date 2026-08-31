# PotatoGuard three-minute demo

## Claim

PotatoGuard makes multi-Agent coordination useful on private data without
confusing human ownership, Agent authority, or Lead delegation.

| Authority | Meaning | Enforcement evidence |
| --- | --- | --- |
| Human identity | Alice and Bob own different Agents, tasks, and documents | HttpOnly server session and owner-filtered APIs |
| Agent data authority | A specialist may read one resource only under an active manual or task-bound capability | Pre-Runtime decision, read-only mount, access receipt |
| Lead delegation | The Lead may route only to the task's authorized specialist roster | Validated structured decision and coordination event |

The recommended flow is automatic but not ambient: selecting **Authorize for
this task** is Alice's explicit consent to create separate temporary read
capabilities for the final specialist roster. Each capability carries the task
ID, cannot be reused in the Playground or another task, and is revoked when the
persistent team ends. The Lead never receives the document.

## Prepared state

Run:

```bash
npm run poc
node scripts/demo-video/prepare.mjs --smoke
```

Then open <http://localhost:3000>. The preparation script ensures:

- a real Ark-backed turn succeeds inside the container Runtime;
- Alice owns **Tokyo Travel Profile**;
- no Alice task is running or paused;
- Trip Coordinator, Flight & Hotel Scout, and Budget Analyst are ready.

Use `alice` / `alice-potato`. All demo content is fictional.

## Exact three-minute recording plan

| Time | Exact actions | Narration | Expected proof |
| --- | --- | --- | --- |
| 0:00–0:20 | Sign in as Alice. Select **Trip Coordinator**. Point to Alice in the sidebar and the Agent principal under its name. | “Alice is the authenticated human. Every Agent she owns has a different non-human principal, so owning an Agent does not silently give it all of her access.” | Human and Agent identities are visibly separate. |
| 0:20–0:45 | Open **Playground**. Select **Finance Report · Bob Lim · external**. Enter: `Read the selected protected document and return its forecast.` Press Enter. | “Alice can discover that Bob has a protected document, but private metadata is redacted. Neither Alice nor her Agent owns it.” | Immediate deny; `RESOURCE_NOT_OWNED`; no Runtime starts and no protected mount occurs. |
| 0:45–1:05 | Open **Audit receipts**. Point to the red deny row, Alice → Agent principal, Finance Report, and **Hash chain verified**. | “The backend denied this before execution and still produced attributable evidence: human, Agent principal, action, resource, reason, and hash.” | Identity and authorization failure path with auditable evidence. |
| 1:05–1:45 | Click **Team tasks** → **New task** if needed. Paste the objective below. Choose **Trip Coordinator**, **You pick them**, **Flight & Hotel Scout**, **Budget Analyst**, and **Tokyo Travel Profile**. Leave **Authorize for this task** selected. Click **Start task**. | “Now Alice explicitly attaches her own travel profile to one team task. PotatoGuard creates a separate read-only capability for each selected specialist, bound to this task only. The Lead coordinates but never sees the raw document.” | Task-access event appears, roster is reserved, Lead establishes a coordination plan and delegates. |
| 1:45–2:25 | Show the live conversation. Point to **Task-scoped access**, current Agent/assignment, then the green **Access decision · ALLOW** event when it appears. | “The Lead chooses who should work next. Before every specialist turn, policy independently checks that exact principal, document, action, expiry, and task ID. Only then is the document mounted read-only into that disposable turn.” | Multi-Agent routing and authorization are part of one real workflow. |
| 2:25–2:45 | When the answer is ready, point to the final Lead synthesis and the enabled follow-up composer. Then click **End team** and point to **Task access closed**. | “The specialists use the dates, budget, and preferences, and the Lead synthesizes their actor-labelled contributions. The roster and access remain available for follow-ups until Alice ends the team; then every task capability is revoked.” | Real private-context output and the persistent-team lifecycle are visible. |
| 2:45–3:00 | Select a specialist → **Access leases** (show revoked task-scoped lease), then **Audit receipts** (show Team Task ALLOW). | “Delegation decided who worked; capability policy decided what each Agent could read. Neither authority was claimed by a model, and both are tamper-evident.” | End-of-team revocation and correlated authorization evidence close the story. |

Use this exact objective:

```text
Using the protected Tokyo Travel Profile, create a practical 4-day Tokyo itinerary.
Respect every date, budget, dietary, pace, and neighbourhood preference in the file.
The Flight & Hotel Scout should recommend a suitable neighbourhood, airport transfer,
and lodging budget; the Budget Analyst should challenge costs and produce a compact SGD
budget table. The Lead must reconcile both contributions into one final Markdown plan.
```

## Backup actions

- **Model latency:** keep recording the real loading state, then cut directly to
  a completed rehearsal task in History if you have one. The preparation script
  never fabricates a completed task; do not claim a prior task completed during
  the uncut interval.
- **Task pauses on a model-format error:** show the retry/failure events and click
  **Resume**. This is genuine middleware recovery evidence.
- **Runtime warning:** do not record. Rerun `node scripts/demo-video/prepare.mjs`;
  it validates Ark and repairs the local Runtime image tag when possible.
- **Need a deterministic deny/recover variant:** start the same task with
  **Require manual approval**. The first specialist is denied with
  `GRANT_MISSING`; issue a five-minute manual lease to each selected specialist,
  return to Team Tasks, and click **Resume**.
- **Need to finish inside three minutes:** the mandatory evidence is the
  cross-user denial, task access issuance, Lead handoff, one specialist ALLOW,
  verified Activity log, and a revoked task lease. The full synthesis can be
  shown from a prior successful rehearsal item.

## What is real, and what is POC scope

The model calls, server policy, read-only container mounts, tenant checks,
task-state machine, retries, and hash verification are real. Alice/Bob identities
and JSON persistence are local fixtures. Hash chains detect changes but are not
external signed audit logs. The production path is OIDC, transactional policy
storage, a durable queue, hardened tenant sandboxes, and signed receipts in a
WORM sink.

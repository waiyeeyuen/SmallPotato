# PotatoGuard three-minute demo

## Claim

PotatoGuard makes multi-Agent coordination useful on private data without
confusing human ownership, Agent authority, or Lead delegation.

| Authority | Meaning | Enforcement evidence |
| --- | --- | --- |
| Human identity | Alice and Bob own different Agents, tasks, and documents | HttpOnly server session and owner-filtered APIs |
| Agent data authority | A specialist may read one resource only under an active manual or task-bound capability | Pre-Runtime decision, read-only mount, access receipt |
| Lead delegation | The Lead may route only to the task's authorized specialist roster | Validated structured decision and coordination event |

The recommended judging flow uses **The Lead picks them** with **Ask me when
needed**. The Lead first chooses a roster using only Alice's objective. When the
first specialist needs the file, PotatoGuard pauses before execution and asks
Alice in the Team chat. Choosing **Allow current roster** creates separate
temporary read capabilities only for that final roster. Each capability carries
the task ID, cannot be reused in the Playground or another task, and is revoked
when the persistent team ends. The Lead never receives the document.

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
| 0:20–0:45 | Open **Playground**. Select **Finance Report · Bob Lim · external**. Enter: `Read the selected protected document and return its forecast.` Press Enter. | “Alice can discover that Bob has a protected document, but private metadata is redacted. Bob has not shared it with her.” | Immediate deny; `SHARE_MISSING`; no Runtime starts and no protected mount occurs. |
| 0:45–1:05 | Open **Audit receipts**. Point to the red deny row, Alice → Agent principal, Finance Report, and **Hash chain verified**. | “The backend denied this before execution and still produced attributable evidence: human, Agent principal, action, resource, reason, and hash.” | Identity and authorization failure path with auditable evidence. |
| 1:05–1:35 | Click **Team tasks** → **New task** if needed. Paste the objective below. Choose **Trip Coordinator**, **The Lead picks them**, **Tokyo Travel Profile**, and **Ask me when needed**. Click **Start task**. | “Alice gives the Lead the goal, not the raw file. The Lead selects the minimum specialist roster first; delegation still cannot grant data access.” | The Lead establishes and locks a coordination plan before any document grant exists. |
| 1:35–2:15 | When the PotatoGuard card appears, point to **blocked before execution**, the named Agent, purpose, read-only permission, and expiry. Click **Allow current roster**. | “PotatoGuard intercepted the first unauthorized read before a specialist Runtime or mount existed. Alice can deny, allow one turn, allow one Agent, or approve only this locked roster. I’ll approve the roster once.” | The request resumes automatically; separate task-bound grants are issued only to the final specialists, followed by a green **Access decision · ALLOW**. |
| 2:15–2:40 | Show both specialist contributions and the final Lead synthesis. Open **Activity log** and point to approval, ALLOW, and **verified**. | “Each specialist is checked independently before its disposable turn. The file is mounted read-only; the Lead sees actor-labelled results, never the document. The second specialist needs no extra prompt because Alice approved this exact roster.” | Multi-Agent routing and step-up authorization appear as one coherent workflow with tamper-checked evidence. |
| 2:40–2:50 | Click **End team** and point to **Task access closed**. | “The team stays available for follow-ups until Alice ends it. Then every roster capability is revoked together.” | The persistent-team lifecycle closes cleanly. |
| 2:50–3:00 | Select a specialist → **Access leases** (show revoked task-scoped lease), then **Audit receipts** (show Team Task ALLOW). | “Delegation decided who worked; capability policy decided what each Agent could read. Neither authority was claimed by a model, and both are tamper-evident.” | End-of-team revocation and correlated authorization evidence close the story. |

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
- **Inline approval is taking too long:** use **You pick them** with **Authorize
  for this task**. Alice's explicit start action creates separate task-bound
  grants immediately for the selected specialists, while the Lead still gets no
  document mount.
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

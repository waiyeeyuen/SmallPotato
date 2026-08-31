# PotatoGuard

**PotatoGuard is runtime authorization middleware for single-Agent and multi-Agent autonomous workflows.** It separates human identity from Agent identity, lets users delegate narrowly scoped and revocable access to protected resources, and enforces authorization before protected data enters the Agent Runtime.

> **The Agent can decide what it wants to do. PotatoGuard decides what it is allowed to access.**

This repository is our **Track 1 / Bouncer** submission built on the Volc Agent Launchpad starter kit.

---

## Why PotatoGuard?

Autonomous Agents create a control problem: an Agent may be misconfigured, manipulated by untrusted input, or simply make the wrong decision. Giving that Agent all of a human user's authority violates least privilege and makes the model itself part of the security boundary.

PotatoGuard moves that boundary out of the model and into trusted middleware:

- the authenticated human and the Agent have separate identities;
- protected-resource authority is delegated to a specific Agent principal, not inherited from the human;
- access is scoped to a resource, action, context, expiry, and revocation state;
- both single-Agent and multi-Agent execution paths converge on the same server-side authorization boundary;
- authorization is enforced immediately before protected Runtime access;
- denied requests stop before the protected file is mounted or the protected Agent Run begins; and
- security decisions produce attributable, tamper-evident audit receipts.

The UI explains and visualizes these controls, but **the security decision is enforced in the backend / Runtime path, not in the browser**.

---

## Core Middleware Capabilities

### 1. Human / Agent Identity Separation

- Demo users such as Alice and Bob authenticate against server-side identities backed by scrypt password hashes.
- Each Agent receives its own **server-generated principal UUID (`principalId`)**, independent of the human who owns it.
- Requests are attributed from the server session; browser-supplied owner/user identity fields are not trusted.
- Foreign Agent/task lookups are owner-filtered and use `404` where appropriate to avoid ownership enumeration.

**Implementation:** `apps/server/src/security-service.ts`, `apps/server/src/app.ts`, `apps/server/src/types.ts`

---

### 2. Scoped, Revocable Access Leases

Protected-resource authority is represented as a temporary capability scoped to the relevant Agent and operation rather than as standing human authority.

Conceptually:

```text
Agent principal + action + resource + context + expiry + revocation state
```

- grants can expire automatically;
- owners can revoke access;
- Team Task capabilities are issued only to the authorized specialist roster and are revoked when the team lifecycle ends; and
- cross-user resource sharing uses explicit owner-controlled grants rather than implicit access.

**Implementation:** `apps/server/src/security-service.ts`, `apps/server/src/types.ts`, `apps/server/src/team-task-service.ts`

---

### 3. Multi-Agent Team Task Coordination

PotatoGuard protects both **single-Agent Playground runs** and **multi-Agent Team Tasks**.

In a Team Task, a lead/orchestrator coordinates multiple specialist Agents. Each specialist has its own Agent principal and is authorized independently before accessing a protected resource.

```text
                    Team Task
                       |
                Lead / Orchestrator
                       |
           +-----------+-----------+
           |           |           |
           v           v           v
       Agent A     Agent B     Agent C
       principal   principal   principal
           |           |           |
           +-----------+-----------+
                       |
                       v
                  PotatoGuard
                       |
                 ALLOW / DENY
                       |
                       v
                  Agent Runtime
```

PotatoGuard does **not** grant blanket authority to the Team Task. Protected-resource access remains scoped to the specialist Agent, resource, action, task context, expiry, and revocation state.

If a specialist lacks authority, the protected turn is denied before Runtime access. Where manual approval is enabled, the Team Task can pause, obtain human approval, and resume with newly delegated authority.

This means the same middleware boundary protects:

- **Single-Agent execution** — one Agent is checked before a protected Run.
- **Multi-Agent execution** — every specialist is checked independently before its protected turn.

**Implementation:** `apps/server/src/team-task-service.ts`, `apps/server/src/security-service.ts`, `apps/web/src/TeamTaskView.tsx`

---

### 4. Pre-Runtime Authorization Enforcement

Before a protected resource is exposed to an Agent turn, PotatoGuard evaluates the authenticated actor, Agent ownership, resource authority, grant state, expiry/revocation state, and execution context.

```text
Single Agent -------------------\
                                 \
                                  > PotatoGuard policy check
                                 /
Team Task specialist -----------/

                     /                 \
                   DENY               ALLOW
                    |                   |
             no protected Run     approved file only
             no protected mount   mounted read-only
                    |                   |
               audit receipt        Agent Runtime
```

**DENY** ends the protected request before the Agent Runtime receives the file. **ALLOW** permits only the approved server-controlled resource path to be mounted into the disposable Runtime.

**Implementation:** `apps/server/src/security-service.ts`, `apps/server/src/app.ts`, `apps/server/src/container-codex-runner.ts`

---

### 5. Cross-User Resource Isolation

- A user does not gain protected-resource access merely by knowing another user's resource or Agent identifier.
- Cross-user reads require an explicit active share/grant from the resource owner.
- Missing, revoked, expired, wrong-context, foreign-Agent, foreign-resource, or deleted-resource requests are rejected before protected Runtime execution.

**Implementation:** `apps/server/src/security-service.ts`, `apps/server/src/app.ts`

---

### 6. Read-Only Protected Runtime Mounts

On an authorized protected turn, the server mounts only the approved protected-resource path into the disposable local container as read-only. Ordinary Agent workspace access remains separate from the protected-resource vault.

The host controls these mounts; PotatoGuard does **not** claim that the host itself is unable to access its own files. The security property demonstrated by this POC is that **protected vault files are not exposed to the Agent Runtime until the trusted server-side authorization gate returns ALLOW**.

**Implementation:** `apps/server/src/container-codex-runner.ts`, `Dockerfile.runtime`

---

### 7. Tamper-Evident Audit Receipts

Authorization and resource-management actions generate receipts with human / Agent attribution. Receipts are linked by hash so modification of stored evidence is detectable during chain verification.

Audit evidence can include:

- human identity;
- Agent principal;
- resource/action;
- ALLOW or DENY decision and reason;
- timestamp;
- Run / Team Task correlation where applicable; and
- receipt-chain hashes.

The UI can verify the chain and export decision evidence as CSV without exporting protected document contents.

**Implementation:** `apps/server/src/audit.ts`, `apps/server/src/security-service.ts`, `apps/server/src/store.ts`

---

## Architecture and Trust Boundaries

The required one-page architecture diagram is here:

**[docs/POTATOGUARD_ARCHITECTURE.md](docs/POTATOGUARD_ARCHITECTURE.md)**

It shows both execution modes:

```text
Single-Agent Playground --------\
                                 > PotatoGuard -> ALLOW / DENY -> Runtime
Team Task specialists ----------/
```

The architecture highlights two primary trust boundaries:

1. **Browser → Fastify control plane** — the browser supplies user intent, while authenticated identity and ownership are resolved server-side.
2. **Control plane / protected vault → Agent Runtime** — PotatoGuard makes the final authorization decision before any protected file is mounted into the disposable Runtime.

The diagram also identifies the **enforcement point**, **instrumentation / audit path**, and **denial / recovery behavior**.

---

## Request Path

### Single-Agent protected Run

1. A human signs in and receives a server-managed HttpOnly session.
2. The server resolves the human actor from that session.
3. The human owns Agents, but each Agent has a separate `principalId`.
4. The user grants bounded protected-resource authority to the Agent.
5. The protected Agent turn requests a resource.
6. PotatoGuard evaluates ownership and active capability state **before Runtime execution**.
7. On **DENY**, the server records evidence and does not create the protected mount / protected Run.
8. On **ALLOW**, only the approved resource is mounted read-only into the Runtime and the real Codex / Ark-backed Agent turn proceeds.
9. Authorization and execution evidence are correlated in the audit trail.

### Multi-Agent Team Task

1. A Team Task orchestrator selects or coordinates specialist Agents.
2. Each specialist retains its own Agent principal.
3. Before a specialist receives a protected resource, PotatoGuard evaluates that specialist's authority independently.
4. An unauthorized specialist turn is blocked before protected Runtime access.
5. Where manual access approval is enabled, the task can pause, obtain human approval, and resume with newly delegated authority.
6. Team Task and authorization events remain correlated in the audit trail.

---

## Repository Structure

```text
apps/server/src/
  app.ts                         # HTTP/session boundary and protected-run routes
  security-service.ts            # PotatoGuard policy, grants, ownership, receipts
  security-service.test.ts       # Authorization / lease / sharing tests
  agent-service.ts               # Agent lifecycle and Run management
  agent-service.test.ts
  team-task-service.ts           # Lead/specialist coordination + scoped delegation
  team-task-service.test.ts
  container-codex-runner.ts      # Disposable Runtime and protected mounts
  container-codex-runner.test.ts
  audit.ts                       # Receipt hashing and verification primitives
  store.ts                       # Local JSON persistence
  store.test.ts
  types.ts                       # Agent, principal, grant and decision structures

apps/web/src/
  App.tsx                        # Main UI, resources, sharing, receipts
  TeamTaskView.tsx               # Team Task + inline authorization controls

docs/
  POTATOGUARD_ARCHITECTURE.md    # Required one-page architecture
  architecture.mmd               # Raw Mermaid architecture source
  demo-runbook.md                # Three-minute live demo
  JUDGE_RUNBOOK.md               # Extended validation / edge cases

scripts/
  start-local-poc.sh             # One-command local judging path
```

---

## Prerequisites

- **Node.js 22+**
- **npm 10+**
- one supported container engine: **Docker**, **Colima**, or **rootless Podman**
- a **Volcengine / BytePlus Ark API key** and a model / endpoint compatible with the configured runtime

Codex CLI is included in the Runtime image; a host Codex installation is not required.

---

## Setup

### 1. Clone

```bash
git clone https://github.com/waiyeeyuen/SmallPotato.git
cd SmallPotato
```

### 2. Install and configure

```bash
npm install
cp .env.example .env
```

Set the Ark values required by your account / region in `.env`:

```env
ARK_API_KEY=replace-with-your-ark-api-key
ARK_MODEL=replace-with-your-model-or-endpoint-id
```

`ARK_BASE_URL` can remain at the value appropriate for the configured Ark environment.

> Use an Ark model API key, not a Volcengine / BytePlus account AK/SK.

Never commit the real `.env` file.

### 3. Validate the repository

```bash
npm run check
```

`npm run check` runs:

```text
typecheck -> server test suite -> production web/server builds
```

All stages should pass before judging.

---

## Run Locally

Start the local POC:

```bash
npm run poc
```

The script installs dependencies if needed, builds the local disposable Runtime image, prepares deterministic fictional demo data, selects a supported container engine, and starts the app on port `3000`.

Open:

**http://localhost:3000**

Seeded fictional demo accounts:

| User | Username | Password |
| --- | --- | --- |
| Alice Tan | `alice` | `alice-potato` |
| Bob Lim | `bob` | `bob-potato` |

These are intentionally published hackathon fixtures, **not production credentials**.

---

## Three-Minute Judge Demo

The full script is in **[docs/demo-runbook.md](docs/demo-runbook.md)**.

### 1. Single-Agent protected Run

```text
Alice
  ↓
Alice-owned Agent
  ↓
valid scoped access to fictional protected resource
  ↓
PotatoGuard ALLOW
  ↓
read-only protected mount
  ↓
real Agent Runtime execution
  ↓
answer + correlated audit receipt
```

### 2. Multi-Agent Team Task

```text
Team Task
  ↓
lead / orchestrator
  ↓
specialist Agents with separate principals
  ↓
PotatoGuard checks each protected specialist turn
  ↓
ALLOW / DENY / approval-resume flow
  ↓
correlated Team Task + audit evidence
```

### 3. Denial / abuse evidence

A protected request without valid authority is rejected **before the protected resource enters the Runtime**, with a corresponding DENY receipt.

This demonstrates:

- one real Agent Run;
- real backend / Runtime middleware behavior;
- single-Agent and multi-Agent integration; and
- an appropriate denial / recovery case.

---

## Automated Verification

Run the full submission check:

```bash
npm run check
```

The server test suite includes coverage across the middleware boundary, including tests for:

- authentication / session behavior;
- Agent ownership and foreign-user isolation;
- strict HTTP request schemas that reject browser-controlled ownership fields;
- scoped grant authorization;
- missing, expired and revoked grants;
- cross-user sharing and denial;
- protected Runtime mount behavior;
- Team Task authorization and approval / resume behavior;
- resource deletion / cleanup; and
- audit receipt hash-chain verification and tamper detection.

Important test files:

```text
apps/server/src/security-service.test.ts
apps/server/src/app.test.ts
apps/server/src/agent-service.test.ts
apps/server/src/team-task-service.test.ts
apps/server/src/container-codex-runner.test.ts
apps/server/src/store.test.ts
```

---

## Security Properties Demonstrated

| Property | Enforcement / evidence |
| --- | --- |
| **Server-derived human identity** | HttpOnly server session; strict request schemas reject browser-controlled identity / owner fields. |
| **Independent Agent identity** | Server-generated Agent `principalId` distinct from the owning human. |
| **Least privilege** | Temporary capabilities scoped to an Agent, resource, action and relevant context / expiry. |
| **Per-specialist multi-Agent authorization** | Team Task specialists retain separate principals and are checked independently before protected turns. |
| **Revocation / expiry** | State checked on each protected request; stale authority is denied. |
| **Pre-Runtime enforcement** | PotatoGuard evaluates access before the protected file is mounted or protected Agent Run proceeds. |
| **Cross-user isolation** | Foreign resources / Agents require explicit authority; inappropriate direct lookups are filtered / denied. |
| **Read-only protected mount** | Approved protected resource enters the local disposable Runtime as a read-only mount. |
| **Tamper evidence** | Hash-chained receipts can be verified; mutation breaks chain verification. |
| **Sensitive-data handling** | Protected contents are not placed in audit CSVs; sensitive request headers are redacted by server logging where configured. |

---

## Limitations

PotatoGuard is intentionally a **hackathon-scale proof of concept**, not a production IAM or multi-tenant security platform.

Current limitations include:

- seeded local identities rather than enterprise OIDC / SSO;
- single-process / local JSON persistence rather than a transactional authorization / session store;
- locally stored hash-chained receipts rather than externally signed or WORM-backed audit evidence;
- ordinary local Docker / Podman isolation rather than a hardened multi-tenant sandbox;
- broad Runtime outbound network access;
- prompt-triggered command and file execution is intentionally supported by the Agent Runtime;
- the Ark key is available to the server and active Runtime container for inference;
- no complete production CSRF strategy;
- no per-Agent container boundary in the optional ECS deployment path; and
- the POC has not undergone an independent production security audit.

See **[SECURITY.md](SECURITY.md)** for the complete security boundary and safe-use guidance.

---

## Development

```bash
npm run dev       # local development
npm run test      # server tests
npm run build     # production builds
npm run check     # typecheck + tests + builds
```
---

## Documentation

- **Architecture:** [docs/POTATOGUARD_ARCHITECTURE.md](docs/POTATOGUARD_ARCHITECTURE.md)
- **Three-minute demo:** [docs/demo-runbook.md](docs/demo-runbook.md)
- **Extended judge runbook:** [docs/JUDGE_RUNBOOK.md](docs/JUDGE_RUNBOOK.md)
- **Security policy / limitations:** [SECURITY.md](SECURITY.md)

---

## License

This project builds on the Volc Agent Launchpad starter kit. See [LICENSE](LICENSE) for license and attribution details.

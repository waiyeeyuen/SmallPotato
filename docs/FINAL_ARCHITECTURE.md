# Final architecture — Agent Launchpad + PotatoGuard

One-page architecture for the whole repository.

- **Authorization boundary** (`SecurityService`) — decides, *before* any
  execution, whether an Agent may read a protected resource.
- **Coordination boundary** (`TeamTaskService`) — owns multi-Agent turn-taking so
  the browser never chooses the acting Agent.

Every allow, deny, hand-off, and completion is an ordered, hash-chained record.

## System architecture and trust boundaries

Three planes follow one request, top to bottom. The two hexagons are the trust
boundaries this project enforces. Highlighted nodes (`new`) are code this project
added; plain nodes are the untouched Starter Kit.

```mermaid
flowchart TB
  subgraph CLIENT["Client plane — browser, no trusted identity"]
    UI["React + Vite Web UI (apps/web)<br/>Playground · Team Tasks · Protected resources<br/>Access leases · Audit receipts + CSV"]
    COOKIE["Holds only sp_session cookie<br/>HttpOnly · SameSite=Strict · 400 ms status polling"]
  end

  B1{{"TRUST BOUNDARY 1 — HTTP edge / session resolution<br/>strict Zod schemas reject body userId / ownerUserId<br/>actorFor then resolveSession(cookie) yields Alice or Bob<br/>identity comes from the server session, never the request"}}

  subgraph CONTROL["Control plane — Node.js, trusted, single process (apps/server)"]
    API["Fastify API (app.ts)<br/>routes · validation · security headers / CSP · error handler"]
    AGENT["AgentService<br/>Agent CRUD · lifecycle ready-busy-ready / stopped / error<br/>distinct principal UUID · foreign Agent id yields 404"]
    SEC["SecurityService — authorization owner<br/>scrypt login · sessions<br/>resource vault: server-named 0600 files<br/>leases: principal + read + resource + TTL 30-3600 s<br/>authorizeResourceRead: deny by default, before execution"]
    TEAM["TeamTaskService — coordination owner<br/>reserves ready Agents (activeTeamTaskId lock, one active task)<br/>Lead and Specialist engine: validated JSON, 1 retry<br/>turnPolicy facilitated or sequential, committed by Lead turn 1<br/>caps: 12 rounds / 30 turns · pause on restart · resume via Lead"]
    AUDIT["audit.ts — one primitive, two chains<br/>receiptHash over PolicyDecision · chainHash over teamTaskEvent"]
    STORE["JsonStore (store.ts)<br/>one schema-versioned JSON file v5 · serialized atomic writes<br/>users · sessions · agents · runs · messages · resources<br/>grants · decisions · teamTasks · teamTaskEvents"]
    WS["WorkspaceManager<br/>per-Agent workspace · shared .team-tasks/ · .deleted/ archive"]
    RF["runner-factory yields AgentRunner interface"]
  end

  B2{{"TRUST BOUNDARY 2 — policy-gated execution<br/>ALLOW mounts exactly the approved file, read-only, at /authorized-resources/ID.txt<br/>DENY yields 403, no Run row, nothing mounted<br/>ARK_API_KEY injected into runner env only, never toward the browser"}}

  subgraph EXEC["Execution plane — disposable, one container per turn"]
    CRUN["ContainerCodexRunner · Local POC<br/>--rm --init --network bridge --cap-drop ALL<br/>--security-opt no-new-privileges --cpus 2 --memory 2g<br/>--pids-limit 256 · non-root user<br/>mounts: workspace rw · codex-home rw · approved resource ro"]
    PRUN["CodexRunner · ECS profile<br/>Codex child process in the app container"]
    CODEX["Codex CLI (@openai/codex 0.111.0)<br/>argv-only · bounded output and time · resumes stored thread"]
    ARK["Volcengine Ark — Responses API<br/>foundation model, not replaced, not fine-tuned"]
  end

  UI --> COOKIE --> B1 --> API
  API --> AGENT --> SEC
  API --> TEAM
  SEC --> AUDIT
  TEAM --> AUDIT
  SEC --> STORE
  TEAM --> STORE
  AGENT --> STORE
  AGENT --> WS
  TEAM --> WS
  AGENT --> RF
  TEAM --> RF
  RF --> B2 --> CRUN
  B2 --> PRUN
  CRUN --> CODEX
  PRUN --> CODEX
  CODEX --> ARK

  classDef new fill:#f3e7d4,stroke:#a9670f,stroke-width:2px,color:#1b212b;
  classDef bound fill:#f4dfdb,stroke:#bb4335,stroke-width:2px,color:#1b212b;
  class SEC,TEAM,AUDIT new;
  class B1,B2 bound;
```

## Main components

| Component | File | Role | Owner |
| --- | --- | --- | --- |
| Web UI | `apps/web` | One screen per capability; never receives the model key or protected content | Starter Kit |
| Fastify API | `apps/server/src/app.ts` | REST routes, Zod validation, CSP / security headers, serves the built UI in production | Starter Kit |
| AgentService | `agent-service.ts` | Agent CRUD, lifecycle FSM, single-Agent Runs, per-Agent principal, ownership checks | Starter Kit + principal |
| SecurityService | `security-service.ts` | scrypt login, sessions, resource vault, capability leases, `authorizeResourceRead()`, receipts | **This project** |
| TeamTaskService | `team-task-service.ts` | Agent reservation, Lead/Specialist turn engine, ordered coordination events, safeguards | **This project** |
| audit | `audit.ts` | `receiptHash` (authorization) + `chainHash` (coordination) hash-chain primitive | **This project** |
| JsonStore | `store.ts` | One schema-versioned JSON file, serialized atomic writes, migrations | Starter Kit + schema |
| WorkspaceManager | `workspace.ts` | Per-Agent workspaces, shared Team Task workspace, deleted-workspace archive | Starter Kit |
| AgentRunner | `container-codex-runner.ts` / `codex-runner.ts` | Disposable container per turn (Local POC) or child process (ECS) | Starter Kit |
| Ark | external | Foundation model via the Responses API | External |

## Data and decision flow — protected read (Bouncer demo)

```mermaid
sequenceDiagram
  actor Alice
  participant API as Fastify API
  participant SEC as SecurityService
  participant RUN as Disposable Runtime
  participant ARK as Ark

  Alice->>API: POST /api/login (username, password)
  API->>SEC: verify scrypt hash
  SEC-->>Alice: Set-Cookie sp_session (HttpOnly)
  Alice->>API: POST /api/agents/:id/permissions (60 s read lease, owned resource)
  API->>SEC: createGrant(principal, read, resource, ttl)
  Alice->>API: POST /api/agents/:id/messages (resourceId) 202
  API->>SEC: authorizeResourceRead(actor, agent, resourceId)
  SEC->>SEC: append hash-chained PolicyDecision receipt
  alt DENY (reason code)
    SEC-->>Alice: 403 + reason, no Run, nothing mounted
  else ALLOW (GRANT_ACTIVE)
    SEC->>RUN: mount file read-only at /authorized-resources/ID.txt
    RUN->>ARK: Codex turn (host-injected key)
    ARK-->>RUN: model output
    RUN-->>API: Run completed, linked to the receipt
  end
  Alice->>API: GET /api/agents/:id/policy-decisions
  API-->>Alice: decisions + verifyDecisionChain() = "hash chain verified"
```

### Authorization ladder — deny by default

`SecurityService.authorizeResourceRead()` checks in this order and records a
receipt on every path:

| Condition | Reason | Outcome |
| --- | --- | --- |
| Agent not owned by the caller | `AGENT_NOT_OWNED` | deny |
| Resource missing or deleted | `RESOURCE_NOT_FOUND` | deny |
| Resource owned by another user and not shared | `SHARE_MISSING` | deny |
| Unexpired, unrevoked `read` lease for this principal | `GRANT_ACTIVE` | **allow** |
| Lease was revoked | `GRANT_REVOKED` | deny |
| Lease has expired | `GRANT_EXPIRED` | deny |
| No matching lease | `GRANT_MISSING` | deny |

`ALLOW` → mount the file read-only, create the Run, link Run ↔ receipt.
Any `DENY` → `403`, receipt still appended, no Run, no mount.

## Coordination turn loop (Team Tasks)

```mermaid
flowchart LR
  START["Create task<br/>reserve selected ready Agents<br/>one active task at a time"] --> PLAN["Lead turn 1<br/>commit turnPolicy + roster<br/>emit coordination_plan event"]
  PLAN --> DEL["Lead delegates<br/>names one in-pool specialist + assignment<br/>out-of-pool id fails validation"]
  DEL --> SPEC["Specialist turn<br/>disposable container · 1 retry<br/>validated specialist_result"]
  SPEC --> BACK["Back to Lead<br/>actor-labelled transcript"]
  BACK -->|not done| DEL
  BACK -->|complete| DONE["Final summary<br/>release Agent reservations"]
  DEL -.->|"12 rounds forced synthesis · 30 turns hard cap<br/>Lead fails twice then pause · restart then pause then resume via Lead"| GUARD["Safeguards"]
```

Every turn start, decision, hand-off, result, retry, failure, pause, resume, and
completion is an ordered event, hash-chained with the same primitive and verified
by `verifyEventChain()` (surfaced as `eventsVerified` on the task detail route).

## Trust boundaries and controls

| Boundary | Trusted source | Enforcement |
| --- | --- | --- |
| Browser → control plane | Hashed server session identifies the human | Strict schemas reject supplied `userId` / `ownerUserId`; `HttpOnly`, `SameSite=Strict` cookie; optional bearer token for remote demos |
| Human → Agent | Stored Agent row identifies owner and principal | Foreign Agents return `404`; every Agent gets a UUID principal |
| Agent → protected resource | Stored lease and server time | Deny by default; exact principal, `read`, resource, expiry, and revocation checks, decided before execution |
| Control plane → Runtime | Successful policy decision | Only the approved server path is mounted, read-only, into the disposable container; the model key never crosses back toward the browser |
| Browser → acting Agent (coordination) | Server-held task state | `TeamTaskService` reserves Agents and chooses every turn; the browser only submits the objective and polls |
| Decision / event → evidence | Server-created immutable snapshot | Each record carries the previous record's hash; verification detects any edit |

## One evidence trail, two chains

| Chain | Primitive | Covers | Verified by |
| --- | --- | --- | --- |
| Authorization receipts | `receiptHash(decision, prevHash)` | human, Agent principal, action, resource, outcome, reason | `verifyDecisionChain()` + CSV export in the Audit view |
| Coordination events | `chainHash(payload, prevHash)` | every `teamTaskEvent` transition | `verifyEventChain()` + `eventsVerified` on the task route |

Editing any stored row breaks its chain from that point on. A receipt-tamper test
is part of the server test suite (`npm run check`, 50 tests).

## Deployment profiles

| Profile | Control plane | Agent execution | Command |
| --- | --- | --- | --- |
| Local POC (judging path) | Host Node.js | Disposable Docker / Colima / Podman container per turn | `npm run poc` → `localhost:3000` |
| Docker Compose | Application container | Codex process in the same container | `docker compose up --build` |
| Volcengine ECS | Application container on ECS | Codex process in the same container | Terraform: VPC · subnet · security group · ECS · EIP |

## Honest boundary

Seeded demo identities (`alice` / `bob`), a single-process JSON store, and
ordinary local containers — not hardened multi-tenant isolation. Hash chaining
detects edits but is not an external append-only log.

**Next production step:** OIDC / SSO, transactional policy storage, a signed /
WORM audit sink, HTTPS + Secure cookies, per-tenant Runtime isolation, and a
durable queue with per-workspace locks for concurrent teams.

## Related documents

- [ARCHITECTURE.md](ARCHITECTURE.md) — component and extension boundaries
- [POTATOGUARD_ARCHITECTURE.md](POTATOGUARD_ARCHITECTURE.md) — authorization boundary detail
- [COORDINATION_ARCHITECTURE.md](COORDINATION_ARCHITECTURE.md) — multi-Agent coordination detail
- [JUDGE_RUNBOOK.md](JUDGE_RUNBOOK.md) — start-to-finish validation flow

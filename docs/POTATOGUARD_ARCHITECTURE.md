# PotatoGuard Architecture

> **Design goal:** PotatoGuard is placed at the pre-Runtime boundary because browser controls and model behavior are not trusted to enforce protected-resource authorization.

```mermaid
flowchart TB
    %% =========================
    %% Human / Browser
    %% =========================
    subgraph HUMAN["Human / Browser"]
        U["User<br/>Alice / Bob"]
        UI["React Web UI"]
        U --> UI
    end

    TB1["TRUST BOUNDARY #1<br/>Browser → Fastify Control Plane"]

    %% =========================
    %% Control Plane
    %% =========================
    subgraph CP["Fastify Control Plane"]
        SESSION["Session-derived<br/>human identity"]
        AGENTOWN["Agent ownership<br/>validation"]

        SINGLE["Single-Agent Flow<br/>Playground"]

        subgraph TEAM["Team Task / Multi-Agent Orchestrator"]
            ORCH["Team Task Orchestrator"]
            A1["Specialist Agent A<br/>own principal"]
            A2["Specialist Agent B<br/>own principal"]
            A3["Specialist Agent C<br/>own principal"]
            ORCH --> A1
            ORCH --> A2
            ORCH --> A3
        end

        subgraph PG["POTATOGUARD MIDDLEWARE"]
            AUTH["authorizeResourceRead()<br/><br/>Agent principal<br/>+ Resource<br/>+ Action<br/>+ Ownership / Share<br/>+ Lease state<br/>+ Expiry / Revocation"]
            DECISION{"ALLOW / DENY"}
            AUTH --> DECISION
        end

        DENY["DENIAL / CONTAINMENT<br/>No protected mount<br/>No protected Runtime execution"]
        AUDIT["INSTRUMENTATION<br/>Audit receipt<br/>+ Run / actor correlation<br/>+ hash-chain verification"]

        SESSION --> AGENTOWN
        AGENTOWN --> SINGLE
        AGENTOWN --> ORCH

        SINGLE --> AUTH
        A1 --> AUTH
        A2 --> AUTH
        A3 --> AUTH

        DECISION -->|DENY| DENY
        DECISION -->|ALLOW| ALLOWOUT["Authorized protected-resource request"]

        DECISION --> AUDIT
        DENY --> AUDIT
    end

    TB2["TRUST BOUNDARY #2<br/>Control Plane → Agent Runtime"]

    %% =========================
    %% Storage and Runtime
    %% =========================
    subgraph DATA["Protected Resource Store"]
        RESOURCE["Protected Resource<br/>server-controlled file + metadata"]
    end

    subgraph RT["Disposable Agent Runtime"]
        MOUNT["Approved resource<br/>mounted read-only"]
        CODEX["Codex Agent Runtime"]
        MOUNT --> CODEX
    end

    RESULT["Agent Result"]

    UI -->|"Authenticated request"| TB1
    TB1 --> SESSION

    ALLOWOUT -->|"ENFORCEMENT POINT<br/>Only after ALLOW"| TB2
    TB2 --> MOUNT
    RESOURCE -->|"authorized file only"| MOUNT

    CODEX --> RESULT
    RESULT -->|"response"| UI

    %% Recovery / lifecycle
    REVOKE["RECOVERY / LIFECYCLE<br/>Revoke / Expire / Delete"]
    REVOKE -->|"next authorization check"| AUTH
    REVOKE --> AUDIT

    %% Styling
    classDef guard fill:#ffe5e5,stroke:#c62828,stroke-width:2px,color:#111;
    classDef boundary fill:#fff7cc,stroke:#9a7b00,stroke-width:2px,color:#111;
    classDef audit fill:#e8f1ff,stroke:#1e5aa8,stroke-width:2px,color:#111;
    classDef runtime fill:#e8ffe8,stroke:#2e7d32,stroke-width:2px,color:#111;
    classDef deny fill:#f8d7da,stroke:#842029,stroke-width:2px,color:#111;

    class AUTH,DECISION guard;
    class TB1,TB2 boundary;
    class AUDIT audit;
    class MOUNT,CODEX runtime;
    class DENY deny;
```

## Trust Boundaries

- **Boundary #1 — Browser → Control Plane:** the browser supplies user intent, but PotatoGuard derives the human actor from the authenticated server session. Client-controlled ownership fields are not trusted.
- **Boundary #2 — Control Plane → Agent Runtime:** protected data may cross this boundary **only after PotatoGuard returns `ALLOW`**.

## Enforcement Point

`authorizeResourceRead()` is the focused server-side authorization boundary for protected-resource execution in this POC.

Both execution modes converge on the same middleware contract:

```text
Single Agent ──────────────┐
                           ├─> PotatoGuard ─> ALLOW / DENY
Team Task Specialist ──────┘
```

Each specialist Agent is authorized independently using its own principal and scoped authority.

## Instrumentation and Recovery

- **Instrumentation:** every authorization outcome is recorded as audit evidence with actor, Agent, resource, decision, reason, and correlation metadata.
- **Denial / containment:** `DENY` stops the protected request before the protected resource is mounted into the Runtime.
- **Recovery / lifecycle:** revocation, expiry, and deletion are enforced on subsequent authorization checks and recorded in the audit trail.

## Extensible Contract

PotatoGuard's authorization boundary is intentionally narrow:

```text
Input:
  Agent + Resource + Action + Context

Output:
  ALLOW | DENY
```

The same boundary can be extended with additional policy context—such as write/deploy actions, budgets, environments, or risk levels—without changing the Agent Runtime or UI architecture.

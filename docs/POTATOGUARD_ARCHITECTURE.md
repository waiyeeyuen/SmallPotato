# PotatoGuard one-page architecture

## Objective

Human ownership, Agent data authority, and Lead delegation are separate. Every
Agent has a distinct principal and no standing protected-resource privilege. A
manual or task-bound capability must pass server policy immediately before a
protected file enters a Runtime.

```mermaid
flowchart LR
  Browser["Browser<br/>no trusted owner fields"] -->|"HttpOnly session"| Control["Fastify control plane"]
  Control --> Ownership{"human owns Agent,<br/>task, and resource?"}
  Ownership -->|deny| Evidence["hash-chained receipt"]
  Ownership -->|allow| Coordinator["Team Task coordinator"]
  Coordinator --> Lead["Lead<br/>coordination context only"]
  Lead -->|"validated roster decision"| Coordinator
  Coordinator --> Capability{"principal + read + resource<br/>+ task + time + revocation"}
  Capability -->|step-up needed| Approval["inline human approval"]
  Approval -->|allow once / Agent / roster| Capability
  Approval -->|deny| Evidence
  Capability -->|other deny before execution| Evidence
  Capability -->|allow| Vault["server-side resource vault"]
  Vault -->|"one read-only mount"| Runtime["disposable specialist Runtime"]
  Runtime --> Coordinator
  Capability -->|"allow receipt"| Evidence
  Coordinator -->|"terminal auto-revoke"| Capability
```

## Trust boundaries and controls

| Boundary | Trusted source | Enforcement |
| --- | --- | --- |
| Browser → control plane | Hashed server session | Strict schemas reject `userId` and `ownerUserId`; HttpOnly, SameSite cookie; Secure in production mode |
| Human → Agent/task | Stored owner IDs | Foreign Agents and Team Tasks return 404; lists are owner-filtered |
| Human → resource | Stored resource owner | External metadata is minimized; foreign grants and task attachment are denied |
| Agent → resource | Stored capability and server time | Exact principal, `read`, resource, task context, expiry, and revocation checks; deny by default |
| Vault → Runtime | Successful policy decision | Only one approved server path is mounted read-only for that turn |
| Decision → evidence | Server attribution snapshot | Each receipt includes the previous receipt hash; mutation breaks verification |

## Capability modes

- **Ask me when needed:** a missing owned-resource grant pauses at the exact
  specialist boundary and displays a server-generated approval card. The human
  may allow one turn, one Agent for the Team, the current roster, or deny. No
  specialist Runtime starts before the decision.
- **Team Task:** explicit attach-time consent creates separate specialist grants,
  each additionally bound to one task ID. For a Lead-selected team, grants are
  deferred until the Lead commits its final roster. They cannot authorize
  Playground or a different task, remain available across requests in that
  persistent team, and are revoked when the team ends.

The Lead never gets a protected mount. Delegation therefore cannot widen data
authority. Every specialist is checked on every protected turn.

## Denied path

Missing, expired, revoked, wrong-task, foreign-Agent, foreign-resource, or deleted
resource → append denial receipt → do not create a Run → do not mount the file.

## Honest boundary

This POC uses seeded identities, a single-process JSON store, and local
containers. Hash chaining detects modification but is neither signed nor an
external append-only log. Existing conversation resumption also uses one shared
host Codex state directory; protected vault files are not stored there, but
production must partition that state by Agent principal. Other next steps are
OIDC/SSO, transactional policy storage, signed WORM receipts, durable
coordination, and hardened per-tenant sandboxes.

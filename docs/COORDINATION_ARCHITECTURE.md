# Multi-Agent Coordination Architecture

## Objective

Team Tasks are real middleware, not a scripted UI. A user creates a persistent team
conversation with a Lead plus one or more specialists, then sends it successive requests.
The server owns the workflow state,
reserves the participating Agents, invokes each Codex Runtime turn, validates its
structured result, and persists every transition. The roster remains reserved between
answers and is released only when the user ends the team.

```mermaid
flowchart LR
  User["User starts a Team Task"] --> UI["React mission control"]
  UI --> API["Fastify control plane"]
  API --> Coordinator["Persistent Team Task coordinator"]
  Coordinator --> Store["JSON task state and ordered event log"]
  Coordinator --> Workspace["Shared task workspace"]
  Coordinator --> Lead["Lead Codex session"]
  Lead -->|"Validated next-Agent decision or completion"| Coordinator
  Coordinator --> Specialist["Selected specialist Codex sessions"]
  Specialist -->|"Validated result and activity"| Coordinator
  Lead --> Workspace
  Specialist --> Workspace
  UI -->|"400 ms status polling"| API
```

## Runtime flow

```mermaid
sequenceDiagram
  actor User
  participant UI as Mission control
  participant C as Coordinator
  participant L as Lead Agent
  participant A as Specialist A
  participant B as Specialist B

  User->>UI: Submit objective and team
  UI->>C: Create Team Task
  C->>C: Reserve Agents and persist task_started + user_message
  C->>L: Ask for the most useful first conversational turn
  L-->>C: Select one relevant specialist and assignment
  C->>C: Validate the Agent against the authorized pool
  C->>A: Run the first assignment
  A-->>C: Return contribution and activity evidence
  C->>L: Provide the updated actor-labelled transcript
  L-->>C: Select the best next specialist using the new result
  C->>B: Run the context-aware next assignment
  B-->>C: Return contribution and activity evidence
  C->>L: Review all results and synthesize
  L-->>C: Return complete with final summary
  C->>C: Persist request_completed and keep Agents reserved
  C-->>UI: Ready state enables the chat composer
  User->>UI: Send the next request
  UI->>C: Append a message to the same Team Task
```

The Lead is intentionally consulted after every specialist turn. This prevents later
work from being selected before earlier output exists. The UI polls quickly and shows
the active routing or specialist assignment, elapsed time, and conversation round so
the genuine collaboration remains understandable while it runs.

## Coordination guarantees

- The server, not the browser, chooses the active Agent and owns all transitions.
- Only selected, ready Agents can participate; they are reserved for the task.
- Every delegation explicitly names one selected specialist; out-of-pool IDs fail validation.
- At least two distinct specialists contribute when the authorized pool contains two or more.
- The Lead may reuse a specialist or leave an irrelevant pool member unused when the transcript justifies it.
- Every specialist receives the same objective, shared state, assignments, named prior messages, and activity evidence.
- Shared-workspace turns are sequential to avoid conflicting file writes.
- Every turn start, decision, handoff, result, retry, failure, pause, resume, stop,
  state patch, and completion is recorded as an ordered event.
- Each Agent has a separate per-task Codex thread while sharing task context and the
  task workspace.
- A Lead failure pauses the task after two attempts. A specialist failure returns to
  the Lead after two attempts for a dynamic recovery decision.
- Twelve successful specialist rounds force final synthesis; a 30-turn global limit
  is the second runaway-coordination safeguard.
- Restarted in-flight tasks become paused and can be resumed explicitly.
- Completed requests return the persistent team to ready without clearing its roster,
  threads, workspace, or transcript. Ending the team clears Agent reservations.

## Deliberate scope

The final hackathon build permits one ready, active, or paused Team conversation at a time. This keeps
the demo deterministic and makes resource ownership obvious. The next production
step would be a durable queue with per-workspace locks, tenant identity, and a database
transaction layer for concurrent teams.

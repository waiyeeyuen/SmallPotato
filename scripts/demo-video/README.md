# Demo video harness

Records the three-minute demo in [`docs/UNIFIED_DEMO.md`](../../docs/UNIFIED_DEMO.md)
as a clean, repeatable take, so the run is driven by a script instead of by
live clicking.

The footage is **real**: real server, real ARK model calls, real hash chains.
Nothing here fabricates a UI or fakes a result — which is the point, given that
the demo's whole claim is that the evidence is tamper-evident.

## What the take records

**One workflow, not two demos.** A team task is started against a protected
document. The Lead coordinates and delegates; the first specialist turn is
refused by policy and **the whole task pauses on its own**. Leases are issued to
both specialists, the task is resumed, and the specialist reads the document and
answers from it. Both the denial and the authorization end up in the coordination
chain, beside the handoffs that caused them, and in the authorization receipt
chain.

There is no separate Playground segment any more. If you are looking for the old
two-part take — deny/allow/cross-user/revoke in the Playground while a team task
ran in the background — it is gone, because
[`team-task-service.ts`](../../apps/server/src/team-task-service.ts) now enforces
leases directly on specialist turns.

## Workflow

```bash
# 1. App must already be running with real credentials
npm run poc

# 2. Check every precondition and reset leftovers from the last take
node scripts/demo-video/prepare.mjs
#    add --fresh to recreate both specialists even when they look clean

# 3. Record. Takes 5-12 minutes; the team task is real work.
npx playwright test --config scripts/demo-video/playwright.config.ts

# 4. Watch the raw take, then record narration to picture
open scripts/demo-video/recordings/*/*.webm
#    read from teleprompter.md

# 5. Assemble
scripts/demo-video/assemble.sh --voice narration.m4a
```

Output lands in `scripts/demo-video/output/`.

## What prepare.mjs resets, and why

**Lease history on the specialists, not just active leases.** The denial beat has
to read `GRANT_MISSING`. [`security-service.ts`](../../apps/server/src/security-service.ts#L367-L373)
returns that reason **only when no grant record exists at all** for the
agent/resource pair — a revoked record yields `GRANT_REVOKED`, an expired one
yields `GRANT_EXPIRED`. So revoking a leftover lease is *not* enough. Deleting
the record means recreating the agent, which the script does automatically for
both specialists whenever either carries any lease history, preserving the seeded
name, description, and instructions.

> If you rehearse live rather than through this harness, do the same by hand —
> delete and recreate both specialists between runs. Otherwise your opening
> denial shows "Capability was revoked", which quietly contradicts the narration.

**A leftover open team task.** Running *or paused* keeps the roster reserved and
the start form hidden — and this demo deliberately ends every aborted take in
`paused`, so this matters more than it used to. The script stops any open task
and waits for the reservation to clear.

**The protected document.** `Tokyo Trip Brief` is created if it is missing; it is
not part of the app's seed data.

**The runtime image tag.** Docker Desktop's containerd store intermittently drops
the `volc-agent-runtime:local` reference: `docker images` still shows the row but
`docker image inspect` fails, which is exactly the check
[`ContainerCodexRunner.isAvailable()`](../../apps/server/src/container-codex-runner.ts#L104)
runs. The server then reports `codexAvailable: false` and the yellow "Runtime
check" banner sits in every frame. The image is intact and still resolves by ID,
so the script re-applies the tag and re-checks.

It also fails fast if the runtime provider is not `container`: protected
resources require the disposable container Runtime, and without it the task
pauses with a Runtime message instead of a policy denial — a take that looks
right and proves nothing.

## The lease-duration tradeoff

The harness issues **five-minute** leases by default, while `UNIFIED_DEMO.md`
tells a live presenter to use sixty seconds.

That is deliberate. The lease has to survive *resume → Lead re-delegates →
specialist reads*, which is two real model calls. A 60-second lease can expire
inside that window, turning the ALLOW beat into a second `GRANT_EXPIRED` denial
and wasting a ten-minute take. A live presenter controls their own pacing and can
afford the shorter number; a recording cannot.

Narrate "five minutes". The claim is identical — the lease still expires on its
own, and revocation is still immediate.

To record with the doc's timing anyway:

```bash
DEMO_LEASE_TTL=60 npx playwright test --config scripts/demo-video/playwright.config.ts
```

## Tuning

| Variable | Default | Effect |
| --- | --- | --- |
| `DEMO_BASE_URL` | `http://localhost:3000` | Target server |
| `DEMO_LEASE_TTL` | `300` | Lease duration in seconds |
| `DEMO_READ` | `4000` | Hold time per screen, in ms — raise if the video feels rushed |
| `DEMO_SLOWMO` | `260` | Delay between UI actions, in ms |

## Why the take can fail

Failure is deliberate. Every claim the narration makes is asserted, so a take
that would have recorded the *wrong* evidence stops rather than looking fine on
camera. Common causes:

- **`.config-banner` found** — the runtime warning is on screen. Rerun
  `prepare.mjs`, which repairs the image tag.
- **`the task never paused`** — a specialist already held a lease, so nothing was
  refused. Rerun `prepare.mjs --fresh`.
- **`the pause was not a policy denial`** — the task paused for another reason
  (usually the Runtime). Read `task.lastError` and fix the cause.
- **`the start form is not showing`** — a task is still open, or fewer than two
  agents are ready. Rerun `prepare.mjs`.
- **`refused again after resume: ...`** — the resumed turn hit the wall a second
  time. Read the reason: `GRANT_MISSING` means a specialist was not leased,
  `RESOURCE_NOT_FOUND` means the protected document was deleted or recreated
  while the task was running.
- **`no specialist turn was ever authorized`** — the Lead never delegated to a
  leased specialist within ten minutes.
- **`team task never reached a terminal state`** — the model stalled. The ALLOW
  was already recorded by that point, so the footage is usually still usable.

Always run `prepare.mjs` immediately before a take. Most failures are a previous
take's state, and it clears all of them.

> **Do not touch the app while a take is running.** Playwright drives its own
> browser window, but it shares one server and the platform allows a single
> active team task. Starting a task by hand, or deleting and recreating the
> protected document mid-run, invalidates the take — the running task keeps a
> resource ID that no longer resolves and is refused with `RESOURCE_NOT_FOUND`.

## Known drift from the demo doc

Checked against the current UI:

| Doc says | UI actually shows |
| --- | --- |
| "Activity log" panel | **Activity log**, badge "N steps · verified" |
| `GRANT_MISSING` | **`GRANT_MISSING`** verbatim in the paused banner; **No matching capability** in the receipts table |
| 60-second lease | the harness issues 300s by default — see the tradeoff above |

The raw reason codes are visible in the paused banner and the exported CSV; the
receipt table shows the human phrases.

# Narration script — record to picture

You are narrating **over finished footage**, not driving the app. So record the
take first, watch it once, then read these lines against what is on screen. The
timings below are the target from `docs/UNIFIED_DEMO.md`; your real footage will
drift by a few seconds because the model's latency is real. Follow the picture,
not the clock.

This is **one workflow**, not two demos. Never say "now for the second part".
The team is denied, leased, and resumed inside a single run.

Wording below matches the labels that are **actually on screen**. Where a raw
reason code appears, it is marked.

---

## 0:00–0:25 · Start one task that needs protected data

> Alice owns these Agents, and each has a principal ID separate from hers. This
> team is about to plan a trip from a document none of them is allowed to read
> yet. Watch what the platform does about that.

*On screen: the objective is typed, Trip Coordinator is chosen as Lead, "You pick
them" is selected, the protected document "Tokyo Trip Brief" is chosen, two
members are checked, Start task.*

> Two things are governed here: which Agents the Lead may call, and what data
> those Agents may read. One task exercises both.

---

## 0:25–0:55 · Coordination, then the wall

*On screen: the Lead takes its first turn, commits a coordination mode, and hands
off. Then the task stops by itself and the paused banner appears.*

> The Lead has delegation authority — it just chose who works next. It does not
> have data authority, and it cannot grant any.
>
> That specialist was refused before a container started, so the brief was never
> mounted. The whole workflow stopped rather than continuing without the data.

⚠️ The paused banner shows the raw reason code **`GRANT_MISSING`** — this is the
team task banner, which quotes the policy engine directly. The Audit receipts
table later shows the same decision as the phrase **"No matching capability"**.
Both are the same decision; say "no matching capability — a missing grant."

*On screen: the Activity log is expanded and the red "Access decision" row is
opened, sitting inline with the handoffs.*

> Every Agent went back to ready. Nothing is half-running.

---

## 0:55–1:25 · Grant least privilege

*On screen: each specialist is selected in turn, Access leases, "Tokyo Trip
Brief", purpose "Plan the trip from the brief", issue.*

> One resource, one action, one Agent, and an expiry. Nothing standing.

⚠️ **Check your take summary.** The harness issues **five-minute** leases by
default, not sixty seconds — a 60-second lease can expire during the resume and
turn the ALLOW beat into a second denial. Say "five minutes" unless you recorded
with `DEMO_LEASE_TTL=60`.

> Both members need one. Delegation does not spread access — each Agent is
> checked on its own, every turn.

---

## 1:25–2:15 · Resume, and watch it work

*On screen: Resume is pressed. The Lead reviews the interruption, re-delegates,
and the green "Access decision · ALLOW" row appears.*

> Same team, same objective, same Lead decision. The only thing that changed is
> a lease.
>
> The file is mounted read-only for that turn, and it is gone afterwards.

*On screen: the specialist's answer quotes the brief — the offsite week, the
three-thousand-dollar cap, the walkable neighbourhood.*

> Those constraints came out of a document that, ninety seconds ago, this Agent
> was refused.

---

## 2:15–3:00 · One chain, one close

*On screen: the Activity log, badge reading "N steps · verified", with the deny
and the allow inline among the handoffs.*

⚠️ The panel is labelled **"Activity log"** and its badge reads
**"N steps · verified"**.

> One workflow produced this whole record. The refusal and the authorization sit
> in the same hash chain as the handoffs that caused them.

*On screen: Audit receipts for the denied specialist, "Hash chain verified".*

> And the same two decisions again, as authorization receipts on their own chain
> — built by the same line of code.
>
> Delegation decided who works. Leases decided what they could read. Neither
> Agent chose either one, and the server can prove all of it.
>
> An Agent's authority here is granted. It is never claimed.

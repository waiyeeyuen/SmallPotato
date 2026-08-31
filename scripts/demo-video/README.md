# Demo video harness

This harness records the real workflow in
[`docs/UNIFIED_DEMO.md`](../../docs/UNIFIED_DEMO.md): an immediate cross-user
denial followed by a protected Tokyo Team Task with automatic task-bound access,
real Ark model calls, per-turn read-only mounts, terminal revocation, and both
verified evidence views.

```bash
# Application and Runtime must already be running.
npm run poc

# Validate Ark/container state, stop only leftover Alice tasks, and create or
# refresh the fictional Tokyo Travel Profile.
node scripts/demo-video/prepare.mjs --smoke

# Record one asserted take. The model workflow can take several minutes; edit
# the real waiting time out of the final three-minute submission video.
npx playwright test --config scripts/demo-video/playwright.config.ts

open scripts/demo-video/recordings/*/*.webm
scripts/demo-video/assemble.sh --voice narration.m4a
```

`--smoke` spends one tiny model call so a configured key or available image is
not mistaken for usable provider quota. Omit it only during repeated local UI
setup, then run it once immediately before recording.

The recording test fails if the denial, task-bound capability event, specialist
ALLOW, completion, auto-revocation, or either hash verification is missing. It
does not fake UI state or model output.

Environment knobs:

| Variable | Default | Purpose |
| --- | --- | --- |
| `DEMO_BASE_URL` | `http://localhost:3000` | Running app URL |
| `DEMO_READ` | `3500` | Hold time on important evidence |
| `DEMO_SLOWMO` | `260` | Delay between visible browser actions |

If a real model-format failure pauses the task, use the manual plan in
`docs/UNIFIED_DEMO.md` or resume after showing the retry evidence. Always rerun
`prepare.mjs` before another take so no Alice task remains open.

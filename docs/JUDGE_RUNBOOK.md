# PotatoGuard judge runbook

This is the exact start-to-finish validation flow for Track 1 / Bouncer. Use
fictional content only.

## One-time setup

1. From the repository root, run `npm run check`.
   - Expected: typecheck, the full server test suite, and both production builds pass.
   - Show: the final green test/build summary.
2. Ensure `.env` contains valid `ARK_API_KEY` and `ARK_MODEL`, then run
   `npm run poc`.
   - Expected: Runtime image builds if needed; server listens on port 3000.
   - Show: `Local POC is ready` and no error.
3. Open <http://localhost:3000>.
   - Expected: the sign-in screen appears.
   - Show: the app is not usable anonymously.

## Happy path

| Step | You do | System does | Show judges |
| --- | --- | --- | --- |
| 1 | Choose Alice and sign in. | Verifies the scrypt password and sets an HttpOnly session cookie. | Alice's name in the sidebar; no user ID field in requests. |
| 2 | Create **Launch Analyst**. | Persists an Alice-owned Agent and generates a distinct Agent principal UUID. | Alice identity beside a different principal ID. |
| 3 | In Playground choose **No protected resource**, ask it to create `hello.txt`. | Runs an ordinary coding task with no protected mount. | Baseline Agent functionality still works. |
| 4 | Open **Protected resources**, create **Judge Brief** with fictional priorities. | Writes a server-owned `0600` text file under a server-generated name; returns metadata only. | Resource card, ownership, and size; content is not displayed after creation. |
| 5 | Open **Access leases**, select Judge Brief, purpose `Summarize for judges`, duration 60 seconds, and issue. | Creates a lease for exactly Launch Analyst's principal + read + Judge Brief + expiry. | Active state and live countdown. |
| 6 | In Playground select Judge Brief and ask for its priorities. | Records `allow`, mounts only that file read-only, runs the Agent, then links the Run to the receipt. | Real answer based on the document and the completed Run. |
| 7 | Open **Audit receipts**. | Verifies the full receipt hash chain. | Human, Agent principal, action, resource, `ALLOW`, reason, time, Run correlation, and **Hash chain verified**. |
| 8 | Click **Export CSV**. | Downloads the selected Agent's receipt evidence. | Open the CSV if time permits; no protected content is present. |

## Required denial and update cases

### A. Missing permission

1. Select Alice's **Launch Plan** before issuing a lease.
2. Send the protected-document prompt.
3. Expected: HTTP 403, `GRANT_MISSING`; no Run and no mount.
4. Show: automatic jump to Audit, denial banner, receipt ID.

### B. Cross-user resource

1. As Alice, select **Finance Report · Bob Lim · external**.
2. Send the same prompt.
3. Expected: HTTP 403, `RESOURCE_NOT_OWNED`; Bob's file never enters the Runtime.
4. Show: backend receipt naming Alice, her Agent, Bob's resource, read, deny.

### C. Revocation

1. Issue a Launch Plan lease and complete one allowed read.
2. Revoke it under **Access leases**.
3. Retry the read.
4. Expected: `GRANT_REVOKED`; the previous allowed result remains historical,
   but the next Run does not start.

### D. Expiry

1. Issue a 60-second lease and wait for its countdown to expire.
2. Retry the protected read.
3. Expected: `GRANT_EXPIRED`; no mount and no Runtime execution.

### E. Delete a protected resource

1. Create a user resource and grant it to the Agent.
2. Delete it from **Protected resources** and confirm.
3. Expected: the server removes its file, soft-deletes metadata, and revokes its
   active leases; it disappears from selectors.
4. Show: the lease is revoked and the resource is unavailable.

## Browser-ID tampering proof

While signed in as Alice, open browser developer tools and run:

```js
fetch("/api/agents", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "Forged Agent", ownerUserId: "user-bob" })
}).then(async response => console.log(response.status, await response.json()))
```

Expected: `400` with `ownerUserId` reported as an unrecognized key. No Agent is
created. Explain that ownership comes from the server session, not browser
input. The automated HTTP-boundary test proves the same case in `npm run check`.

## Reliability edge cases

| Case | Action | Expected result |
| --- | --- | --- |
| Wrong password | Sign in with any wrong password. | Generic 401; no indication whether a username exists. |
| Anonymous API | Clear site cookies and call `/api/agents`. | 401; UI returns to sign-in. |
| Page reload during Run | Reload while a Run is queued/running. | Session and selected Agent recover; polling resumes until terminal state. |
| Stopped Agent | Stop the Agent, then try to send. | Composer is disabled; start restores it. |
| Foreign Agent URL | As Bob, request an Alice Agent UUID directly. | 404, preventing ownership enumeration. |
| Runtime unavailable | Stop the container engine or omit Ark config. | Visible configuration/runtime warning; protected policy decisions remain server-side. |
| Receipt modification | Change a stored receipt in a test copy. | Hash verification becomes invalid; covered by automated tamper test. |

## What to say if judges ask about production

“The authorization and Runtime mount boundary are real; the identities and
storage are intentionally local hackathon fixtures. The next production step is
OIDC/SSO, transactional policy storage, signed receipts in an external WORM
audit sink, HTTPS/Secure cookies, and hardened per-tenant Runtime isolation.”

# PotatoGuard three-minute live demo

## Prepare before the timer

1. Run `npm run poc`, open <http://localhost:3000>, and confirm the Runtime
   banner is clear.
2. Sign in as Alice with `alice` / `alice-potato`.
3. Delete or ignore old Agents, then keep the Create Agent dialog ready.
4. Use fictional data only. Do not open `.env`, logs containing credentials, or
   the host protected-resource directory during the demo.

## Timed script

### 0:00–0:25 — Create separate identities

- Create **Launch Analyst** with the default instructions.
- Point to **Alice Tan** in the sidebar and the separate **Agent principal** ID
  in the header.
- Say: “The session identifies Alice on the server; the browser cannot choose
  the human or Agent owner. Every Agent starts with zero protected access.”

### 0:25–0:50 — Run a normal coding task

- Keep **No protected resource** selected.
- Send: `Create hello.txt containing "hello judges", then report what you did.`
- Show the completed Agent response.
- Say: “Ordinary Agent work still works; PotatoGuard gates only protected data.”

### 0:50–1:10 — Prove deny by default

- Select **Launch Plan · Alice Tan · yours**.
- Send: `Read the selected protected document and summarize its priorities and success metric.`
- Show the Audit view reached automatically, the `DENY` banner, and
  `GRANT_MISSING`.
- Say: “The backend stopped the request before the Runtime started, so the file
  was never mounted.”

### 1:10–1:50 — Issue least privilege and prove the allow path

- Open **Access leases** and issue a **60-second** read lease for Launch Plan.
- Return to Playground, keep Launch Plan selected, and repeat the prompt.
- Show the answer mentioning just-in-time access and attributable receipts.
- Say: “Only this Agent, action, and file are authorized; the file is mounted
  read-only for this Run.”

### 1:50–2:15 — Prove cross-user denial

- Select **Finance Report · Bob Lim · external** and repeat the prompt.
- Show `RESOURCE_NOT_OWNED` in Audit receipts.
- Say: “Alice can see the fictional resource label for the demo, but neither
  Alice nor her Agent receives Bob's content. The denial is server-side.”

### 2:15–2:40 — Revoke and prove the update takes effect

- Revoke the active Launch Plan lease.
- Retry Launch Plan and show `GRANT_REVOKED`.
- Say: “Revocation affects the very next Run; there is no standing Agent privilege.”

### 2:40–3:00 — Close with evidence

- Show **Hash chain verified**, the allow and deny rows, human name, Agent
  principal, resource, action, reason, timestamp, and short receipt hash.
- Click **Export CSV**.
- Close with: “PotatoGuard makes Agent access short-lived, least-privilege,
  Runtime-enforced, attributable, and tamper-evident.”

If model latency threatens the timer, pre-run the normal task and keep its
result visible; perform the deny/allow/cross-user/revoke policy actions live.

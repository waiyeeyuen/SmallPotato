# PotatoGuard Demo Runbook

This guide provides a deterministic validation sequence for PotatoGuard's authorization middleware. All scenarios use fictional data only.

## One-Time Setup

### 1. Validate the repository

```bash
cd SmallPotato
npm run check
```

**Expected output:**
```
✓ typecheck
✓ tests (vitest: N tests)
✓ build
```

If any step fails, the build is not ready for judging. Stop and investigate.

### 2. Configure Volcengine Ark

Create or update `.env`:

```bash
cp .env.example .env
# Edit .env:
# ARK_API_KEY=your-volcengine-ark-api-key
# ARK_MODEL=ep-your-endpoint-id (e.g., ep-xxxxxxxx)
# ARK_BASE_URL=https://ark.cn-beijing.volces.com/api/v3 (or your region)
# APP_AUTH_TOKEN=  (leave empty for local demo)
```

See `.env.example` for all available configuration options.

### 3. Start the POC

```bash
npm run poc
```

**Expected output:**
```
✓ Runtime image built (or already exists)
✓ Seeding demo users and Agents
✓ Starting Fastify server on port 3000
✓ Web UI compiled and ready
✓ Local POC is ready at http://localhost:3000
```

### 4. Open the browser

Visit **<http://localhost:3000>** and sign in as Alice:

| Field | Value |
|---|---|
| **Username** | `alice` | 
| **Password** | `alice-potato` |

Bob's Credentials (for Demo 3 below)
| Field | Value |
|---|---|
| **Username** | `bob` | 
| **Password** | `bob-potato` |


You should see:
- Sidebar with Agents, Team tasks, Protected resources, Sharing, and Audit receipts
- 7 pre-seeded Agents (Trip Coordinator + 6 specialists)
- 3 protected resources (Launch Plan, Finance Report, Partnerships Brief)

---

## 3-Minute Live Demo

This sequence demonstrates PotatoGuard's core capabilities in about 3 minutes.

### Demo 1: Protected-Resource Access Success (ALLOW)

**What this tests:** Authorization success path — protected resource reaches Agent, audit receipt created.

**Steps:**

1. In the left sidebar, open **Agents** and select **Analyst Agent** (or any of the 7 pre-seeded Agents)
2. Click **Playground**
3. In the resource selector (top-right), select **Partnerships Brief** (marked as `· shared with you`)
4. In the chat, type:
   ```
   What are the key partnership opportunities mentioned in the document?
   ```
5. Press **Send**

**Expected behavior:**

- ✓ Agent starts (container visible in logs, or watch `docker ps` / `podman ps`)
- ✓ Agent reads the mounted resource
- ✓ Agent returns an answer based on the document
- ✓ Run status shows "completed"
- ✓ Message history displays the Agent's response

**Audit evidence:**

1. In the sidebar, open **Audit receipts**
2. Look for the most recent entry with:
   - **Outcome:** `allow`
   - **Action:** `read`
   - **Agent name:** Analyst Agent
   - **Resource:** Partnerships Brief
   - **Reason:** (empty or blank for allow)
3. Verify the receipt shows your username (alice)

**What it proves:**
- Server validated your session
- Agent is owned by your account
- Resource is accessible (Bob shared it to Alice)
- Authorization decision was made before Agent execution
- Decision was recorded in the audit trail

---

### Demo 2: Protected-Resource Access Denial (DENY)

**What this tests:** Authorization failure path — protected resource does NOT enter Agent, Agent doesn't run, denial receipt created.

**Steps:**

1. Open the same **Analyst Agent** Playground (or use a different pre-seeded Agent)
2. Change the resource selector to **Finance Report** (Bob's file, not shared to Alice)
3. Type:
   ```
   Summarize the financial performance.
   ```
4. Press **Send**

**Expected behavior:**

- ✗ Agent does **not** start
- ✗ No container appears
- ✓ Error message appears immediately, e.g.:
  ```
  RESOURCE_ACCESS_DENIED
  Reason: SHARE_MISSING
  The owner has not shared this resource with you.
  ```
- ✓ Run status shows "failed"
- ✗ Agent transcript is **not** updated (no response)

**Audit evidence:**

1. Open **Audit receipts**
2. Look for the most recent entry with:
   - **Outcome:** `deny`
   - **Reason:** `SHARE_MISSING`
   - **Agent name:** Analyst Agent
   - **Resource:** Finance Report

**What it proves:**
- Authorization decision was made **before** Runtime
- Denied request resulted in **zero** Agent execution
- Protected data **never** entered the Runtime
- Denial was recorded in the audit trail

---

### Demo 3: Cross-User Sharing (for extended time)

**What this tests:** Cross-user resource isolation and sharing workflow.

**Setup (as Alice):**

1. Sidebar → **Audit receipts** → Confirm *Partnerships Brief* shows an `allow` with Agent, and `share_created` event showing Bob shared it to Alice
2. This demonstrates the pre-seeded share is already active

**Steps (as Bob):**

1. Sign out (top-right menu → Sign out)
2. Sign in as Bob:
   - **Username:** `bob`
   - **Password:** `bob-potato`
3. Sidebar → **Protected resources**
4. You should see *Partnerships Brief* (your resource), *Finance Report* (your resource)
5. Click **Sharing** tab to see shares and revocations

**Back as Alice:**

1. Sign in as Alice again
2. Try to use *Finance Report* in an Agent Playground (same steps as Demo 2)
3. Confirm it is denied with `SHARE_MISSING`
4. Check **Audit receipts** → confirm the denial

**What it proves:**
- Resources are isolated by owner (Bob's Finance Report is not visible to Alice for access)
- Sharing is explicit and revocable
- Audit trail tracks both allows and denials across users

---

## Extended Validation

The following scenarios can be validated beyond the 3-minute demo.

### Scenario: Expired Grant (if reproducible)

**Objective:** Demonstrate that expired grants are immediately denied.

**Setup:**

1. Create a new protected resource as Alice (if not already present)
2. Create a custom grant with a very short TTL (e.g., 10 seconds)
3. Use it in an Agent run immediately (should ALLOW)
4. Wait for the grant to expire
5. Retry the same Agent + resource combination

**Expected outcome:**
- First run: ALLOW, receipt created
- After expiry: DENY with reason `GRANT_EXPIRED`, receipt created
- No grace period; denial is immediate

**Audit evidence:** Two receipts: one `allow` with `grantId`, one `deny` with reason `GRANT_EXPIRED`.

---

### Scenario: Revocation (manual)

**Objective:** Demonstrate that revoked grants are immediately denied.

**Setup:**

1. Alice creates a protected resource and an explicit grant to Agent X (if necessary)
2. Alice uses Agent X to read the resource (should ALLOW)
3. Alice revokes the grant via the UI (Sidebar → Protected resources → revoke grant)
4. Retry Agent X with the same resource

**Expected outcome:**
- First run: ALLOW
- After revocation: DENY with reason `GRANT_REVOKED`
- Revocation receipt is created immediately

---

### Scenario: Team Task Authorization Integration

**Objective:** Demonstrate that Team Task specialists are authorized the same way as single-Agent Playground runs.

**Setup:**

1. Sidebar → **Team tasks** → **Create task**
2. Select:
   - **Lead:** Trip Coordinator
   - **Specialists:** Select at least 2 agents (e.g., Analyst Agent, Cost Optimizer)
   - **Objective:** "Plan a 3-day trip to a European city with a $1000 budget"
   - **Resource:** Partnerships Brief (attach it in 'Protected Documents')
   - **Access mode:** "Authorize for this task" (one-click approval)
3. Click **Start task**

**Expected behavior:**

- ✓ Task starts
- ✓ Lead Agent receives the objective + specialist pool metadata (not resource content)
- ✓ Lead delegates to a specialist
- ✓ Specialist run succeeds (ALLOW receipt created with team task ID)
- ✓ Specialist receives read-only mounted resource
- ✓ Run completes and result returns to Lead
- ✓ Lead can continue with additional specialists

**Audit evidence:**

1. Open **Audit receipts**
2. Filter or sort by resource "Partnerships Brief"
3. Confirm:
   - Multiple `allow` receipts with the same `teamTaskId`
   - Each receipt names a different specialist Agent
   - All have outcome "allow"
   - All have action "read"
4. Verify that the `teamTaskId` is linked to the Team Task you just ran (if visible in the UI)

**What it proves:**
- Team Task specialization uses the same authorization boundary as single-Agent runs
- Each specialist receives an independent authorization check
- All decisions are audit-logged with Team Task correlation

---

### Scenario: Browser-Supplied Owner ID Rejection

**Objective:** Demonstrate that browser-supplied owner identity is rejected.

**Setup:**

1. Open browser DevTools (F12)
2. Open the Network tab
3. Open a Console tab
4. Submit a request to the API with a fake owner ID:

```javascript
fetch('http://localhost:3000/api/agents', {
  headers: {
    'Content-Type': 'application/json',
    // Try to claim ownership of Bob's agents:
    'X-Owner-User-Id': 'bob'  // This header is ignored
  }
})
.then(r => r.json())
.then(d => console.log(d))
```

**Expected outcome:**

- Request completes
- Returned data includes only Alice's Agents (you are logged in as Alice)
- The `X-Owner-User-Id` header is ignored
- You cannot see Bob's Agents or tasks
- No error; just no unauthorized data

**Audit evidence:**

- No suspicious receipts or events; the browser-supplied header never reaches authorization logic

**What it proves:**
- Browser-supplied owner IDs are rejected
- Server-side session validation is the source of truth
- Cannot enumerate foreign Agents even with fake headers

---

### Scenario: Foreign Agent Access Denial (404)

**Objective:** Demonstrate that requesting another user's Agent returns 404 (not 403), preventing ownership enumeration.

**Setup:**

1. Identify one of Bob's Agent IDs (e.g., from an earlier screenshot or by asking the reviewer)
2. As Alice, try to GET that Agent:

```javascript
// Get Bob's Agent ID somehow (e.g., b0b-agent-uuid)
fetch('http://localhost:3000/api/agents/b0b-agent-uuid')
  .then(r => {
    console.log('Status:', r.status)
    return r.json()
  })
  .then(d => console.log(d))
```

**Expected outcome:**

- Status: **404** (not 403)
- Message: "Agent not found" (or similar)
- Alice cannot determine if the Agent exists or is owned by Bob
- Response does **not** say "Forbidden" or "Access denied"

**Audit evidence:**

- No receipt is created (authorization was never checked; the Agent didn't exist in Alice's view)

**What it proves:**
- Foreign Agents are not visible, even to authenticated users
- 404 prevents enumeration attacks
- Ownership is never leaked

---

### Scenario: Audit Receipt Verification

**Objective:** Demonstrate that the receipt chain is tamper-evident.

**Setup:**

1. Export audit receipts as CSV:
   - Sidebar → **Audit receipts** → Download CSV
2. Open the CSV in a text editor
3. Find a row with a `receiptHash` value
4. Manually edit one field in that row (e.g., change "allow" to "deny" in an earlier row)
5. Save the CSV

**Note:** This is a verification demonstration, not a recovery path. The tamper-evident design works **in-system**, not on exported files. This step shows that the receipt structure is designed for verification.

**What it proves:**
- Receipts include a `receiptHash` linking to the previous decision
- The chain structure makes tampering detectable
- Exported receipts can be independently verified using the raw data


import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "./api";
import type {
  Agent,
  AgentRun,
  Message,
  PermissionGrant,
  PolicyDecision,
  ResourceSummary,
  SystemInfo,
  User,
} from "./types";

type View = "playground" | "resources" | "access" | "audit";

const emptyAgent = {
  name: "",
  description: "",
  instructions:
    "Help me complete tasks in this workspace. Explain actions clearly and respect platform permissions.",
};

const reasonLabels: Record<string, string> = {
  GRANT_ACTIVE: "Active capability lease",
  GRANT_MISSING: "No matching capability",
  GRANT_REVOKED: "Capability was revoked",
  GRANT_EXPIRED: "Capability expired",
  AGENT_NOT_OWNED: "Agent belongs to another user",
  RESOURCE_NOT_OWNED: "Resource belongs to another user",
  RESOURCE_NOT_FOUND: "Resource unavailable",
};

function shortId(value: string): string {
  return value.length > 15 ? value.slice(0, 8) + "…" + value.slice(-4) : value;
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

function remaining(value: string): string {
  const seconds = Math.max(0, Math.ceil((Date.parse(value) - Date.now()) / 1000));
  if (seconds === 0) return "Expired";
  if (seconds < 60) return seconds + "s left";
  return Math.ceil(seconds / 60) + "m left";
}

function Spinner() {
  return <span className="spinner" aria-label="Loading" />;
}

function StatusPill({ status }: { status: Agent["status"] }) {
  return (
    <span className={"status status-" + status}>
      <span className="status-dot" />
      {status}
    </span>
  );
}

function Login({ onLogin, notice }: { onLogin: (user: User) => void; notice?: string | null }) {
  const [username, setUsername] = useState("alice");
  const [password, setPassword] = useState("alice-potato");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onLogin((await api.login(username, password)).user);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const chooseDemo = (name: "alice" | "bob") => {
    setUsername(name);
    setPassword(name + "-potato");
    setError(null);
  };

  return (
    <main className="auth-screen">
      <form className="auth-card" onSubmit={submit}>
        <div className="brand-mark">A</div>
        <span className="eyebrow">Agent Launchpad</span>
        <h1 id="login-title">Sign in to the control plane</h1>
        <p>Your session identifies which Agents and protected resources you can manage.</p>
        {(error || notice) && <div className="error-banner" role="alert">{error || notice}</div>}
        <label>
          Username
          <input
            autoFocus
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            autoComplete="username"
            required
          />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            required
          />
        </label>
        <button className="button button-primary login-button" disabled={busy}>
          {busy ? <Spinner /> : "Open Launchpad"}
        </button>
        <div className="demo-accounts">
          <span>Demo identities</span>
          <button type="button" onClick={() => chooseDemo("alice")}>Alice</button>
          <button type="button" onClick={() => chooseDemo("bob")}>Bob</button>
        </div>
      </form>
    </main>
  );
}

export default function App() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [resources, setResources] = useState<ResourceSummary[]>([]);
  const [grants, setGrants] = useState<PermissionGrant[]>([]);
  const [decisions, setDecisions] = useState<PolicyDecision[]>([]);
  const [chainValid, setChainValid] = useState(true);
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [view, setView] = useState<View>("playground");
  const [prompt, setPrompt] = useState("");
  const [resourceId, setResourceId] = useState("");
  const [activeRun, setActiveRun] = useState<AgentRun | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [form, setForm] = useState(emptyAgent);
  const [grantResourceId, setGrantResourceId] = useState("");
  const [purpose, setPurpose] = useState("Summarize for the launch review");
  const [ttlSeconds, setTtlSeconds] = useState(300);
  const [resourceForm, setResourceForm] = useState({
    name: "",
    description: "",
    content: "",
  });
  const [editingResource, setEditingResource] = useState<ResourceSummary | null>(null);
  const [resourceEditForm, setResourceEditForm] = useState({
    name: "",
    description: "",
    content: "",
  });
  const [, setClock] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [policyAlert, setPolicyAlert] = useState<{ reason: string; decisionId?: string } | null>(null);
  const selectedIdRef = useRef<string | null>(null);
  const polling = useRef(new Set<string>());
  selectedIdRef.current = selectedId;

  const selected = useMemo(
    () => agents.find((agent) => agent.id === selectedId) ?? null,
    [agents, selectedId],
  );
  const ownedResources = resources.filter((resource) => resource.ownedByCurrentUser);
  const activeGrants = grants.filter((grant) => grant.state === "active");

  const refreshResources = useCallback(async () => {
    const result = await api.resources();
    setResources(result.resources);
    setGrantResourceId((current) =>
      current && result.resources.some((resource) => resource.id === current && resource.ownedByCurrentUser)
        ? current
        : result.resources.find((resource) => resource.ownedByCurrentUser)?.id ?? "",
    );
    setResourceId((current) =>
      current && result.resources.some((resource) => resource.id === current) ? current : "",
    );
  }, []);

  const refreshAgents = useCallback(async () => {
    const next = (await api.listAgents()).agents;
    setAgents(next);
    setSelectedId((current) =>
      current && next.some((agent) => agent.id === current) ? current : next[0]?.id ?? null,
    );
  }, []);

  const bootstrap = useCallback(async () => {
    const [agentResult, nextSystem, resourceResult] = await Promise.all([
      api.listAgents(),
      api.system(),
      api.resources(),
    ]);
    setAgents(agentResult.agents);
    setSelectedId((current) =>
      current && agentResult.agents.some((agent) => agent.id === current)
        ? current
        : agentResult.agents[0]?.id ?? null,
    );
    setSystem(nextSystem);
    setResources(resourceResult.resources);
    setGrantResourceId(resourceResult.resources.find((resource) => resource.ownedByCurrentUser)?.id ?? "");
  }, []);

  const refreshAgentData = useCallback(async (agentId: string) => {
    const [messageResult, runResult, grantResult, decisionResult] = await Promise.all([
      api.messages(agentId),
      api.runs(agentId),
      api.grants(agentId),
      api.decisions(agentId),
    ]);
    if (selectedIdRef.current !== agentId) return;
    setMessages(messageResult.messages);
    setActiveRun(runResult.runs[0] ?? null);
    setGrants(grantResult.grants);
    setDecisions(decisionResult.decisions);
    setChainValid(decisionResult.chainValid);
  }, []);

  useEffect(() => {
    void api.session()
      .then(async ({ user: sessionUser }) => {
        setUser(sessionUser);
        await bootstrap();
      })
      .catch(() => setUser(null));
  }, [bootstrap]);

  useEffect(() => {
    const expired = () => {
      setUser(null);
      setAgents([]);
      setSelectedId(null);
      setError("Your session expired. Sign in again to continue.");
    };
    window.addEventListener("launchpad:session-expired", expired);
    return () => window.removeEventListener("launchpad:session-expired", expired);
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setClock((value) => value + 1), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!selectedId) {
      setMessages([]);
      setGrants([]);
      setDecisions([]);
      setActiveRun(null);
      return;
    }
    setShowSettings(false);
    setPolicyAlert(null);
    void refreshAgentData(selectedId).catch((reason) =>
      setError(reason instanceof Error ? reason.message : String(reason)),
    );
  }, [refreshAgentData, selectedId]);

  useEffect(() => {
    if (!selected) return;
    setForm({
      name: selected.name,
      description: selected.description,
      instructions: selected.instructions,
    });
  }, [selected]);

  const pollRun = async (runId: string, agentId: string) => {
    if (polling.current.has(runId)) return;
    polling.current.add(runId);
    try {
      while (true) {
        await new Promise((resolve) => window.setTimeout(resolve, 900));
        const result = await api.run(runId);
        if (selectedIdRef.current === agentId) setActiveRun(result.run);
        if (!["queued", "running"].includes(result.run.status)) {
          await Promise.all([refreshAgents(), refreshAgentData(agentId)]);
          return;
        }
      }
    } finally {
      polling.current.delete(runId);
    }
  };

  useEffect(() => {
    if (
      selectedId &&
      activeRun &&
      ["queued", "running"].includes(activeRun.status)
    ) {
      void pollRun(activeRun.id, selectedId);
    }
  }, [activeRun?.id, activeRun?.status, selectedId]);

  const loginComplete = async (nextUser: User) => {
    setUser(nextUser);
    setError(null);
    await bootstrap();
  };

  const logout = async () => {
    await api.logout();
    setUser(null);
    setAgents([]);
    setSelectedId(null);
  };

  const createAgent = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      const agent = (await api.createAgent(form)).agent;
      await refreshAgents();
      setSelectedId(agent.id);
      setShowCreate(false);
      setForm(emptyAgent);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const saveAgent = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected) return;
    setBusy(true);
    try {
      await api.updateAgent(selected.id, form);
      await refreshAgents();
      setShowSettings(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const toggleAgent = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      if (selected.status === "stopped") await api.startAgent(selected.id);
      else await api.stopAgent(selected.id);
      await refreshAgents();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const deleteAgent = async () => {
    if (!selected || !window.confirm("Delete " + selected.name + "? Its workspace will be archived.")) return;
    setBusy(true);
    try {
      await api.deleteAgent(selected.id);
      await refreshAgents();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const sendMessage = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected || !prompt.trim()) return;
    const content = prompt.trim();
    setPrompt("");
    setError(null);
    setPolicyAlert(null);
    try {
      const result = await api.sendMessage(selected.id, content, resourceId || undefined);
      setMessages((current) => [...current, result.message]);
      setActiveRun(result.run);
      setAgents((current) =>
        current.map((agent) => agent.id === selected.id ? { ...agent, status: "busy" } : agent),
      );
      await pollRun(result.run.id, selected.id);
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 403) {
        setPolicyAlert({
          reason: String(reason.details.reason ?? "GRANT_MISSING"),
          decisionId:
            typeof reason.details.decisionId === "string" ? reason.details.decisionId : undefined,
        });
        setView("audit");
        await refreshAgentData(selected.id);
      } else {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
      await refreshAgents();
    }
  };

  const createGrant = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected || !grantResourceId) return;
    setBusy(true);
    try {
      await api.createGrant(selected.id, { resourceId: grantResourceId, purpose, ttlSeconds });
      await refreshAgentData(selected.id);
      setPolicyAlert(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const createResource = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { resource } = await api.createResource(resourceForm);
      setResourceForm({ name: "", description: "", content: "" });
      await refreshResources();
      setGrantResourceId(resource.id);
      setResourceId(resource.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const deleteResource = async (resource: ResourceSummary) => {
    if (!window.confirm("Delete " + resource.name + "? Active leases will be revoked.")) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteResource(resource.id);
      await refreshResources();
      if (selected) await refreshAgentData(selected.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const openResourceEditor = (resource: ResourceSummary) => {
    setEditingResource(resource);
    setResourceEditForm({
      name: resource.name,
      description: resource.description,
      content: "",
    });
  };

  const updateResource = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!editingResource) return;
    setBusy(true);
    setError(null);
    try {
      await api.updateResource(editingResource.id, {
        name: resourceEditForm.name,
        description: resourceEditForm.description,
        ...(resourceEditForm.content.trim() ? { content: resourceEditForm.content } : {}),
      });
      setEditingResource(null);
      await refreshResources();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const exportReceipts = async () => {
    if (!selected) return;
    try {
      const blob = await api.decisionExport(selected.id);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = selected.name.toLowerCase().replace(/[^a-z0-9]+/g, "-") + "-receipts.csv";
      link.click();
      URL.revokeObjectURL(url);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const revokeGrant = async (grantId: string) => {
    if (!selected) return;
    setBusy(true);
    try {
      await api.revokeGrant(selected.id, grantId);
      await refreshAgentData(selected.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  if (user === undefined) {
    return <main className="auth-screen"><section className="auth-card"><div className="brand-mark">A</div><span className="eyebrow">Agent Launchpad</span><h1>Connecting to the control plane</h1><Spinner /></section></main>;
  }
  if (!user) return <Login notice={error} onLogin={(nextUser) => void loginComplete(nextUser)} />;

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">Skip to main content</a>
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">A</div>
          <div><strong>Agent Launchpad</strong><span>Permission-aware Codex runtime</span></div>
        </div>
        <button className="button button-primary create-button" onClick={() => {
          setForm(emptyAgent);
          setShowCreate(true);
        }}>＋ Create agent</button>
        <div className="sidebar-label"><span>Your agents</span><span>{agents.length}</span></div>
        <nav className="agent-list" aria-label="Agents">
          {agents.map((agent) => (
            <button
              className={"agent-card " + (agent.id === selectedId ? "selected" : "")}
              key={agent.id}
              onClick={() => setSelectedId(agent.id)}
            >
              <span className="agent-avatar">{agent.name.slice(0, 1).toUpperCase()}</span>
              <span className="agent-card-copy"><strong>{agent.name}</strong><span>{agent.description || "Coding agent"}</span></span>
              <span className={"mini-dot mini-" + agent.status} />
            </button>
          ))}
          {agents.length === 0 && <div className="empty-sidebar">No agents for {user.displayName}.</div>}
        </nav>
        <div className="runtime-card">
          <span className="eyebrow">Enforcement boundary</span>
          <strong>{system?.runtimeProvider === "container" ? "Disposable container" : "Local development"}</strong>
          <span>{system?.containerEngine ?? "Container required for protected files"}</span>
        </div>
        <div className="user-card">
          <span className="user-avatar">{user.displayName.slice(0, 1)}</span>
          <span><strong>{user.displayName}</strong><small>@{user.username}</small></span>
          <button onClick={() => void logout()} aria-label="Log out">↗</button>
        </div>
      </aside>

      <main className="main" id="main-content">
        {error && <div className="error-banner" role="alert"><span>{error}</span><button onClick={() => setError(null)}>×</button></div>}
        {!system?.arkConfigured || !system?.codexAvailable ? (
          <div className="config-banner"><strong>Runtime check</strong><span>
            {!system?.arkConfigured ? "Configure ARK_API_KEY and ARK_MODEL to run agents." : "Agent Runtime is unavailable."}
          </span></div>
        ) : null}

        {selected ? (
          <>
            <header className="agent-header">
              <div>
                <span className="eyebrow">Agent principal · {shortId(selected.principalId)}</span>
                <div className="header-title-row"><h1>{selected.name}</h1><StatusPill status={selected.status} /></div>
                <p>{selected.description || "An autonomous worker with deny-by-default access."}</p>
              </div>
              <div className="header-actions">
                <button className="button button-ghost" onClick={() => setShowSettings((open) => !open)}>Settings</button>
                <button className="button button-ghost" onClick={() => void toggleAgent()} disabled={busy}>{selected.status === "stopped" ? "Start" : "Stop"}</button>
                <button className="button button-danger" onClick={() => void deleteAgent()} disabled={busy || selected.status === "busy"}>Delete</button>
              </div>
            </header>

            <nav className="view-tabs" aria-label="Agent workspace">
              {(["playground", "resources", "access", "audit"] as View[]).map((item) => (
                <button key={item} className={view === item ? "active" : ""} onClick={() => setView(item)}>
                  {item === "playground" ? "Playground" : item === "resources" ? "Protected resources" : item === "access" ? "Access leases" : "Audit receipts"}
                  {item === "resources" && <span>{ownedResources.length}</span>}
                  {item === "access" && <span>{activeGrants.length}</span>}
                  {item === "audit" && <span>{decisions.length}</span>}
                </button>
              ))}
            </nav>

            {showSettings && (
              <form className="settings-panel" onSubmit={saveAgent}>
                <div className="panel-heading"><div><span className="eyebrow">Agent profile</span><h2>Configuration</h2></div><code>{shortId(selected.principalId)}</code></div>
                <div className="form-grid">
                  <label>Name<input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} required /></label>
                  <label>Description<input value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} /></label>
                </div>
                <label>Instructions<textarea rows={4} value={form.instructions} onChange={(event) => setForm({ ...form, instructions: event.target.value })} /></label>
                <div className="panel-footer"><span>Owner: {user.displayName}</span><button className="button button-primary" disabled={busy}>Save changes</button></div>
              </form>
            )}

            {view === "playground" && (
              <section className="playground">
                <div className="playground-topbar">
                  <div><span className="eyebrow">Playground</span><h2>Build something with your Agent</h2></div>
                  <span className="session-info"><i />{selected.codexThreadId ? "Session resumed" : "New session"}</span>
                </div>
                <div className="messages">
                  {messages.length === 0 && !activeRun ? (
                    <div className="welcome">
                      <div className="welcome-orbit"><div>⌁</div></div>
                      <h3>What should {selected.name} do?</h3>
                      <p>Run a standard task, or select a protected resource to exercise the capability policy before the Agent starts.</p>
                      <button onClick={() => {
                        setPrompt("Read the selected protected document and summarize its priorities and success metric.");
                        setResourceId(resources.find((resource) => resource.ownedByCurrentUser)?.id ?? "");
                      }}>Prepare the success-case prompt →</button>
                    </div>
                  ) : messages.map((message) => (
                    <article className={"message message-" + message.role} key={message.id}>
                      <div className="message-meta"><strong>{message.role === "user" ? user.displayName : selected.name}</strong><span>{formatTime(message.createdAt)}</span></div>
                      <div className="message-body">{message.content}</div>
                    </article>
                  ))}
                  {activeRun && ["queued", "running"].includes(activeRun.status) && (
                    <article className="message message-assistant thinking"><Spinner /><span>Runtime is executing with the approved capability mount…</span></article>
                  )}
                  {activeRun?.status === "failed" && <article className="run-error"><strong>Run failed</strong><span>{activeRun.error}</span></article>}
                </div>
                <form className="composer" onSubmit={sendMessage}>
                  <div className="resource-picker">
                    <label htmlFor="resource-select">Protected resource</label>
                    <select id="resource-select" value={resourceId} onChange={(event) => setResourceId(event.target.value)}>
                      <option value="">No protected resource</option>
                      {resources.map((resource) => <option key={resource.id} value={resource.id}>{resource.name} · {resource.ownerName}{resource.ownedByCurrentUser ? " · yours" : " · external"}</option>)}
                    </select>
                    <span className={resourceId ? "armed" : ""}>{resourceId ? "Policy check armed" : "Standard run"}</span>
                  </div>
                  <textarea
                    value={prompt}
                    onChange={(event) => setPrompt(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.shiftKey) {
                        event.preventDefault();
                        event.currentTarget.form?.requestSubmit();
                      }
                    }}
                    placeholder="Ask the agent to work with or without a protected resource…"
                    rows={3}
                    disabled={selected.status === "stopped" || selected.status === "busy"}
                  />
                  <div className="composer-footer"><span>Enter to send · Protected files mount read-only only after authorization</span><button className="send-button" disabled={!prompt.trim() || selected.status !== "ready"}>↑</button></div>
                </form>
              </section>
            )}

            {view === "access" && (
              <section className="security-layout">
                <form className="capability-card" onSubmit={createGrant}>
                  <div className="card-index">01 / ISSUE</div>
                  <span className="eyebrow">Just-in-time capability</span>
                  <h2>Grant the minimum access needed.</h2>
                  <div className="passport-line"><span>Principal</span><code>{shortId(selected.principalId)}</code></div>
                  <label>Resource<select value={grantResourceId} onChange={(event) => setGrantResourceId(event.target.value)}>{ownedResources.map((resource) => <option key={resource.id} value={resource.id}>{resource.name}</option>)}</select></label>
                  <label>Purpose<input value={purpose} onChange={(event) => setPurpose(event.target.value)} maxLength={240} required /></label>
                  <label>Lease duration<select value={ttlSeconds} onChange={(event) => setTtlSeconds(Number(event.target.value))}><option value={60}>60 seconds</option><option value={300}>5 minutes</option><option value={900}>15 minutes</option></select></label>
                  <button className="button button-primary" disabled={busy || !grantResourceId}>Issue capability lease</button>
                  <small>Permission is scoped to one agent, one resource, and the read action.</small>
                </form>
                <div className="lease-list-panel">
                  <div className="panel-heading"><div><span className="eyebrow">Capability register</span><h2>Issued leases</h2></div><span>{grants.length} total</span></div>
                  <div className="lease-list">
                    {grants.map((grant) => (
                      <article className={"lease-item lease-" + grant.state} key={grant.id}>
                        <span className="lease-state">{grant.state}</span>
                        <div><strong>{grant.resourceName}</strong><p>{grant.purpose}</p><code>read · {shortId(grant.id)}</code></div>
                        <div className="lease-actions"><span>{grant.state === "active" ? remaining(grant.expiresAt) : grant.state}</span>{grant.state === "active" && <button onClick={() => void revokeGrant(grant.id)} disabled={busy}>Revoke</button>}</div>
                      </article>
                    ))}
                    {grants.length === 0 && <div className="empty-state">No capability has ever been issued to this principal.</div>}
                  </div>
                </div>
              </section>
            )}

            {view === "resources" && (
              <section className="resource-layout">
                <form className="resource-create-panel" onSubmit={createResource}>
                  <span className="eyebrow">Resource vault</span>
                  <h2>Add protected data</h2>
                  <p>The document stays on the server. Its contents are never returned to the browser after creation.</p>
                  <label>Name<input value={resourceForm.name} onChange={(event) => setResourceForm({ ...resourceForm, name: event.target.value })} placeholder="Launch brief" maxLength={100} required /></label>
                  <label>Description<input value={resourceForm.description} onChange={(event) => setResourceForm({ ...resourceForm, description: event.target.value })} placeholder="What this resource contains" maxLength={500} /></label>
                  <label>Plain-text content<textarea value={resourceForm.content} onChange={(event) => setResourceForm({ ...resourceForm, content: event.target.value })} placeholder="Paste fictional demo data here…" rows={8} maxLength={100_000} required /></label>
                  <button className="button button-primary" disabled={busy || !resourceForm.name.trim() || !resourceForm.content.trim()}>{busy ? <Spinner /> : "Protect resource"}</button>
                </form>
                <div className="resource-list-panel">
                  <div className="panel-heading"><div><span className="eyebrow">Ownership boundary</span><h2>Available resources</h2></div><span>{resources.length} visible</span></div>
                  <div className="resource-list">
                    {resources.map((resource) => (
                      <article className={"resource-item " + (resource.ownedByCurrentUser ? "resource-owned" : "resource-external")} key={resource.id}>
                        <span className="resource-icon">{resource.ownedByCurrentUser ? "◇" : "⊘"}</span>
                        <div><strong>{resource.name}</strong><p>{resource.description || "No description"}</p><small>{resource.ownerName} · {Math.max(1, Math.ceil(resource.sizeBytes / 1024))} KB · {resource.isDemo ? "demo fixture" : "user-created"}</small></div>
                        <div className="resource-actions">
                          <span>{resource.ownedByCurrentUser ? "Owned" : "External"}</span>
                          {resource.ownedByCurrentUser && !resource.isDemo && (
                            <div>
                              <button onClick={() => openResourceEditor(resource)} disabled={busy}>Edit</button>
                              <button onClick={() => void deleteResource(resource)} disabled={busy}>Delete</button>
                            </div>
                          )}
                        </div>
                      </article>
                    ))}
                  </div>
                </div>
              </section>
            )}

            {view === "audit" && (
              <section className="audit-panel">
                <div className="audit-header">
                  <div><span className="eyebrow">Attributable evidence</span><h2>Access receipts</h2><p>Every protected read is decided before the agent Runtime starts.</p></div>
                  <div className="audit-tools"><span className={chainValid ? "chain-ok" : "chain-bad"}>{chainValid ? "Hash chain verified" : "Receipt chain invalid"}</span><button className="button button-ghost" onClick={() => void exportReceipts()} disabled={decisions.length === 0}>Export CSV</button><div className="audit-stats"><span><b>{decisions.filter((item) => item.outcome === "allow").length}</b> allowed</span><span><b>{decisions.filter((item) => item.outcome === "deny").length}</b> denied</span></div></div>
                </div>
                {policyAlert && <div className="policy-alert" role="alert"><span>DENY</span><div><strong>{reasonLabels[policyAlert.reason] ?? policyAlert.reason}</strong><p>The protected resource was not mounted and the agent Runtime did not start.</p></div></div>}
                <div className="receipt-table" role="table" aria-label="Policy decisions">
                  <div className="receipt-row receipt-head" role="row"><span>Decision</span><span>Actor → Principal</span><span>Resource</span><span>Reason</span><span>Time</span></div>
                  {decisions.map((decision) => (
                    <article className="receipt-row" role="row" key={decision.id}>
                      <span><b className={"decision decision-" + decision.outcome}>{decision.outcome}</b><code>{shortId(decision.id)}</code><small>hash {shortId(decision.receiptHash)}</small></span>
                      <span><strong>{decision.humanName}</strong><code>{shortId(decision.agentPrincipalId)}</code></span>
                      <span><strong>{decision.resourceName}</strong><small>{decision.action} · read-only</small></span>
                      <span>{reasonLabels[decision.reason] ?? decision.reason}</span>
                      <span>{formatTime(decision.createdAt)}</span>
                    </article>
                  ))}
                  {decisions.length === 0 && <div className="empty-state">No protected action has been requested yet.</div>}
                </div>
              </section>
            )}
          </>
        ) : (
          <section className="no-agent"><div className="no-agent-art">A</div><span className="eyebrow">Agent Launchpad</span><h1>Your runtime is ready for an Agent.</h1><p>Create a workspace with its own principal and deny-by-default protected-resource access.</p><button className="button button-primary" onClick={() => setShowCreate(true)}>Create your first Agent</button></section>
        )}
      </main>

      {showCreate && (
        <div className="modal-backdrop" onMouseDown={() => setShowCreate(false)}>
          <form className="modal" onSubmit={createAgent} onMouseDown={(event) => event.stopPropagation()}>
            <div className="modal-heading"><div><span className="eyebrow">New workspace</span><h2>Create an Agent</h2><p>Each Agent gets a persistent folder and a unique permission principal.</p></div><button type="button" onClick={() => setShowCreate(false)}>×</button></div>
            <label>Name<input autoFocus value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="Launch Analyst" required /></label>
            <label>Description<input value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} placeholder="Summarizes launch documents" /></label>
            <label>Instructions<textarea rows={5} value={form.instructions} onChange={(event) => setForm({ ...form, instructions: event.target.value })} /></label>
            <div className="modal-footer"><button type="button" className="button button-ghost" onClick={() => setShowCreate(false)}>Cancel</button><button className="button button-primary" disabled={busy}>Create agent</button></div>
          </form>
        </div>
      )}

      {editingResource && (
        <div className="modal-backdrop" onMouseDown={() => setEditingResource(null)}>
          <form className="modal" onSubmit={updateResource} onMouseDown={(event) => event.stopPropagation()}>
            <div className="modal-heading"><div><span className="eyebrow">Protected resource</span><h2>Edit metadata or replace content</h2><p>Existing content is never sent to the browser. Leave replacement content blank to preserve it.</p></div><button type="button" onClick={() => setEditingResource(null)}>×</button></div>
            <label>Name<input autoFocus value={resourceEditForm.name} onChange={(event) => setResourceEditForm({ ...resourceEditForm, name: event.target.value })} maxLength={100} required /></label>
            <label>Description<input value={resourceEditForm.description} onChange={(event) => setResourceEditForm({ ...resourceEditForm, description: event.target.value })} maxLength={500} /></label>
            <label>Replacement content (optional)<textarea rows={6} value={resourceEditForm.content} onChange={(event) => setResourceEditForm({ ...resourceEditForm, content: event.target.value })} maxLength={100_000} placeholder="Leave blank to keep the current protected content" /></label>
            <div className="modal-footer"><button type="button" className="button button-ghost" onClick={() => setEditingResource(null)}>Cancel</button><button className="button button-primary" disabled={busy || !resourceEditForm.name.trim()}>{busy ? <Spinner /> : "Save resource"}</button></div>
          </form>
        </div>
      )}
    </div>
  );
}

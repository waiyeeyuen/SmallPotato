import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import { MarkdownContent } from "./MarkdownContent";
import type {
  Agent,
  ResourceSummary,
  TeamAgentSelection,
  TeamResourceAccessMode,
  TeamTask,
  TeamTaskEvent,
} from "./types";

interface Props {
  agents: Agent[];
  resources: ResourceSummary[];
  onAgentsChanged: () => Promise<void>;
  onCreateAgent: () => void;
  onError: (message: string) => void;
}

/** One rendered line of the team conversation: an Agent turn, or a short note. */
type ChatEntry =
  | { kind: "agent"; id: string; name: string; role?: string; body: string; at: string }
  | { kind: "note"; id: string; tone: "info" | "allow" | "deny"; body: string; detail?: string | null; at: string };

const terminalStatuses = new Set<TeamTask["status"]>(["completed", "failed", "stopped"]);

const STATUS_LABEL: Record<TeamTask["status"], string> = {
  running: "Working",
  paused: "Paused",
  completed: "Done",
  failed: "Failed",
  stopped: "Stopped",
};

const EVENT_LABEL: Record<string, string> = {
  task_started: "Task started",
  turn_started: "Turn started",
  coordination_plan: "Plan set",
  lead_decision: "Lead update",
  delegated: "Passed to a member",
  specialist_result: "Member replied",
  turn_retry: "Retried a turn",
  turn_failed: "Turn failed",
  resource_authorization: "Access decision",
  task_access_granted: "Task access issued",
  task_access_revoked: "Task access closed",
  task_paused: "Paused",
  task_resumed: "Resumed",
  task_completed: "Task finished",
  task_stopped: "Stopped",
  system: "System",
};

function time(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function initials(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join("") || "?"
  );
}

function oneLine(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > 120 ? compact.slice(0, 117) + "…" : compact;
}

function elapsed(startedAt: string | null): string {
  if (!startedAt) return "starting";
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(startedAt)) / 1_000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function modeText(task: TeamTask): string {
  if (task.turnPolicy === "sequential") return "Members take turns in a set order";
  if (task.turnPolicy === "facilitated") return "The Lead chooses who replies next";
  return "The Lead is still setting up";
}

export function TeamTaskView({ agents, resources, onAgentsChanged, onCreateAgent, onError }: Props) {
  const [tasks, setTasks] = useState<TeamTask[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [task, setTask] = useState<TeamTask | null>(null);
  const [events, setEvents] = useState<TeamTaskEvent[]>([]);
  const [eventsVerified, setEventsVerified] = useState<boolean | null>(null);
  const [objective, setObjective] = useState("");
  const [leadId, setLeadId] = useState("");
  const [agentSelection, setAgentSelection] = useState<TeamAgentSelection>("user");
  const [specialistIds, setSpecialistIds] = useState<string[]>([]);
  const [resourceId, setResourceId] = useState("");
  const [resourceAccessMode, setResourceAccessMode] =
    useState<TeamResourceAccessMode>("task");
  const [submitting, setSubmitting] = useState(false);
  const [, setClock] = useState(0);
  const objectiveRef = useRef<HTMLTextAreaElement>(null);
  const conversationEnd = useRef<HTMLDivElement>(null);

  const agentMap = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents]);
  const readyAgents = useMemo(
    () => agents.filter((agent) => agent.status === "ready" && !agent.activeTeamTaskId),
    [agents],
  );
  const ownedResources = useMemo(
    () => resources.filter((resource) => resource.ownedByCurrentUser),
    [resources],
  );
  const openTask = tasks.find((item) => item.status === "running" || item.status === "paused");
  const participants = task ? [task.leadAgentId, ...task.specialistAgentIds] : [];

  const refreshTasks = useCallback(async () => {
    const result = await api.listTeamTasks();
    setTasks(result.tasks);
    setSelectedId((current) =>
      current && result.tasks.some((item) => item.id === current)
        ? current
        : result.tasks[0]?.id ?? null,
    );
    return result.tasks;
  }, []);

  const refreshDetail = useCallback(async (id: string) => {
    const result = await api.teamTask(id);
    setTask(result.task);
    setEvents(result.events);
    setEventsVerified(result.eventsVerified);
    setTasks((current) => {
      const next = current.some((item) => item.id === result.task.id)
        ? current.map((item) => (item.id === result.task.id ? result.task : item))
        : [result.task, ...current];
      return next.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    });
    return result;
  }, []);

  useEffect(() => {
    void refreshTasks().catch((reason) =>
      onError(reason instanceof Error ? reason.message : String(reason)),
    );
  }, [onError, refreshTasks]);

  useEffect(() => {
    if (!selectedId) {
      setTask(null);
      setEvents([]);
      setEventsVerified(null);
      return;
    }
    let cancelled = false;
    let timer = 0;
    let lastEventCount = -1;
    const poll = async () => {
      try {
        const result = await refreshDetail(selectedId);
        if (cancelled) return;
        if (result.events.length !== lastEventCount) {
          lastEventCount = result.events.length;
          conversationEnd.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
        }
        if (result.task.status === "running") {
          timer = window.setTimeout(poll, 400);
        } else if (terminalStatuses.has(result.task.status)) {
          await Promise.all([refreshTasks(), onAgentsChanged()]);
        }
      } catch (reason) {
        if (!cancelled) onError(reason instanceof Error ? reason.message : String(reason));
      }
    };
    void poll();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // `task?.status` is a dep so resuming a paused task (paused -> running) restarts polling.
  }, [onAgentsChanged, onError, refreshDetail, refreshTasks, selectedId, task?.status]);

  useEffect(() => {
    const timer = window.setInterval(() => setClock((value) => value + 1), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!readyAgents.some((agent) => agent.id === leadId)) {
      setLeadId(readyAgents[0]?.id ?? "");
    }
    setSpecialistIds((current) =>
      current.filter((id) => id !== leadId && readyAgents.some((agent) => agent.id === id)),
    );
  }, [agents, leadId, readyAgents]);

  const leadPicksAgents = agentSelection === "lead";
  const otherReadyCount = readyAgents.filter((agent) => agent.id !== leadId).length;
  const canSubmit =
    Boolean(objective.trim()) &&
    Boolean(leadId) &&
    (leadPicksAgents ? otherReadyCount >= 1 : specialistIds.length > 0);

  const createTask = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const result = await api.createTeamTask({
        objective: objective.trim(),
        leadAgentId: leadId,
        specialistAgentIds: leadPicksAgents ? [] : specialistIds,
        agentSelection,
        ...(resourceId ? { resourceId } : {}),
        ...(resourceId ? { resourceAccessMode } : {}),
      });
      setObjective("");
      setSpecialistIds([]);
      setResourceId("");
      setResourceAccessMode("task");
      setSelectedId(result.task.id);
      setTask(result.task);
      setEvents([]);
      setEventsVerified(null);
      await Promise.all([refreshTasks(), onAgentsChanged()]);
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSubmitting(false);
    }
  };

  const action = async (kind: "stop" | "resume") => {
    if (!task) return;
    setSubmitting(true);
    try {
      if (kind === "stop") await api.stopTeamTask(task.id);
      else await api.resumeTeamTask(task.id);
      await Promise.all([refreshDetail(task.id), refreshTasks(), onAgentsChanged()]);
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSubmitting(false);
    }
  };

  const startNewTask = () => {
    setSelectedId(null);
    setObjective("");
    setSpecialistIds([]);
    setResourceId("");
    setResourceAccessMode("task");
    window.requestAnimationFrame(() => objectiveRef.current?.focus());
  };

  const toggleSpecialist = (id: string) => {
    setSpecialistIds((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    );
  };

  const replyCount = (agentId: string) =>
    events.filter((event) => event.agentId === agentId && event.type === "specialist_result").length;

  const workingName = agentMap.get(task?.currentAgentId ?? "")?.name ?? "The team";
  const showForm = !openTask && (!task || terminalStatuses.has(task.status));
  const formReady = showForm && !openTask && readyAgents.length >= 2;
  const finalMessage =
    task?.status === "completed" && task.completionSummary
      ? { name: agentMap.get(task.leadAgentId)?.name ?? "Lead", body: task.completionSummary }
      : null;

  /**
   * The chat is built from the same event log the Activity panel shows, so
   * whatever the team actually did is what a reader sees — no separate
   * transcript that can drift.
   *
   * Every Agent turn becomes a bubble in both coordination modes. Handoffs and
   * policy decisions become compact one-line notes, so the reason work stopped
   * or resumed is visible in the conversation rather than buried in the log.
   */
  const conversation = useMemo<ChatEntry[]>(() => {
    const entries: ChatEntry[] = [];
    for (const item of events) {
      const name = item.agentId ? agentMap.get(item.agentId)?.name ?? "Agent" : "System";
      switch (item.type) {
        case "coordination_plan":
          entries.push({ kind: "note", id: item.id, tone: "info", at: item.createdAt, body: item.content });
          break;
        case "lead_decision":
          if (item.content.trim()) {
            entries.push({ kind: "agent", id: item.id, name, role: "Lead", at: item.createdAt, body: item.content });
          }
          break;
        case "delegated":
          entries.push({
            kind: "note",
            id: item.id,
            tone: "info",
            at: item.createdAt,
            body: item.content,
            detail: item.assignment,
          });
          break;
        case "specialist_result":
          entries.push({
            kind: "agent",
            id: item.id,
            name,
            at: item.createdAt,
            body: item.chatContent ?? item.content,
          });
          break;
        case "resource_authorization":
          entries.push({
            kind: "note",
            id: item.id,
            tone: item.content.startsWith("DENY") ? "deny" : "allow",
            at: item.createdAt,
            body: item.content,
          });
          break;
        case "task_access_granted":
          entries.push({ kind: "note", id: item.id, tone: "allow", at: item.createdAt, body: item.content });
          break;
        case "task_access_revoked":
          entries.push({ kind: "note", id: item.id, tone: "info", at: item.createdAt, body: item.content });
          break;
        case "turn_retry":
        case "turn_failed":
        case "task_paused":
        case "task_resumed":
        case "task_stopped":
          entries.push({
            kind: "note",
            id: item.id,
            tone: item.type === "task_resumed" ? "info" : "deny",
            at: item.createdAt,
            body: item.content,
          });
          break;
        default:
          break;
      }
    }
    return entries;
  }, [events, agentMap]);

  return (
    <section className="team-view">
      <header className="team-bar">
        <div className="team-bar-title">
          <h1>Team Tasks</h1>
          {task && (
            <span className={`team-chip team-chip-${task.status}`}>{STATUS_LABEL[task.status]}</span>
          )}
        </div>
        <div className="team-bar-actions">
          {task?.status === "running" && (
            <button
              className="button button-danger"
              disabled={submitting}
              onClick={() => void action("stop")}
            >
              Stop
            </button>
          )}
          {task?.status === "paused" && (
            <>
              <button
                className="button button-primary"
                disabled={submitting}
                onClick={() => void action("resume")}
              >
                Resume
              </button>
              <button
                className="button button-ghost"
                disabled={submitting}
                onClick={() => void action("stop")}
              >
                Stop
              </button>
            </>
          )}
          {!openTask && task && terminalStatuses.has(task.status) && (
            <button className="button button-primary" onClick={startNewTask}>
              New task
            </button>
          )}
        </div>
      </header>

      <div className="team-body">
        <aside className="team-side">
          {formReady ? (
            <form className="team-form" onSubmit={createTask}>
              <button
                className="button button-primary team-start-btn"
                disabled={submitting || !canSubmit}
              >
                {submitting ? <span className="spinner" aria-label="Starting" /> : "Start task"}
              </button>
              <details className="team-panel" open={showForm}>
                <summary>Start a task</summary>
                <div className="team-panel-body">
                  <label>
                    What should the team do?
                    <textarea
                      ref={objectiveRef}
                      rows={4}
                      value={objective}
                      onChange={(event) => setObjective(event.target.value)}
                      maxLength={20_000}
                      placeholder="Describe one outcome you want the team to deliver…"
                    />
                  </label>
                  <label>
                    Lead agent
                    <select
                      value={leadId}
                      onChange={(event) => {
                        setLeadId(event.target.value);
                        setSpecialistIds((ids) => ids.filter((id) => id !== event.target.value));
                      }}
                    >
                      <option value="">Choose a lead</option>
                      {readyAgents.map((agent) => (
                        <option key={agent.id} value={agent.id}>
                          {agent.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <fieldset className="team-radio-group">
                    <legend>Who picks the other members?</legend>
                    <label className="team-choice">
                      <input
                        type="radio"
                        name="agentSelection"
                        checked={agentSelection === "user"}
                        onChange={() => setAgentSelection("user")}
                      />
                      <span>
                        <strong>You pick them</strong>
                        <small>Choose the exact members below.</small>
                      </span>
                    </label>
                    <label className="team-choice">
                      <input
                        type="radio"
                        name="agentSelection"
                        checked={agentSelection === "lead"}
                        onChange={() => setAgentSelection("lead")}
                      />
                      <span>
                        <strong>The Lead picks them</strong>
                        <small>
                          The Lead reads the task and picks from your {otherReadyCount} other ready
                          agent{otherReadyCount === 1 ? "" : "s"}.
                        </small>
                      </span>
                    </label>
                  </fieldset>
                  <label>
                    Protected document (optional)
                    <select value={resourceId} onChange={(event) => setResourceId(event.target.value)}>
                      <option value="">No protected document</option>
                      {ownedResources.map((resource) => (
                        <option key={resource.id} value={resource.id}>
                          {resource.name} · yours
                        </option>
                      ))}
                    </select>
                  </label>
                  {resourceId && (
                    <fieldset className="team-access-consent">
                      <legend>Document access</legend>
                      <label className="team-choice">
                        <input
                          type="radio"
                          name="resourceAccessMode"
                          checked={resourceAccessMode === "task"}
                          onChange={() => setResourceAccessMode("task")}
                        />
                        <span>
                          <strong>Authorize for this task</strong>
                          <small>
                            Recommended · issue temporary read-only capabilities to the final
                            specialist roster, then revoke them automatically when the task ends.
                          </small>
                        </span>
                      </label>
                      <label className="team-choice">
                        <input
                          type="radio"
                          name="resourceAccessMode"
                          checked={resourceAccessMode === "manual"}
                          onChange={() => setResourceAccessMode("manual")}
                        />
                        <span>
                          <strong>Require manual approval</strong>
                          <small>
                            The first specialist without a lease is denied before Runtime execution,
                            and the task pauses for approval.
                          </small>
                        </span>
                      </label>
                      <p className="team-hint">
                        The Lead coordinates without the raw document. Every specialist is still
                        checked separately before each turn; attaching a document never grants
                        account-wide access.
                      </p>
                    </fieldset>
                  )}
                  {leadPicksAgents ? (
                    <p className="team-hint">
                      The Lead will decide which agents to involve and how they work together on its
                      first turn.
                    </p>
                  ) : (
                    <fieldset>
                      <legend>Members</legend>
                      <div className="team-member-picker">
                        {agents
                          .filter((agent) => agent.id !== leadId)
                          .map((agent) => (
                            <label className="team-choice" key={agent.id}>
                              <input
                                type="checkbox"
                                checked={specialistIds.includes(agent.id)}
                                disabled={agent.status !== "ready" || Boolean(agent.activeTeamTaskId)}
                                onChange={() => toggleSpecialist(agent.id)}
                              />
                              <span className="team-choice-avatar" aria-hidden="true">
                                {initials(agent.name)}
                              </span>
                              <span>
                                <strong>{agent.name}</strong>
                                <small>
                                  {agent.description ||
                                    (agent.status === "ready" ? "Ready" : "Not available")}
                                </small>
                              </span>
                            </label>
                          ))}
                      </div>
                    </fieldset>
                  )}
                </div>
              </details>
            </form>
          ) : (
            <details className="team-panel" open={showForm}>
              <summary>Start a task</summary>
              <div className="team-panel-body">
                {openTask ? (
                  <div className="team-note">
                    <p>A task is already running. Stop or finish it before starting another.</p>
                    <button
                      type="button"
                      className="button button-ghost"
                      onClick={() => setSelectedId(openTask.id)}
                    >
                      Go to it
                    </button>
                  </div>
                ) : (
                  <div className="team-note">
                    <p>You need at least two ready agents — one Lead and one other.</p>
                    <button type="button" className="button button-primary" onClick={onCreateAgent}>
                      Create an agent
                    </button>
                  </div>
                )}
              </div>
            </details>
          )}

          {task && (
            <details className="team-panel">
              <summary>This task</summary>
              <div className="team-panel-body">
                <p className="team-mode">{modeText(task)}</p>
                {task.resourceId && (
                  <p className="team-access-summary">
                    <strong>{task.resourceAccessMode === "task" ? "Task-scoped access" : "Manual access"}</strong>
                    {task.resourceAccessMode === "task"
                      ? " · temporary read capabilities for the specialist roster"
                      : " · each specialist needs an existing lease"}
                  </p>
                )}
                <ul className="team-members">
                  {participants.map((id, index) => {
                    const agent = agentMap.get(id);
                    const working = task.currentAgentId === id;
                    const replies = replyCount(id);
                    return (
                      <li className={working ? "working" : ""} key={id}>
                        <span className="team-avatar team-avatar-sm" aria-hidden="true">
                          {initials(agent?.name ?? "?")}
                        </span>
                        <span className="team-member-copy">
                          <strong>{agent?.name ?? "Unknown agent"}</strong>
                          <small>
                            {index === 0
                              ? "Lead"
                              : working
                                ? "replying now…"
                                : replies === 0
                                  ? "no replies yet"
                                  : `${replies} repl${replies === 1 ? "y" : "ies"}`}
                          </small>
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            </details>
          )}

          {task && events.length > 0 && (
            <details className="team-panel">
              <summary>
                Activity log
                <small
                  className={eventsVerified === false ? "team-verify-bad" : "team-verify-ok"}
                  title={
                    eventsVerified === false
                      ? "The saved record failed its tamper check."
                      : "Every step is saved and tamper-checked."
                  }
                >
                  {events.length} step{events.length === 1 ? "" : "s"}
                  {eventsVerified === false ? " · check failed" : eventsVerified ? " · verified" : ""}
                </small>
              </summary>
              <div className="team-panel-body team-log-list">
                {events.map((item) => {
                  const actor = item.agentId
                    ? agentMap.get(item.agentId)?.name ?? "Unknown agent"
                    : "System";
                  const label = EVENT_LABEL[item.type] ?? item.type.replace(/_/g, " ");
                  const notes = item.statePatch
                    ? Object.entries(item.statePatch)
                        .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
                        .join(", ")
                    : "";
                  const decision =
                    item.type === "resource_authorization"
                      ? item.content.startsWith("DENY")
                        ? "deny"
                        : "allow"
                      : null;
                  return (
                    <details
                      className={decision ? `team-log team-log-${decision}` : "team-log"}
                      key={item.id}
                    >
                      <summary>
                        <strong>{label}</strong>
                        <span>{actor}</span>
                        <time>{time(item.createdAt)}</time>
                      </summary>
                      <div className="team-log-detail">
                        {item.content && <p>{item.content}</p>}
                        {item.assignment && (
                          <p>
                            <b>Task given:</b> {item.assignment}
                          </p>
                        )}
                        {item.chatContent && (
                          <p>
                            <b>Shown in chat:</b> {item.chatContent}
                          </p>
                        )}
                        {notes && (
                          <p>
                            <b>Shared notes:</b> {notes}
                          </p>
                        )}
                      </div>
                    </details>
                  );
                })}
              </div>
            </details>
          )}

          {tasks.length > 0 && (
            <details className="team-panel">
              <summary>History</summary>
              <div className="team-panel-body team-history">
                {tasks.map((item) => (
                  <button
                    className={item.id === selectedId ? "selected" : ""}
                    key={item.id}
                    onClick={() => setSelectedId(item.id)}
                  >
                    <strong>{oneLine(item.objective)}</strong>
                    <small>
                      {STATUS_LABEL[item.status]} · {item.turnCount} turn
                      {item.turnCount === 1 ? "" : "s"}
                    </small>
                  </button>
                ))}
              </div>
            </details>
          )}
        </aside>

        <div className="team-chat-wrap">
          {!task ? (
            <div className="team-empty">
              <div className="welcome-orbit">
                <div>◇</div>
              </div>
              <h2>Start a team task</h2>
              <p>Describe what you want done, pick a Lead, and the team takes it from there.</p>
            </div>
          ) : (
            <>
              <div className="team-chat-head" title={task.objective}>
                {oneLine(task.objective)}
              </div>
              <div className="team-chat" aria-label="Team conversation">
                <article className="team-message team-message-objective">
                  <div className="team-avatar" aria-hidden="true">
                    Y
                  </div>
                  <div className="team-message-body">
                    <div className="team-message-meta">
                      <strong>You</strong>
                      <time>{time(task.createdAt)}</time>
                    </div>
                    <div className="team-bubble">
                      <MarkdownContent>{task.objective}</MarkdownContent>
                    </div>
                  </div>
                </article>

                {/* Every Agent turn appears here in both coordination modes; handoffs
                    and policy decisions appear as short notes so the reader can follow
                    why the team did what it did. */}
                {conversation.map((entry) =>
                  entry.kind === "agent" ? (
                    <article className="team-message" key={entry.id}>
                      <div className="team-avatar" aria-hidden="true">
                        {initials(entry.name)}
                      </div>
                      <div className="team-message-body">
                        <div className="team-message-meta">
                          <strong>{entry.name}</strong>
                          {entry.role && <span>{entry.role}</span>}
                          <time>{time(entry.at)}</time>
                        </div>
                        <div className="team-bubble">
                          <MarkdownContent>{entry.body}</MarkdownContent>
                        </div>
                      </div>
                    </article>
                  ) : (
                    <div className={`team-system-entry team-note-${entry.tone}`} key={entry.id}>
                      <div className="team-system-message">
                        <span aria-hidden="true">
                          {entry.tone === "deny" ? "!" : entry.tone === "allow" ? "\u2713" : "\u00b7"}
                        </span>
                        <span>
                          {entry.body}
                          {entry.detail && <em className="team-note-detail">{entry.detail}</em>}
                        </span>
                      </div>
                    </div>
                  ),
                )}

                {task.status === "running" && (
                  <div className="team-typing">
                    <span />
                    <span />
                    <span />
                    <small>
                      {task.currentAgentId && agentMap.get(task.currentAgentId)
                        ? `${workingName} is replying…`
                        : "The team is working…"}
                    </small>
                  </div>
                )}

                {finalMessage && (
                  <article className="team-message">
                    <div className="team-avatar" aria-hidden="true">
                      {initials(finalMessage.name)}
                    </div>
                    <div className="team-message-body">
                      <div className="team-message-meta">
                        <strong>{finalMessage.name}</strong>
                        <span>Final answer</span>
                        <time>{time(task.completedAt ?? task.updatedAt)}</time>
                      </div>
                      <div className="team-bubble">
                        <MarkdownContent>{finalMessage.body}</MarkdownContent>
                      </div>
                    </div>
                  </article>
                )}

                <div ref={conversationEnd} />
              </div>

              {task.status === "running" && (
                <div className="team-working" aria-live="polite">
                  <span className="team-live-pulse">
                    <i />
                    <i />
                    <i />
                  </span>
                  <span>
                    <strong>{workingName}</strong> is working · {elapsed(task.activeTurnStartedAt)} ·
                    step {task.turnCount}
                  </span>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  );
}

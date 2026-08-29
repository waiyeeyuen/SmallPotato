import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import { MarkdownContent } from "./MarkdownContent";
import type { Agent, TeamTask, TeamTaskEvent } from "./types";

interface Props {
  agents: Agent[];
  onAgentsChanged: () => Promise<void>;
  onCreateAgent: () => void;
  onError: (message: string) => void;
}

const terminalStatuses = new Set<TeamTask["status"]>([
  "completed",
  "failed",
  "stopped",
]);

function time(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("") || "?";
}

function oneLine(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > 110 ? compact.slice(0, 107) + "…" : compact;
}

function elapsed(startedAt: string | null): string {
  if (!startedAt) return "Preparing turn";
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(startedAt)) / 1_000));
  return seconds < 60 ? `${seconds}s elapsed` : `${Math.floor(seconds / 60)}m ${seconds % 60}s elapsed`;
}

function phaseLabel(task: TeamTask): string {
  const phase = task.sharedState.phase;
  return typeof phase === "string" ? phase : task.status;
}

export function TeamTaskView({
  agents,
  onAgentsChanged,
  onCreateAgent,
  onError,
}: Props) {
  const [tasks, setTasks] = useState<TeamTask[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [task, setTask] = useState<TeamTask | null>(null);
  const [events, setEvents] = useState<TeamTaskEvent[]>([]);
  const [objective, setObjective] = useState("");
  const [leadId, setLeadId] = useState("");
  const [specialistIds, setSpecialistIds] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [, setClock] = useState(0);
  const objectiveRef = useRef<HTMLTextAreaElement>(null);
  const conversationEnd = useRef<HTMLDivElement>(null);

  const agentMap = useMemo(
    () => new Map(agents.map((agent) => [agent.id, agent])),
    [agents],
  );
  const readyAgents = useMemo(
    () => agents.filter((agent) => agent.status === "ready" && !agent.activeTeamTaskId),
    [agents],
  );
  const openTask = tasks.find((item) => item.status === "running" || item.status === "paused");
  const participants = task
    ? [task.leadAgentId, ...task.specialistAgentIds]
    : [];
  const collaborationRounds = events.filter((event) => event.type === "specialist_result").length;

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
    setTasks((current) => {
      const next = current.some((item) => item.id === result.task.id)
        ? current.map((item) => item.id === result.task.id ? result.task : item)
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
  }, [onAgentsChanged, onError, refreshDetail, refreshTasks, selectedId]);

  useEffect(() => {
    const timer = window.setInterval(() => setClock((value) => value + 1), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!readyAgents.some((agent) => agent.id === leadId)) {
      setLeadId(readyAgents[0]?.id ?? "");
    }
    setSpecialistIds((current) =>
      current.filter((id) =>
        id !== leadId && readyAgents.some((agent) => agent.id === id),
      ),
    );
  }, [agents, leadId, readyAgents]);

  const createTask = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!objective.trim() || !leadId || specialistIds.length === 0) return;
    setSubmitting(true);
    try {
      const result = await api.createTeamTask({
        objective: objective.trim(),
        leadAgentId: leadId,
        specialistAgentIds: specialistIds,
      });
      setObjective("");
      setSpecialistIds([]);
      setSelectedId(result.task.id);
      setTask(result.task);
      setEvents([]);
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

  const startAnotherTask = () => {
    setObjective("");
    setSpecialistIds([]);
    window.requestAnimationFrame(() => objectiveRef.current?.focus());
  };

  const toggleSpecialist = (id: string) => {
    setSpecialistIds((current) =>
      current.includes(id)
        ? current.filter((item) => item !== id)
        : [...current, id],
    );
  };

  const resultCount = (agentId: string) => events.filter(
    (event) => event.agentId === agentId && event.type === "specialist_result",
  ).length;

  return (
    <section className="team-view">
      <header className="team-heading">
        <div>
          <h1>Team Tasks</h1>
          <p>A Lead reviews every contribution, dynamically selects the next specialist, and consolidates the shared conversation.</p>
        </div>
        <div className="team-heading-actions">
          <div className="team-heading-metric">
            <strong>{tasks.filter((item) => item.status === "completed").length}</strong>
            <span>completed</span>
          </div>
          {task && terminalStatuses.has(task.status) && (
            <button className="button button-primary team-heading-action" onClick={startAnotherTask}>Start another task</button>
          )}
        </div>
      </header>

      <div className="team-grid">
        <aside className="team-column">
          <form className="team-create" onSubmit={createTask}>
            <div className="team-panel-title">
              <div><span className="eyebrow">Mission control</span><h2>Start a shared objective</h2></div>
              <span>01 / Configure</span>
            </div>
            {openTask ? (
              <div className="team-empty team-active-lock">
                <span className="team-live-dot team-live-dot-running" />
                <p>A Team Task is active. Finish or stop it before starting another.</p>
                <button type="button" className="button button-ghost" onClick={() => setSelectedId(openTask.id)}>View active task</button>
              </div>
            ) : readyAgents.length < 2 ? (
              <div className="team-empty">
                <p>Create or start at least two ready Agents before coordinating a task.</p>
                <button type="button" className="button button-primary" onClick={onCreateAgent}>Create Agent</button>
              </div>
            ) : (
              <>
                <label>
                  Objective
                  <textarea
                    ref={objectiveRef}
                    rows={5}
                    value={objective}
                    onChange={(event) => setObjective(event.target.value)}
                    maxLength={20_000}
                    placeholder="Describe one outcome the team should deliver…"
                  />
                </label>
                <label>
                  Lead Agent
                  <select
                    value={leadId}
                    onChange={(event) => {
                      setLeadId(event.target.value);
                      setSpecialistIds((ids) => ids.filter((id) => id !== event.target.value));
                    }}
                  >
                    <option value="">Select a ready Lead</option>
                    {readyAgents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
                  </select>
                </label>
                <fieldset>
                  <legend className="team-fieldset-title">Specialist pool</legend>
                  <div className="team-specialist-list">
                    {agents.filter((agent) => agent.id !== leadId).map((agent) => (
                      <label className="team-agent-choice" key={agent.id}>
                        <input
                          type="checkbox"
                          checked={specialistIds.includes(agent.id)}
                          disabled={agent.status !== "ready" || Boolean(agent.activeTeamTaskId)}
                          onChange={() => toggleSpecialist(agent.id)}
                        />
                        <span className="team-choice-avatar" aria-hidden="true">{initials(agent.name)}</span>
                        <span className="team-choice-copy">
                          <strong>{agent.name}</strong>
                          <small>{specialistIds.includes(agent.id) ? "Available to Lead · " : ""}{agent.description || agent.status}</small>
                        </span>
                      </label>
                    ))}
                  </div>
                </fieldset>
                <button className="button button-primary" disabled={submitting || !objective.trim() || !leadId || specialistIds.length === 0}>
                  {submitting ? <span className="spinner" aria-label="Starting" /> : "Start Team Task"}
                </button>
              </>
            )}
          </form>

          {tasks.length > 0 && (
            <div className="team-task-list">
              <span className="eyebrow">Task history</span>
              <div className="team-history-list">
                {tasks.map((item) => (
                  <button className={item.id === selectedId ? "selected" : ""} key={item.id} onClick={() => setSelectedId(item.id)}>
                    <strong>{oneLine(item.objective)}</strong>
                    <span><i className={`history-dot history-dot-${item.status}`} />{item.status} · {item.turnCount}/{item.maxTurns} turns</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </aside>

        <div className="team-detail">
          {!task ? (
            <div className="team-empty team-empty-detail">
              <div className="welcome-orbit"><div>◇</div></div>
              <h2>Ready to coordinate</h2>
              <p>Define an objective, choose a Lead, and assign at least one specialist.</p>
            </div>
          ) : (
            <div className="team-chat" aria-label="Team conversation">
              <article className="team-message team-message-objective">
                <div className="team-avatar" aria-hidden="true">Y</div>
                <div className="team-message-body">
                  <div className="team-message-meta"><strong>You</strong><span>Objective</span><time>{time(task.createdAt)}</time></div>
                  <div className="team-bubble"><MarkdownContent>{task.objective}</MarkdownContent></div>
                </div>
              </article>

              {events.map((item) => {
                const agentName = item.agentId ? agentMap.get(item.agentId)?.name ?? "Unknown Agent" : "Coordinator";
                if (item.type === "specialist_result" && item.chatContent) {
                  return <article className="team-message team-message-specialist" key={item.id}>
                    <div className="team-avatar" aria-hidden="true">{initials(agentName)}</div>
                    <div className="team-message-body"><div className="team-message-meta"><strong>{agentName}</strong><span>Specialist</span><time>{time(item.createdAt)}</time></div><div className="team-bubble"><MarkdownContent>{item.chatContent}</MarkdownContent></div></div>
                  </article>;
                }
                if (["turn_retry", "turn_failed", "task_paused", "task_resumed", "task_stopped"].includes(item.type)) {
                  return <article className={`team-system-entry team-system-entry-${item.type}`} key={item.id}>
                    <div className="team-system-meta"><time>{time(item.createdAt)}</time></div>
                    <div className={`team-system-message team-system-message-${item.type}`}>
                      <span aria-hidden="true">{item.type === "turn_retry" ? "↻" : "!"}</span>
                      <span className="team-system-content">{item.content}</span>
                    </div>
                  </article>;
                }
                return null;
              })}
              {task.status === "running" && <div className="team-typing"><span /><span /><span /><small>Waiting for structured Agent output</small></div>}
              <div ref={conversationEnd} />
            </div>
          )}
        </div>

        {task && (
          <aside className="team-inspector">
            <section className="team-status-panel">
              <div className="team-summary">
                <div>
                  <span className={`team-status team-status-${task.status}`}>{task.status}</span>
                  <h2>{oneLine(task.objective)}</h2>
                  <p>Phase · {phaseLabel(task)} · shared state v{task.stateVersion}</p>
                </div>
                <div className="header-actions">
                  {task.status === "running" && <button className="button button-danger" disabled={submitting} onClick={() => void action("stop")}>Stop task</button>}
                  {task.status === "paused" && <button className="button button-primary" disabled={submitting} onClick={() => void action("resume")}>Resume</button>}
                  {task.status === "paused" && <button className="button button-danger" disabled={submitting} onClick={() => void action("stop")}>Stop</button>}
                </div>
              </div>

              <div className="team-participant-rail" aria-label="Team participants">
                {participants.map((id, index) => {
                  const agent = agentMap.get(id);
                  const working = task.currentAgentId === id;
                  return (
                    <div className={`team-participant ${working ? "working" : ""}`} key={id}>
                      <span className="team-avatar">{initials(agent?.name ?? "?")}</span>
                      <span><strong>{agent?.name ?? "Unknown Agent"}</strong><small>{index === 0 ? "Lead" : `${resultCount(id)} contribution${resultCount(id) === 1 ? "" : "s"}`}</small></span>
                      {working ? <i className="spinner" aria-label="Working" /> : <i className="participant-check">{resultCount(id) > 0 || task.status === "completed" ? "✓" : index + 1}</i>}
                    </div>
                  );
                })}
              </div>

              {task.status === "running" && (
                <div className="team-live-status" aria-live="polite">
                  <span className="team-live-pulse"><i /><i /><i /></span>
                  <div>
                    <strong>{agentMap.get(task.currentAgentId ?? "")?.name ?? "Coordinator"} is working</strong>
                    <span>{task.currentAssignment ?? "Preparing the next handoff"}</span>
                  </div>
                  <div className="team-progress-meta">
                    <span>{elapsed(task.activeTurnStartedAt)}</span>
                    <span>{collaborationRounds} conversation round{collaborationRounds === 1 ? "" : "s"} · turn {task.turnCount}/{task.maxTurns}</span>
                  </div>
                </div>
              )}

              {task.assignmentQueue.length > 0 && (
                <div className="team-queue">
                  <span className="eyebrow">Persisted handoffs</span>
                  {task.assignmentQueue.map((assignment, index) => (
                    <span key={assignment.id}><b>{index + 1}</b>{agentMap.get(assignment.agentId)?.name ?? "Specialist"} · {oneLine(assignment.assignment)}</span>
                  ))}
                </div>
              )}

              {task.lastError && (
                <div className="team-error">
                  <div><h3>Attention needed</h3><p>{task.lastError}</p></div>
                </div>
              )}

              {task.completionSummary && (
                <div className="team-complete">
                  <span>✓</span>
                  <div><small>Lead synthesis</small><h3>Objective completed</h3><MarkdownContent>{task.completionSummary}</MarkdownContent></div>
                </div>
              )}
            </section>

            <section className="team-logs">
              <header className="team-logs-heading"><span>Activity and coordination evidence</span><small>{events.length} events · shared state v{task.stateVersion}</small></header>
              <div className="team-log-list">
                {events.map((item) => {
                  const actor = item.agentId ? agentMap.get(item.agentId)?.name ?? "Unknown Agent" : "Platform";
                  return <details className="team-log" key={item.id}>
                    <summary>
                      <span className="team-log-actor"><strong>#{item.sequence}</strong><strong>{actor}</strong></span>
                      <time>{time(item.createdAt)}</time>
                      <span className="team-log-preview">{oneLine(item.assignment ?? item.content)}</span>
                    </summary>
                    <div className="team-log-detail">
                      <dl><div><dt>Event</dt><dd>{item.type}</dd></div>{item.attempt && <div><dt>Attempt</dt><dd>{item.attempt}</dd></div>}</dl>
                      <p>{item.content}</p>
                      {item.chatContent && <div><strong>Visible contribution</strong><p>{item.chatContent}</p></div>}
                      {item.assignment && <div><strong>Assignment</strong><p>{item.assignment}</p></div>}
                      {item.statePatch && Object.keys(item.statePatch).length > 0 && <div><strong>State patch</strong><pre><code>{JSON.stringify(item.statePatch, null, 2)}</code></pre></div>}
                    </div>
                  </details>;
                })}
              </div>
            </section>
          </aside>
        )}
      </div>
    </section>
  );
}

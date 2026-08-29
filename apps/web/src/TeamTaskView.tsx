import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "./api";
import type { Agent, TeamTask, TeamTaskEvent } from "./types";

interface Props {
  agents: Agent[];
  onAgentsChanged: () => Promise<void>;
  onCreateAgent: () => void;
  onError: (message: string) => void;
}

interface ChatItem {
  event: TeamTaskEvent;
  kind: "message" | "system";
  recipientId: string | null;
  assignment: string | null;
  completion: string | null;
}

function time(value: string): string {
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "?";
}

function oneLine(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > 110 ? compact.slice(0, 107) + "…" : compact;
}

const systemChatEvents = new Set(["task_started", "turn_failed", "task_paused", "task_resumed", "task_stopped"]);

export function TeamTaskView({ agents, onAgentsChanged, onCreateAgent, onError }: Props) {
  const [tasks, setTasks] = useState<TeamTask[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [task, setTask] = useState<TeamTask | null>(null);
  const [events, setEvents] = useState<TeamTaskEvent[]>([]);
  const [objective, setObjective] = useState("");
  const [leadId, setLeadId] = useState("");
  const [specialistIds, setSpecialistIds] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);

  const agentMap = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents]);
  const readyAgents = agents.filter((agent) => agent.status === "ready" && !agent.activeTeamTaskId);
  const openTask = tasks.find((item) => item.status === "running" || item.status === "paused");
  const delegationRecipients = useMemo(() => {
    const recipients = new Map<string, string>();
    if (!task || task.specialistAgentIds.length === 0) return recipients;
    let delegationIndex = 0;
    for (const item of events) {
      if (item.type !== "delegated") continue;
      const recipientId = task.specialistAgentIds[delegationIndex % task.specialistAgentIds.length];
      if (recipientId) recipients.set(item.id, recipientId);
      delegationIndex += 1;
    }
    return recipients;
  }, [events, task]);

  const chatItems = useMemo<ChatItem[]>(() => events.flatMap<ChatItem>((item, index) => {
    if (item.type === "specialist_result") {
      return [{ event: item, kind: "message" as const, recipientId: null, assignment: item.assignment, completion: null }];
    }
    if (item.type === "lead_decision") {
      const next = events[index + 1];
      const delegated = next?.type === "delegated" ? next : null;
      const completed = next?.type === "task_completed" ? next : null;
      return [{
        event: item,
        kind: "message" as const,
        recipientId: delegated ? delegationRecipients.get(delegated.id) ?? null : null,
        assignment: delegated?.assignment ?? null,
        completion: completed?.content ?? null,
      }];
    }
    if (systemChatEvents.has(item.type)) {
      return [{ event: item, kind: "system" as const, recipientId: null, assignment: null, completion: null }];
    }
    if (item.type === "task_completed" && events[index - 1]?.type !== "lead_decision") {
      return [{ event: item, kind: "system" as const, recipientId: null, assignment: null, completion: null }];
    }
    return [];
  }), [delegationRecipients, events]);

  const refreshTasks = useCallback(async () => {
    const result = await api.listTeamTasks();
    setTasks(result.tasks);
    setSelectedId((current) => current ?? result.tasks[0]?.id ?? null);
  }, []);

  const refreshDetail = useCallback(async (id: string) => {
    const result = await api.teamTask(id);
    setTask(result.task);
    setEvents(result.events);
    return result.task;
  }, []);

  useEffect(() => {
    void refreshTasks().catch((reason) => onError(reason instanceof Error ? reason.message : String(reason)));
  }, [onError, refreshTasks]);

  useEffect(() => {
    if (!selectedId) {
      setTask(null);
      setEvents([]);
      return;
    }
    let cancelled = false;
    let timer = 0;
    const poll = async () => {
      try {
        const current = await refreshDetail(selectedId);
        if (cancelled) return;
        if (current.status === "running") timer = window.setTimeout(poll, 1_000);
        await onAgentsChanged();
      } catch (reason) {
        if (!cancelled) onError(reason instanceof Error ? reason.message : String(reason));
      }
    };
    void poll();
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [onAgentsChanged, onError, refreshDetail, selectedId]);

  useEffect(() => {
    if (!leadId && readyAgents[0]) setLeadId(readyAgents[0].id);
  }, [leadId, readyAgents]);

  const createTask = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!objective.trim() || !leadId || specialistIds.length === 0) return;
    setSubmitting(true);
    try {
      const result = await api.createTeamTask({ objective: objective.trim(), leadAgentId: leadId, specialistAgentIds: specialistIds });
      setObjective("");
      setSpecialistIds([]);
      setSelectedId(result.task.id);
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

  const toggleSpecialist = (id: string) => {
    setSpecialistIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  };

  return (
    <section className="team-view">
      <header className="team-heading">
        <div><span className="eyebrow">Multi-Agent collaboration</span><h1>Team Tasks</h1><p>A Lead delegates sequential work to specialists in one shared workspace.</p></div>
      </header>

      <div className="team-grid">
        <div className="team-column">
          <form className="team-create" onSubmit={createTask}>
            <h2>Start a shared objective</h2>
            {openTask ? (
              <div className="team-empty"><p>Finish or stop the current Team Task before creating another.</p><button type="button" className="button button-ghost" onClick={() => setSelectedId(openTask.id)}>View active task</button></div>
            ) : readyAgents.length < 2 ? (
              <div className="team-empty"><p>Create or start at least two ready Agents before starting a Team Task.</p><button type="button" className="button button-primary" onClick={onCreateAgent}>Create Agent</button></div>
            ) : (
              <>
                <label>Objective<textarea rows={5} value={objective} onChange={(event) => setObjective(event.target.value)} maxLength={20_000} placeholder="Describe the outcome the team should achieve…" /></label>
                <label>Lead Agent<select value={leadId} onChange={(event) => { setLeadId(event.target.value); setSpecialistIds((ids) => ids.filter((id) => id !== event.target.value)); }}>
                  <option value="">Select a ready Lead</option>{readyAgents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
                </select></label>
                <fieldset><legend>Specialists</legend>{agents.filter((agent) => agent.id !== leadId).map((agent) => (
                  <label className="team-agent-choice" key={agent.id}><input type="checkbox" checked={specialistIds.includes(agent.id)} disabled={agent.status !== "ready" || Boolean(agent.activeTeamTaskId)} onChange={() => toggleSpecialist(agent.id)} /><span><strong>{agent.name}</strong><small>{specialistIds.includes(agent.id) ? `Rotation ${specialistIds.indexOf(agent.id) + 1} · ` : ""}{agent.description || agent.status}</small></span></label>
                ))}</fieldset>
                <button className="button button-primary" disabled={submitting || readyAgents.length < 2 || !objective.trim() || !leadId || specialistIds.length === 0}>Start Team Task</button>
              </>
            )}
          </form>

          {tasks.length > 0 && <div className="team-task-list"><span className="eyebrow">Task history</span>{tasks.map((item) => <button className={item.id === selectedId ? "selected" : ""} key={item.id} onClick={() => setSelectedId(item.id)}><strong>{item.objective}</strong><span>{item.status} · {item.turnCount}/{item.maxTurns} turns</span></button>)}</div>}
        </div>

        <div className="team-detail">
          {!task ? <div className="team-empty"><h2>No Team Task selected</h2><p>Create an objective and choose Agents to begin.</p></div> : <>
            <div className="team-summary">
              <div><span className={"team-status team-status-" + task.status}>{task.status}</span><h2>{task.objective}</h2><div className="team-participants"><span>Lead · {agentMap.get(task.leadAgentId)?.name ?? "Unknown Agent"}</span>{task.specialistAgentIds.map((id, index) => <span key={id}>{index + 1} · {agentMap.get(id)?.name ?? "Unknown Agent"}</span>)}</div></div>
              <div className="header-actions">{["running", "paused"].includes(task.status) && <button className="button button-danger" disabled={submitting} onClick={() => void action("stop")}>Stop</button>}{task.status === "paused" && <button className="button button-primary" disabled={submitting} onClick={() => void action("resume")}>Resume</button>}</div>
            </div>
            <div className="team-live-status"><span className={"team-live-dot team-live-dot-" + task.status} />{task.currentAgentId ? <><strong>{agentMap.get(task.currentAgentId)?.name ?? "Unknown Agent"} is working</strong><span>{task.currentAssignment ?? "Waiting for an assignment"}</span></> : <><strong>{task.status === "completed" ? "Conversation complete" : "No agent is currently working"}</strong><span>{task.status}</span></>}</div>
            {task.lastError && <div className="run-error"><strong>Attention needed</strong><span>{task.lastError}</span></div>}
            <div className="team-chat" aria-label="Team conversation">{chatItems.map((item) => {
              if (item.kind === "system") return <div className={"team-system-message team-system-message-" + item.event.type} key={item.event.id}><span>{item.event.content}</span><time>{time(item.event.createdAt)}</time></div>;
              const isLead = item.event.agentId === task.leadAgentId;
              const agentName = item.event.agentId ? agentMap.get(item.event.agentId)?.name ?? "Unknown Agent" : "Platform";
              const recipientName = item.recipientId ? agentMap.get(item.recipientId)?.name ?? "Unknown Agent" : null;
              return <article className={"team-message " + (isLead ? "team-message-lead" : "team-message-specialist")} key={item.event.id}>
                <div className="team-avatar" aria-hidden="true">{initials(agentName)}</div>
                <div className="team-message-body"><div className="team-message-meta"><strong>{agentName}</strong>{isLead && <span>Lead</span>}<time>{time(item.event.createdAt)}</time></div><div className="team-bubble"><p>{item.event.content}</p>{item.assignment && <div className="team-message-assignment"><span>To {recipientName ?? "next specialist"}</span>{item.assignment}</div>}{item.completion && <div className="team-message-completion"><span>Task completed</span>{item.completion}</div>}</div></div>
              </article>;
            })}</div>
            <details className="team-logs">
              <summary><span>Activity logs</span><small>{events.length} event{events.length === 1 ? "" : "s"} · shared state v{task.stateVersion}</small></summary>
              <div className="team-log-list">{events.map((item) => {
                const actor = item.agentId ? agentMap.get(item.agentId)?.name ?? "Unknown Agent" : "Platform";
                return <details className="team-log" key={item.id}><summary><strong>{actor}</strong><time>{time(item.createdAt)}</time><span>{oneLine(item.assignment ?? item.content)}</span></summary><div className="team-log-detail"><dl><div><dt>Event</dt><dd>#{item.sequence} · {item.type}</dd></div>{item.attempt && <div><dt>Attempt</dt><dd>{item.attempt}</dd></div>}</dl><p>{item.content}</p>{item.assignment && <div><strong>Assignment</strong><p>{item.assignment}</p></div>}{item.statePatch && Object.keys(item.statePatch).length > 0 && <div><strong>State patch</strong><pre><code>{JSON.stringify(item.statePatch, null, 2)}</code></pre></div>}</div></details>;
              })}</div>
            </details>
          </>}
        </div>
      </div>
    </section>
  );
}

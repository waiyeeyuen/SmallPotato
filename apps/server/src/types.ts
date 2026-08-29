export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type MessageRole = "user" | "assistant";
export type TeamTaskStatus = "running" | "paused" | "completed" | "failed" | "stopped";
export type TeamTaskEventType =
  | "task_started"
  | "turn_started"
  | "lead_decision"
  | "delegated"
  | "specialist_result"
  | "turn_retry"
  | "turn_failed"
  | "task_paused"
  | "task_resumed"
  | "task_completed"
  | "task_stopped"
  | "system";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface Agent {
  id: string;
  name: string;
  description: string;
  instructions: string;
  status: AgentStatus;
  workspacePath: string;
  codexThreadId: string | null;
  activeTeamTaskId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  agentId: string;
  runId: string;
  role: MessageRole;
  content: string;
  createdAt: string;
}

export interface RunUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
}

export interface AgentRun {
  id: string;
  agentId: string;
  status: RunStatus;
  prompt: string;
  output: string | null;
  error: string | null;
  usage: RunUsage | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface TeamTask {
  id: string;
  objective: string;
  leadAgentId: string;
  specialistAgentIds: string[];
  status: TeamTaskStatus;
  workspacePath: string;
  currentAgentId: string | null;
  currentAssignment: string | null;
  assignmentQueue: TeamAssignment[];
  activeTurnStartedAt: string | null;
  turnCount: number;
  maxTurns: number;
  sharedState: Record<string, JsonValue>;
  stateVersion: number;
  threadIds: Record<string, string | null>;
  completionSummary: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface TeamAssignment {
  id: string;
  agentId: string;
  assignment: string;
}

export interface TeamTaskEvent {
  id: string;
  taskId: string;
  sequence: number;
  type: TeamTaskEventType;
  agentId: string | null;
  content: string;
  chatContent: string | null;
  assignment: string | null;
  attempt: number | null;
  statePatch: Record<string, JsonValue> | null;
  createdAt: string;
}

export interface Database {
  version: 2;
  agents: Agent[];
  messages: Message[];
  runs: AgentRun[];
  teamTasks: TeamTask[];
  teamTaskEvents: TeamTaskEvent[];
}

export interface CreateAgentInput {
  name: string;
  description?: string | undefined;
  instructions?: string | undefined;
}

export interface UpdateAgentInput {
  name?: string | undefined;
  description?: string | undefined;
  instructions?: string | undefined;
}

export interface CreateTeamTaskInput {
  objective: string;
  leadAgentId: string;
  specialistAgentIds: string[];
}

export interface RunnerResult {
  output: string;
  threadId: string | null;
  usage: RunUsage | null;
}

export interface RunnerRequest {
  agentId: string;
  workspacePath: string;
  prompt: string;
  threadId: string | null;
}

export interface AgentRunner {
  run(request: RunnerRequest): Promise<RunnerResult>;
  cancel(agentId: string): Promise<boolean>;
  isAvailable(): Promise<boolean>;
}

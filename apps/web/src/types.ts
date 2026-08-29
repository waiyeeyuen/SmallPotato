export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface User {
  userId: string;
  username: string;
  displayName: string;
}

export interface Agent {
  id: string;
  ownerUserId: string;
  principalId: string;
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
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

export interface AgentRun {
  id: string;
  agentId: string;
  status: RunStatus;
  prompt: string;
  output: string | null;
  error: string | null;
  usage: {
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
  } | null;
  resourceId: string | null;
  policyDecisionId: string | null;
  createdAt: string;
}

export interface ResourceSummary {
  id: string;
  name: string;
  description: string;
  ownerUserId: string;
  ownerName: string;
  ownedByCurrentUser: boolean;
  sizeBytes: number;
  isDemo: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PermissionGrant {
  id: string;
  agentPrincipalId: string;
  resourceId: string;
  resourceName: string;
  actions: "read"[];
  purpose: string;
  grantedByUserId: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  state: "active" | "revoked" | "expired";
}

export interface PolicyDecision {
  id: string;
  humanUserId: string;
  humanName: string;
  agentId: string;
  agentName: string;
  agentPrincipalId: string;
  action: "read";
  resourceId: string;
  resourceName: string;
  outcome: "allow" | "deny";
  reason: string;
  grantId: string | null;
  runId: string | null;
  previousReceiptHash: string | null;
  receiptHash: string;
  createdAt: string;
}

export interface SystemInfo {
  arkConfigured: boolean;
  arkBaseUrl: string;
  arkModel: string | null;
  codexAvailable: boolean;
  codexSandboxMode: string;
  runtimeProvider: "local-process" | "container";
  containerEngine: string | null;
  runtime: string;
}

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type TeamTaskStatus = "running" | "paused" | "completed" | "failed" | "stopped";

export interface TeamAssignment {
  id: string;
  agentId: string;
  assignment: string;
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

export interface TeamTaskEvent {
  id: string;
  taskId: string;
  sequence: number;
  type: string;
  agentId: string | null;
  content: string;
  chatContent: string | null;
  assignment: string | null;
  attempt: number | null;
  statePatch: Record<string, JsonValue> | null;
  createdAt: string;
}

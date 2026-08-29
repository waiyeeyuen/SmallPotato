export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type MessageRole = "user" | "assistant";

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
  resourceId: string | null;
  policyDecisionId: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface User {
  id: string;
  username: string;
  displayName: string;
  passwordSalt: string;
  passwordHash: string;
  createdAt: string;
}

export interface Session {
  tokenHash: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
}

export interface ProtectedResource {
  id: string;
  ownerUserId: string;
  name: string;
  description: string;
  filePath: string;
  sizeBytes: number;
  isDemo: boolean;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ResourceAction = "read";

export interface PermissionGrant {
  id: string;
  agentPrincipalId: string;
  resourceId: string;
  actions: ResourceAction[];
  purpose: string;
  grantedByUserId: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
}

export type PolicyReason =
  | "GRANT_ACTIVE"
  | "GRANT_MISSING"
  | "GRANT_REVOKED"
  | "GRANT_EXPIRED"
  | "AGENT_NOT_OWNED"
  | "RESOURCE_NOT_OWNED"
  | "RESOURCE_NOT_FOUND";

export interface PolicyDecision {
  id: string;
  humanUserId: string;
  humanName: string;
  agentId: string;
  agentName: string;
  agentPrincipalId: string;
  action: ResourceAction;
  resourceId: string;
  resourceName: string;
  outcome: "allow" | "deny";
  reason: PolicyReason;
  grantId: string | null;
  runId: string | null;
  previousReceiptHash: string | null;
  receiptHash: string;
  createdAt: string;
}

export interface RequestActor {
  userId: string;
  username: string;
  displayName: string;
}

export interface Database {
  version: 3;
  users: User[];
  sessions: Session[];
  agents: Agent[];
  messages: Message[];
  runs: AgentRun[];
  resources: ProtectedResource[];
  grants: PermissionGrant[];
  decisions: PolicyDecision[];
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
  mounts?: RunnerMount[];
}

export interface RunnerMount {
  sourcePath: string;
  targetPath: string;
  readOnly: boolean;
}

export interface AgentRunner {
  run(request: RunnerRequest): Promise<RunnerResult>;
  cancel(agentId: string): Promise<boolean>;
  isAvailable(): Promise<boolean>;
}

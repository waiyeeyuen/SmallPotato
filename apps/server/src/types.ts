export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type MessageRole = "user" | "assistant";
export type TeamTaskStatus = "ready" | "running" | "paused" | "completed" | "failed" | "stopped";
/**
 * How the platform decides which agent takes the next turn.
 * - "facilitated": the Lead agent names the next specialist each turn (open-ended
 *   work, e.g. planning an event — the Lead routes by relevance).
 * - "sequential": the platform rotates through the specialist pool in a fixed
 *   order (turn-by-turn work with a deterministic hand-off, e.g. a countdown or
 *   any relay). The Lead still writes the assignment and decides when to stop.
 */
export type TeamTaskTurnPolicy = "facilitated" | "sequential";
/**
 * Who picks the specialist pool for a Team Task.
 * - "user": the person selects every specialist up front (default).
 * - "lead": the person selects only the Lead; the platform reserves all ready
 *   Agents and the Lead names its working roster on its first turn.
 */
export type TeamAgentSelection = "user" | "lead";
export type TeamResourceAccessMode = "manual" | "task";
export type TeamAccessApprovalDecision =
  | "allow_once"
  | "allow_agent_task"
  | "allow_roster_task"
  | "deny";
export type TeamTaskEventType =
  | "task_started"
  | "user_message"
  | "turn_started"
  | "coordination_plan"
  | "lead_decision"
  | "delegated"
  | "specialist_result"
  | "turn_retry"
  | "turn_failed"
  | "resource_authorization"
  | "access_approval_requested"
  | "access_approval_granted"
  | "access_approval_denied"
  | "access_approval_consumed"
  | "access_approval_expired"
  | "task_access_granted"
  | "task_access_revoked"
  | "task_paused"
  | "task_resumed"
  | "task_completed"
  | "request_completed"
  | "request_cancelled"
  | "request_failed"
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

export interface TeamTask {
  id: string;
  /** The human who started the task; the actor every turn is authorized as. */
  ownerUserId: string;
  objective: string;
  leadAgentId: string;
  /**
   * Optional protected resource the specialists need. Every specialist turn is
   * authorized against it independently, so a Lead's delegation can never widen
   * data access beyond what a lease already allows.
   */
  resourceId: string | null;
  /**
   * "task" turns the user's document attachment into explicit consent for the
   * selected specialist roster to receive temporary read capabilities. "manual"
   * preserves the deny -> grant -> resume workflow for demonstrations and
   * exceptional approvals.
   */
  resourceAccessMode: TeamResourceAccessMode;
  /**
   * Middleware-generated step-up request. The model never creates or resolves
   * this object, and no protected Runtime starts while it is present.
   */
  pendingAccessApproval: TeamAccessApprovalRequest | null;
  /** A single-turn approval is revoked after the blocked specialist finishes. */
  oneTimeAccessGrantIds: string[];
  oneTimeAccessAgentId: string | null;
  /**
   * When agentSelection is "user" this is the fixed specialist pool. When it is
   * "lead" this starts as every reserved candidate Agent and is narrowed to the
   * Lead's chosen roster once the Lead's first-turn plan is applied.
   */
  specialistAgentIds: string[];
  agentSelection: TeamAgentSelection;
  /** True once the persistent conversation's specialist roster is fixed. */
  rosterLocked: boolean;
  /** null until the Lead commits a coordination mode on its first turn. */
  turnPolicy: TeamTaskTurnPolicy | null;
  status: TeamTaskStatus;
  /** Sequence of the user_message event that started the current request. */
  activeRequestSequence: number | null;
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

export interface TeamAccessApprovalRequest {
  id: string;
  taskId: string;
  agentId: string;
  resourceId: string;
  action: "read";
  assignment: string;
  createdAt: string;
  expiresAt: string;
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
  /** Hash-chain link to the previous event for this task (tamper-evident coordination log). */
  previousReceiptHash: string | null;
  receiptHash: string | null;
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
  source: "manual" | "team_task";
  teamTaskId: string | null;
  grantedByUserId: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
}

/**
 * Cross-user share: the resource OWNER grants another user read access to one
 * protected resource. Distinct from a PermissionGrant (which binds an Agent
 * principal to a resource the actor owns). Once an active share exists, every
 * Agent belonging to the grantee may read the file — no per-Agent lease needed.
 */
export interface ResourceShare {
  id: string;
  resourceId: string;
  /** Denormalized owner at creation time = resource.ownerUserId. */
  ownerUserId: string;
  granteeUserId: string;
  actions: ResourceAction[];
  purpose: string;
  /** Always equal to ownerUserId — only the owner can create a share. */
  createdByUserId: string;
  createdAt: string;
  /** null = no expiry; the owner may still revoke at any time. */
  expiresAt: string | null;
  revokedAt: string | null;
}

export type PolicyAction = "read" | "share" | "unshare";

export type PolicyReason =
  | "GRANT_ACTIVE"
  | "GRANT_MISSING"
  | "GRANT_REVOKED"
  | "GRANT_EXPIRED"
  | "AGENT_NOT_OWNED"
  | "RESOURCE_NOT_OWNED"
  | "RESOURCE_NOT_FOUND"
  | "SHARE_ACTIVE"
  | "SHARE_MISSING"
  | "SHARE_REVOKED"
  | "SHARE_EXPIRED"
  | "SHARE_CREATED"
  | "SHARE_REVOKED_BY_OWNER";

export interface PolicyDecision {
  id: string;
  humanUserId: string;
  humanName: string;
  /** null for share-management receipts, which are not tied to an Agent. */
  agentId: string | null;
  agentName: string | null;
  agentPrincipalId: string | null;
  action: PolicyAction;
  resourceId: string;
  resourceName: string;
  /** Denormalized so a resource owner can filter receipts about their own files. */
  resourceOwnerUserId: string;
  outcome: "allow" | "deny";
  reason: PolicyReason;
  grantId: string | null;
  runId: string | null;
  teamTaskId: string | null;
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
  version: 6;
  users: User[];
  sessions: Session[];
  agents: Agent[];
  messages: Message[];
  runs: AgentRun[];
  resources: ProtectedResource[];
  grants: PermissionGrant[];
  shares: ResourceShare[];
  decisions: PolicyDecision[];
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
  /** Protected resource the specialists may read, subject to a capability lease. */
  resourceId?: string | undefined;
  /** Defaults to task-scoped access when a protected resource is attached. */
  resourceAccessMode?: TeamResourceAccessMode | undefined;
  /** Required when agentSelection is "user"; ignored when it is "lead". */
  specialistAgentIds: string[];
  agentSelection?: TeamAgentSelection | undefined;
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

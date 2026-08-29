export type GuardAction = "read" | "write" | "deploy";

export type GuardDecision =
  | "allow"
  | "deny"
  | "require_approval";

export interface AgentPolicy {
  agentId: string;
  resource: string;
  allowedActions: GuardAction[];
}

export interface PolicyResult {
  decision: GuardDecision;
  reason: string;
}
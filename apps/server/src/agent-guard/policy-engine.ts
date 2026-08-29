import type {
  AgentPolicy,
  GuardAction,
  PolicyResult,
} from "./types.js";

export function evaluatePolicy(
  policies: AgentPolicy[],
  agentId: string,
  resource: string,
  action: GuardAction,
): PolicyResult {
  // Sensitive production operations require a human.
  if (resource.endsWith("-production") && action === "deploy") {
    return {
      decision: "require_approval",
      reason: "Production deployment requires human approval",
    };
  }

  const policy = policies.find(
    (item) =>
      item.agentId === agentId &&
      item.resource === resource,
  );

  if (!policy) {
    return {
      decision: "deny",
      reason: "Agent has no delegated access to this resource",
    };
  }

  if (!policy.allowedActions.includes(action)) {
    return {
      decision: "deny",
      reason: `Agent does not have permission to ${action} this resource`,
    };
  }

  return {
    decision: "allow",
    reason: "Action permitted by delegated policy",
  };
}
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
  /**
   * First check whether the agent has any
   * delegated authority over this resource.
   */
  const policy = policies.find(
    (item) =>
      item.agentId === agentId &&
      item.resource === resource,
  );

  if (!policy) {
    return {
      decision: "deny",
      reason:
        "Agent has no delegated access to this resource",
    };
  }

  /**
   * Then check the requested action.
   */
  if (!policy.allowedActions.includes(action)) {
    return {
      decision: "deny",
      reason: `Agent does not have permission to ${action} this resource`,
    };
  }

  /**
   * Sensitive operations require a human
   * even if the agent has delegated authority.
   */
  if (
    resource.endsWith("-production") &&
    action === "deploy"
  ) {
    return {
      decision: "require_approval",
      reason:
        "Production deployment requires human approval",
    };
  }

  /**
   * Otherwise allow it.
   */
  return {
    decision: "allow",
    reason:
      "Action permitted by delegated policy",
  };
}
import type { AgentPolicy } from "./types.js";

const policiesByAgent = new Map<string, AgentPolicy[]>();

export function ensureDefaultPolicies(
  agentId: string,
): AgentPolicy[] {
  const existing = policiesByAgent.get(agentId);

  if (existing) {
    return existing;
  }

  const policies: AgentPolicy[] = [
    {
      agentId,
      resource: "project-alpha",
      allowedActions: ["read", "write"],
    },
    {
      agentId,
      resource: "project-alpha-production",
      allowedActions: ["deploy"],
    },
  ];

  policiesByAgent.set(agentId, policies);

  return policies;
}

export function getPoliciesForAgent(
  agentId: string,
): AgentPolicy[] {
  return policiesByAgent.get(agentId) ?? [];
}
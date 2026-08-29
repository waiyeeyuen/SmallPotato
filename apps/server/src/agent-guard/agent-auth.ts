import { randomUUID } from "node:crypto";

export interface AgentIdentity {
  agentId: string;
  runId: string;
}

const activeTokens = new Map<string, AgentIdentity>();

export function issueAgentToken(
  agentId: string,
  runId: string,
): string {
  const token = randomUUID();

  activeTokens.set(token, {
    agentId,
    runId,
  });

  return token;
}

export function resolveAgentToken(
  token: string | undefined,
): AgentIdentity | null {
  if (!token) {
    return null;
  }

  return activeTokens.get(token) ?? null;
}

export function revokeAgentToken(
  token: string,
): void {
  activeTokens.delete(token);
}
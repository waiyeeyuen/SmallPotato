const agentTokens = new Map<string, string>([
  ["demo-token-agent-a", "agent-a"],
]);

export function resolveAgentToken(
  token: string | undefined,
): string | null {
  if (!token) {
    return null;
  }

  return agentTokens.get(token) ?? null;
}
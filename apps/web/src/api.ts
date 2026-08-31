import type {
  Agent,
  AgentRun,
  Message,
  PermissionGrant,
  PolicyDecision,
  ResourceSummary,
  SystemInfo,
  TeamTask,
  TeamTaskEvent,
  User,
} from "./types";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const headers = {
    ...(options?.body ? { "Content-Type": "application/json" } : {}),
    ...options?.headers,
  };
  const response = await fetch(url, { ...options, headers, credentials: "include" });
  const data = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) {
    if (response.status === 401 && url !== "/api/login") {
      window.dispatchEvent(new Event("launchpad:session-expired"));
    }
    throw new ApiError(data.error ?? "Request failed", response.status, data);
  }
  return data;
}

export const api = {
  login: (username: string, password: string) =>
    request<{ user: User; expiresAt: string }>("/api/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }),
  session: () => request<{ user: User }>("/api/session"),
  logout: () => request<{ ok: boolean }>("/api/logout", { method: "POST" }),
  system: () => request<SystemInfo>("/api/system"),
  listAgents: () => request<{ agents: Agent[] }>("/api/agents"),
  createAgent: (body: { name: string; description: string; instructions: string }) =>
    request<{ agent: Agent }>("/api/agents", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateAgent: (
    id: string,
    body: { name: string; description: string; instructions: string },
  ) =>
    request<{ agent: Agent }>("/api/agents/" + id, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteAgent: (id: string) =>
    request<{ archivedWorkspace: string }>("/api/agents/" + id, {
      method: "DELETE",
    }),
  startAgent: (id: string) =>
    request<{ agent: Agent }>("/api/agents/" + id + "/start", { method: "POST" }),
  stopAgent: (id: string) =>
    request<{ agent: Agent }>("/api/agents/" + id + "/stop", { method: "POST" }),
  messages: (id: string) =>
    request<{ messages: Message[] }>("/api/agents/" + id + "/messages"),
  runs: (id: string) =>
    request<{ runs: AgentRun[] }>("/api/agents/" + id + "/runs"),
  sendMessage: (id: string, content: string, resourceId?: string) =>
    request<{ run: AgentRun; message: Message }>(
      "/api/agents/" + id + "/messages",
      {
        method: "POST",
        body: JSON.stringify({ content, ...(resourceId ? { resourceId } : {}) }),
      },
    ),
  run: (id: string) => request<{ run: AgentRun }>("/api/runs/" + id),
  listTeamTasks: () => request<{ tasks: TeamTask[] }>("/api/team-tasks"),
  createTeamTask: (body: {
    objective: string;
    leadAgentId: string;
    specialistAgentIds: string[];
    agentSelection: TeamTask["agentSelection"];
    resourceId?: string;
    resourceAccessMode?: TeamTask["resourceAccessMode"];
  }) =>
    request<{ task: TeamTask }>("/api/team-tasks", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  teamTask: (id: string) =>
    request<{ task: TeamTask; events: TeamTaskEvent[]; eventsVerified: boolean }>(
      "/api/team-tasks/" + id,
    ),
  stopTeamTask: (id: string) =>
    request<{ task: TeamTask }>("/api/team-tasks/" + id + "/stop", { method: "POST" }),
  resumeTeamTask: (id: string) =>
    request<{ task: TeamTask }>("/api/team-tasks/" + id + "/resume", { method: "POST" }),
  resources: () => request<{ resources: ResourceSummary[] }>("/api/resources"),
  createResource: (body: { name: string; description: string; content: string }) =>
    request<{ resource: ResourceSummary }>("/api/resources", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateResource: (
    id: string,
    body: { name?: string; description?: string; content?: string },
  ) => request<{ resource: ResourceSummary }>("/api/resources/" + id, {
    method: "PATCH",
    body: JSON.stringify(body),
  }),
  deleteResource: (id: string) =>
    request<{ ok: true }>("/api/resources/" + id, { method: "DELETE" }),
  grants: (agentId: string) =>
    request<{ grants: PermissionGrant[] }>(
      "/api/agents/" + agentId + "/permissions",
    ),
  createGrant: (
    agentId: string,
    body: { resourceId: string; purpose: string; ttlSeconds: number },
  ) =>
    request<{ grant: PermissionGrant }>(
      "/api/agents/" + agentId + "/permissions",
      { method: "POST", body: JSON.stringify(body) },
    ),
  revokeGrant: (agentId: string, grantId: string) =>
    request<{ grant: PermissionGrant }>(
      "/api/agents/" + agentId + "/permissions/" + grantId,
      { method: "DELETE" },
    ),
  decisions: (agentId: string) =>
    request<{ decisions: PolicyDecision[]; chainValid: boolean }>(
      "/api/agents/" + agentId + "/policy-decisions",
    ),
  decisionExport: async (agentId: string) => {
    const response = await fetch(
      "/api/agents/" + agentId + "/policy-decisions.csv",
      { credentials: "include" },
    );
    if (!response.ok) throw new ApiError("Unable to export receipts", response.status);
    return response.blob();
  },
};

import { describe, expect, it } from "vitest";

import { evaluatePolicy } from "./policy-engine.js";
import type { AgentPolicy } from "./types.js";

const policies: AgentPolicy[] = [
  {
    agentId: "agent-a",
    resource: "project-alpha",
    allowedActions: ["read", "write"],
  },
  {
    agentId: "agent-a",
    resource: "project-alpha-production",
    allowedActions: ["deploy"],
  },
];

describe("AgentGuard policy engine", () => {
  it("allows an authorized read", () => {
    const result = evaluatePolicy(
      policies,
      "agent-a",
      "project-alpha",
      "read",
    );

    expect(result.decision).toBe("allow");
  });

  it("denies access to an unauthorized resource", () => {
    const result = evaluatePolicy(
      policies,
      "agent-a",
      "project-beta",
      "read",
    );

    expect(result.decision).toBe("deny");
  });

  it("denies an unauthorized action", () => {
    const result = evaluatePolicy(
      policies,
      "agent-a",
      "project-alpha",
      "deploy",
    );

    expect(result.decision).toBe("deny");
  });

  it("requires approval for production deployment", () => {
    const result = evaluatePolicy(
      policies,
      "agent-a",
      "project-alpha-production",
      "deploy",
    );

    expect(result.decision).toBe("require_approval");
  });
});
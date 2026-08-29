import type { GuardAction } from "./types.js";

const resources: Record<string, string> = {
  "project-alpha":
    "Project Alpha configuration: PORT=3000",

  "project-beta":
    "CONFIDENTIAL Project Beta configuration: SECRET=super-secret",
};

export function executeResourceAction(
  resource: string,
  action: GuardAction,
): string {
  if (action === "read") {
    const value = resources[resource];

    if (!value) {
      throw new Error(
        `Resource ${resource} does not exist`,
      );
    }

    return value;
  }

  if (action === "write") {
    return `Write operation executed on ${resource}`;
  }

  if (action === "deploy") {
    return `${resource} deployed successfully`;
  }

  throw new Error("Unsupported action");
}
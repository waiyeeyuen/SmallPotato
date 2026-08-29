import { randomUUID } from "node:crypto";
import type { GuardAction } from "./types.js";

export type ApprovalStatus =
  | "pending"
  | "approved"
  | "used"
  | "denied";

export interface ApprovalRequest {
  id: string;
  agentId: string;
  requestedRunId: string;
  resource: string;
  action: GuardAction;
  status: ApprovalStatus;
  createdAt: string;
}

const approvals = new Map<string, ApprovalRequest>();

export function getOrCreatePendingApproval(
  agentId: string,
  runId: string,
  resource: string,
  action: GuardAction,
): ApprovalRequest {
  const existing = [...approvals.values()].find(
    (approval) =>
      approval.agentId === agentId &&
      approval.resource === resource &&
      approval.action === action &&
      approval.status === "pending",
  );

  if (existing) {
    return existing;
  }

  const approval: ApprovalRequest = {
    id: randomUUID(),
    agentId,
    requestedRunId: runId,
    resource,
    action,
    status: "pending",
    createdAt: new Date().toISOString(),
  };

  approvals.set(approval.id, approval);

  return approval;
}

export function approveRequest(
  id: string,
): ApprovalRequest | null {
  const approval = approvals.get(id);

  if (!approval || approval.status !== "pending") {
    return null;
  }

  approval.status = "approved";

  return approval;
}

export function consumeApprovedRequest(
  agentId: string,
  resource: string,
  action: GuardAction,
): ApprovalRequest | null {
  const approval = [...approvals.values()].find(
    (item) =>
      item.agentId === agentId &&
      item.resource === resource &&
      item.action === action &&
      item.status === "approved",
  );

  if (!approval) {
    return null;
  }

  approval.status = "used";

  return approval;
}

export function listApprovals(): ApprovalRequest[] {
  return [...approvals.values()];
}
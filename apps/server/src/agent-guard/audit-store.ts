import { randomUUID } from "node:crypto";

export interface AuditEvent {
  id: string;
  timestamp: string;

  actorType: "agent" | "human";
  actorId: string;

  agentId?: string;
  runId?: string;

  resource: string;
  action: string;
  decision: string;
  reason: string;

  approvalId?: string;
}

const auditEvents: AuditEvent[] = [];

export function recordAuditEvent(
  event: Omit<AuditEvent, "id" | "timestamp">,
): AuditEvent {
  const auditEvent: AuditEvent = {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    ...event,
  };

  auditEvents.push(auditEvent);

  return auditEvent;
}

export function listAuditEvents(): AuditEvent[] {
  return [...auditEvents].reverse();
}
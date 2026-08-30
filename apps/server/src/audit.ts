import { createHash } from "node:crypto";
import type { PolicyDecision } from "./types.js";

export type ReceiptPayload = Omit<
  PolicyDecision,
  "runId" | "previousReceiptHash" | "receiptHash"
>;

export function receiptHash(
  decision: ReceiptPayload,
  previousReceiptHash: string | null,
): string {
  return createHash("sha256")
    .update(JSON.stringify({ ...decision, previousReceiptHash }))
    .digest("hex");
}

/**
 * Generic tamper-evident hash-chain link, shared by the authorization receipt
 * chain (above) and the multi-agent coordination event log so both trails are
 * verifiable the same way.
 */
export function chainHash(payload: unknown, previousHash: string | null): string {
  return createHash("sha256")
    .update(JSON.stringify({ payload, previousHash }))
    .digest("hex");
}

export function verifyReceiptChain(decisions: PolicyDecision[]): boolean {
  let previous: string | null = null;
  for (const decision of decisions) {
    const { runId: _runId, previousReceiptHash, receiptHash: storedHash, ...payload } =
      decision;
    if (previousReceiptHash !== previous) return false;
    if (receiptHash(payload, previous) !== storedHash) return false;
    previous = storedHash;
  }
  return true;
}

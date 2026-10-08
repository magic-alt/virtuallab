/**
 * Optional, provider-neutral safety bridge.
 * UI approvals are NOT a capability token and must never authorize hardware I/O.
 * A separately implemented, trusted native/device provider must enforce a lease on every operation.
 */
export type ProtectedAction = "motion" | "power" | "flash" | "release";
export interface ApprovalRequest {
  id: string;
  workspaceRoot: string;
  resourceId: string;
  action: ProtectedAction;
  reason: string;
  createdAtMs: number;
  expiresAtMs: number;
}
export type Decision = "approved-by-human" | "denied";
export interface ApprovalRecord {
  request: ApprovalRequest;
  decision: Decision;
  decidedAtMs: number;
}
export interface EnforcedLease {
  leaseId: string;
  resourceId: string;
  workspaceRoot: string;
  action: ProtectedAction;
  expiresAtMs: number;
}
/** The external device gate must independently attest both grant and ongoing lease validity. */
export interface EnforcingHardwareProvider {
  acquireWithHumanApproval(record: ApprovalRecord): Promise<EnforcedLease>;
  validateBeforeOperation(lease: EnforcedLease): Promise<boolean>;
  release(lease: EnforcedLease): Promise<void>;
}

const MAX_TTL = 10 * 60 * 1000;
export function validateApprovalRequest(request: ApprovalRequest, nowMs: number): string | null {
  if (!request.workspaceRoot.trim() || !request.resourceId.trim()) return "Workspace and resource are required.";
  if (!["motion", "power", "flash", "release"].includes(request.action)) return "Unsupported protected action.";
  if (!Number.isFinite(request.createdAtMs) || !Number.isFinite(request.expiresAtMs)
      || request.expiresAtMs <= nowMs || request.expiresAtMs - request.createdAtMs > MAX_TTL)
    return "Approval expiry is invalid or exceeds ten minutes.";
  return null;
}
export class AgentApprovalBroker {
  private requests = new Map<string, ApprovalRequest>();
  private records = new Map<string, ApprovalRecord>();
  private consumed = new Set<string>();
  constructor(private readonly provider: EnforcingHardwareProvider | null = null,
    private readonly clock: () => number = Date.now) {}

  request(input: ApprovalRequest): void {
    const error = validateApprovalRequest(input, this.clock());
    if (error) throw new Error(error);
    if (this.requests.has(input.id) || this.records.has(input.id)) throw new Error("Approval ID already exists.");
    this.requests.set(input.id, input);
  }
  decide(id: string, decision: Decision, explicitHumanGesture: boolean): ApprovalRecord {
    if (!explicitHumanGesture) throw new Error("A direct human decision is required.");
    const request = this.requests.get(id);
    if (!request) throw new Error("Approval request not found.");
    const error = validateApprovalRequest(request, this.clock());
    if (error) throw new Error(error);
    this.requests.delete(id);
    const record = { request, decision, decidedAtMs: this.clock() };
    this.records.set(id, record);
    return record;
  }
  /** Fail closed by default. The user-facing approval UI alone cannot supply a lease. */
  async authorize(id: string): Promise<EnforcedLease> {
    const record = this.records.get(id);
    if (!record || record.decision !== "approved-by-human" || this.consumed.has(id))
      throw new Error("A fresh, unconsumed human approval is required.");
    if (validateApprovalRequest(record.request, this.clock()))
      throw new Error("Approval expired.");
    if (!this.provider) throw new Error("No independently enforcing hardware provider configured.");
    this.consumed.add(id);
    const lease = await this.provider.acquireWithHumanApproval(record);
    if (lease.workspaceRoot !== record.request.workspaceRoot
      || lease.resourceId !== record.request.resourceId
      || lease.action !== record.request.action || lease.expiresAtMs <= this.clock()
      || lease.expiresAtMs > record.request.expiresAtMs
      || !(await this.provider.validateBeforeOperation(lease))) {
      await this.provider.release(lease).catch(() => undefined);
      throw new Error("Hardware lease scope or enforcement check failed.");
    }
    return lease;
  }
  pending(): ApprovalRequest[] { return Array.from(this.requests.values()); }
  decisions(): ApprovalRecord[] { return Array.from(this.records.values()); }
}

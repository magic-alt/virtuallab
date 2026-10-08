import type {
  HardwareAction,
  HardwareApproval,
  HardwareLease,
  HardwareLeaseRequest,
  HardwarePolicyDecision,
  HardwareResource,
  PermissionLevel,
} from "@/types/hardware";

const RANK: Record<PermissionLevel, number> = {
  L0: 0, L1: 1, L2: 2, L3: 3, L4: 4,
};

const REQUIRED: Record<HardwareAction, PermissionLevel> = {
  "inspect-metadata": "L0",
  "workspace-build": "L1",
  "bench-read": "L2",
  motion: "L3",
  power: "L3",
  flash: "L3",
  release: "L4",
};

export const MAX_LEASE_TTL_MS = 10 * 60 * 1000;

export function hardwareRequiredLevel(action: HardwareAction): PermissionLevel {
  return REQUIRED[action];
}

/**
 * This is a pure policy preview used for UI/tests, NOT a security boundary.
 * Hardware execution must be independently authorized by the native broker.
 * Human approvals are never generated from Agent messages.
 */
export function evaluateHardwarePolicy(
  resource: HardwareResource,
  request: HardwareLeaseRequest,
  approval: HardwareApproval | null,
  currentLeases: HardwareLease[],
  nowMs: number,
): HardwarePolicyDecision {
  const requiredLevel = hardwareRequiredLevel(request.action);
  const deny = (reason: string): HardwarePolicyDecision => ({
    allowed: false, requiredLevel, reason,
  });

  if (!resource.id || resource.id !== request.resourceId) return deny("Resource mismatch.");
  if (!request.workspaceRoot.trim()) return deny("Workspace path is required.");
  if (!Number.isSafeInteger(request.ttlMs) || request.ttlMs < 1 || request.ttlMs > MAX_LEASE_TTL_MS) {
    return deny("Lease TTL must be positive and no more than ten minutes.");
  }
  if (!resource.capabilities.includes(request.action)) {
    return deny("Resource does not declare the requested capability.");
  }
  if (RANK[requiredLevel] >= RANK.L2) {
    if (!approval || approval.issuer !== "human") {
      return deny("L2–L4 operations require independent human approval.");
    }
    if (
      approval.resourceId !== resource.id ||
      approval.workspaceRoot !== request.workspaceRoot ||
      approval.expiresAtMs <= nowMs ||
      RANK[approval.maxLevel] < RANK[requiredLevel] ||
      approval.oneUse !== true
    ) {
      return deny("Approval scope, validity or level does not match.");
    }
  }

  const active = currentLeases.filter(
    (lease) => lease.resourceId === resource.id && lease.expiresAtMs > nowMs,
  );
  if (
    active.some(
      (lease) => request.mode === "exclusive" || lease.mode === "exclusive",
    )
  ) {
    return deny("An active exclusive/shared lease conflicts with this request.");
  }
  if (request.action !== "inspect-metadata" && request.mode !== "exclusive") {
    return deny("Hardware-changing/bench actions require an exclusive lease.");
  }
  return { allowed: true, requiredLevel, reason: "Policy preview only; native gate is authoritative." };
}

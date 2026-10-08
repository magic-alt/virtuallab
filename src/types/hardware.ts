export type PermissionLevel = "L0" | "L1" | "L2" | "L3" | "L4";

export type HardwareAction =
  | "inspect-metadata"
  | "workspace-build"
  | "bench-read"
  | "motion"
  | "power"
  | "flash"
  | "release";

export type HardwareLeaseMode = "shared-read" | "exclusive";

export interface HardwareResource {
  id: string;
  kind: "dut" | "bus" | "fpga" | "programmer" | "instrument" | "power-supply";
  capabilities: HardwareAction[];
}

export interface HardwareLease {
  id: string;
  resourceId: string;
  workspaceRoot: string;
  mode: HardwareLeaseMode;
  action: HardwareAction;
  level: PermissionLevel;
  issuedAtMs: number;
  expiresAtMs: number;
}

export interface HardwareLeaseRequest {
  resourceId: string;
  workspaceRoot: string;
  mode: HardwareLeaseMode;
  action: HardwareAction;
  ttlMs: number;
}

export interface HardwareApproval {
  id: string;
  issuer: "human";
  resourceId: string;
  workspaceRoot: string;
  maxLevel: PermissionLevel;
  expiresAtMs: number;
  oneUse: true;
}

export interface HardwarePolicyDecision {
  allowed: boolean;
  requiredLevel: PermissionLevel;
  reason: string;
}

import { describe, expect, it } from "vitest";
import { evaluateHardwarePolicy, hardwareRequiredLevel } from "./hardwarePolicy";
import type { HardwareApproval, HardwareLease, HardwareLeaseRequest, HardwareResource } from "@/types/hardware";

const resource: HardwareResource = {
  id: "resource-a", kind: "dut", capabilities: ["inspect-metadata", "bench-read", "motion", "flash"],
};
const req: HardwareLeaseRequest = {
  resourceId: "resource-a", workspaceRoot: "/repo/worktree",
  mode: "shared-read", action: "inspect-metadata", ttlMs: 1000,
};
const grant: HardwareApproval = {
  id: "human-1", issuer: "human", resourceId: "resource-a",
  workspaceRoot: "/repo/worktree", maxLevel: "L3", expiresAtMs: 2000, oneUse: true,
};

describe("hardware policy", () => {
  it("maps operations to an explicit L0-L4 level", () => {
    expect(hardwareRequiredLevel("inspect-metadata")).toBe("L0");
    expect(hardwareRequiredLevel("workspace-build")).toBe("L1");
    expect(hardwareRequiredLevel("bench-read")).toBe("L2");
    expect(hardwareRequiredLevel("motion")).toBe("L3");
    expect(hardwareRequiredLevel("release")).toBe("L4");
  });

  it("never promotes an Agent to bench permissions without human approval", () => {
    expect(evaluateHardwarePolicy(resource, {...req, action:"bench-read", mode:"exclusive"}, null, [], 1000).allowed).toBe(false);
    expect(evaluateHardwarePolicy(resource, {...req, action:"motion", mode:"exclusive"}, null, [], 1000).requiredLevel).toBe("L3");
  });

  it("checks grant scope and expiry", () => {
    const requested = {...req, action:"motion" as const, mode:"exclusive" as const};
    expect(evaluateHardwarePolicy(resource, requested, grant, [], 1000).allowed).toBe(true);
    expect(evaluateHardwarePolicy(resource, requested, grant, [], 2000).allowed).toBe(false);
    expect(evaluateHardwarePolicy(resource, requested, {...grant, workspaceRoot:"/other"}, [], 1000).allowed).toBe(false);
  });

  it("prevents exclusive lease conflicts and ignores expired leases", () => {
    const active: HardwareLease = {
      id: "lease-1", resourceId:"resource-a", workspaceRoot:"/other",
      action:"inspect-metadata", mode:"shared-read", level:"L0", issuedAtMs:500, expiresAtMs:1800,
    };
    expect(evaluateHardwarePolicy(resource, {...req, mode:"exclusive"}, null, [active], 1000).allowed).toBe(false);
    expect(evaluateHardwarePolicy(resource, {...req, mode:"exclusive"}, null, [active], 1800).allowed).toBe(true);
  });

  it("rejects excessive TTL and undeclared capabilities", () => {
    expect(evaluateHardwarePolicy(resource, {...req, ttlMs: Infinity}, null, [], 1000).allowed).toBe(false);
    expect(evaluateHardwarePolicy(resource, {...req, action:"power"}, null, [], 1000).allowed).toBe(false);
  });
});

import { describe, expect, it, vi } from "vitest";
import { AgentApprovalBroker, type ApprovalRequest, type EnforcingHardwareProvider } from "./agentSafety";

const base: ApprovalRequest = {
  id: "approval-1", workspaceRoot: "/repo/worktree", resourceId: "user-provided-resource",
  action: "flash", reason: "Bench validation", createdAtMs: 1000, expiresAtMs: 6000,
};
describe("agent safety broker", () => {
  it("requires a direct human gesture and fails closed with no provider", async () => {
    const broker = new AgentApprovalBroker(null, () => 2000);
    broker.request(base);
    expect(() => broker.decide(base.id, "approved-by-human", false)).toThrow("direct human");
    broker.decide(base.id, "approved-by-human", true);
    await expect(broker.authorize(base.id)).rejects.toThrow("No independently enforcing");
  });
  it("rejects mismatched leases and consumes one-use decisions", async () => {
    const provider: EnforcingHardwareProvider = {
      acquireWithHumanApproval: vi.fn().mockResolvedValue({
        leaseId: "lease", workspaceRoot: "/different", resourceId: base.resourceId,
        action: base.action, expiresAtMs: 4000,
      }),
      validateBeforeOperation: vi.fn().mockResolvedValue(true),
      release: vi.fn().mockResolvedValue(undefined),
    };
    const broker = new AgentApprovalBroker(provider, () => 2000);
    broker.request(base);
    broker.decide(base.id, "approved-by-human", true);
    await expect(broker.authorize(base.id)).rejects.toThrow("scope");
    expect(provider.release).toHaveBeenCalled();
    await expect(broker.authorize(base.id)).rejects.toThrow("unconsumed");
  });
  it("requires bounded expiry", () => {
    const broker = new AgentApprovalBroker(null, () => 2000);
    expect(() => broker.request({ ...base, expiresAtMs: 2000 })).toThrow("expiry");
  });
});

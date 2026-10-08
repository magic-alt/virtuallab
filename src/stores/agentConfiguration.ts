import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { agentWorkspaceKey } from "./agentSessions";

export interface AgentRole {
  id: string;
  name: string;
  instructions: string;
}
export interface AgentSkill {
  id: string;
  name: string;
  instructions: string;
}
export interface AgentSelection {
  roleId: string;
  skillIds: string[];
}

export const BUILTIN_ROLES: AgentRole[] = [
  { id: "general", name: "General", instructions: "Work within the selected workspace. Clearly identify assumptions, changes, and verification." },
  { id: "reviewer", name: "Reviewer", instructions: "Review for correctness, security, and regressions. Cite file locations; do not modify files unless explicitly asked." },
  { id: "verifier", name: "Verifier", instructions: "Focus on reproducible build/test results, failure causes, and evidence. Do not claim tests were run without evidence." },
];

interface AgentConfigurationState {
  roles: AgentRole[];
  skills: AgentSkill[];
  selections: Record<string, AgentSelection>;
  addRole: (role: AgentRole) => void;
  removeRole: (id: string) => void;
  addSkill: (skill: AgentSkill) => void;
  removeSkill: (id: string) => void;
  setRole: (workspace: string, id: string) => void;
  toggleSkill: (workspace: string, id: string) => void;
}
function cleanText(value: unknown, max: number) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}
function cleanItems(value: unknown): AgentRole[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v) => v && typeof v.id === "string" && typeof v.name === "string"
      && typeof v.instructions === "string" && v.id.startsWith("custom-"))
    .slice(0, 50).map((v) => ({
      id: cleanText(v.id, 90), name: cleanText(v.name, 80),
      instructions: cleanText(v.instructions, 4000),
    })).filter((v) => v.id && v.name && v.instructions);
}
function selections(value: unknown): Record<string, AgentSelection> {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(Object.entries(value)
    .filter(([, v]) => v && typeof v === "object" && typeof (v as AgentSelection).roleId === "string")
    .map(([k, v]) => {
      const selection = v as AgentSelection;
      return [agentWorkspaceKey(k), {
        roleId: cleanText(selection.roleId, 90),
        skillIds: Array.isArray(selection.skillIds) ? selection.skillIds.filter((id): id is string => typeof id === "string").slice(0, 30) : [],
      }];
    }));
}
export const useAgentConfiguration = create<AgentConfigurationState>()(
  persist((set) => ({
    roles: [], skills: [], selections: {},
    addRole: (role) => set((s) => ({ roles: [...s.roles.filter((v) => v.id !== role.id), ...cleanItems([role])] })),
    removeRole: (id) => set((s) => ({ roles: s.roles.filter((r) => r.id !== id) })),
    addSkill: (skill) => set((s) => ({ skills: [...s.skills.filter((v) => v.id !== skill.id), ...cleanItems([skill])] })),
    removeSkill: (id) => set((s) => ({ skills: s.skills.filter((r) => r.id !== id) })),
    setRole: (root, id) => set((s) => ({
      selections: { ...s.selections, [agentWorkspaceKey(root)]: {
        roleId: id, skillIds: s.selections[agentWorkspaceKey(root)]?.skillIds ?? [],
      } },
    })),
    toggleSkill: (root, id) => set((s) => {
      const key = agentWorkspaceKey(root);
      const current = s.selections[key] ?? { roleId: "general", skillIds: [] };
      return { selections: { ...s.selections, [key]: {
        ...current, skillIds: current.skillIds.includes(id)
          ? current.skillIds.filter((v) => v !== id)
          : [...current.skillIds, id],
      } } };
    }),
  }), {
    name: "virtuallab-agent-configuration-v1",
    storage: createJSONStorage(() => window.localStorage),
    version: 1,
    partialize: ({ roles, skills, selections }) => ({ roles, skills, selections }),
    merge: (stored, current) => {
      const value = stored as Partial<AgentConfigurationState>;
      return { ...current, roles: cleanItems(value?.roles), skills: cleanItems(value?.skills),
        selections: selections(value?.selections) };
    },
  }),
);
export function buildAgentPrompt(message: string, role: AgentRole | undefined, skills: AgentSkill[]): string {
  const instructions = [
    role?.instructions ? "Role instructions:\n" + role.instructions : "",
    ...skills.map((skill) => "Opt-in skill " + skill.name + ":\n" + skill.instructions),
  ].filter(Boolean).join("\n\n");
  return instructions ? instructions + "\n\nUser request:\n" + message.trim() : message.trim();
}

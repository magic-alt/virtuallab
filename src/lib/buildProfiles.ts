import type { BuildStep, BuildSuggestion, ProcessProfile } from "@/types/workbench";

/** Legacy V0.2 profiles are a single executable/argv tuple. */
export function stepsForProfile(profile: ProcessProfile): BuildStep[] {
  return profile.steps?.length
    ? profile.steps
    : [{ name: profile.name, program: profile.program, args: profile.args }];
}

/** Suggestions are ephemeral and worktree-specific; saved profiles stay repository-scoped. */
export function profileFromSuggestion(suggestion: BuildSuggestion, repositoryRoot: string): ProcessProfile {
  const first = suggestion.steps[0];
  if (!first) throw new Error("Cannot create a workflow without a step.");
  return {
    id: "preset-" + suggestion.id,
    name: suggestion.name,
    kind: suggestion.kind,
    repositoryRoot,
    program: first.program,
    args: [...first.args],
    steps: suggestion.steps.map((step) => ({
      name: step.name,
      program: step.program,
      args: [...step.args],
    })),
  };
}

export function formatStep(step: BuildStep): string {
  // Presentation only, never parsed or passed as a shell string.
  return [step.program, ...step.args].join(" ");
}

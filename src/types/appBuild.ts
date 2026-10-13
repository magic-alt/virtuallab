/** Immutable identity embedded in the running desktop executable. */
export interface AppBuildInfo {
  version: string;
  gitCommit: string | null;
  gitBranch: string | null;
  gitDirty: boolean | null;
  builtAtUnixSeconds: number;
  profile: "debug" | "release";
}

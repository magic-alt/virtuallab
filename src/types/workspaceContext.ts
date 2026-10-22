/** An explicitly selected companion checkout. It never changes the primary write scope. */
export interface ContextRepository {
  repositoryRoot: string;
  workspaceRoot: string;
}

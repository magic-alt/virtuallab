# Task Git conversion compatibility

## Problem and intended behavior

Control Center automation fails before Codex starts when the selected repository
uses `core.autocrlf=true`. A clean Windows linked worktree contains CRLF bytes
while its index and commit normally contain LF bytes. Accepting the configuration
value alone would still misclassify these inputs as dirty.

Support ordinary Git end-of-line rules for input checks, retained provider edits,
automatic candidate commits and formal verification. Preserve the selected
repository's configuration and physical file bytes. Keep unsupported external
filters, identity expansion and encoding conversion behind a clear input error.

## Native design

- Retain the raw byte fingerprint used to identify the exact tested inputs.
- Derive Git blob identities separately from immutable snapshots using explicitly
  qualified built-in EOL rules: `core.autocrlf`, `text`, `text=auto`, `-text`, and
  `eol=lf`/`eol=crlf`. Binary detection and existing CRLF index content matter.
- Carry a `SourceSnapshot` from provider preflight through completion. Compare
  per-file raw fingerprints as well as Git identities so an EOL-only edit outside
  the approved scope cannot disappear through normalization.
- Hash snapshots with `git hash-object --no-filters`. For an authorized automatic
  candidate, populate an isolated index from the approved snapshot identities
  rather than asking `git add` to interpret changing files and filters.
- Preserve staged-content conflict checks, index locking, expected-HEAD updates,
  commit-hook/signing policy, bounded reads, path restrictions and output exclusions.
- Recheck raw inputs and effective conversion policy before publishing a candidate.
- Compare info/global/system attribute source fingerprints unconditionally and
  enforce scope on every relevant working attribute file, including ignored
  ancestors. A scoped comment edit cannot exempt other policy changes.
- Re-canonicalize immutable raw inputs against the fully populated candidate index
  before publication so removed attributes cannot alter cached fallback afterward.

`SourceIdentity` keeps its existing fields. The additional in-memory interface is
`SourceSnapshot { identity: SourceIdentity, raw_files: BTreeMap<String, String> }`.
`source_identity` remains the formal verification adapter; `source_snapshot` and
`retained_candidate(..., &SourceSnapshot, ...)` serve provider execution.
`seal_candidate_from_snapshot` validates the provider baseline against the same
observation whose objects it prepares. Private snapshot fields retain conversion
configuration and attribute provenance. Six fixed parallel read-only workers
retain the existing managed-process cleanup and cancellation semantics. Two
configuration workers each issue at most three unchanged Git queries; the other
workers observe working attributes, cached attributes, indexed EOLs and attribute
sources. All workers are joined before any error is propagated, and complete
policy comparison remains unchanged.

## Reporting and recovery

Log input checking before preflight and Codex startup only after preflight passes.
A rejected preflight must explain that Codex has not started and the worktree was
retained. Existing Retry creates a new Attempt in that same worktree.

Failed implementation guidance prioritizes its actual failure over delivery
blockers such as an absent Profile. A preflight-failed implementation retry must
not reuse an old Agent summary. Only an independent verification Attempt may
display the preceding implementation report as supporting context.

## Verification

Use real temporary repositories and linked worktrees for CRLF input, binary and
`-text` handling, attributes, candidate byte equality, configuration preservation,
and out-of-scope EOL-only changes. Exercise the actual provider preflight/completion
helpers. Preserve tests rejecting custom filters and conflicting staged content.
Run the frontend suite, typecheck/build, locked Linux native checks and the
repository's Windows/macOS/Linux CI matrix. Authenticated interactive Codex desktop
execution remains a separate host check; do not report a simulated provider as it.

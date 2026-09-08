import type { Operation } from "./plan.ts";
// Artifact handlers supply reusable knowledge of selected native artifact
// types (SPEC 0.4). Core resolves instance/artifact addressing and decides
// when to call a handler; everything about the artifact's meaning — its
// exposed selectors, its validity, how its contribution merges into a target
// project — lives behind this interface.
//
// Handlers never execute their own planned mutations and never write files:
// adjust works on in-memory text, and planApply only reads the target and
// returns operation records for the reviewed runtime.

// A structural edit within one artifact. Core strips the instance/artifact
// addressing (SPEC 0.5) before handing the edit to the owning handler.
export type StructuralEdit = { op: "omit"; selector: string; entry: string };

export type AdjustResult = {
  contents: string;
  conflicts: string[];
  evidence: string[];
};

// Planning input for contributing an adjusted artifact into an existing
// target project. `read` is Core's tracked read: observations are registered
// into the plan's reviewed inputs automatically, so handlers never build
// input snapshots themselves.
export type ApplyContext = {
  cwd: string;
  artifactPath: string;
  contents: string;
  read: (path: string) => Promise<string | null>;
};

export type ApplyPlan = {
  operations: Operation[];
  evidence: string[];
  conflicts: string[];
};

// One already-resolved, already-customized contribution targeting a shared
// artifact path. Core groups contributions by path and hands each group to
// the claiming handler; the instance chain plus accumulated sources let
// conflicts and evidence name the recipe instance behind every value.
export type ArtifactContribution = {
  instance: string[];
  sources: string[];
  path: string;
  contents: string;
};

export type CombineResult = {
  contents: string;
  evidence: string[];
  conflicts: string[];
};

export type ArtifactHandler = {
  id: string;
  // Which captured artifact paths this handler claims. At most one handler
  // may claim a path; competing claims are a Core-level conflict.
  handles: (artifactPath: string) => boolean;
  // Apply one structural edit to a captured artifact, in memory only.
  // Stale selectors or entries return conflicts, not silent no-ops.
  adjust: (artifactPath: string, contents: string, edit: StructuralEdit) => AdjustResult;
  // Check that an adjusted artifact is still valid for this handler. This is
  // the boundary invalid adjusted combinations must fail at, before any
  // project mutation.
  validateAdjusted?: (artifactPath: string, contents: string) => string[];
  // Plan the adjusted artifact's contribution into the target project:
  // additive merging that preserves unrelated native content, blocking
  // conflicts for differing values, and unsupported structures reported
  // before mutation.
  planApply: (context: ApplyContext) => Promise<ApplyPlan>;
  // Combine several same-path contributions into one, before planApply
  // ever runs. The handler owns how its values merge; Core only groups by
  // path and routes the group here. Order-independent and lossless: every
  // contributed value is preserved or named in a conflict. Absent here,
  // Core deduplicates byte-identical groups and conflicts otherwise.
  combine?: (contributions: ArtifactContribution[]) => CombineResult;
};

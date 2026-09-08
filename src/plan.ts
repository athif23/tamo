import { createHash } from "node:crypto";

// Fingerprints cover text reads and binary observations (tracked executable
// state such as installed native binaries) alike; null records observed
// absence. Bytes are always hashed raw — never decoded — so text and binary
// observations share one semantic; the runtime recheck reads the same raw
// bytes. Hashes are only compared within a reviewed plan, never persisted.
export function fingerprint(contents: string | Uint8Array | null): string | null {
  return contents === null ? null : createHash("sha256").update(contents).digest("hex");
}
export type Snapshot = { path: string; hash: string | null };
export type WriteOperation = {
  kind: "write";
  path: string;
  before: string | null;
  after: string;
};
export type CommandOperation = {
  kind: "command";
  executable: string;
  args: string[];
  cwd: string;
  purpose: string;
};
export type Operation = WriteOperation | CommandOperation;
export type Plan = {
  // Human- and agent-readable label for what the plan applies
  // (for example `recipe:effect-oxlint` or `create`). Display only; the
  // runtime never branches on it.
  subject: string;
  cwd: string;
  inputs: Snapshot[];
  evidence: string[];
  conflicts: string[];
  operations: Operation[];
  validation: string[];
  // True when executing this plan changes project state that planning has
  // not yet observed: the caller must plan again from fresh state instead
  // of treating these operations as the final result. A planning signal
  // only — the runtime never branches on it.
  requiresReplan: boolean;
};

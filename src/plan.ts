import { createHash } from "node:crypto";

export function fingerprint(contents: string | null): string | null {
  return contents === null ? null : createHash("sha256").update(contents).digest("hex");
}
export type Snapshot = { path: string; hash: string | null };
export type Operation =
  | { kind: "write"; path: string; before: string | null; after: string }
  | { kind: "command"; executable: string; args: string[]; cwd: string; purpose: string };
export type Plan = {
  extension: string;
  cwd: string;
  inputs: Snapshot[];
  evidence: string[];
  conflicts: string[];
  operations: Operation[];
  validation: string[];
};
export type ReadContext = { cwd: string; read: (path: string) => Promise<string | null> };
export type Extension = {
  id: string;
  description: string;
  plan: (context: ReadContext) => Promise<Plan>;
  validate: (cwd: string) => Promise<string[]>;
};

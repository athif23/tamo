import { join } from "node:path";
import type { Operation } from "../plan.ts";

// Core's conservative whole-file fallback for artifacts no semantic handler
// claims (SPEC 0.7): create missing files, leave identical files unchanged,
// and report differing content as a conflict. This is application policy,
// not artifact semantics — Core invokes it explicitly for unclaimed
// artifacts, so semantic behavior never depends on registration order.
// Fine-grained selection inside an artifact requires a semantic handler.
export async function planWholeFile({
  cwd,
  artifactPath,
  contents,
  read,
}: {
  cwd: string;
  artifactPath: string;
  contents: string;
  read: (path: string) => Promise<string | null>;
}): Promise<{ operations: Operation[]; evidence: string[]; conflicts: string[] }> {
  const path = join(cwd, artifactPath);
  const target = await read(path);

  if (target === null)
    return {
      operations: [{ kind: "write", path, before: null, after: contents }],
      evidence: [`create ${artifactPath}`],
      conflicts: [],
    };
  if (target === contents)
    return { operations: [], evidence: [`${artifactPath} already matches`], conflicts: [] };
  return {
    operations: [],
    evidence: [],
    conflicts: [`${artifactPath} differs; preserve it and review manually.`],
  };
}

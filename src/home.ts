import { homedir } from "node:os";
import { resolve } from "node:path";

// All developer-owned Tamo state (recipes) lives under one home so
// it survives per-project changes and tests can isolate it with TAMO_HOME.
export function tamoHome(): string {
  const override = process.env.TAMO_HOME?.trim();
  return override ? resolve(override) : resolve(homedir(), ".tamo");
}

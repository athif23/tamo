import { parse, modify, applyEdits, type ParseError } from "jsonc-parser";

// Shared JSON/JSONC decode/edit mechanics. Decoding is strict; editing goes
// through jsonc-parser's targeted modify so comments, formatting, and
// unrelated settings in the surrounding document survive.
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type ObjectJson = { [key: string]: Json };

export function object(value: unknown): value is ObjectJson {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function json(text: string, path: string): ObjectJson {
  const errors: ParseError[] = [];
  const value: unknown = parse(text, errors, { allowTrailingComma: true });
  if (errors.length || !object(value))
    throw new Error(`Expected a valid JSON/JSONC object: ${path}`);
  return value;
}

export function array(value: Json | undefined, field: string): Json[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`Expected an array: ${field}`);
  return value;
}

export function section(value: Json | undefined, field: string): ObjectJson {
  if (value === undefined) return {};
  if (!object(value)) throw new Error(`Expected an object: ${field}`);
  return value;
}

export function severity(value: Json | undefined): Json | undefined {
  if (Array.isArray(value)) return value.length === 1 ? severity(value[0]) : value;
  return value === 2
    ? "error"
    : value === 1
      ? "warn"
      : value === 0 || value === "allow"
        ? "off"
        : value;
}

function modifyText(text: string, path: (string | number)[], value: Json | undefined): string {
  return applyEdits(
    text,
    modify(text, path, value, {
      formattingOptions: {
        insertSpaces: true,
        tabSize: 2,
        eol: text.includes("\r\n") ? "\r\n" : "\n",
      },
    }),
  );
}

export function edit(text: string, path: (string | number)[], value: Json): string {
  return modifyText(text, path, value);
}

// Canonical comparison for contribution coverage: objects compare by sorted
// keys so identical state in a different key order is not misreported as a
// divergence. Arrays keep their order; absent values never equal present ones.
export function canonical(value: Json | undefined): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
    .join(",")}}`;
}

// Structural removal: jsonc-parser treats an undefined value as property
// deletion and touches only the removed entry's span, so surrounding
// comments and formatting survive.
export function removeKey(text: string, path: (string | number)[]): string {
  return modifyText(text, path, undefined);
}

import type { Observation } from "../types.js";

export type Action =
  | { kind: "tap"; ref?: string; selector?: string }
  | { kind: "type"; ref?: string; selector?: string; text: string }
  | { kind: "scroll"; direction: "up" | "down" }
  | { kind: "open_link"; url: string }
  | { kind: "wait"; ms: number }
  | { kind: "back" };

export interface DeviceAdapter {
  readonly platform: string;
  open(target: string): Promise<Observation>;
  observe(opts?: { screenshot?: boolean; label?: string }): Promise<Observation>;
  act(action: Action, opts?: { screenshot?: boolean; label?: string }): Promise<Observation>;
  waitFor(q: { text?: string; selector?: string; absent?: boolean; timeoutMs?: number }): Promise<boolean>;
  screenshot(label: string): Promise<string>;
  close(): Promise<void>;
}

export interface DeviceOptions {
  evidenceDir: string;
  platform: string;
  device?: string;
  session?: string;
  headed?: boolean;
}

/** Deterministic fingerprint of a UI tree with dynamic values stripped. */
export function fingerprintOf(title: string, nodes: { role: string; name: string; testId?: string }[]): string {
  const norm = nodes
    .map((n) => `${n.role}|${n.testId ?? ""}|${n.name.replace(/\d+([.,]\d+)?/g, "#").trim()}`)
    .join("\n");
  return `${title}|${simpleHash(norm)}`;
}

export function simpleHash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** Jaccard similarity of two node sets, used for cache hit / drift decisions. */
export function similarity(a: { role: string; name: string; testId?: string }[], b: { role: string; name: string; testId?: string }[]): number {
  const key = (n: { role: string; name: string; testId?: string }) => `${n.role}|${n.testId ?? ""}|${n.name.replace(/\d+/g, "#")}`;
  const A = new Set(a.map(key));
  const B = new Set(b.map(key));
  let inter = 0;
  for (const k of A) if (B.has(k)) inter++;
  const union = new Set([...A, ...B]).size;
  return union === 0 ? 1 : inter / union;
}

export function renderSnapshot(title: string, nodes: { ref: string; role: string; name: string; testId?: string; value?: string; interactive: boolean }[]): string {
  const lines = [`# screen: ${title}`];
  for (const n of nodes) {
    const parts = [`# @${n.ref} [${n.role}]`, JSON.stringify(n.name)];
    if (n.testId) parts.push(`testID=${n.testId}`);
    if (n.value !== undefined && n.value !== "") parts.push(`value=${JSON.stringify(n.value)}`);
    if (!n.interactive) parts.push("(static)");
    lines.push(parts.join(" "));
  }
  return lines.join("\n");
}

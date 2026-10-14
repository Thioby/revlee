import fs from "node:fs";
import { TaskContext, ImpactMap } from "./types.js";

export function loadTaskContext(file: string): TaskContext {
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  return TaskContext.parse(raw);
}

/** Minimal Impact Analyzer: changed files -> screens via repo_knowledge.screens. */
export function analyzeImpact(ctx: TaskContext): ImpactMap {
  const screens: ImpactMap["screens"] = [];
  const mapped = new Set<string>();
  for (const s of ctx.repo_knowledge.screens) {
    const hits = ctx.pr.files.filter((f) => s.files.some((p) => f === p || f.endsWith(p) || globLike(p, f)));
    if (hits.length) {
      hits.forEach((h) => mapped.add(h));
      screens.push({ id: s.id, confidence: Math.min(0.95, 0.6 + 0.1 * hits.length), why: hits.map((h) => `${h} modified`), entry_path: s.entry });
    }
  }
  const unmapped = ctx.pr.files.filter((f) => !mapped.has(f));
  const sharedTouched = ctx.pr.files.some((f) => /theme|tokens|components\/ui|index\.html|styles?\./i.test(f));
  const blast = screens.length === 0 && unmapped.length === 0 ? "none" : sharedTouched ? "shared_component" : screens.length <= 2 ? "local" : "layout";
  return ImpactMap.parse({ screens, blast_radius: blast, unmapped_files: unmapped });
}

function globLike(pattern: string, file: string): boolean {
  if (!pattern.includes("*")) return false;
  const re = new RegExp("^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*") + "$");
  return re.test(file);
}

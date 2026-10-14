import fs from "node:fs";
import { VerificationPlan, type ImpactMap, type TaskContext } from "./types.js";
import type { ModelClient } from "./model.js";

const SYSTEM = `You are the Planner of the Revlee system: you turn the context of a pull request and its task into an explicit, auditable verification plan that an agent executes against the running application.

Hard rules:
1. The diff is authoritative; the PR description is context only. Never accept behavior that contradicts the acceptance criteria just because the PR description says so.
2. Every claimed_behavior MUST have a source_ref pointing to an existing acceptance criterion (e.g. "SHOP-412#ac:2"), a diff hunk ("pr:h1") or a line of the PR description ("pr:body"). Behaviors derived from the diff that are not in the ticket must be marked derived=true.
3. Every acceptance criterion -> at least one scenario, or an entry in cannot_verify_via_ui with a reason.
4. Scenario steps are natural language, platform independent, with no refs (@e12) and no coordinates. Max 12 steps. Every step has expect_after: what must be observable after the step.
5. Oracles: prefer a11y_assert (text visible/absent, element by testID/role/name) whenever the property is visible in the accessibility tree. Use vlm_rubric ONLY for properties invisible in the tree (color, layout, charts). Every oracle has at_step (after which step it is evaluated) and expected_on_base: "absent" when the element/text must not exist on the base build, "different" when the appearance must differ, "same" when nothing should change.
6. Every scenario has at least one negative control (negative_controls): something that must NOT be present (e.g. the toast text before the action; no new element on the base build when compare_with_base=true).
7. Never plan destructive actions: payments, account deletion, sending messages, or anything the playbook forbids.
8. Use test data and navigation paths from the playbook and the screen map.
Respond only with a JSON object matching the schema.`;

export async function buildPlan(model: ModelClient, ctx: TaskContext, impact: ImpactMap, opts: { mockPlanFile?: string } = {}): Promise<VerificationPlan> {
  if (model.isMock) {
    if (!opts.mockPlanFile) throw new Error("mock model requires --plan <file>");
    return VerificationPlan.parse(JSON.parse(fs.readFileSync(opts.mockPlanFile, "utf8")));
  }
  const user = [
    "<task_context>",
    JSON.stringify({ pr: { ...ctx.pr, diff_hunks: ctx.pr.diff_hunks }, tickets: ctx.tickets, scope_hint: ctx.scope_hint }, null, 1),
    "</task_context>",
    "<impact_map>", JSON.stringify(impact, null, 1), "</impact_map>",
    "<playbook>", ctx.repo_knowledge.playbook_md, "</playbook>",
    "<screens>", JSON.stringify(ctx.repo_knowledge.screens), "</screens>",
    "Build the VerificationPlan. Criterion ids: use the ids from acceptance_criteria (AC1, AC2...). Scenarios: S1, S2... Oracles: O1, O2... Negative controls: N1, N2...",
  ].join("\n");
  const plan = await model.parse({ system: SYSTEM, content: [{ type: "text", text: user }], schema: VerificationPlan, effort: "high" });
  validatePlan(plan, ctx);
  return plan;
}

/** Deterministic plan QA (mirrors docs/06 §2.3). Throws on hard violations. */
export function validatePlan(plan: VerificationPlan, ctx: TaskContext): string[] {
  const warnings: string[] = [];
  const acIds = new Set(ctx.tickets.flatMap((t) => t.acceptance_criteria.map((a) => a.id)));
  const validRefs = new Set<string>([...ctx.tickets.flatMap((t) => t.acceptance_criteria.map((a) => a.source_ref)), ...ctx.pr.diff_hunks.map((h) => `pr:${h.id}`), "pr:body", "pr:title"]);
  for (const b of plan.claimed_behaviors) {
    if (!validRefs.has(b.source_ref)) throw new Error(`claimed behavior ${b.id} has unknown source_ref ${b.source_ref}`);
  }
  const covered = new Set(plan.scenarios.flatMap((s) => s.covers));
  for (const ac of acIds) {
    if (!covered.has(ac) && !plan.cannot_verify_via_ui.some((c) => c.criterion === ac)) throw new Error(`acceptance criterion ${ac} has no scenario and no cannot_verify entry`);
  }
  for (const s of plan.scenarios) {
    if (s.negative_controls.length === 0) warnings.push(`${s.id}: no negative control`);
    for (const st of s.steps) if (/@e\d+|\b\d{2,4}\s*,\s*\d{2,4}\b/.test(st.text)) throw new Error(`${s.id} step ${st.n} uses refs/coordinates`);
    for (const o of s.oracles) {
      if (o.type === "a11y_assert" && !o.assert) throw new Error(`${o.id}: a11y_assert without assert`);
      if (o.type === "vlm_rubric" && !o.rubric) throw new Error(`${o.id}: vlm_rubric without rubric`);
      if (!s.steps.some((st) => st.n === o.at_step)) throw new Error(`${o.id}: at_step ${o.at_step} not in scenario`);
    }
  }
  return warnings;
}

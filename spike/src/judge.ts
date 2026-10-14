import fs from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import { z } from "zod";
import type { CriterionVerdict, Observation, Oracle, RunVerdict, ScenarioRun, VerdictValue, VerificationPlan } from "./types.js";
import { imageBlock, type ModelClient } from "./model.js";

export interface JudgeOptions { votes: number; evidenceDir: string; log: (s: string) => void; changeIntent: string }

const JudgeOut = z.object({
  verdict: z.enum(["pass", "fail", "inconclusive"]),
  evidence: z.string().describe("Which observations/elements prove it (image index, region, text)."),
  unmet_subcriteria: z.array(z.string()),
});

const JUDGE_SYSTEM = `You are an independent QA judge. You evaluate ONLY the attached observations (screenshots and accessibility trees). You do not know and do not need the agent's narration.
Break the criterion into atomic sub-criteria and evaluate each. For verdict=pass you must cite concrete evidence (which image, which element/region). If the observations are insufficient, answer inconclusive and state what evidence is missing. Do not assume an action succeeded just because the order of images suggests it. Answer with JSON matching the schema.`;

// ---------- deterministic oracles ----------
export function evalA11y(assert: NonNullable<Oracle["assert"]>, obs: Observation): { ok: boolean; detail: string } {
  const texts = obs.nodes.map((n) => `${n.name} ${n.value ?? ""}`).join(" | ");
  if (assert.text_contains) { const ok = texts.includes(assert.text_contains); return { ok, detail: `${ok ? "found" : "missing"} text "${assert.text_contains}"` }; }
  if (assert.text_absent) { const ok = !texts.includes(assert.text_absent); return { ok, detail: `text "${assert.text_absent}" ${ok ? "absent" : "PRESENT"}` }; }
  if (assert.element) {
    const e = assert.element;
    const node = obs.nodes.find((n) => (!e.test_id || n.testId === e.test_id) && (!e.role || n.role === e.role) && (!e.name_contains || n.name.includes(e.name_contains)));
    const want = assert.element_state ?? "visible";
    let ok = want === "visible" ? !!node : !node;
    if (ok && node && e.value_equals !== null && e.value_equals !== undefined) {
      const actual = (node.value ?? node.name).trim();
      ok = actual === e.value_equals;
      return { ok, detail: `element testID=${node.testId ?? "-"} ${node.role} value="${actual}" ${ok ? "==" : "!="} expected "${e.value_equals}"` };
    }
    return { ok, detail: node ? `element ${node.role} "${node.name}" testID=${node.testId ?? "-"} value=${node.value ?? "-"} ${want === "visible" ? "present" : "PRESENT (expected absent)"}` : `element ${JSON.stringify(e)} ${want === "absent" ? "absent" : "MISSING"}` };
  }
  return { ok: false, detail: "empty assertion" };
}

export function pixelDiff(aPath: string, bPath: string, outPath: string): { pct: number; diffPath: string } | null {
  try {
    const a = PNG.sync.read(fs.readFileSync(aPath));
    const b = PNG.sync.read(fs.readFileSync(bPath));
    if (a.width !== b.width || a.height !== b.height) return null;
    const diff = new PNG({ width: a.width, height: a.height });
    const n = pixelmatch(a.data, b.data, diff.data, a.width, a.height, { threshold: 0.1, includeAA: false });
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, PNG.sync.write(diff));
    return { pct: (n / (a.width * a.height)) * 100, diffPath: outPath };
  } catch { return null; }
}

// ---------- VLM judge with voting ----------
async function vlmJudge(model: ModelClient, oracle: Oracle, obs: Observation, prev: Observation | undefined, baseObs: Observation | undefined, opts: JudgeOptions): Promise<CriterionVerdict["judge_votes"]> {
  if (model.isMock || !obs.screenshotPath) return undefined;
  const votes: NonNullable<CriterionVerdict["judge_votes"]> = [];
  const content: any[] = [];
  const push = (label: string, o?: Observation) => { if (o?.screenshotPath) { content.push({ type: "text", text: label }); content.push(imageBlock(fs.readFileSync(o.screenshotPath).toString("base64"))); } };
  if (prev && prev !== obs) push("Image A: screen BEFORE the step", prev);
  push("Image B: screen AFTER the step (under evaluation)", obs);
  if (baseObs) push("Image C: the same step on the BASE build (before the change)", baseObs);
  content.push({ type: "text", text: `Accessibility tree of screen B:\n${obs.snapshotText}\n\nCriterion: ${oracle.rubric}\nChange context: ${opts.changeIntent}\nExpectation relative to the base build: ${oracle.expected_on_base}` });
  for (let i = 0; i < opts.votes; i++) {
    try {
      const out = await model.parse({ system: JUDGE_SYSTEM, content, schema: JudgeOut, effort: "medium" });
      votes.push({ model: model.model, verdict: out.verdict, evidence: `${out.evidence}${out.unmet_subcriteria.length ? ` | unmet: ${out.unmet_subcriteria.join("; ")}` : ""}` });
    } catch (e: any) { votes.push({ model: model.model, verdict: "inconclusive", evidence: `judge error: ${String(e?.message ?? e).slice(0, 200)}` }); }
  }
  return votes;
}

// ---------- aggregate ----------
export async function judgeAll(model: ModelClient, plan: VerificationPlan, prRuns: ScenarioRun[], baseRuns: ScenarioRun[] | null, opts: JudgeOptions): Promise<{ criteria: CriterionVerdict[]; run: RunVerdict; findings: string[] }> {
  const criteriaIds = [...new Set(plan.claimed_behaviors.map((b) => b.id))];
  const perCriterion = new Map<string, CriterionVerdict[]>();
  const findings: string[] = [];

  for (const run of prRuns) {
    const base = baseRuns?.find((b) => b.scenario.id === run.scenario.id);
    // negative controls
    const negResults: CriterionVerdict["negative_controls"] = [];
    for (const nc of run.scenario.negative_controls) {
      const target = nc.compare_with_base ? base : run;
      const idx = target?.stepObs[nc.at_step];
      if (idx === undefined || !nc.assert) { negResults.push({ id: nc.id, result: "unable_to_verify", detail: nc.compare_with_base && !base ? "no base run" : "step not reached" }); continue; }
      const r = evalA11y(nc.assert, target!.observations[idx]);
      negResults.push({ id: nc.id, result: r.ok ? "pass" : "fail", detail: `${nc.compare_with_base ? "base" : "pr"} obs#${idx}: ${r.detail}` });
    }
    for (const o of run.scenario.oracles) {
      const idx = run.stepObs[o.at_step];
      const v: CriterionVerdict = { criterion_id: o.covers, verdict: "unable_to_verify", oracle_type: o.type, confidence: 0, evidence: [], negative_controls: negResults.filter((n) => n.result !== "unable_to_verify" || true) };
      if (idx === undefined) { v.reason = run.blocker ?? `step ${o.at_step} not reached`; push(perCriterion, v); continue; }
      const obs = run.observations[idx];
      const baseIdx = base?.stepObs[o.at_step];
      const baseObs = baseIdx !== undefined ? base!.observations[baseIdx] : undefined;
      if (o.type === "a11y_assert" && o.assert) {
        const r = evalA11y(o.assert, obs);
        v.verdict = r.ok ? "pass" : "fail";
        v.confidence = 0.95;
        v.evidence.push({ observation: idx, detail: r.detail, screenshot: obs.screenshotPath });
        if (baseObs && o.expected_on_base !== "same") {
          const rb = evalA11y(o.assert, baseObs);
          const consistent = o.expected_on_base === "absent" ? !rb.ok : true;
          v.evidence.push({ observation: baseIdx!, detail: `base: ${rb.detail} (${consistent ? "consistent with expected_on_base" : "UNEXPECTED on base"})`, screenshot: baseObs.screenshotPath });
          if (!consistent && v.verdict === "pass") { v.verdict = "inconclusive"; v.reason = "same result on base build: change not demonstrated"; v.confidence = 0.5; }
        }
      } else if (o.type === "vlm_rubric") {
        // 1) visual differential vs base (deterministic detector)
        let diffPct: number | null = null;
        if (baseObs?.screenshotPath && obs.screenshotPath) {
          const d = pixelDiff(baseObs.screenshotPath, obs.screenshotPath, path.join(opts.evidenceDir, "diffs", `${o.id}.png`));
          if (d) { diffPct = d.pct; v.evidence.push({ observation: idx, detail: `pixel diff vs base: ${d.pct.toFixed(2)}% (expected_on_base=${o.expected_on_base})`, screenshot: d.diffPath }); }
        }
        // 2) VLM votes (observations only, never agent narration)
        const prev = idx > 0 ? run.observations[idx - 1] : undefined;
        const votes = await vlmJudge(model, o, obs, prev, baseObs, opts);
        v.judge_votes = votes;
        if (votes && votes.length) {
          const passes = votes.filter((x) => x.verdict === "pass").length, fails = votes.filter((x) => x.verdict === "fail").length;
          if (passes === votes.length) { v.verdict = "pass"; v.confidence = 0.7 * (diffPct === null ? 1 : o.expected_on_base === "different" && diffPct > 0.1 ? 1.15 : 0.8); }
          else if (fails > 0 && passes === 0) { v.verdict = "fail"; v.confidence = 0.7 * (fails / votes.length); }
          else { v.verdict = "inconclusive"; v.confidence = 0.4; v.reason = `judges disagree (${passes} pass / ${fails} fail / ${votes.length} total)`; }
          v.evidence.push({ observation: idx, detail: votes.map((x) => `${x.verdict}: ${x.evidence}`).join(" || "), screenshot: obs.screenshotPath });
        } else if (diffPct !== null) {
          // mock mode: differential detector only
          const ok = o.expected_on_base === "different" ? diffPct > 0.1 : diffPct <= 0.1;
          v.verdict = ok ? "pass" : "fail";
          v.confidence = 0.6;
          v.reason = "no VLM judge (mock model): verdict from pixel differential vs base only";
        } else { v.verdict = "unable_to_verify"; v.reason = "vlm_rubric needs a model or a base build for pixel differential"; }
        v.confidence = Math.min(0.99, v.confidence);
      }
      push(perCriterion, v);
    }
    if (run.status !== "completed") findings.push(`${run.scenario.id}: ${run.status} (${run.blocker})`);
  }

  // merge oracles per criterion: strongest oracle wins; any confirmed fail -> fail
  const criteria: CriterionVerdict[] = criteriaIds.map((id) => {
    const vs = perCriterion.get(id) ?? [];
    if (!vs.length) return { criterion_id: id, verdict: "unable_to_verify", oracle_type: "none", confidence: 0, evidence: [], negative_controls: [], reason: plan.cannot_verify_via_ui.find((c) => c.criterion === id)?.reason ?? "no oracle" };
    const order: VerdictValue[] = ["fail", "inconclusive", "unable_to_verify", "pass"];
    const worst = vs.reduce((acc, v) => (order.indexOf(v.verdict) < order.indexOf(acc.verdict) ? v : acc), vs[0]);
    const allPass = vs.every((v) => v.verdict === "pass");
    const negFail = vs.flatMap((v) => v.negative_controls).some((n) => n.result === "fail");
    const merged: CriterionVerdict = { ...(allPass ? vs.reduce((a, b) => (b.confidence > a.confidence ? b : a)) : worst) };
    merged.evidence = vs.flatMap((v) => v.evidence);
    merged.negative_controls = dedupe(vs.flatMap((v) => v.negative_controls));
    merged.judge_votes = vs.flatMap((v) => v.judge_votes ?? []);
    merged.oracle_type = [...new Set(vs.map((v) => v.oracle_type))].join("+");
    if (allPass) merged.confidence = Math.max(...vs.map((v) => v.confidence));
    if (negFail && merged.verdict === "pass") { merged.verdict = "inconclusive"; merged.reason = "negative control failed"; merged.confidence = 0.4; }
    return merged;
  });

  const runVerdict: RunVerdict = criteria.every((c) => c.verdict === "unable_to_verify") ? "unable_to_verify"
    : criteria.some((c) => c.verdict === "fail") ? "failed"
    : criteria.some((c) => c.verdict === "inconclusive" || c.verdict === "unable_to_verify") ? "inconclusive"
    : findings.length ? "ready_with_issues" : "ready";
  return { criteria, run: runVerdict, findings };
}

function push(m: Map<string, CriterionVerdict[]>, v: CriterionVerdict) { m.set(v.criterion_id, [...(m.get(v.criterion_id) ?? []), v]); }
function dedupe<T extends { id: string }>(xs: T[]): T[] { const seen = new Set<string>(); return xs.filter((x) => (seen.has(x.id) ? false : (seen.add(x.id), true))); }

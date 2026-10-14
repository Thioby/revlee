import fs from "node:fs";
import path from "node:path";
import type { CriterionVerdict, RunVerdict, ScenarioRun, TaskContext, VerificationPlan } from "./types.js";
import type { Usage } from "./model.js";

export interface ReportInput {
  ctx: TaskContext; plan: VerificationPlan; prRuns: ScenarioRun[]; baseRuns: ScenarioRun[] | null;
  criteria: CriterionVerdict[]; run: RunVerdict; findings: string[]; usage: Usage; durationS: number; platform: string; adapter: string; model: string; outDir: string;
}

const ICON: Record<string, string> = { pass: "✅", fail: "❌", inconclusive: "❔", unable_to_verify: "⛔" };
const HEAD: Record<RunVerdict, string> = { ready: "✅ Ready", ready_with_issues: "⚠️ Ready with issues", failed: "❌ Failed", inconclusive: "❔ Inconclusive", unable_to_verify: "⛔ Unable to verify" };

export function writeReports(r: ReportInput) {
  const rel = (p?: string) => (p ? path.relative(r.outDir, p) : "");
  const conf = r.criteria.length ? Math.min(...r.criteria.filter((c) => c.verdict !== "unable_to_verify").map((c) => c.confidence), 1) : 0;
  const lines: string[] = [];
  lines.push(`<!-- revlee:comment pr=${r.ctx.pr.number} -->`);
  lines.push(`## ${HEAD[r.run]} · confidence ${conf.toFixed(2)}`);
  lines.push(`**PR #${r.ctx.pr.number} · ${r.ctx.pr.head_sha}** · ${r.platform} (${r.adapter}) · model ${r.model} · ${r.durationS.toFixed(0)} s · ${r.usage.calls} model calls · ${r.usage.usd.toFixed(3)} USD · base ${r.baseRuns ? "compared" : "not compared"}`);
  if (r.ctx.tickets.length) lines.push(`Task: ${r.ctx.tickets.map((t) => (t.url ? `[${t.id}](${t.url})` : t.id)).join(", ")} · AC: ${r.ctx.tickets.reduce((n, t) => n + t.acceptance_criteria.length, 0)}`);
  lines.push("", `> Change intent: ${r.plan.change_intent}`, "");
  lines.push("| Criterion | Verdict | Oracle | Evidence | Confidence |", "|---|---|---|---|---|");
  for (const c of r.criteria) {
    const b = r.plan.claimed_behaviors.find((x) => x.id === c.criterion_id);
    const ev = c.evidence.slice(0, 3).map((e) => (e.screenshot ? `[obs#${e.observation}](${rel(e.screenshot)})` : `obs#${e.observation}`)).join(" ");
    lines.push(`| ${c.criterion_id} ${b?.text ?? ""}${b?.derived ? " *(derived)*" : ""} | ${ICON[c.verdict]} ${c.verdict}${c.reason ? ` — ${c.reason}` : ""} | ${c.oracle_type} | ${ev} | ${c.confidence.toFixed(2)} |`);
  }
  for (const c of r.criteria) {
    if (c.verdict === "pass") continue;
    lines.push("", `### ${ICON[c.verdict]} ${c.criterion_id}`);
    for (const e of c.evidence) lines.push(`- obs#${e.observation}: ${e.detail}${e.screenshot ? ` ([screenshot](${rel(e.screenshot)}))` : ""}`);
    if (c.judge_votes?.length) lines.push(`- judge votes: ${c.judge_votes.map((v) => `${v.verdict}`).join(", ")}`);
  }
  for (const run of r.prRuns) {
    lines.push("", `### Walkthrough ${run.scenario.id} · ${run.scenario.title} · ${run.status}${run.blocker ? ` (${run.blocker})` : ""}`);
    lines.push("| # | Step | Source | Expectation | After step |", "|---|---|---|---|---|");
    for (const st of run.scenario.steps) {
      const idx = run.stepObs[st.n];
      const act = run.actions.filter((a) => a.step === st.n);
      const obs = idx !== undefined ? run.observations[idx] : undefined;
      lines.push(`| ${st.n} | ${st.text} | ${act.map((a) => a.source).filter((v, i, a2) => a2.indexOf(v) === i).join("/") || "—"} | ${st.expect_after} | ${obs ? `${obs.title} ${obs.screenshotPath ? `([shot](${rel(obs.screenshotPath)}))` : ""}` : "not reached"} |`);
    }
    const ncs = r.criteria.flatMap((c) => c.negative_controls).filter((n, i, a) => a.findIndex((x) => x.id === n.id) === i);
    if (ncs.length) lines.push("", `Negative controls: ${ncs.map((n) => `${n.id} ${ICON[n.result]} (${n.detail})`).join(" · ")}`);
  }
  if (r.findings.length) lines.push("", "### Findings", ...r.findings.map((f) => `- ${f}`));
  const unable = r.criteria.filter((c) => c.verdict === "unable_to_verify");
  lines.push("", "### Not verified", unable.length ? unable.map((c) => `- ${c.criterion_id}: ${c.reason}`).join("\n") : "— all criteria executed");
  lines.push("", "<details><summary>How this was verified</summary>", "", `plan: ${r.plan.scenarios.length} scenarios, ${r.plan.scenarios.reduce((n, s) => n + s.steps.length, 0)} steps · actions: ${r.prRuns.reduce((n, s) => n + s.actions.length, 0)} (${r.prRuns.flatMap((s) => s.actions).filter((a) => a.source === "replay").length} replay) · tokens in/out: ${r.usage.tokens_in}/${r.usage.tokens_out} · oracles: ${[...new Set(r.criteria.map((c) => c.oracle_type))].join(", ")}`, "", "</details>");
  const summary = { verdict: r.run, confidence: Number(conf.toFixed(2)), criteria: count(r.criteria), cost_usd: Number(r.usage.usd.toFixed(3)), duration_s: Math.round(r.durationS), sha: r.ctx.pr.head_sha, platform: r.platform };
  lines.push(`<!-- revlee:summary ${JSON.stringify(summary)} -->`);
  fs.writeFileSync(path.join(r.outDir, "report.md"), lines.join("\n"));
  fs.writeFileSync(path.join(r.outDir, "verdicts.json"), JSON.stringify({ summary, criteria: r.criteria, findings: r.findings }, null, 2));
  fs.writeFileSync(path.join(r.outDir, "junit.xml"), junit(r));
  fs.writeFileSync(path.join(r.outDir, "actions.ndjson"), r.prRuns.flatMap((s) => s.actions).map((a) => JSON.stringify(a)).join("\n"));
  return summary;
}

function count(cs: CriterionVerdict[]) { return { pass: cs.filter((c) => c.verdict === "pass").length, fail: cs.filter((c) => c.verdict === "fail").length, inconclusive: cs.filter((c) => c.verdict === "inconclusive").length, unable_to_verify: cs.filter((c) => c.verdict === "unable_to_verify").length }; }

function junit(r: ReportInput): string {
  const esc = (s: string) => s.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]!);
  const cases = r.criteria.map((c) => {
    const b = r.plan.claimed_behaviors.find((x) => x.id === c.criterion_id);
    const name = esc(`${c.criterion_id} ${b?.text ?? ""}`);
    const body = c.verdict === "pass" ? "" : c.verdict === "fail" ? `<failure message="${esc(c.evidence.map((e) => e.detail).join("; "))}"/>` : `<skipped message="${esc(`${c.verdict}: ${c.reason ?? ""}`)}"/>`;
    return `  <testcase classname="revlee.${r.platform}" name="${name}" time="0">${body}</testcase>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="revlee PR #${r.ctx.pr.number}" tests="${r.criteria.length}" failures="${r.criteria.filter((c) => c.verdict === "fail").length}" skipped="${r.criteria.filter((c) => c.verdict !== "pass" && c.verdict !== "fail").length}" time="${r.durationS.toFixed(1)}">\n${cases.join("\n")}\n</testsuite>\n`;
}

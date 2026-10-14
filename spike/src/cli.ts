#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadTaskContext, analyzeImpact } from "./context.js";
import { buildPlan, validatePlan } from "./planner.js";
import { ModelClient } from "./model.js";
import { PlaywrightAdapter } from "./device/playwright.js";
import { AgentDeviceAdapter } from "./device/agentDevice.js";
import type { DeviceAdapter } from "./device/types.js";
import { runScenario, replayScenario } from "./executor.js";
import { judgeAll } from "./judge.js";
import { writeReports } from "./report.js";
import type { ScenarioRun } from "./types.js";

const HELP = `revlee-spike verify --context <task_context.json> --url <app url | app id> [options]

  --adapter playwright|agent-device   (default: playwright for web, agent-device otherwise)
  --platform web|ios|android          (default: web)
  --base-url <url|app id>             build bazowy do porównania różnicowego
  --model mock|claude-opus-5-5|...    (default: $REVLEE_MODEL or claude-opus-5-5; mock = bez LLM)
  --plan <plan.json>                  gotowy plan (wymagany dla --model mock)
  --out <dir>                         katalog dowodów (default .revlee-run/<timestamp>)
  --votes <n>                         głosy sędziego VLM (default 3)
  --max-usd <n> --max-turns <n>       budżety (default 5 / 60)
  --headed                            Playwright z oknem
  --device <id>                       urządzenie dla agent-device (UDID / serial)

Exit codes: 0 ready/ready_with_issues, 2 failed, 3 unable_to_verify/inconclusive, 1 error.`;

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      context: { type: "string" }, url: { type: "string" }, "base-url": { type: "string" }, adapter: { type: "string" }, platform: { type: "string", default: "web" },
      model: { type: "string" }, plan: { type: "string" }, out: { type: "string" }, votes: { type: "string", default: "3" }, "max-usd": { type: "string", default: "5" }, "max-turns": { type: "string", default: "60" },
      headed: { type: "boolean", default: false }, device: { type: "string" }, help: { type: "boolean", default: false },
    },
  });
  if (values.help || positionals[0] !== "verify" || !values.context || !values.url) { console.log(HELP); process.exit(positionals[0] === "verify" ? 1 : 0); }
  const t0 = Date.now();
  const outDir = path.resolve(values.out ?? path.join(".revlee-run", new Date().toISOString().replace(/[:.]/g, "-")));
  fs.mkdirSync(outDir, { recursive: true });
  const log = (s: string) => { console.log(s); fs.appendFileSync(path.join(outDir, "run.log"), s + "\n"); };
  const modelName = values.model ?? process.env.REVLEE_MODEL ?? "claude-opus-5-5";
  const platform = values.platform!;
  const adapterName = values.adapter ?? (platform === "web" ? "playwright" : "agent-device");
  const model = new ModelClient(modelName);
  log(`revlee-spike verify · platform=${platform} adapter=${adapterName} model=${modelName} out=${outDir}`);

  // 1. context + impact
  const ctx = loadTaskContext(values.context);
  const impact = analyzeImpact(ctx);
  fs.writeFileSync(path.join(outDir, "task_context.json"), JSON.stringify(ctx, null, 2));
  fs.writeFileSync(path.join(outDir, "impact_map.json"), JSON.stringify(impact, null, 2));
  log(`context: PR #${ctx.pr.number} "${ctx.pr.title}" · tickets ${ctx.tickets.map((t) => t.id).join(",") || "-"} · AC ${ctx.tickets.reduce((n, t) => n + t.acceptance_criteria.length, 0)} · impact screens ${impact.screens.map((s) => s.id).join(",") || "-"} · blast ${impact.blast_radius}`);

  // 2. plan
  const plan = await buildPlan(model, ctx, impact, { mockPlanFile: values.plan });
  const warnings = validatePlan(plan, ctx);
  fs.writeFileSync(path.join(outDir, "plan.json"), JSON.stringify(plan, null, 2));
  log(`plan: ${plan.scenarios.length} scenariuszy, ${plan.claimed_behaviors.length} zachowań, ${plan.cannot_verify_via_ui.length} nieweryfikowalnych${warnings.length ? ` · warnings: ${warnings.join("; ")}` : ""}`);
  for (const s of plan.scenarios) log(`  ${s.id} ${s.title}: ${s.steps.length} kroków, orakula ${s.oracles.map((o) => `${o.id}:${o.type}`).join(",")}`);

  const mkDevice = (sub: string): DeviceAdapter => {
    const evidenceDir = path.join(outDir, sub);
    fs.mkdirSync(evidenceDir, { recursive: true });
    return adapterName === "playwright" ? new PlaywrightAdapter({ evidenceDir, platform, headed: values.headed }) : new AgentDeviceAdapter({ evidenceDir, platform, device: values.device });
  };

  // 3. execute on PR build
  const prRuns: ScenarioRun[] = [];
  for (const scenario of plan.scenarios) {
    const device = mkDevice(`pr/${scenario.id}`);
    try {
      log(`execute ${scenario.id} on PR build`);
      const initial = await device.open(values.url);
      const run = await runScenario(model, device, ctx, scenario, initial, { maxTurns: Number(values["max-turns"]), maxUsd: Number(values["max-usd"]), maxScreenshots: 12, log });
      log(`  -> ${run.status}${run.blocker ? ` (${run.blocker})` : ""} · ${run.actions.length} akcji · ${run.usd.toFixed(3)} USD`);
      prRuns.push(run);
    } finally { await device.close(); }
  }

  // 4. replay on base build (differential)
  let baseRuns: ScenarioRun[] | null = null;
  if (values["base-url"]) {
    baseRuns = [];
    for (const run of prRuns) {
      const device = mkDevice(`base/${run.scenario.id}`);
      try {
        log(`replay ${run.scenario.id} on BASE build`);
        const initial = await device.open(values["base-url"]);
        baseRuns.push(await replayScenario(device, run, initial, log));
      } finally { await device.close(); }
    }
  }

  // 5. judge
  const verdicts = await judgeAll(model, plan, prRuns, baseRuns, { votes: Number(values.votes), evidenceDir: outDir, log, changeIntent: plan.change_intent });
  // 6. report
  const summary = writeReports({ ctx, plan, prRuns, baseRuns, ...verdicts, usage: model.usage, durationS: (Date.now() - t0) / 1000, platform, adapter: adapterName, model: modelName, outDir });
  log(`\n${fs.readFileSync(path.join(outDir, "report.md"), "utf8")}`);
  log(`\nVERDICT ${summary.verdict} · ${JSON.stringify(summary)}`);
  process.exit(summary.verdict === "failed" ? 2 : summary.verdict === "ready" || summary.verdict === "ready_with_issues" ? 0 : 3);
}

main().catch((e) => { console.error(e); process.exit(1); });

import fs from "node:fs";
import { VerificationPlan, type ImpactMap, type TaskContext } from "./types.js";
import type { ModelClient } from "./model.js";

const SYSTEM = `Jesteś Plannerem systemu Revlee: zamieniasz kontekst pull requesta i zadania na jawny, audytowalny plan weryfikacji wykonywany przez agenta na działającej aplikacji.

Twarde reguły:
1. Diff jest autorytatywny; opis PR jest tylko kontekstem. Nie akceptuj zachowania sprzecznego z kryteriami akceptacji tylko dlatego, że opis PR tak mówi.
2. Każde claimed_behavior MUSI mieć source_ref wskazujący istniejące kryterium akceptacji (np. "SHOP-412#ac:2"), hunk diffu ("pr:h1") lub linię opisu PR ("pr:body"). Zachowania wyprowadzone z diffu, których nie ma w tickecie, oznacz derived=true.
3. Każde kryterium akceptacji -> co najmniej jeden scenariusz, albo wpis w cannot_verify_via_ui z powodem.
4. Kroki scenariusza są w języku naturalnym, niezależne od platformy, bez refów (@e12) i współrzędnych. Maks. 12 kroków. Każdy krok ma expect_after: co ma być widoczne po kroku.
5. Orakula: preferuj a11y_assert (tekst widoczny/nieobecny, element po testID/roli/nazwie) zawsze gdy cecha jest widoczna w drzewie accessibility. vlm_rubric TYLKO dla cech niewidocznych w drzewie (kolor, układ, wykres). Każde orakulum ma at_step (po którym kroku oceniać) i expected_on_base: "absent" gdy element/tekst nie powinien istnieć na buildzie bazowym, "different" gdy wygląd ma się różnić, "same" gdy nic nie powinno się zmienić.
6. Każdy scenariusz ma co najmniej jedną kontrolę negatywną (negative_controls): coś, co musi NIE występować (np. tekst toasta przed akcją; brak nowego elementu na buildzie bazowym gdy compare_with_base=true).
7. Nie planuj akcji destrukcyjnych: płatności, usuwania konta, wysyłania wiadomości, ani niczego, co playbook zakazuje.
8. Używaj danych testowych i ścieżek nawigacji z playbooka i mapy ekranów.
Odpowiadaj wyłącznie obiektem JSON zgodnym ze schematem.`;

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
    "Zbuduj VerificationPlan. Identyfikatory kryteriów: użyj id z acceptance_criteria (AC1, AC2...). Scenariusze: S1, S2... Orakula: O1, O2... Kontrole negatywne: N1, N2...",
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

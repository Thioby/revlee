import { z } from "zod";

// ---------- Task context (input) ----------
export const AcceptanceCriterion = z.object({
  id: z.string(),
  text: z.string(),
  source_ref: z.string(),
  kind: z.enum(["visual", "behavior", "state"]).default("behavior"),
});
export const DiffHunk = z.object({
  id: z.string(),
  path: z.string(),
  patch: z.string(),
});
export const TaskContext = z.object({
  schema: z.literal("revlee.task_context/1").default("revlee.task_context/1"),
  pr: z.object({
    number: z.number(),
    title: z.string(),
    body_author: z.string().default(""),
    head_sha: z.string().default("local"),
    base_sha: z.string().default("local"),
    files: z.array(z.string()).default([]),
    diff_hunks: z.array(DiffHunk).default([]),
  }),
  tickets: z
    .array(
      z.object({
        id: z.string(),
        url: z.string().default(""),
        title: z.string(),
        description_md: z.string().default(""),
        acceptance_criteria: z.array(AcceptanceCriterion),
      }),
    )
    .default([]),
  repo_knowledge: z
    .object({
      playbook_md: z.string().default(""),
      screens: z
        .array(
          z.object({
            id: z.string(),
            files: z.array(z.string()).default([]),
            entry: z.array(z.string()).default([]),
            title_pattern: z.string().optional(),
          }),
        )
        .default([]),
    })
    .default({ playbook_md: "", screens: [] }),
  scope_hint: z.string().nullable().default(null),
});
export type TaskContext = z.infer<typeof TaskContext>;

// ---------- Impact map ----------
export const ImpactMap = z.object({
  screens: z.array(z.object({ id: z.string(), confidence: z.number(), why: z.array(z.string()), entry_path: z.array(z.string()) })),
  blast_radius: z.enum(["none", "local", "shared_component", "layout", "global"]),
  unmapped_files: z.array(z.string()),
});
export type ImpactMap = z.infer<typeof ImpactMap>;

// ---------- Verification plan (LLM output) ----------
export const Oracle = z.object({
  id: z.string(),
  type: z.enum(["a11y_assert", "vlm_rubric"]),
  covers: z.string().describe("criterion id (AC1, B2, ...)"),
  at_step: z.number().int().describe("step number after which the oracle is evaluated"),
  // a11y_assert
  assert: z
    .object({
      text_contains: z.string().nullable().default(null),
      text_absent: z.string().nullable().default(null),
      element: z
        .object({ role: z.string().nullable().default(null), name_contains: z.string().nullable().default(null), test_id: z.string().nullable().default(null), value_equals: z.string().nullable().default(null).describe("expected text/value of the element") })
        .nullable()
        .default(null),
      element_state: z.enum(["visible", "absent"]).nullable().default(null),
    })
    .nullable()
    .default(null),
  // vlm_rubric
  rubric: z.string().nullable().default(null),
  expected_on_base: z.enum(["same", "different", "absent"]).default("same"),
});
export const Step = z.object({
  n: z.number().int(),
  text: z.string().describe("Natural-language instruction, platform independent, no refs or coordinates"),
  expect_after: z.string().describe("What should be observable after the step"),
});
export const NegativeControl = z.object({
  id: z.string(),
  text: z.string(),
  assert: Oracle.shape.assert,
  at_step: z.number().int(),
  compare_with_base: z.boolean().default(false),
});
export const Scenario = z.object({
  id: z.string(),
  title: z.string(),
  covers: z.array(z.string()),
  preconditions: z.string().default(""),
  steps: z.array(Step).min(1).max(12),
  oracles: z.array(Oracle).min(1),
  negative_controls: z.array(NegativeControl).default([]),
});
export const VerificationPlan = z.object({
  change_intent: z.string(),
  claimed_behaviors: z.array(z.object({ id: z.string(), text: z.string(), source_ref: z.string(), derived: z.boolean().default(false) })),
  scenarios: z.array(Scenario).min(1),
  cannot_verify_via_ui: z.array(z.object({ criterion: z.string(), reason: z.string() })).default([]),
  notes: z.array(z.string()).default([]),
});
export type VerificationPlan = z.infer<typeof VerificationPlan>;
export type Scenario = z.infer<typeof Scenario>;
export type Oracle = z.infer<typeof Oracle>;

// ---------- Device layer ----------
export interface UiNode {
  ref: string; // "e12"
  role: string;
  name: string;
  testId?: string;
  value?: string;
  interactive: boolean;
}
export interface Observation {
  snapshotText: string; // agent-device style lines: # @e2 [button] "Add"
  nodes: UiNode[];
  fingerprint: string;
  title: string;
  screenshotPath?: string;
}

// ---------- Execution records ----------
export interface ActionRecord {
  scenario: string;
  step: number;
  ts: string;
  source: "agent" | "replay" | "mock";
  expectation: string | null;
  tool: string;
  input: Record<string, unknown>;
  before: { fingerprint: string; obs: number };
  after: { fingerprint: string; obs: number; screenshot?: string };
  model_calls: number;
  tokens_in: number;
  tokens_out: number;
  error?: string;
}
export interface ScenarioRun {
  scenario: Scenario;
  status: "completed" | "blocked" | "budget";
  observations: Observation[]; // index = obs id
  actions: ActionRecord[];
  stepObs: Record<number, number>; // step n -> observation index after step
  blocker?: string;
  usd: number;
}

// ---------- Verdicts ----------
export type VerdictValue = "pass" | "fail" | "inconclusive" | "unable_to_verify";
export interface CriterionVerdict {
  criterion_id: string;
  verdict: VerdictValue;
  oracle_type: string;
  confidence: number;
  evidence: { observation: number; detail: string; screenshot?: string }[];
  negative_controls: { id: string; result: VerdictValue; detail: string }[];
  judge_votes?: { model: string; verdict: VerdictValue; evidence: string }[];
  reason?: string;
}
export type RunVerdict = "ready" | "ready_with_issues" | "failed" | "inconclusive" | "unable_to_verify";

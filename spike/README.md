# Revlee spike (phase 0)

A minimal, working version of the loop from [docs/04](../docs/04-flow-pr-to-verdict.md): **PR + ticket context → plan → agent on a device → replay on the base build → oracles and judge → report**. The goal of the spike is to measure cost and accuracy before the MVP is built.

```
src/
  types.ts            schemas (TaskContext, VerificationPlan, Observation, verdicts)
  context.ts          context loading + a simple Impact Analyzer (files → screens)
  planner.ts          LLM Planner (structured output) + deterministic plan validator
  executor.ts         Executor: tool-use loop (observe/tap/type/wait_for/note_expectation/step_done),
                      a mock executor (no LLM) and scenario replay on the base build
  judge.ts            oracles: a11y_assert, pixel diff base vs PR (pixelmatch), VLM judge with voting,
                      negative controls, verdict aggregation
  report.ts           report.md (PR comment layout), verdicts.json, junit.xml, actions.ndjson
  device/types.ts     DeviceAdapter interface + screen fingerprint
  device/agentDevice.ts  adapter over the agent-device CLI (iOS / Android / web)
  device/playwright.ts   web adapter on Playwright (a11y snapshot in agent-device format)
sample-app/           test app "Acme Shop" with variants: ?variant=pr|base, &bug=toast-name|badge|color|theme-leak
fixtures/pr88/        TaskContext (PR + ticket SHOP-412 with 3 AC) and a ready-made plan for mock mode
bench/run.sh          micro-benchmark: 4 variants → verdict matrix
```

## Running without a model (`mock` mode)

```bash
cd spike && npm install && npm run build
bash bench/run.sh            # starts sample-app, runs 4 verifications, prints the verdict matrix
```

Expected result (measured 2026-10-14 in a Linux sandbox, Playwright/Chromium):

| variant | expected | verdict | failing AC |
|---|---|---|---|
| good | ready | ready | — |
| bug-toast (toast names the wrong product) | failed | failed | AC2 |
| bug-badge (counter does not increase) | failed | failed | AC3 |
| bug-color (CTA stays blue) | failed | failed | AC1 |

In mock mode the plan is loaded from a file, the executor is rule-based (it matches quoted names from the steps against the a11y snapshot), and the visual criterion AC1 is decided solely by the pixel diff against the base build. One run including the base comparison takes about 12 s.

## Running with a model

```bash
export ANTHROPIC_API_KEY=...          # or `ant auth login`
node sample-app/server.mjs 3077 &
node dist/cli.js verify \
  --context fixtures/pr88/task_context.json \
  --url "http://localhost:3077/?variant=pr&bug=toast-name" \
  --base-url "http://localhost:3077/?variant=base" \
  --model claude-opus-5-5 --votes 3 --out .revlee-run/real-1
bash bench/run.sh --model claude-opus-5-5
```

- Planner: `messages.parse` with a zod schema (`VerificationPlan`), effort `high`; the validator rejects plans without `source_ref`, without AC coverage, or with refs/coordinates in steps.
- Executor: manual tool-use loop on `client.beta.messages` with `fallbacks: "default"` (beta `server-side-fallback-2026-07-01`), effort `medium`, mandatory `note_expectation` before every mutating action, at most 2 images kept in context (older ones are removed), `--max-usd` / `--max-turns` budgets.
- Judge: `messages.parse` with a rubric, N votes, sees only observations (screenshots + a11y trees; images A/B/C: before, after, base). `pass` only when unanimous.
- Default model: `claude-opus-5-5` for every role (`--model`, `REVLEE_MODEL`); the target design uses separate models per role (docs/12).

> Model mode was not executed in the sandbox (no API key available). The code compiles against SDK 0.133 types, but the first run with a key should be treated as a test.

## agent-device (iOS / Android)

```bash
npm i -g agent-device@0.21.27
# iOS Simulator (Mac with Xcode): build the .app, install it, then:
node dist/cli.js verify --context fixtures/pr88/task_context.json --platform ios --adapter agent-device \
  --url com.acme.shop --base-url com.acme.shop.base --device <UDID> --model mock --plan fixtures/pr88/plan.mock.json
# Android emulator:
node dist/cli.js verify ... --platform android --url com.acme.shop --device emulator-5554
```

The `agentDevice.ts` adapter uses `open --relaunch --foreground`, `snapshot -i --force-full --json`, `press/fill/scroll --settle`, `wait text|absent`, `screenshot <path>`, `close`, always with `--session` and `--platform`. It parses JSON (`data.nodes`) or text lines `@e12 [button] label="..."`. The grammar was verified with `agent-device help <cmd>` (0.21.27); **driving a real simulator/emulator was not tested in the sandbox** (no Xcode/KVM). The agent-device web backend requires Node ≥ 24 and downloads Chromium from googlechromelabs (blocked in the sandbox), hence the Playwright adapter for web.

## What the spike confirms (and what it does not)

Confirmed:
- The data contract from the documentation (TaskContext → ImpactMap → VerificationPlan → Observation/ActionRecord → CriterionVerdict) is implementable and sufficient.
- Deterministic oracles on the a11y tree plus a pixel diff against base produce the correct verdict matrix without any model; the VLM judge is only needed for visual properties, and even there it is just one of the votes.
- Semantic replay (role/name/testID) of the same steps on the base build works and yields negative controls "for free".
- The PR-comment-style report (table AC → verdict → oracle → evidence → confidence, negative controls, JSON footer) is generated from the evidence.

Not confirmed (next steps of phase 0):
1. Quality and cost of Planner/Executor/Judge with a real model (`bash bench/run.sh --model claude-opus-5-5`); target: 4/4, ≤ 2 USD per run.
2. agent-device on iOS Simulator and Android Emulator on a Mac (adapter + boot time measurements).
3. A richer benchmark: 10 historical PRs plus mutations, including a PR without AC (`diff_driven` mode) and a PR with a regression on another screen (smoke).
4. Step cache between pushes and `handed_off` on drift (today replay exists only for the base build).

# 13 · Roadmap, risks, and metrics

## 1. Phases

### Phase 0 · Spike (2–3 weeks)
Goal: confirm that the loop works on a single Mac.
- Manual `pull_request` workflow on a runner on the host (trusted PRs).
- Android emulator arm64 + agent-device + Claude Agent SDK; plan from the diff + GitHub Issue (`Closes #N`); judge with 1 vote; PR comment with screenshots (`gh --attach`).
- Measurements: emulator/simulator boot time, build time, cost per PR, accuracy on 10 real PRs from the repo history (including 3 with a deliberately injected bug).
- Output: go/no-go decision and budget calibration.

### Phase 1 · MVP (6–8 weeks)
- Packages: `@revlee/cli`, `@revlee/context` (github, jira), `@revlee/impact` (RN/Expo + Next.js), `@revlee/planner`, `@revlee/device` (android, web), `@revlee/judge`, `@revlee/report`.
- Oracle hierarchy 1–4 without differential comparison; negative controls on the PR build (absence of old texts).
- Idempotent comment + JUnit + artifacts; check run via GitHub App.
- Read-write step cache in artifacts; replay for repeated pushes.
- `revlee init/doctor/verify/plan/report`, `examples/` workflows.
- Infra: 1 Linux KVM (ARC or a single runner), 1 Mac for iOS builds (no iOS verification).

### Phase 2 · Parity with Revyl and beyond (8–12 weeks)
- iOS Simulator (agent-device + simctl) in an ephemeral VM (Tart/Cilicon), pool of 2 VMs.
- Differential comparison base vs PR (odiff, intended/unintended classification), smoke from the blast radius.
- Linear, PR template, Figma as an auxiliary oracle.
- App Map (SQLite→Postgres), `revlee map explore/open/diff`, `screens.yaml` scaffold.
- Judge voting with two model families, calibration on negative controls, 👍/👎.
- `explore` and `regression_only` modes (`.ad` scripts), integration with tester-army/e2e as a regression runner.
- `pull_request`/`workflow_run` separation for forks; per PR/repo budgets.
- Local grounding (UI-TARS) and an executor on a local model as an option.

### Phase 3 · Scale and product (ongoing)
- `revlee-app`: webhooks, device queue, dashboard, live device preview.
- Physical devices via Appium/agent-device (physical iOS/Android).
- Flutter/native iOS/Android in the Impact Analyzer.
- Export of scenarios to Maestro YAML; import of existing Maestro flows as smoke.
- Training the Planner on history (`plan_error`, 👎), personalized `REVIEW.md`-like team rules.

## 2. Success criteria (metrics)

| Metric | Target after phase 1 | Target after phase 2 |
|---|---|---|
| Time PR → verdict (p50 / p95) | 12 / 25 min | 8 / 18 min |
| LLM cost per PR (p50) | ≤ 3 USD | ≤ 2 USD |
| False `pass` on the set of PRs with an injected bug (n ≥ 30) | ≤ 10 % | ≤ 3 % |
| False `fail` (correct PRs marked `failed`) | ≤ 10 % | ≤ 5 % |
| Share of `unable_to_verify` due to infra/setup causes | ≤ 15 % | ≤ 5 % |
| Step cache hit rate on the 2nd push | ≥ 40 % | ≥ 70 % |
| 👍 / (👍+👎) on findings | ≥ 70 % | ≥ 85 % |
| AC covered by a scenario (when AC exist) | ≥ 90 % | ≥ 95 % |

Evaluation set: `revlee-bench` — 30–50 historical team PRs + mutations (wrong color, missing toast, regression on another screen, crash), run nightly; results in `revlee stats`. This is also the answer to the lack of public benchmarks for agentic UI verification.

## 3. Risks and mitigations

| Risk | Prob. | Impact | Mitigation |
|---|---|---|---|
| VLM judge gives false `pass` (benchmarks ~70 % precision) | high | high | oracle hierarchy, voting, negative controls, `pass` only with evidence; FP metric in the bench |
| Build time blows the 10-minute budget | medium | medium | remote cache, build once per SHA, native build reuse, pre-warmed images; the report shows build time separately |
| Simulator boot on Xcode 27 "a few minutes" | medium | medium | pre-boot in a VM snapshot, version pinning, alternatively Xcode 26 |
| API churn of building blocks (agent-device 0.x, e2e pre-1.0) | high | medium | adapters with pinned versions, adapter contract tests in Revlee CI |
| Limit of 2 macOS VMs | certain | medium | more Macs; bare host for trusted PRs; Android/web priority in the queue |
| Prompt injection from the screen/ticket | medium | high | isolation, allow-lists, no tools beyond the device, reporting; red-team in the bench |
| No AC in the team's tickets | high | medium | `diff_driven` mode + request for AC in the PR; context quality metric |
| Cost grows with the number of pushes | medium | medium | replay, skipping non-UI, daily budgets, `effort: light` for drafts |
| Flaky devices (timeouts, ANR) | medium | medium | `infra/flaky` triage, 1 retry, neutral check run, metric |
| Team trust after a few wrong verdicts | medium | high | `gating: neutral` to start, full visibility of evidence and "not verified", 👍/👎 |
| `gh --attach` does not work with an App token | medium | low | fallback to S3 links / job with a user token |

## 4. Open decisions (to be settled in phase 0)

1. Agent-device vs mobile-mcp as the default Android adapter (compare snapshot stability on 3 apps).
2. Whether the executor defaults to Sonnet 5.5 or Haiku 5.5 (quality vs cost on the bench).
3. Whether to commit the step cache to the repo (visibility) or keep it in a database (less noise in the PR).
4. Whether to create the check run via a GitHub App from the MVP, or start with a comment + commit status.
5. Postgres from the start or SQLite in artifacts (depends on the number of repos).

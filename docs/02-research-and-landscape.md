# 02 · Research and market landscape (as of 2026-10-14)

This chapter summarizes five research threads (full notes with citations: [`research_notes/`](../research_notes/agentic-pr-verification-vs-revyl/)). It answers three questions: how exactly Revyl works, whether something like it already exists in open source, and which building blocks it can be built from.

## 1. How Revyl works (verified against sources and the `revyl-cli` code)

Revyl has three PR verification paths:

| Path | Mechanism | Who plans |
|---|---|---|
| **A. GitHub App + "Proof of Changes"** (GA 2026-09-04) | Configuration in `.revyl/config.yaml` (`pr_review.proof_of_changes.{enabled, harness.kind, system_prompt, always_verify[]}`). The Revyl agent gets a one-time checkout of the PR in a sandbox and an API key minted for that single PR, installs the build on a cloud simulator/emulator, "clicks through" the diff, and publishes a single comment (overwritten after every push) via the hidden command `revyl proof comment <md> [--problem\|--blocked]`. | Hosted Revyl agent (model undisclosed) or Cursor Cloud Agent |
| **B. BYO-CI + coding agent** | CI uploads the build (`revyl build upload --version <sha>`), Claude Code Action / Cursor Automation matches the build to the SHA, starts a device (`revyl device start --build-version-id`), drives `revyl device tap --target "description"`, publishes `## Revyl device proof`. | Claude Code / Cursor with a `CLAUDE.md` playbook |
| **C. CLI regression** | `RevylAI/revyl-gh-action` (`run-test`, `run-workflow`, `upload-build`), saved YAML tests. | None (fixed tests) |

Key design facts:

- **Context:** the diff is authoritative, the PR description is a "limited fragment of the author-written part" used only as context. **No Jira/Linear, no Figma in proof** (Figma exists as a separate skill that compares against Atlas).
- **Verdicts** (since 2026-09-18): `Ready | Ready with polish | Ready with issues | Failed | Inconclusive`, confidence 1/5–5/5, problems as annotation threads in Atlas (`revyl report annotations create --severity blocker|issue|polish`, anchored to screenshot coordinates). "Claimed ready outcome still requires a recorded device session." The proof verdict **does not set a GitHub check**; only a failed managed build can produce a failing check.
- **Execution:** vision-first: capture → ground (a VLM grounding model returns coordinates for a natural-language target) → act (UIAutomator2/XCTest) → verify (a VLM evaluates the new screenshot). A11y trees deemed "unreliable on production apps". The vendor admits: "vision models hallucinate coordinates", higher cost.
- **Atlas:** a knowledge graph of the application built from every run: screens (clusters with variants), transitions (with video intervals), product areas, "heat", annotation threads. CLI `revyl atlas brief|graph|search|screen|neighbors|edge`.
- **Evidence per run:** video, step timeline, AI summary, action results from `/reasoning`, screenshots, logs, network (JSON), CPU/FPS/memory (+Perfetto), device state snapshots (`device state snapshot|diff`, `sqlite`, `userdefaults`), no-login link.
- **Tests:** YAML with blocks `instructions | validation | extraction | manual | code_execution | module_import | if | while`, natural-language payload; `revyl test create --from-session`.
- **Determinism:** simulators wiped between runs, `auth_bypass` deep link, launch args, `--retries`, stability classification, triage skill `REAL BUG | FLAKY TEST | INFRA | SETUP | TEST IMPROVEMENT`. No caching of agent steps between pushes (every push = full execution).
- **Devices:** exclusively cloud iOS simulators (18.5–27.0) and Android emulators (only Pixel 7/Android 14 in the targets file). No physical devices. No web.
- **Pricing:** Free; Starter 250 USD/month (3 parallel devices); Team Pro 750 USD/month (10); Enterprise. **No self-hosted.**
- **Open source from Revyl (MIT):** `revyl-cli` (Go, MCP server, skills, OpenAPI with 159 endpoints), `greenlight` (App Store/Play compliance scanner), `mobile-devtools` (templates: `mobile-pr-reviewer`, `visual-regression` with 0.1 % threshold, `figma-design-checker`, `app-explorer` BFS). The device cloud, grounding models, Atlas backend, and proof orchestrator are closed.

Criticism (mainly from competitors and the vendor itself): simulators only, mobile only, proprietary YAML without export, no ticket integration, the explorer gets lost after ~50 screens, video URLs expire after an hour, no HN/Reddit discussion (small customer base, ~5-person team).

## 2. Does the full system already exist in open source?

**No.** No OSS project implements the full loop "ticket/AC + diff → plan → run the application → evidence in GitHub". The closest fragments:

| Project | What it does | What is missing |
|---|---|---|
| `RevylAI/mobile-pr-reviewer` (MIT, 5★) | Claude Code Action + Revyl cloud: reads the diff, one-sentence hypothesis, reactive screenshot→tap loop, link to the recording | No ticket, no plan, no check run, requires the Revyl cloud |
| `ACHultman/pr-qa-copilot` (MIT) | Finds the preview URL via the Deployments API, runs hand-written Playwright journeys, one idempotent comment + artifact | No agent, no AC |
| `anthropics/claude-code-action` | Runs Claude Code in Actions, MCP via `--mcp-config`, tool gating `--allowedTools mcp__<server>__<tool>` | Comments only, no formal reviews/checks, no device example |
| `/verify` skills (Claude Code), Shiplight `verify`, OpenHands `qa-changes`, Playwright Test Agents (planner/generator/healer) | Local verification of changes by an agent | No PR→ticket→evidence loop |
| SWE-Review (arXiv 2607.06065) | Reviewer agent "issue + PR → accept/reject" | Code only, without running the application |

Coding agents verify **their own** PRs (Copilot: Playwright MCP + screenshots in the PR since 07.2025; Devin: "Test the app" mode with an annotated recording; Codex: in-app browser on localhost; Claude Code: `/verify`), but nobody offers an independent verifier of an arbitrary PR against a ticket.

Commercially, the web pattern has stabilized: GitHub App + preview detection (Vercel/Netlify/…) + plan from title/description/diff + a real browser + comment/review updated in place (QA.tech, TesterArmy, Autonoma, Momentic, QA Wolf, Checksum, Greptile TREX, Meticulous). **QA.tech** is the only one that claims to fetch the linked Jira/Linear ticket and to require every test to cite a diff hunk. For mobile, only Revyl has an agentic on-device loop; Maestro Cloud is scripts.

The most concrete lessons about failure modes (Cognition, May 2026): the agent **over-tests unrelated areas**, **hallucinates paths in the application that do not exist** (without grounding in the code), and **"lies less" when it has to declare an expectation before acting**; results per assertion: passed/failed/untested.

## 3. Open source building blocks for Revlee

### 3.1 Device control and perception

| Building block | License / version | Role in Revlee | Notes |
|---|---|---|---|
| **callstack/agent-device** | MIT, 0.21.27 (2026-10-12), ~5k★ | Primary iOS Simulator / Android / web driver for the agent: a11y snapshots with refs (`@e2 [button] "Add"`), diffs after an action (`--settle`), `screenshot --overlay-refs`, `record start/stop` (MP4 with touch overlay), `trace`, `logs`, `network dump`, `perf`, `.ad` scripts for replay, MCP (`agent-device mcp`) | No built-in NL assertion (our Judge does that). Used by Expensify, Shopify, JPMC |
| **mobile-next/mobile-mcp** + `mobilewright` | Apache-2.0, 1.0.10 / 0.0.65 | Alternative mobile stack: 36 `mobile_*` tools, Playwright-style API with retrying `expect`, JUnit/HTML | The `mobilecli` layer is under FSL-1.1 (source-available) |
| **Playwright + @playwright/mcp** | Apache-2.0, 0.0.83 | Web: a11y snapshot, `browser_verify_*` (`--caps=testing`), trace.zip, video, `browser_mouse_*_xy` (`--caps=vision`) | "Not a security boundary", `browser_run_code_unsafe` = RCE |
| **appium/appium-mcp** | Apache-2.0, 1.97.1 | Optional adapter for physical devices / existing Appium | XML page source |
| **Maestro** | Apache-2.0, 2.11.0 | Export of scenarios to Maestro YAML (`agent-device --maestro`), `maestro hierarchy` | `assertWithAI` has known false negatives; MCP shares port 22087 between simulators (bug #3611) |

### 3.2 Test framework with cache/replay

**tester-army/e2e** (Apache-2.0, 0.20.0, 10.3k★, pre-1.0) is the only OSS mobile+web framework with a documented cache of verified agent steps: an `agent.act` step saved as JSON (targets by role/name/testId + end-state checks, no screenshots), replay without model calls, modes `read-write | read-only (CI) | off`, `--strict-cache` → `REPLAY_STALE` exit 2, report `report.json` + `junit.xml` + `trace.md` + PNG/MP4, reporter `@e2e-dev/github`. Assertions (`agent.assert`, `vision: true | 'only'`) always call the model. Known problems: key-format churn invalidated committed recordings (#938), `assert/waitFor/extract` ignore the cache.

**Decision:** Revlee uses e2e as an **optional runner for regression scenarios** (phase 2), but builds its own PR verification loop directly on agent-device/Playwright + Claude Agent SDK, because we need: a plan derived from AC, base vs PR comparison, our own oracle hierarchy, and a per-criterion report. We copy the step cache pattern (details in [08](08-executor-agent-and-oracles.md)).

### 3.3 Agent, models, integration

- **Claude Agent SDK / claude-code-action:** MCP via `mcpServers`/`--mcp-config`, gating with `allowedTools` (`mcp__device__*`), `PreToolUse` hooks with `permissionDecision: deny`, `--max-turns`, `--max-budget-usd`, OIDC instead of an API key in a secret. Fork-PR rules: base ref at root, PR head in `--add-dir pr-head`, secrets withheld on forks.
- **Computer use (Anthropic):** toolset `computer_toolset_20260801`, ~1,000–1,800 input tokens per screenshot, recommended 1280×720/1280×800, batch actions, Anthropic classifiers scan screenshots for prompt injection. Models: Fable 5.1, Opus 5.5, Sonnet 5.5, Haiku 5.5.
- **Benchmarks (for calibrating expectations):** OSWorld-Verified ~85–90 % (above the human 72 %), OSWorld 2.0 20–44 % at 25–76 USD/task; AndroidWorld ~85–87 %. Latency: 75–94 % of step time is the LLM call. Conclusion: short, well-specified flows (5–30 steps) are within reach; long explorations are not.
- **Judge (LLM-as-judge):** AgentRewardBench: the best judges reach ~70 % precision; Mobile-JudgeBench: "surface UI match" and "partial completion" errors; Gaming the Judge: merely changing the agent's narrative raises the VLM judge's false "pass" rate by up to 90 %. Mitigations with evidence: judgment from observations, not narrative; requirement to cite a specific snapshot (SmartSnap); unanimous voting across multiple samples (ZeroGUI); negative controls; deterministic oracles.
- **Differential verification:** RippleGUItester (2026) — change-driven tests run on the before and after versions, differences classified as intended/unintended relative to the intent; 26 new bugs in Firefox/Zettlr/JabRef/Godot. Testora, DiffTestGen similarly.
- **Pixel diff:** `odiff` (Zig, milliseconds, anti-aliasing, ignore regions, YIQ, server mode), `pixelmatch` (`threshold`, `includeAA`).

### 3.4 Infrastructure

- **GitHub:** self-hosted runners "almost never" for public repos; a fork can compromise a persistent runner. Mitigations: `--ephemeral`/JIT, VM per job, runner groups, OIDC, `workflow_run` for permission separation, never check out a fork under `pull_request_target`.
- **macOS:** license limit of **2 parallel macOS VMs per host** (VZErrorDomain 6). Tools: Tart (Cirrus), Cilicon (Trade Republic), Tartelet, runscaler. `xcrun simctl` covers boot/install/launch/screenshot/recordVideo/push/privacy/status_bar/root CA without Simulator.app. Memory ~4 GB per simulator (vendor). Xcode 27.1: known issue "initial simulator launch can take several minutes".
- **Android:** emulator 37.2.12; `-no-window -gpu swiftshader_indirect -noaudio -no-boot-anim`, Quick Boot "up to 10× faster", `-read-only` for N clones of a single AVD, 64 instances via `-port`, KVM (udev rule), `/dev/kvm` in K8s via device plugin. API 37 enforces 4 GB RAM.
- **Media in the PR:** `gh` ≥ 2.99.0 (2026-09-01) has `--attach` for PNG/JPEG/GIF/WebP/SVG/MP4/MOV/WebM in `gh pr comment` (requires push access). Actions artifacts require login; S3/MinIO for public links (trace viewer). Checks API: `output.summary/text` ≤ 65,535 characters, `annotations` ≤ 50/request, `images[]` with an external URL, requires a GitHub App with `checks:write`.
- **Build:** remote Gradle build cache 15→6 min; do not move the whole DerivedData (8 GB = 10 min); `eas build --local` without cache (better `expo prebuild` + native build); Expo fingerprint allows reusing the native build for JS-only changes.

## 4. Where Revlee can be better than Revyl

| Area | Revyl | Revlee |
|---|---|---|
| Hosting | Revyl cloud only | self-hosted, your Macs/Linux boxes, your S3 |
| Platforms | iOS sim, Android emu | + web (Playwright) |
| Task context | diff + fragment of the description | + GitHub Issues/Jira/Linear with AC, PR template, Figma (optional) |
| Plan | implicit (LLM on the fly) | explicit JSON: AC → scenario → oracle → evidence; visible in the report |
| Comparison | PR build only | base vs PR on the same flows, intended/unintended classification |
| Perception | vision-first | a11y-first, vision as fallback (cheaper, deterministic) |
| Judgment | VLM `validation` | oracle hierarchy, voting, negative controls, the Judge does not see the narrative |
| Verdict in GitHub | comment | comment + check run (optional gating) + JUnit |
| Missing context | the agent guesses | `unable_to_verify` with a code + question to the author about AC |
| Cost of subsequent pushes | full execution | replay of cached steps for untouched screens |
| Models | closed | any (Anthropic/OpenAI/local), separate model for planner/executor/judge |

## 5. Knowledge gaps (to be verified with our own measurements)

- No independent benchmarks of the accuracy and cost of agentic UI verification (vendor data only; Slack: 15–30 USD per agentic run, dominated by re-sending context; TestMu: ~20 % of Playwright-MCP runs take the same path).
- No measurements of Xcode 27 simulator / emulator 37.x boot time on specific hardware.
- Whether `gh pr comment --attach` works with `GITHUB_TOKEN` (installation token) in Actions, or requires OAuth/PAT.
- The exact layout of the Revyl GitHub App comment (docs blocked in the sandbox).

# 01 · Vision and goals

> Revlee is an open, self-hosted system in which an AI agent **verifies on its own whether a pull request correctly implements the task**, by running the application built from that PR (iOS, Android, web) on your own hardware and publishing a verdict with evidence directly in GitHub.

## 1. Problem

Code review answers the question "does this code look good?". It does not answer the question "after this change, does the application **do what the task asked for**?". Today a human fills that gap: pulls the branch, builds, clicks through, compares against the ticket. This is slow, inconsistent, and often skipped.

Revyl (YC F24) showed that an agent can do this work: it installs the PR build on a cloud device, "clicks through" the changed flows, and publishes a verdict (`Ready | Ready with polish | Ready with issues | Failed | Inconclusive`) with a session recording. It has hard limitations, however (details in [02-research](02-research-and-landscape.md)):

| Revyl limitation | Consequence |
|---|---|
| Revyl cloud only, no self-hosted | Data, builds, and recordings leave the company; cost 250–750 USD/month + credits |
| Mobile only (iOS simulators, Android emulators) | No web verification |
| Context = diff + fragment of the PR description | **No ticket (Jira/Linear/GitHub Issues)**, no acceptance criteria, no Figma in proof |
| Verdict is a comment, not a check | Hard to gate merges |
| No base vs PR comparison | The agent judges "does it look good", not "what changed" |
| Closed grounding/judge models | No control over cost or judgment quality |

## 2. Goal

Build a system **at least equivalent to Revyl, and better in the key places**, running on your own hardware and launched from GitHub Actions (self-hosted runner), fully open source.

### 2.1 Product goals

1. **Full task context.** The agent knows the diff, the PR description, the commits, *and* the linked task (GitHub Issue, Jira, Linear) with acceptance criteria, plus optionally Figma mockups. From this it builds an explicit, auditable verification plan.
2. **Traceability.** Every acceptance criterion has at least one assigned scenario, and every scenario has evidence (screenshot, accessibility tree, video, log). The report states explicitly what was checked, what was not, and why.
3. **Differential verification.** The same flows are executed on the base build and on the PR build. The agent evaluates the difference against the intent of the change, not just "does the screen look reasonable".
4. **Honest verdict.** Judgment based on a hierarchy of oracles (deterministic assertions → pixel diff → VLM judge with voting), with a separate `unable_to_verify` state and reason codes. The model never judges its own narrative.
5. **Native GitHub integration.** One idempotent comment with media (video/screenshots) + check run (`neutral` by default, `failure` when the team enables gating). Commands `/verify`, `/verify again`, `/verify "only the cart screen"`.
6. **Three platforms.** iOS Simulator, Android Emulator, web (Playwright). One device API for the agent.
7. **Memory of the application.** A graph of screens and transitions built from every run (the equivalent of Revyl Atlas), used to map diff → screen and for deterministic replay.

### 2.2 Non-functional goals

| Goal | Measure |
|---|---|
| Time PR → verdict | p50 ≤ 10 min, p95 ≤ 20 min for a typical UI PR (with a warm build cache) |
| LLM cost per PR | ≤ 5 USD typically, configurable hard limit (`budget.max_usd`) |
| False "pass" | No `pass` verdict without evidence from a deterministic oracle or a unanimous judge |
| Isolation | One job = one fresh device (VM/pod/AVD); PRs from forks never touch secrets |
| Model-agnostic | Anthropic (default), OpenAI, local models through a single interface |
| Zero vendor lock-in | Configuration in the repo (`.revlee/`), evidence in your S3/MinIO, application graph in your database |

## 3. Scope: MVP vs target

| Area | MVP (phase 1) | Target |
|---|---|---|
| Platforms | Android emulator + web | + iOS Simulator |
| Context | diff, PR body, GitHub Issues (`Closes #N`) | + Jira, Linear, Figma, PR template |
| Plan | LLM with diff + AC, JSON schema | + static impact analysis (import graph → screens) |
| Execution | step-by-step agent (a11y + screenshot) | + step cache/replay, self-healing |
| Oracles | a11y assertions + VLM judge | + pixel diff base vs PR, voting, negative control |
| Report | PR comment with AC table + media | + check run, annotations, dashboard |
| Infra | 1 Linux runner (KVM) + 1 Mac | VM pools (Tart), ARC, queue |

## 4. Design principles

1. **The diff is authoritative, the PR description is context.** We do not accept "odd" behavior just because the description claims it is intended (a principle taken from Revyl's prompts, confirmed by Cognition).
2. **Evidence before verdict.** "Ready" requires a recorded session on a device. No build = no verification; we do not guess.
3. **Hard controls > prompt.** Tool restrictions (MCP allow-list, PreToolUse hooks, read-only servers) are enforced on the tool side, not in the system prompt.
4. **The Judge sees observations, not narrative.** Judgment is based on screenshots/a11y trees and the expected result, never on what the agent *said* it did.
5. **Better `unable_to_verify` than guessing.** Every unverifiable state has a reason code and is visible in the report.
6. **Configuration as code.** Everything lives in `.revlee/` in the repo; a PR may change its own configuration, but the security sections are always read from the base branch.
7. **Compose from existing building blocks.** We do not write our own device driver or test framework if mature OSS exists (agent-device, mobile-mcp, Playwright, odiff, Claude Agent SDK).

## 5. Who it is for

- **Mobile/web teams with self-hosted CI** that cannot or do not want to send builds to a SaaS.
- **Teams using coding agents** (Claude Code, Codex, Cursor), where the volume of PRs outgrows the capacity for manual QA.
- **Teams with ticket discipline** (Jira/Linear) that want an automatic check of "was what the task asked for actually done".

## 6. What Revlee does not do

- It does not replace unit tests or deterministic E2E suites; it complements them (and can run them as oracles).
- It does not approve PRs. The verdict is a signal for a human and an optional required check.
- It does not test on physical devices in phase 1 (possible later via an Appium/STF adapter).
- It does not manage test-case management; it exports results to JUnit/JSON, which can be forwarded elsewhere.

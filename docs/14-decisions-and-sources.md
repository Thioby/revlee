# 14 · Architecture decision records (ADR) and sources

## 1. Decision register

| ID | Decision | Alternatives | Rationale |
|---|---|---|---|
| ADR-1 | Self-hosted on GitHub Actions with ephemeral runners | SaaS (Revyl), own webhook server from day one | user requirement; GitHub Actions provides a queue, secrets, artifacts; the App server only in phase 3 |
| ADR-2 | TypeScript/Node as the language | Go (like revyl-cli), Python (mobilerun) | the ecosystem of building blocks (agent-device, Playwright, e2e, MCP SDK, Agent SDK) is in TS |
| ADR-3 | agent-device as the main mobile adapter | mobile-mcp, Appium, Maestro, Argent | a11y-first with refs and diffs, evidence (MP4 with overlay, trace, network), `.ad` scripts for replay, MIT, active development; mobile-mcp as an alternative (mobilecli under FSL) |
| ADR-4 | Own verification loop instead of using tester-army/e2e as the engine | e2e as core | we need a plan from AC, base/PR comparison, our own oracle hierarchy, and a per-criterion report; e2e remains an optional regression runner; we copy the cache pattern |
| ADR-5 | A11y-first perception, vision as a fallback | vision-first (Revyl) | cheaper (no 1–1.8k tokens per screenshot), deterministic selectors for the cache; vision only for features invisible in the tree; research evidence: harness/grounding matters more than the model |
| ADR-6 | Verdict from the oracle hierarchy; the VLM judge does not see the agent's narrative | single VLM "validation" (Revyl) | AgentRewardBench, Mobile-JudgeBench, Gaming the Judge; Cognition: declare the expectation before the action |
| ADR-7 | Differential comparison base vs PR enabled by default | PR build only | RippleGUItester/Testora: differences classified against intent; distinguishes a regression from a plan error; negative control "for free" |
| ADR-8 | Explicit, cited plan published before execution | plan hidden inside the agent | auditability, reviewer reaction, stable scenario IDs for the cache, QA.tech's rule "every test cites a hunk" |
| ADR-9 | Ticket (Jira/Linear/GitHub) as the source of criteria | diff + PR description only (Revyl) | Revyl's main gap; Qodo/QA.tech show feasibility; traceability AC → evidence |
| ADR-10 | Idempotent comment + `neutral` check run by default | review with approve/decline, failure status | approve is a human decision; a neutral check builds trust (Claude Code Review pattern); gating optional |
| ADR-11 | `security/budget/gating` sections from the base branch, the rest from head | entire configuration from head (Revyl) | a PR cannot loosen its own constraints; it can change the plan/paths |
| ADR-12 | Media via `gh --attach`, evidence in S3/MinIO, artifacts as a copy | artifacts only | artifacts require login and do not embed; `--attach` since gh 2.99 |
| ADR-13 | Separate models for planner/executor/judge, two families in voting | one model | cost and independence of judgment |
| ADR-14 | App Map (screen graph) as persistent memory | no memory | mapping diff → screen, entry paths, replay, historical comparisons; Atlas equivalent without vendor lock-in |
| ADR-15 | No `Bash`/write access for the agent, hard controls in the MCP server | trusting the prompt | claude-code-action security.md, DBHub read-only precedent; defense in depth |

## 2. Glossary

| Term | Meaning |
|---|---|
| **AC** | acceptance criterion from the ticket |
| **TaskContext** | normalized input document (PR + ticket + repo knowledge) |
| **ImpactMap** | mapping diff → screens, anchors, blast radius |
| **VerificationPlan** | explicit plan: behaviors, scenarios, oracles, negative controls |
| **Oracle** | mechanism that decides pass/fail (a11y, state, visual diff, judge) |
| **Negative control** | a check that must yield "no" (absence of old text, base without the new element) |
| **Screen fingerprint** | hash of the normalized a11y tree; cache and App Map key |
| **Replay / heal / agent / blocked** | source of a step's execution |
| **App Map** | graph of screens and transitions built from runs (Revyl Atlas equivalent) |
| **Finding** | a finding outside the criteria verdict (`blocker | issue | polish`) |
| **`unable_to_verify`** | the honest "could not check" state with a reason code |

## 3. Sources

Full notes with citations (about 350 URLs) are in [`research_notes/agentic-pr-verification-vs-revyl/`](../research_notes/agentic-pr-verification-vs-revyl/):

- `revyl_deep_dive.md` — Revyl: docs, changelog, `revyl-cli`/`revyl-gh-action`/`mobile-devtools` code, pricing, critique.
- `agentic_testing_frameworks.md` — tester-army/e2e, agent-device (+ addendum from the replay/MCP docs), mobile-mcp, mobilerun, Maestro, Appium MCP, Playwright MCP, Midscene, Stagehand, Browser Use, Skyvern, UI-TARS, others.
- `pr_verification_systems.md` — existing PR verification systems (OSS and commercial), coding agents, GitHub mechanics (Checks API, media, forks).
- `device_infrastructure.md` — self-hosted runners, Tart/Cilicon, simctl, emulator, ARC/KVM, build cache, `gh --attach`, timings.
- `agent_architecture_patterns.md` — computer use, MCP/Agent SDK, plan generation from a diff, LLM-as-judge, cache/replay, security, report design.

Most important individual sources:
- Revyl docs: Proof of Changes, GitHub integration, Atlas, Reports; `RevylAI/revyl-cli` (`cmd/revyl/proof.go`, `internal/config/compiler.go`, `examples/cursor-automation/prove-mobile-pr/PROMPT.md`); `RevylAI/mobile-pr-reviewer`.
- `callstack/agent-device` README + `website/docs/docs/{agent-setup,replay-e2e}.md`; `tester-army/e2e` `docs/{cache,agent-steps,ci,mcp}.mdx`; `mobile-next/mobile-mcp`.
- Anthropic: computer use tool docs, Agent SDK MCP docs, Claude Code hooks, `claude-code-action` `docs/{configuration,security}.md`, Claude Code Review docs.
- GitHub docs: self-hosted runners, ARC, secure use, events, Checks API, `attaching-files-with-github-cli.md`; `ReactiveCircus/android-emulator-runner`; Android emulator CLI/snapshots; Apple WWDC20 "Become a Simulator expert"; `cirruslabs/tart`, `traderepublic/Cilicon`.
- Research: RippleGUItester (arXiv 2603.03121), Testora (2503.18597), AgentRewardBench (2504.08942), Mobile-JudgeBench (2608.11434), Gaming the Judge (2601.14691), OSWorld-Human (2506.16042), TRAP (2512.23128), AndroidWorld (2405.14573).
- Practice: Cognition "Verifying Agentic Development at Scale" (05.2026), QA.tech changelog (04.2026), Momentic auto-heal docs, Slack Engineering "Agentic testing", odiff README.

Methodological caveat: some pages (docs.revyl.com, docs.github.com, arxiv.org, playwright.dev, and others) were unavailable from the research sandbox; facts from them come from search engine snippets or from source code on GitHub and are marked as such in the notes.

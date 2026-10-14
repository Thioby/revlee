# 12 · Configuration, CLI, and user experience

## 1. `.revlee/config.yaml` (full schema with default values)

```yaml
version: 1
project:
  name: acme-shop
  platforms: [android, ios, web]          # order = priority under a constrained budget

triggers:
  on: [pull_request]                       # + issue_comment (/verify) always enabled
  paths: ["apps/mobile/**", "packages/ui/**"]
  skip_if_only: ["**/*.test.*", "docs/**", "**/*.md", ".github/**", "**/*.lock"]
  labels: ["!skip-verify"]                 # ! = exclude
  drafts: false
  forks: manual                            # manual | never
  allowed_bots: []
  allow_author_rerun: false

context:
  issue_tracker:
    kind: jira                             # github | jira | linear | none
    jira: { base_url: https://acme.atlassian.net, project_keys: [SHOP], ac_field: customfield_10042 }
    linear: { team_keys: [] }
  link_patterns: ["SHOP-\\d+", "Closes #(\\d+)"]
  pr_template_sections: ["Test plan", "Acceptance criteria"]
  figma: { enabled: false, frames: [] }     # frames: [{ screen: product, url: https://figma.com/file/…?node-id=… }]
  playbook: .revlee/playbook.md
  screens: .revlee/screens.yaml
  max_chars: { pr_body: 4000, ticket: 8000, diff: 60000 }

builds:
  android:
    command: "./gradlew :app:assembleDebug --build-cache"
    artifact: app/build/outputs/apk/debug/app-debug.apk
    package: com.acme.shop
  ios:
    command: "xcodebuild -workspace ios/App.xcworkspace -scheme App -configuration Debug -sdk iphonesimulator -derivedDataPath build/dd CODE_SIGNING_ALLOWED=NO build"
    artifact: build/dd/Build/Products/Debug-iphonesimulator/App.app
    bundle_id: com.acme.shop
  web:
    command: "npm run build"
    start: "npm run start -- --port 3000"
    url: http://localhost:3000             # or preview: { provider: vercel, bypass_secret: VERCEL_BYPASS }
  base:
    source: artifact-cache                 # artifact-cache | build | none
  reuse_native_when_js_only: true          # Expo fingerprint

app:
  launch_args: ["-UITestMode", "1"]
  launch_env: { E2E: "1" }
  auth_bypass:
    deep_link: "acme://e2e/auth?token=${E2E_TOKEN}"   # ${…} from Orchestrator secrets
  permissions: [notifications, location]
  reset_between_scenarios: deep_link       # deep_link (acme://e2e/reset) | reinstall | none
  network:
    mode: allowlist                        # allowlist | mock | passthrough
    allowed_hosts: ["api-test.acme.dev", "cdn.acme.dev"]
    mock_server: null                      # e.g. wiremock mappings dir

devices:
  android: { api: 35, image: google_apis, arch: x86_64, profile: pixel_7, locale: en-US }
  ios: { model: "iPhone 17", runtime: "iOS-27-0", locale: en-US, appearance: light }
  web: { browser: chromium, viewport: [1280, 800] }

verification:
  mode: ac_driven                          # ac_driven | diff_driven | explore | regression_only
  always_verify:
    - "The app launches to the Home screen without crashing"
    - "Login via auth bypass ends on the Home screen"
  base_comparison: true
  max_scenarios: 8
  smoke_screens_limit: 6
  vision_policy: auto                      # auto | minimal | always
  cache: { mode: read-write, strict: false, commit_to_repo: false }
  flows_dir: .revlee/flows                 # .ad scripts for replay (regression_only / smoke)
  ignore_regions: .revlee/ignore-regions.yaml

oracles:
  judge: { votes: 3, require_unanimous: true, models: [anthropic/claude-sonnet-5-5, anthropic/claude-sonnet-5-5, openai/gpt-5-4] }
  visual_diff: { tool: odiff, threshold_pct: 0.1, antialiasing: true }
  negative_controls: required               # required | optional

models:
  planner: anthropic/claude-sonnet-5-5
  executor: anthropic/claude-sonnet-5-5     # or anthropic/claude-haiku-5-5 for light
  judge: inherit                            # see oracles.judge.models
  grounding: null                           # e.g. local/ui-tars-1.5-7b (OpenAI-compatible endpoint)
  endpoints: { local: http://vllm.internal:8000/v1 }

budget:
  max_usd: 5
  max_turns: 80
  max_minutes: 15
  max_screenshots_to_model: 25
  per_pr_daily_max_usd: 20
  repo_monthly_max_usd: 600
  effort: standard                          # light | standard | thorough

report:
  comment: true
  check_run: { enabled: true, gating: neutral }
  include_agent_transcript: false
  junit: true
  html: true
  evidence:
    store: s3                               # artifact | s3
    bucket: acme-revlee-evidence
    prefix: revlee/
    public_base_url: https://evidence.acme.dev
    retention_days: 30
  media: attach                             # attach (gh --attach) | links | gif

security:                                   # always read from the base branch
  deny_actions: ["pay", "delete account", "send message"]
  allowed_link_schemes: ["acme://", "https://api-test.acme.dev"]
  redact_patterns: ["\\b\\d{16}\\b", "[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}"]
```

`revlee config validate` checks the schema and publishes errors in the PR (just as Revyl validates `.revyl/config.yaml` in a PR that changes the configuration).

## 2. The `revlee` CLI

| Command | Description |
|---|---|
| `revlee init` | creates `.revlee/` (config, playbook draft, screens scaffold), GitHub workflows, `.mcp.json` |
| `revlee doctor` | checks Xcode/Android SDK/KVM/agent-device/gh/odiff/model keys |
| `revlee verify --pr 88 [--platform android] [--artifact app.apk] [--base-artifact …] [--scope "…"] [--mode …] [--no-cache] [--dry-run]` | full run; `--dry-run` stops after the plan |
| `revlee plan --pr 88` | only TaskContext + ImpactMap + VerificationPlan (preview the plan locally) |
| `revlee context --pr 88` | shows the collected context (tracker debugging) |
| `revlee device start|stop|install|screenshot|snapshot|record …` | manual device control (developer) |
| `revlee run-scenario plan.json S1 --platform ios` | run a single scenario locally with a live preview |
| `revlee judge evidence/<run>` | re-judge existing evidence (e.g. with a different model) |
| `revlee report evidence/<run> --format md\|html\|junit\|json` | regenerate the report |
| `revlee map explore --platform android --budget 40` | BFS exploration feeding the App Map |
| `revlee map open \| diff <shaA> <shaB> \| scaffold` | preview/graph, differences, `screens.yaml` generation |
| `revlee cache ls \| stats \| gc \| clear` | step cache management |
| `revlee flows record --platform ios --out .revlee/flows/checkout.ad` | record an agent-device script for regression |
| `revlee stats [--since 30d] [--prom]` | metrics: cost, time, verdicts, cache hit, 👍/👎 |
| `revlee config validate \| migrate` | schema validation and migration |

Every command has `--json`. Exit codes: `0` ok/ready, `1` tool error, `2` verdict `failed` (for CI gating), `3` `unable_to_verify`.

## 3. MCP servers (for developers and coding agents)

Revlee exposes the same capabilities locally in Claude Code / Cursor / Codex:
```bash
claude mcp add revlee -- npx -y @revlee/cli@<version> mcp
```
Tools: `revlee_plan_pr`, `revlee_verify_pr` (runs a run locally), `revlee_device_*` (like `revlee-device`), `revlee_map_query`, `revlee_report_open`. The `revlee-verify` skill (`npx skills add <org>/revlee`) teaches the agent: "before opening a PR, run `revlee verify --pr` locally and include a link to the report in the description". This closes the loop: the coding agent writes code → verifies it with the same engine → the maintainer sees the same report format in the PR.

## 4. GitHub Actions workflow (trusted PRs, simple variant)

```yaml
name: revlee
on:
  pull_request: { types: [opened, synchronize, reopened, ready_for_review] }
  issue_comment: { types: [created] }
permissions: { contents: read, pull-requests: write, checks: write, actions: write, id-token: write, issues: read }
concurrency: { group: revlee-${{ github.event.pull_request.number || github.event.issue.number }}, cancel-in-progress: true }
jobs:
  gate:
    runs-on: ubuntu-latest
    outputs: { run: ${{ steps.g.outputs.run }}, platforms: ${{ steps.g.outputs.platforms }} }
    steps:
      - uses: actions/checkout@v6
      - id: g
        run: npx -y @revlee/cli@1 gate --event "$GITHUB_EVENT_PATH" >> "$GITHUB_OUTPUT"
  verify:
    needs: gate
    if: needs.gate.outputs.run == 'true'
    strategy: { matrix: { platform: ${{ fromJson(needs.gate.outputs.platforms) }} } }
    runs-on: ${{ matrix.platform == 'ios' && fromJson('["self-hosted","macos","revlee"]') || fromJson('["self-hosted","linux","kvm","revlee"]') }}
    timeout-minutes: 25
    env:
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
      OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
      JIRA_TOKEN: ${{ secrets.JIRA_TOKEN }}
      E2E_TOKEN: ${{ secrets.E2E_TOKEN }}
      REVLEE_S3_KEY: ${{ secrets.REVLEE_S3_KEY }}
      REVLEE_APP_PRIVATE_KEY: ${{ secrets.REVLEE_APP_PRIVATE_KEY }}   # GitHub App for check runs
      GH_TOKEN: ${{ github.token }}
    steps:
      - uses: actions/checkout@v6
        with: { fetch-depth: 0 }
      - run: npx -y @revlee/cli@1 verify --pr ${{ github.event.pull_request.number || github.event.issue.number }} --platform ${{ matrix.platform }}
      - uses: actions/upload-artifact@v4
        if: always()
        with: { name: revlee-${{ matrix.platform }}-${{ github.sha }}, path: .revlee-run/, retention-days: 14, compression-level: 0 }
```

The variant with `pull_request` → `workflow_run` separation (forks) is in [10 §2](10-security-costs-limits.md); ready-made files are in [`examples/`](../examples/).

## 5. Developer experience

**PR author:**
1. Opens a PR with `Closes SHOP-412`. Within ~1 min they see a comment "⏳ plan: 3 criteria…" and can react (`/verify "skip smoke"`).
2. After ~8 min: a verdict with thumbnails and video. On `fail` they get "Expected/Observed/How to reproduce" and an `.ad` script that reproduces the bug locally: `agent-device replay fail-S1.ad`.
3. Pushes a fix: steps outside the changed screens are replayed, the report updates in place.

**Reviewer:** reads the criteria table, clicks the evidence next to a questionable AC, rates 👍/👎. The check run in the PR says whether Revlee considers the PR ready; knowing what was **not** checked is equally visible.

**QA/PM team:** `revlee map open` shows the app map; a ticket without AC is flagged in the PR, which raises ticket quality; `revlee stats` gives cost and accuracy.

**Coding agent (Claude Code/Codex):** the same engine locally via MCP/skill; the result of local verification is pasted into the PR description; Revlee in CI confirms independently.

## 6. Dashboard (phase 3, optional)

`revlee-app` (GitHub App + UI): list of runs, filters by verdict/cost, evidence player (the same `report.html`), interactive App Map, judge calibration (👍/👎 vs verdict), device queue, budgets. Without the dashboard everything works from comments, check runs, and `report.html` in S3.

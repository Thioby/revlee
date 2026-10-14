# 12 · Konfiguracja, CLI i doświadczenie użytkownika

## 1. `.revlee/config.yaml` (pełny schemat z wartościami domyślnymi)

```yaml
version: 1
project:
  name: acme-shop
  platforms: [android, ios, web]          # kolejność = priorytet przy ograniczonym budżecie

triggers:
  on: [pull_request]                       # + issue_comment (/verify) zawsze włączone
  paths: ["apps/mobile/**", "packages/ui/**"]
  skip_if_only: ["**/*.test.*", "docs/**", "**/*.md", ".github/**", "**/*.lock"]
  labels: ["!skip-verify"]                 # ! = wyklucz
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
    url: http://localhost:3000             # lub preview: { provider: vercel, bypass_secret: VERCEL_BYPASS }
  base:
    source: artifact-cache                 # artifact-cache | build | none
  reuse_native_when_js_only: true          # Expo fingerprint

app:
  launch_args: ["-UITestMode", "1"]
  launch_env: { E2E: "1" }
  auth_bypass:
    deep_link: "acme://e2e/auth?token=${E2E_TOKEN}"   # ${…} z sekretów Orchestratora
  permissions: [notifications, location]
  reset_between_scenarios: deep_link       # deep_link (acme://e2e/reset) | reinstall | none
  network:
    mode: allowlist                        # allowlist | mock | passthrough
    allowed_hosts: ["api-test.acme.dev", "cdn.acme.dev"]
    mock_server: null                      # np. wiremock mappings dir

devices:
  android: { api: 35, image: google_apis, arch: x86_64, profile: pixel_7, locale: pl-PL }
  ios: { model: "iPhone 17", runtime: "iOS-27-0", locale: pl-PL, appearance: light }
  web: { browser: chromium, viewport: [1280, 800] }

verification:
  mode: ac_driven                          # ac_driven | diff_driven | explore | regression_only
  always_verify:
    - "Aplikacja startuje do ekranu Home bez crasha"
    - "Logowanie przez auth bypass kończy się na ekranie Home"
  base_comparison: true
  max_scenarios: 8
  smoke_screens_limit: 6
  vision_policy: auto                      # auto | minimal | always
  cache: { mode: read-write, strict: false, commit_to_repo: false }
  flows_dir: .revlee/flows                 # skrypty .ad do replaya (regression_only / smoke)
  ignore_regions: .revlee/ignore-regions.yaml

oracles:
  judge: { votes: 3, require_unanimous: true, models: [anthropic/claude-sonnet-5-5, anthropic/claude-sonnet-5-5, openai/gpt-5-4] }
  visual_diff: { tool: odiff, threshold_pct: 0.1, antialiasing: true }
  negative_controls: required               # required | optional

models:
  planner: anthropic/claude-sonnet-5-5
  executor: anthropic/claude-sonnet-5-5     # lub anthropic/claude-haiku-5-5 dla light
  judge: inherit                            # patrz oracles.judge.models
  grounding: null                           # np. local/ui-tars-1.5-7b (OpenAI-compatible endpoint)
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

security:                                   # zawsze czytane z gałęzi bazowej
  deny_actions: ["zapłać", "pay", "usuń konto", "delete account", "wyślij", "send message"]
  allowed_link_schemes: ["acme://", "https://api-test.acme.dev"]
  redact_patterns: ["\\b\\d{16}\\b", "[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}"]
```

`revlee config validate` sprawdza schemat i publikuje błędy w PR (jak Revyl waliduje `.revyl/config.yaml` w PR-ze zmieniającym konfigurację).

## 2. CLI `revlee`

| Komenda | Opis |
|---|---|
| `revlee init` | tworzy `.revlee/` (config, playbook szkic, screens scaffold), workflowy GitHub, `.mcp.json` |
| `revlee doctor` | sprawdza Xcode/Android SDK/KVM/agent-device/gh/odiff/klucze modeli |
| `revlee verify --pr 88 [--platform android] [--artifact app.apk] [--base-artifact …] [--scope "…"] [--mode …] [--no-cache] [--dry-run]` | pełny run; `--dry-run` kończy po planie |
| `revlee plan --pr 88` | tylko TaskContext + ImpactMap + VerificationPlan (podgląd planu lokalnie) |
| `revlee context --pr 88` | pokazuje zebrany kontekst (debug trackera) |
| `revlee device start|stop|install|screenshot|snapshot|record …` | ręczne sterowanie urządzeniem (deweloper) |
| `revlee run-scenario plan.json S1 --platform ios` | wykonaj jeden scenariusz lokalnie z podglądem |
| `revlee judge evidence/<run>` | ponowny osąd istniejących dowodów (np. innym modelem) |
| `revlee report evidence/<run> --format md\|html\|junit\|json` | regeneracja raportu |
| `revlee map explore --platform android --budget 40` | eksploracja BFS zasilająca App Map |
| `revlee map open \| diff <shaA> <shaB> \| scaffold` | podgląd/graf, różnice, generacja `screens.yaml` |
| `revlee cache ls \| stats \| gc \| clear` | zarządzanie cache kroków |
| `revlee flows record --platform ios --out .revlee/flows/checkout.ad` | nagranie skryptu agent-device do regresji |
| `revlee stats [--since 30d] [--prom]` | metryki: koszt, czas, werdykty, cache hit, 👍/👎 |
| `revlee config validate \| migrate` | walidacja i migracja schematu |

Każda komenda ma `--json`. Kody wyjścia: `0` ok/ready, `1` błąd narzędzia, `2` werdykt `failed` (dla gatingu w CI), `3` `unable_to_verify`.

## 3. Serwery MCP (dla developerów i coding-agentów)

Revlee udostępnia te same możliwości lokalnie w Claude Code / Cursor / Codex:
```bash
claude mcp add revlee -- npx -y @revlee/cli@<version> mcp
```
Narzędzia: `revlee_plan_pr`, `revlee_verify_pr` (uruchamia run lokalnie), `revlee_device_*` (jak `revlee-device`), `revlee_map_query`, `revlee_report_open`. Skill `revlee-verify` (`npx skills add <org>/revlee`) uczy agenta: „przed otwarciem PR-a uruchom `revlee verify --pr` lokalnie i dołącz link do raportu w opisie”. To zamyka pętlę: coding agent pisze kod → weryfikuje tym samym silnikiem → maintainer widzi ten sam format raportu w PR.

## 4. Workflow GitHub Actions (zaufane PR-y, wariant prosty)

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
      REVLEE_APP_PRIVATE_KEY: ${{ secrets.REVLEE_APP_PRIVATE_KEY }}   # GitHub App do check runów
      GH_TOKEN: ${{ github.token }}
    steps:
      - uses: actions/checkout@v6
        with: { fetch-depth: 0 }
      - run: npx -y @revlee/cli@1 verify --pr ${{ github.event.pull_request.number || github.event.issue.number }} --platform ${{ matrix.platform }}
      - uses: actions/upload-artifact@v4
        if: always()
        with: { name: revlee-${{ matrix.platform }}-${{ github.sha }}, path: .revlee-run/, retention-days: 14, compression-level: 0 }
```

Wariant z separacją `pull_request` → `workflow_run` (forki) w [10 §2](10-bezpieczenstwo-koszty-limity.md); gotowe pliki w [`examples/`](../examples/).

## 5. Doświadczenie developera

**Autor PR-a:**
1. Otwiera PR z `Closes SHOP-412`. W ciągu ~1 min widzi komentarz „⏳ plan: 3 kryteria…”, może zareagować (`/verify "pomiń smoke"`).
2. Po ~8 min: werdykt z miniaturami i wideo. Przy `fail` ma „Oczekiwane/Zaobserwowane/Jak odtworzyć” i skrypt `.ad`, który odtwarza błąd lokalnie: `agent-device replay fail-S1.ad`.
3. Pushuje poprawkę: kroki poza zmienionymi ekranami replayują się, raport aktualizuje się w miejscu.

**Recenzent:** czyta tabelę kryteriów, klika dowód przy wątpliwym AC, ocenia 👍/👎. Check run w PR mówi, czy Revlee uważa PR za gotowy; wiedza, co **nie** zostało sprawdzone, jest równie widoczna.

**Zespół QA/PM:** `revlee map open` pokazuje mapę aplikacji; ticket bez AC jest sygnalizowany w PR, co podnosi jakość ticketów; `revlee stats` daje koszt i trafność.

**Coding agent (Claude Code/Codex):** ten sam silnik lokalnie przez MCP/skill; wynik lokalnej weryfikacji wklejany w opis PR; Revlee w CI potwierdza niezależnie.

## 6. Dashboard (faza 3, opcjonalny)

`revlee-app` (GitHub App + UI): lista runów, filtry po werdykcie/koszcie, odtwarzacz dowodów (ten sam `report.html`), App Map interaktywna, kalibracja sędziego (👍/👎 vs werdykt), kolejka urządzeń, budżety. Bez dashboardu wszystko działa z komentarzy, check runów i `report.html` w S3.

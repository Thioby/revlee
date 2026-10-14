# 02 · Research i stan rynku (stan na 14.10.2026)

Ten rozdział streszcza pięć wątków researchu (pełne notatki z cytowaniami: [`research_notes/`](../research_notes/Agentowa%20weryfikacja%20PR%20jak%20Revyl/)). Odpowiada na trzy pytania: jak dokładnie działa Revyl, czy coś takiego już istnieje w open source, i z jakich klocków da się to zbudować.

## 1. Jak działa Revyl (zweryfikowane ze źródeł i kodu `revyl-cli`)

Revyl ma trzy ścieżki weryfikacji PR-a:

| Ścieżka | Mechanizm | Kto planuje |
|---|---|---|
| **A. GitHub App + „Proof of Changes”** (GA 4.09.2026) | Konfiguracja w `.revyl/config.yaml` (`pr_review.proof_of_changes.{enabled, harness.kind, system_prompt, always_verify[]}`). Agent Revyl dostaje jednorazowy checkout PR-a w sandboxie i klucz API wybity dla tego jednego PR-a, instaluje build na symulatorze/emulatorze w chmurze, „przeklikuje” diff, publikuje jeden komentarz (nadpisywany po każdym pushu) przez ukrytą komendę `revyl proof comment <md> [--problem\|--blocked]`. | Hostowany agent Revyl (model nieujawniony) lub Cursor Cloud Agent |
| **B. BYO-CI + coding agent** | CI uploaduje build (`revyl build upload --version <sha>`), Claude Code Action / Cursor Automation dopasowuje build do SHA, startuje urządzenie (`revyl device start --build-version-id`), steruje `revyl device tap --target "opis"`, publikuje `## Revyl device proof`. | Claude Code / Cursor z playbookiem `CLAUDE.md` |
| **C. CLI regresja** | `RevylAI/revyl-gh-action` (`run-test`, `run-workflow`, `upload-build`), zapisane testy YAML. | Brak (stałe testy) |

Kluczowe fakty projektowe:

- **Kontekst:** diff jest autorytatywny, opis PR to „ograniczony fragment części napisanej przez autora” używany tylko jako kontekst. **Brak Jira/Linear, brak Figmy w proof** (Figma istnieje jako osobny skill porównujący z Atlasem).
- **Werdykty** (od 18.09.2026): `Ready | Ready with polish | Ready with issues | Failed | Inconclusive`, pewność 1/5–5/5, problemy jako wątki anotacji w Atlasie (`revyl report annotations create --severity blocker|issue|polish`, zakotwiczone do współrzędnych screenshotu). „Claimed ready outcome still requires a recorded device session.” Werdykt proof **nie ustawia GitHub check**; tylko nieudany build managed może dać failing check.
- **Wykonanie:** vision-first: capture → ground (model VLM do groundingu zwraca współrzędne dla celu w języku naturalnym) → act (UIAutomator2/XCTest) → verify (VLM ocenia nowy screenshot). Drzewa a11y uznane za „zawodne na produkcyjnych appkach”. Vendor przyznaje: „vision models hallucinate coordinates”, większy koszt.
- **Atlas:** graf wiedzy o aplikacji budowany z każdego uruchomienia: ekrany (klastry z wariantami), przejścia (z interwałami wideo), obszary produktowe, „heat”, wątki anotacji. CLI `revyl atlas brief|graph|search|screen|neighbors|edge`.
- **Dowody na run:** wideo, timeline kroków, podsumowanie AI, wyniki akcji z `/reasoning`, screenshoty, logi, sieć (JSON), CPU/FPS/pamięć (+Perfetto), snapshoty stanu urządzenia (`device state snapshot|diff`, `sqlite`, `userdefaults`), link bez logowania.
- **Testy:** YAML z blokami `instructions | validation | extraction | manual | code_execution | module_import | if | while`, payload w języku naturalnym; `revyl test create --from-session`.
- **Determinizm:** wymazywanie symulatorów między runami, `auth_bypass` deep link, launch args, `--retries`, klasyfikacja stabilności, skill triage `REAL BUG | FLAKY TEST | INFRA | SETUP | TEST IMPROVEMENT`. Brak cache'owania kroków agenta między pushami (każdy push = pełne wykonanie).
- **Urządzenia:** wyłącznie chmurowe symulatory iOS (18.5–27.0) i emulatory Android (w pliku celów tylko Pixel 7/Android 14). Brak fizycznych urządzeń. Brak web.
- **Cennik:** Free; Starter 250 USD/mies. (3 równoległe urządzenia); Team Pro 750 USD/mies. (10); Enterprise. **Brak self-hosted.**
- **Open source od Revyl (MIT):** `revyl-cli` (Go, MCP server, skille, OpenAPI 159 endpointów), `greenlight` (skaner zgodności App Store/Play), `mobile-devtools` (szablony: `mobile-pr-reviewer`, `visual-regression` 0,1 % próg, `figma-design-checker`, `app-explorer` BFS). Chmura urządzeń, modele groundingu, backend Atlasa i orkiestrator proof są zamknięte.

Krytyka (głównie konkurencja i sam vendor): tylko symulatory, tylko mobile, własny YAML bez eksportu, brak integracji ticketowej, explorer gubi się po ~50 ekranach, URL-e wideo wygasają po godzinie, brak dyskusji HN/Reddit (mała baza klientów, ~5 osób w zespole).

## 2. Czy pełny system już istnieje w open source?

**Nie.** Żaden projekt OSS nie robi pełnej pętli „ticket/AC + diff → plan → uruchomienie aplikacji → dowody w GitHubie”. Najbliższe fragmenty:

| Projekt | Co robi | Czego brakuje |
|---|---|---|
| `RevylAI/mobile-pr-reviewer` (MIT, 5★) | Claude Code Action + chmura Revyl: czyta diff, hipoteza jednym zdaniem, reaktywna pętla screenshot→tap, link do nagrania | Brak ticketa, brak planu, brak check run, wymaga chmury Revyl |
| `ACHultman/pr-qa-copilot` (MIT) | Znajduje preview URL przez Deployments API, odpala ręcznie pisane podróże Playwright, jeden idempotentny komentarz + artefakt | Brak agenta, brak AC |
| `anthropics/claude-code-action` | Uruchamia Claude Code w Actions, MCP przez `--mcp-config`, gating narzędzi `--allowedTools mcp__<server>__<tool>` | Tylko komentarze, brak formalnych review/checków, brak przykładu z urządzeniem |
| Skille `/verify` (Claude Code), Shiplight `verify`, OpenHands `qa-changes`, Playwright Test Agents (planner/generator/healer) | Weryfikacja lokalna zmian przez agenta | Brak pętli PR→ticket→dowody |
| SWE-Review (arXiv 2607.06065) | Agent-recenzent „issue + PR → accept/reject” | Tylko kod, bez uruchamiania aplikacji |

Coding-agenty weryfikują **własne** PR-y (Copilot: Playwright MCP + screenshoty w PR od 07.2025; Devin: tryb „Test the app” z adnotowanym nagraniem; Codex: przeglądarka in-app na localhost; Claude Code: `/verify`), ale nikt nie oferuje niezależnego weryfikatora dowolnego PR-a względem ticketa.

Komercyjnie wzorzec web się ustabilizował: GitHub App + wykrycie preview (Vercel/Netlify/…) + plan z tytułu/opisu/diffu + prawdziwa przeglądarka + komentarz/review aktualizowany w miejscu (QA.tech, TesterArmy, Autonoma, Momentic, QA Wolf, Checksum, Greptile TREX, Meticulous). **QA.tech** jako jedyny deklaruje pobieranie powiązanego ticketa Jira/Linear i wymóg, by każdy test cytował hunk diffu. Dla mobile tylko Revyl ma agentową pętlę na urządzeniu; Maestro Cloud to skrypty.

Najbardziej konkretne lekcje o trybach awarii (Cognition, maj 2026): agent **nad-testuje niezwiązane obszary**, **halucynuje ścieżki w aplikacji, które nie istnieją** (bez ugruntowania w kodzie), i **„kłamie mniej”, gdy musi zadeklarować oczekiwanie przed akcją**; wyniki per asercja: passed/failed/untested.

## 3. Klocki open source do zbudowania Revlee

### 3.1 Sterowanie urządzeniem i percepcja

| Klocek | Licencja / wersja | Rola w Revlee | Uwagi |
|---|---|---|---|
| **callstack/agent-device** | MIT, 0.21.27 (12.10.2026), ~5k★ | Główny sterownik iOS Simulator / Android / web dla agenta: snapshoty a11y z refami (`@e2 [button] "Add"`), diffy po akcji (`--settle`), `screenshot --overlay-refs`, `record start/stop` (MP4 z nakładką dotyku), `trace`, `logs`, `network dump`, `perf`, skrypty `.ad` do replaya, MCP (`agent-device mcp`) | Brak własnej asercji NL (robi to nasz sędzia). Używany przez Expensify, Shopify, JPMC |
| **mobile-next/mobile-mcp** + `mobilewright` | Apache-2.0, 1.0.10 / 0.0.65 | Alternatywny stos mobilny: 36 narzędzi `mobile_*`, API w stylu Playwright z retrying `expect`, JUnit/HTML | Warstwa `mobilecli` na FSL-1.1 (source-available) |
| **Playwright + @playwright/mcp** | Apache-2.0, 0.0.83 | Web: snapshot a11y, `browser_verify_*` (`--caps=testing`), trace.zip, wideo, `browser_mouse_*_xy` (`--caps=vision`) | „Not a security boundary”, `browser_run_code_unsafe` = RCE |
| **appium/appium-mcp** | Apache-2.0, 1.97.1 | Opcjonalny adapter do fizycznych urządzeń / istniejącego Appium | XML page source |
| **Maestro** | Apache-2.0, 2.11.0 | Eksport scenariuszy do YAML Maestro (`agent-device --maestro`), `maestro hierarchy` | `assertWithAI` ma znane fałszywe negatywy; MCP współdzieli port 22087 między symulatorami (bug #3611) |

### 3.2 Framework testowy z cache/replay

**tester-army/e2e** (Apache-2.0, 0.20.0, 10,3k★, pre-1.0) to jedyny OSS framework mobile+web z udokumentowanym cache'em zweryfikowanych kroków agenta: krok `agent.act` zapisany jako JSON (cele po roli/nazwie/testId + kontrole stanu końcowego, bez screenshotów), replay bez wywołań modelu, tryby `read-write | read-only (CI) | off`, `--strict-cache` → `REPLAY_STALE` exit 2, raport `report.json` + `junit.xml` + `trace.md` + PNG/MP4, reporter `@e2e-dev/github`. Asercje (`agent.assert`, `vision: true | 'only'`) zawsze wywołują model. Znane problemy: churn formatu klucza unieważnił zakomitowane nagrania (#938), `assert/waitFor/extract` ignorują cache.

**Decyzja:** Revlee używa e2e jako **opcjonalnego runnera scenariuszy regresyjnych** (faza 2), ale własną pętlę weryfikacji PR buduje bezpośrednio na agent-device/Playwright + Claude Agent SDK, bo potrzebujemy: planu z AC, porównania base vs PR, własnej hierarchii orakli i raportu per kryterium. Wzorzec cache'u kroków kopiujemy (szczegóły w [08](08-agent-wykonawczy-i-orakula.md)).

### 3.3 Agent, modele, integracja

- **Claude Agent SDK / claude-code-action:** MCP przez `mcpServers`/`--mcp-config`, gating `allowedTools` (`mcp__device__*`), `PreToolUse` hooki z `permissionDecision: deny`, `--max-turns`, `--max-budget-usd`, OIDC zamiast klucza API w sekrecie. Zasady fork-PR: base ref w root, head PR w `--add-dir pr-head`, sekrety wstrzymane na forkach.
- **Computer use (Anthropic):** toolset `computer_toolset_20260801`, ~1 000–1 800 tokenów wejścia na screenshot, zalecane 1280×720/1280×800, batch actions, klasyfikatory Anthropic skanują screenshoty pod kątem prompt injection. Modele: Fable 5.1, Opus 5.5, Sonnet 5.5, Haiku 5.5.
- **Benchmarki (dla kalibracji oczekiwań):** OSWorld-Verified ~85–90 % (powyżej człowieka 72 %), OSWorld 2.0 20–44 % przy 25–76 USD/zadanie; AndroidWorld ~85–87 %. Latencja: 75–94 % czasu kroku to wywołanie LLM. Wniosek: krótkie, dobrze określone przepływy (5–30 kroków) są w zasięgu; długie eksploracje nie.
- **Sędzia (LLM-as-judge):** AgentRewardBench: najlepsi sędziowie ~70 % precyzji; Mobile-JudgeBench: błędy „surface UI match” i „partial completion”; Gaming the Judge: sama zmiana narracji agenta podnosi fałszywe „pass” sędziego VLM nawet o 90 %. Mitygacje z dowodami: osąd z obserwacji, nie z narracji; wymóg cytowania konkretnego snapshotu (SmartSnap); jednogłośne głosowanie wielu próbek (ZeroGUI); kontrole negatywne; deterministyczne orakula.
- **Weryfikacja różnicowa:** RippleGUItester (2026) — testy sterowane zmianą, uruchamiane na wersji przed i po, różnice klasyfikowane jako zamierzone/niezamierzone względem intencji; 26 nowych błędów w Firefox/Zettlr/JabRef/Godot. Testora, DiffTestGen podobnie.
- **Diff pikselowy:** `odiff` (Zig, ms, anti-aliasing, ignore regions, YIQ, tryb serwera), `pixelmatch` (`threshold`, `includeAA`).

### 3.4 Infrastruktura

- **GitHub:** self-hosted runnery „almost never” dla repo publicznych; fork może skompromitować trwały runner. Mitygacje: `--ephemeral`/JIT, VM per job, runner groups, OIDC, `workflow_run` do separacji uprawnień, nigdy checkout forka pod `pull_request_target`.
- **macOS:** limit licencyjny **2 równoległe VM macOS na hoście** (VZErrorDomain 6). Narzędzia: Tart (Cirrus), Cilicon (Trade Republic), Tartelet, runscaler. `xcrun simctl` pokrywa boot/install/launch/screenshot/recordVideo/push/privacy/status_bar/root CA bez Simulator.app. Pamięć ~4 GB na symulator (vendor). Xcode 27.1: znany problem „initial simulator launch can take several minutes”.
- **Android:** emulator 37.2.12; `-no-window -gpu swiftshader_indirect -noaudio -no-boot-anim`, Quick Boot „do 10× szybciej”, `-read-only` dla N klonów jednego AVD, 64 instancje przez `-port`, KVM (udev rule), `/dev/kvm` w K8s przez device plugin. API 37 wymusza 4 GB RAM.
- **Media w PR:** `gh` ≥ 2.99.0 (1.09.2026) ma `--attach` dla PNG/JPEG/GIF/WebP/SVG/MP4/MOV/WebM w `gh pr comment` (wymaga push access). Artefakty Actions wymagają logowania; S3/MinIO dla publicznych linków (trace viewer). Checks API: `output.summary/text` ≤ 65 535 znaków, `annotations` ≤ 50/żądanie, `images[]` z zewnętrznym URL, wymaga GitHub App z `checks:write`.
- **Build:** zdalny Gradle build cache 15→6 min; nie przenosić całego DerivedData (8 GB = 10 min); `eas build --local` bez cache (lepiej `expo prebuild` + natywny build); Expo fingerprint pozwala reużyć natywny build przy zmianach tylko JS.

## 4. Gdzie Revlee może być lepszy niż Revyl

| Obszar | Revyl | Revlee |
|---|---|---|
| Hosting | tylko chmura Revyl | self-hosted, Twoje Maci/Linuxy, Twój S3 |
| Platformy | iOS sim, Android emu | + web (Playwright) |
| Kontekst zadania | diff + fragment opisu | + GitHub Issues/Jira/Linear z AC, PR template, Figma (opcjonalnie) |
| Plan | niejawny (LLM w locie) | jawny JSON: AC → scenariusz → orakulum → dowód; widoczny w raporcie |
| Porównanie | tylko build PR | base vs PR na tych samych przepływach, klasyfikacja zamierzone/niezamierzone |
| Percepcja | vision-first | a11y-first, vision jako fallback (tańsze, deterministyczne) |
| Osąd | VLM `validation` | hierarchia orakli, głosowanie, kontrole negatywne, sędzia nie widzi narracji |
| Werdykt w GitHub | komentarz | komentarz + check run (gating opcjonalny) + JUnit |
| Brak kontekstu | agent zgaduje | `unable_to_verify` z kodem + pytanie do autora o AC |
| Koszt kolejnych pushy | pełne wykonanie | replay zakeszowanych kroków dla nietkniętych ekranów |
| Modele | zamknięte | dowolne (Anthropic/OpenAI/lokalne), osobny model dla plannera/executora/sędziego |

## 5. Luki w wiedzy (do zweryfikowania własnymi pomiarami)

- Brak niezależnych benchmarków trafności i kosztu agentowej weryfikacji UI (tylko dane vendorów; Slack: 15–30 USD/run agentowy, dominuje ponowne wysyłanie kontekstu; TestMu: ~20 % runów Playwright-MCP idzie tą samą ścieżką).
- Brak pomiarów czasu bootu symulatora Xcode 27 / emulatora 37.x na konkretnym sprzęcie.
- Czy `gh pr comment --attach` działa z `GITHUB_TOKEN` (installation token) w Actions, czy wymaga OAuth/PAT.
- Dokładny układ komentarza Revyl GitHub App (docs zablokowane w sandboxie).

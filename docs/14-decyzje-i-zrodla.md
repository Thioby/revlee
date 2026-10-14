# 14 · Decyzje architektoniczne (ADR) i źródła

## 1. Rejestr decyzji

| ID | Decyzja | Alternatywy | Uzasadnienie |
|---|---|---|---|
| ADR-1 | Self-hosted na GitHub Actions z ephemeral runnerami | SaaS (Revyl), własny serwer webhooków od razu | wymaganie użytkownika; GitHub Actions daje kolejkę, sekrety, artefakty; serwer App dopiero w fazie 3 |
| ADR-2 | TypeScript/Node jako język | Go (jak revyl-cli), Python (mobilerun) | ekosystem klocków (agent-device, Playwright, e2e, MCP SDK, Agent SDK) jest w TS |
| ADR-3 | agent-device jako główny adapter mobilny | mobile-mcp, Appium, Maestro, Argent | a11y-first z refami i diffami, dowody (MP4 z nakładką, trace, network), skrypty `.ad` do replaya, MIT, aktywny rozwój; mobile-mcp jako alternatywa (mobilecli na FSL) |
| ADR-4 | Własna pętla weryfikacji zamiast użycia tester-army/e2e jako silnika | e2e jako core | potrzebujemy planu z AC, porównania base/PR, własnej hierarchii orakli i raportu per kryterium; e2e zostaje opcjonalnym runnerem regresji; wzorzec cache kopiujemy |
| ADR-5 | Percepcja a11y-first, vision jako fallback | vision-first (Revyl) | tańsze (brak 1–1,8k tokenów na screenshot), deterministyczne selektory do cache; vision tylko dla cech niewidocznych w drzewie; dowody z badań: harness/grounding ważniejszy niż model |
| ADR-6 | Werdykt z hierarchii orakli; sędzia VLM nie widzi narracji agenta | pojedyncza „validation” VLM (Revyl) | AgentRewardBench, Mobile-JudgeBench, Gaming the Judge; Cognition: deklaracja oczekiwania przed akcją |
| ADR-7 | Porównanie różnicowe base vs PR domyślnie włączone | tylko build PR | RippleGUItester/Testora: różnice klasyfikowane względem intencji; rozróżnia regresję od błędu planu; kontrola negatywna „za darmo” |
| ADR-8 | Plan jawny, cytowany, publikowany przed wykonaniem | plan ukryty w agencie | audytowalność, reakcja recenzenta, stabilne ID scenariuszy dla cache, QA.tech-owa zasada „każdy test cytuje hunk” |
| ADR-9 | Ticket (Jira/Linear/GitHub) jako źródło kryteriów | tylko diff + opis PR (Revyl) | główna luka Revyl; Qodo/QA.tech pokazują wykonalność; traceability AC → dowód |
| ADR-10 | Komentarz idempotentny + check run `neutral` domyślnie | review z approve/decline, status failure | approve to decyzja człowieka; neutralny check buduje zaufanie (wzorzec Claude Code Review); gating opcjonalny |
| ADR-11 | Sekcje `security/budget/gating` z gałęzi bazowej, reszta z head | cała konfiguracja z head (Revyl) | PR nie może poluzować własnych ograniczeń; może zmienić plan/ścieżki |
| ADR-12 | Media przez `gh --attach`, dowody w S3/MinIO, artefakty jako kopia | tylko artefakty | artefakty wymagają logowania i nie osadzają się; `--attach` od gh 2.99 |
| ADR-13 | Osobne modele dla plannera/executora/sędziego, dwie rodziny w głosowaniu | jeden model | koszt i niezależność osądu |
| ADR-14 | App Map (graf ekranów) jako trwała pamięć | brak pamięci | mapowanie diff → ekran, ścieżki dojścia, replay, porównania historyczne; odpowiednik Atlas bez vendor lock-in |
| ADR-15 | Brak `Bash`/zapisu dla agenta, hard controls w serwerze MCP | zaufanie do promptu | security.md claude-code-action, DBHub read-only precedent; obrona w głąb |

## 2. Słownik

| Termin | Znaczenie |
|---|---|
| **AC** | kryterium akceptacji z ticketa |
| **TaskContext** | znormalizowany dokument wejściowy (PR + ticket + repo knowledge) |
| **ImpactMap** | mapowanie diff → ekrany, kotwice, promień zmiany |
| **VerificationPlan** | jawny plan: zachowania, scenariusze, orakula, kontrole negatywne |
| **Orakulum** | mechanizm rozstrzygający pass/fail (a11y, stan, diff wizualny, sędzia) |
| **Kontrola negatywna** | sprawdzenie, które musi dać „nie” (brak starego tekstu, base bez nowego elementu) |
| **Fingerprint ekranu** | hash znormalizowanego drzewa a11y; klucz cache i App Map |
| **Replay / heal / agent / blocked** | źródło wykonania kroku |
| **App Map** | graf ekranów i przejść budowany z runów (odpowiednik Revyl Atlas) |
| **Finding** | ustalenie poza werdyktem kryteriów (`blocker | issue | polish`) |
| **`unable_to_verify`** | stan uczciwego „nie udało się sprawdzić” z kodem przyczyny |

## 3. Źródła

Pełne notatki z cytowaniami (ok. 350 URL-i) znajdują się w [`research_notes/Agentowa weryfikacja PR jak Revyl/`](../research_notes/Agentowa%20weryfikacja%20PR%20jak%20Revyl/):

- `revyl_deep_dive.md` — Revyl: docs, changelog, kod `revyl-cli`/`revyl-gh-action`/`mobile-devtools`, cennik, krytyka.
- `agentic_testing_frameworks.md` — tester-army/e2e, agent-device (+ addendum z docs replay/MCP), mobile-mcp, mobilerun, Maestro, Appium MCP, Playwright MCP, Midscene, Stagehand, Browser Use, Skyvern, UI-TARS, inne.
- `pr_verification_systems.md` — istniejące systemy weryfikacji PR (OSS i komercyjne), coding-agenty, mechanika GitHub (Checks API, media, forki).
- `device_infrastructure.md` — self-hosted runnery, Tart/Cilicon, simctl, emulator, ARC/KVM, build cache, `gh --attach`, timingi.
- `agent_architecture_patterns.md` — computer use, MCP/Agent SDK, generowanie planów z diffu, LLM-as-judge, cache/replay, bezpieczeństwo, projekt raportu.

Najważniejsze pojedyncze źródła:
- Revyl docs: Proof of Changes, GitHub integration, Atlas, Reports; `RevylAI/revyl-cli` (`cmd/revyl/proof.go`, `internal/config/compiler.go`, `examples/cursor-automation/prove-mobile-pr/PROMPT.md`); `RevylAI/mobile-pr-reviewer`.
- `callstack/agent-device` README + `website/docs/docs/{agent-setup,replay-e2e}.md`; `tester-army/e2e` `docs/{cache,agent-steps,ci,mcp}.mdx`; `mobile-next/mobile-mcp`.
- Anthropic: computer use tool docs, Agent SDK MCP docs, Claude Code hooks, `claude-code-action` `docs/{configuration,security}.md`, Claude Code Review docs.
- GitHub docs: self-hosted runners, ARC, secure use, events, Checks API, `attaching-files-with-github-cli.md`; `ReactiveCircus/android-emulator-runner`; Android emulator CLI/snapshots; Apple WWDC20 „Become a Simulator expert”; `cirruslabs/tart`, `traderepublic/Cilicon`.
- Badania: RippleGUItester (arXiv 2603.03121), Testora (2503.18597), AgentRewardBench (2504.08942), Mobile-JudgeBench (2608.11434), Gaming the Judge (2601.14691), OSWorld-Human (2506.16042), TRAP (2512.23128), AndroidWorld (2405.14573).
- Praktyka: Cognition „Verifying Agentic Development at Scale” (05.2026), QA.tech changelog (04.2026), Momentic auto-heal docs, Slack Engineering „Agentic testing”, odiff README.

Zastrzeżenie metodologiczne: część stron (docs.revyl.com, docs.github.com, arxiv.org, playwright.dev i inne) była niedostępna z sandboxu researchu; fakty z nich pochodzą z fragmentów wyszukiwarki lub z kodu źródłowego na GitHubie i są tak oznaczone w notatkach.

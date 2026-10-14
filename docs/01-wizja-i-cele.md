# 01 · Wizja i cele

> Revlee to otwarty, self-hosted system, w którym agent AI **sam sprawdza, czy pull request poprawnie implementuje zadanie**, uruchamiając zbudowaną z tego PR-a aplikację (iOS, Android, web) na Twoim sprzęcie i publikując werdykt z dowodami prosto w GitHubie.

## 1. Problem

Przegląd kodu odpowiada na pytanie „czy ten kod wygląda dobrze?”. Nie odpowiada na pytanie „czy aplikacja po tej zmianie **robi to, co było w zadaniu**?”. Dziś tę lukę wypełnia człowiek: pobiera branch, buduje, klika, porównuje z ticketem. Jest to wolne, nierówne i często pomijane.

Revyl (YC F24) pokazał, że tę pracę może wykonać agent: instaluje build PR-a na urządzeniu w chmurze, „przeklikuje” zmienione przepływy i publikuje werdykt (`Ready | Ready with polish | Ready with issues | Failed | Inconclusive`) z nagraniem sesji. Ma jednak twarde ograniczenia (szczegóły w [02-research](02-research-i-stan-rynku.md)):

| Ograniczenie Revyl | Konsekwencja |
|---|---|
| Wyłącznie chmura Revyl, brak self-hosted | Dane, buildy i nagrania wychodzą poza firmę; koszt 250–750 USD/mies. + kredyty |
| Tylko mobile (symulatory iOS, emulatory Android) | Brak weryfikacji web |
| Kontekst = diff + fragment opisu PR | **Brak ticketa (Jira/Linear/GitHub Issues)**, brak kryteriów akceptacji, brak Figmy w proof |
| Werdykt to komentarz, nie check | Trudno gate'ować merge |
| Brak porównania base vs PR | Agent ocenia „czy wygląda dobrze”, nie „co się zmieniło” |
| Zamknięte modele grounding/judge | Brak kontroli nad kosztem i jakością osądu |

## 2. Cel

Zbudować system **co najmniej równoważny Revyl, a w kluczowych miejscach lepszy**, działający na własnym sprzęcie i uruchamiany z GitHub Actions (self-hosted runner), w pełni open source.

### 2.1 Cele produktowe

1. **Pełny kontekst zadania.** Agent zna diff, opis PR-a, commity, *oraz* powiązane zadanie (GitHub Issue, Jira, Linear) z kryteriami akceptacji, a opcjonalnie makiety Figma. Z tego buduje jawny, audytowalny plan weryfikacji.
2. **Traceability.** Każde kryterium akceptacji ma przypisany co najmniej jeden scenariusz, a każdy scenariusz ma dowód (screenshot, drzewo accessibility, wideo, log). Raport mówi wprost, co zostało sprawdzone, co nie i dlaczego.
3. **Weryfikacja różnicowa.** Te same przepływy wykonywane na buildzie bazowym i buildzie PR-a. Agent ocenia różnicę względem intencji zmiany, nie tylko „czy ekran wygląda sensownie”.
4. **Uczciwy werdykt.** Osąd oparty na hierarchii orakli (deterministyczne asercje → diff pikselowy → sędzia VLM z głosowaniem), z osobnym stanem `unable_to_verify` i kodami przyczyn. Model nigdy nie ocenia własnej narracji.
5. **Natywna integracja z GitHub.** Jeden idempotentny komentarz z mediami (wideo/screenshoty) + check run (`neutral` domyślnie, `failure` gdy zespół włączy gating). Komendy `/verify`, `/verify again`, `/verify "tylko ekran koszyka"`.
6. **Trzy platformy.** iOS Simulator, Android Emulator, web (Playwright). Jedno API urządzenia dla agenta.
7. **Pamięć o aplikacji.** Graf ekranów i przejść budowany z każdego uruchomienia (odpowiednik Revyl Atlas), używany do mapowania diff → ekran i do deterministycznego replaya.

### 2.2 Cele niefunkcjonalne

| Cel | Miara |
|---|---|
| Czas PR → werdykt | p50 ≤ 10 min, p95 ≤ 20 min dla typowego PR-a UI (z ciepłym cache buildu) |
| Koszt LLM na PR | ≤ 5 USD typowo, twardy limit konfigurowalny (`budget.max_usd`) |
| Fałszywe „pass” | Brak werdyktu `pass` bez dowodu z orakla deterministycznego lub jednogłośnego sędziego |
| Izolacja | Jeden job = jedno świeże urządzenie (VM/pod/AVD); PR-y z forków nigdy nie dotykają sekretów |
| Model-agnostic | Anthropic (domyślnie), OpenAI, modele lokalne przez jeden interfejs |
| Zero vendor lock-in | Konfiguracja w repo (`.revlee/`), dowody w Twoim S3/MinIO, graf aplikacji w Twojej bazie |

## 3. Zakres MVP vs docelowy

| Obszar | MVP (faza 1) | Docelowo |
|---|---|---|
| Platformy | Android emulator + web | + iOS Simulator |
| Kontekst | diff, PR body, GitHub Issues (`Closes #N`) | + Jira, Linear, Figma, PR template |
| Plan | LLM z diff + AC, JSON schema | + statyczna analiza wpływu (graf importów → ekrany) |
| Wykonanie | agent krok po kroku (a11y + screenshot) | + cache/replay kroków, self-healing |
| Orakula | asercje a11y + sędzia VLM | + diff pikselowy base vs PR, głosowanie, kontrola negatywna |
| Raport | komentarz PR z tabelą AC + media | + check run, annotations, dashboard |
| Infra | 1 runner Linux (KVM) + 1 Mac | pule VM (Tart), ARC, kolejka |

## 4. Zasady projektowe

1. **Diff jest autorytatywny, opis PR jest kontekstem.** Nie akceptujemy „dziwnego” zachowania tylko dlatego, że opis twierdzi, że tak ma być (zasada przejęta z promptów Revyl, potwierdzona przez Cognition).
2. **Dowód przed werdyktem.** „Ready” wymaga nagranej sesji na urządzeniu. Brak buildu = brak weryfikacji, nie zgadujemy.
3. **Twarde kontrole > prompt.** Ograniczenia narzędzi (allow-list MCP, hooki PreToolUse, read-only serwery) wymuszamy po stronie narzędzia, nie w systemowym prompcie.
4. **Sędzia widzi obserwacje, nie narrację.** Osąd na podstawie screenshotów/drzew a11y i oczekiwanego wyniku, nigdy na podstawie tego, co agent *powiedział*, że zrobił.
5. **Lepiej `unable_to_verify` niż zgadywanie.** Każdy stan nieweryfikowalny ma kod przyczyny i jest widoczny w raporcie.
6. **Konfiguracja jako kod.** Wszystko w `.revlee/` w repo; PR może zmienić własną konfigurację, ale sekcje bezpieczeństwa są zawsze czytane z gałęzi bazowej.
7. **Składaj z istniejących klocków.** Nie piszemy własnego sterownika urządzeń ani frameworka testowego, jeśli istnieje dojrzały OSS (agent-device, mobile-mcp, Playwright, odiff, Claude Agent SDK).

## 5. Dla kogo

- **Zespoły mobilne/web z self-hosted CI**, które nie mogą lub nie chcą wysyłać buildów do SaaS.
- **Zespoły używające coding-agentów** (Claude Code, Codex, Cursor), gdzie wolumen PR-ów przerasta możliwości ręcznego QA.
- **Zespoły z dyscypliną ticketową** (Jira/Linear), które chcą automatycznej kontroli „czy zrobiono to, co było w zadaniu”.

## 6. Czego Revlee nie robi

- Nie zastępuje testów jednostkowych ani deterministycznych suite E2E; je uzupełnia (i może je uruchamiać jako orakula).
- Nie approve'uje PR-ów. Werdykt to sygnał dla człowieka i opcjonalny required check.
- Nie testuje na fizycznych urządzeniach w fazie 1 (możliwe przez adapter Appium/STF później).
- Nie zarządza test-case management; eksportuje wyniki do JUnit/JSON, które można wysłać dalej.

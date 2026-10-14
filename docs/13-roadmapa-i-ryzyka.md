# 13 · Roadmapa, ryzyka i metryki

## 1. Fazy

### Faza 0 · Spike (2–3 tygodnie)
Cel: potwierdzić, że pętla działa na jednym Macu.
- Ręczny workflow `pull_request` na runnerze na hoście (zaufane PR-y).
- Android emulator arm64 + agent-device + Claude Agent SDK; plan z diffu + GitHub Issue (`Closes #N`); sędzia 1 głos; komentarz PR z screenshotami (`gh --attach`).
- Pomiary: czas bootu emulatora/symulatora, czas buildu, koszt na PR, trafność na 10 prawdziwych PR-ach z historii repo (w tym 3 z celowo wstrzykniętym błędem).
- Wyjście: decyzja go/no-go i kalibracja budżetów.

### Faza 1 · MVP (6–8 tygodni)
- Pakiety: `@revlee/cli`, `@revlee/context` (github, jira), `@revlee/impact` (RN/Expo + Next.js), `@revlee/planner`, `@revlee/device` (android, web), `@revlee/judge`, `@revlee/report`.
- Hierarchia orakli 1–4 bez porównania różnicowego; kontrole negatywne na buildzie PR (brak starych tekstów).
- Komentarz idempotentny + JUnit + artefakty; check run przez GitHub App.
- Cache kroków read-write w artefaktach; replay dla ponownych pushy.
- `revlee init/doctor/verify/plan/report`, `examples/` workflowów.
- Infra: 1 Linux KVM (ARC lub pojedynczy runner), 1 Mac dla buildów iOS (bez weryfikacji iOS).

### Faza 2 · Parytet z Revyl i ponad (8–12 tygodni)
- iOS Simulator (agent-device + simctl) w ephemeral VM (Tart/Cilicon), pula 2 VM.
- Porównanie różnicowe base vs PR (odiff, klasyfikacja intended/unintended), smoke z promienia zmiany.
- Linear, PR template, Figma jako orakulum pomocnicze.
- App Map (SQLite→Postgres), `revlee map explore/open/diff`, `screens.yaml` scaffold.
- Głosowanie sędziów dwiema rodzinami modeli, kalibracja na kontrolach negatywnych, 👍/👎.
- Tryby `explore`, `regression_only` (skrypty `.ad`), integracja z tester-army/e2e jako runnerem regresji.
- Separacja `pull_request`/`workflow_run` dla forków; budżety per PR/repo.
- Lokalny grounding (UI-TARS) i executor na modelu lokalnym jako opcja.

### Faza 3 · Skala i produkt (ciągła)
- `revlee-app`: webhooki, kolejka urządzeń, dashboard, live podgląd urządzenia.
- Fizyczne urządzenia przez Appium/agent-device (physical iOS/Android).
- Flutter/natywne iOS/Android w Impact Analyzer.
- Eksport scenariuszy do Maestro YAML; import istniejących flow Maestro jako smoke.
- Uczenie Plannera na historii (`plan_error`, 👎), personalizowane `REVIEW.md`-like reguły zespołu.

## 2. Kryteria sukcesu (metryki)

| Metryka | Cel po fazie 1 | Cel po fazie 2 |
|---|---|---|
| Czas PR → werdykt (p50 / p95) | 12 / 25 min | 8 / 18 min |
| Koszt LLM na PR (p50) | ≤ 3 USD | ≤ 2 USD |
| Fałszywe `pass` na zbiorze PR-ów z wstrzykniętym błędem (n ≥ 30) | ≤ 10 % | ≤ 3 % |
| Fałszywe `fail` (PR poprawne oznaczone `failed`) | ≤ 10 % | ≤ 5 % |
| Udział `unable_to_verify` z przyczyn infra/setup | ≤ 15 % | ≤ 5 % |
| Cache hit-rate kroków na 2. pushu | ≥ 40 % | ≥ 70 % |
| 👍 / (👍+👎) na ustaleniach | ≥ 70 % | ≥ 85 % |
| AC pokryte scenariuszem (gdy AC istnieją) | ≥ 90 % | ≥ 95 % |

Zbiór ewaluacyjny: `revlee-bench` — 30–50 historycznych PR-ów zespołu + mutacje (zły kolor, brak toasta, regresja na innym ekranie, crash), uruchamiane nocą; wyniki w `revlee stats`. To również odpowiedź na brak publicznych benchmarków agentowej weryfikacji UI.

## 3. Ryzyka i mitygacje

| Ryzyko | Prawd. | Wpływ | Mitygacja |
|---|---|---|---|
| Sędzia VLM daje fałszywe `pass` (benchmarki ~70 % precyzji) | wysokie | wysoki | hierarchia orakli, głosowanie, kontrole negatywne, `pass` tylko z dowodem; metryka FP w benchu |
| Czas buildu rozsadza budżet 10 min | średnie | średni | remote cache, build raz na SHA, reużycie natywnego buildu, pre-warm obrazów; raport pokazuje czas buildu osobno |
| Boot symulatora na Xcode 27 „kilka minut” | średnie | średni | pre-boot w snapshocie VM, pin wersji, alternatywnie Xcode 26 |
| Churn API klocków (agent-device 0.x, e2e pre-1.0) | wysokie | średni | adaptery z pinowanymi wersjami, testy kontraktowe adapterów w CI Revlee |
| Limit 2 VM macOS | pewne | średni | więcej Maców; bare-host dla zaufanych PR-ów; priorytet Android/web w kolejce |
| Prompt injection z ekranu/ticketu | średnie | wysoki | izolacja, allow-listy, brak narzędzi poza urządzeniem, raportowanie; red-team w benchu |
| Brak AC w ticketach zespołu | wysokie | średni | tryb `diff_driven` + prośba o AC w PR; metryka jakości kontekstu |
| Koszt rośnie z liczbą pushy | średnie | średni | replay, skip nie-UI, budżety dzienne, `effort: light` dla draftów |
| Flaky urządzeń (timeouty, ANR) | średnie | średni | triage `infra/flaky`, 1 retry, neutralny check run, metryka |
| Zaufanie zespołu po kilku błędnych werdyktach | średnie | wysoki | `gating: neutral` na start, pełna widoczność dowodów i „nie zweryfikowano”, 👍/👎 |
| `gh --attach` nie działa z tokenem App | średnie | niski | fallback S3 linki / job z tokenem użytkownika |

## 4. Decyzje otwarte (do rozstrzygnięcia w fazie 0)

1. Agent-device vs mobile-mcp jako domyślny adapter Android (porównać stabilność snapshotów na 3 aplikacjach).
2. Czy executor domyślnie na Sonnet 5.5 czy Haiku 5.5 (jakość vs koszt na benchu).
3. Czy cache kroków commitować do repo (widoczność) czy trzymać w bazie (mniej szumu w PR).
4. Czy check run tworzyć z GitHub App od MVP, czy zacząć od komentarza + statusu commit.
5. Postgres od początku czy SQLite w artefaktach (zależy od liczby repo).

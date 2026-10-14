# Revlee spike (faza 0)

Minimalna, działająca pętla z [docs/04](../docs/04-przeplyw-pr-do-werdyktu.md): **kontekst PR + ticket → plan → agent na urządzeniu → replay na buildzie bazowym → orakula i sędzia → raport**. Celem spike'a jest zmierzyć koszt i trafność, zanim powstanie MVP.

```
src/
  types.ts            schematy (TaskContext, VerificationPlan, Observation, werdykty)
  context.ts          wczytanie kontekstu + prosty Impact Analyzer (pliki → ekrany)
  planner.ts          Planner LLM (structured output) + deterministyczny walidator planu
  executor.ts         Executor: pętla tool-use (observe/tap/type/wait_for/note_expectation/step_done),
                      executor mock (bez LLM) i replay scenariusza na buildzie base
  judge.ts            orakula: a11y_assert, diff pikselowy base vs PR (pixelmatch), sędzia VLM z głosowaniem,
                      kontrole negatywne, agregacja werdyktów
  report.ts           report.md (format komentarza PR), verdicts.json, junit.xml, actions.ndjson
  device/types.ts     interfejs DeviceAdapter + fingerprint ekranu
  device/agentDevice.ts  adapter na CLI agent-device (iOS / Android / web)
  device/playwright.ts   adapter web na Playwright (snapshot a11y w formacie agent-device)
sample-app/           aplikacja testowa "Acme Shop" z wariantami: ?variant=pr|base, &bug=toast-name|badge|color|theme-leak
fixtures/pr88/        TaskContext (PR + ticket SHOP-412 z 3 AC) i gotowy plan dla trybu mock
bench/run.sh          mikro-benchmark: 4 warianty → macierz werdyktów
```

## Uruchomienie bez modelu (tryb `mock`)

```bash
cd spike && npm install && npm run build
bash bench/run.sh            # start sample-app + 4 runy + macierz werdyktów
```

Oczekiwany wynik (zmierzony 14.10.2026 w sandboxie Linux, Playwright/Chromium):

| wariant | oczekiwane | werdykt | padające AC |
|---|---|---|---|
| good | ready | ready | — |
| bug-toast (toast pokazuje zły produkt) | failed | failed | AC2 |
| bug-badge (licznik nie rośnie) | failed | failed | AC3 |
| bug-color (CTA zostaje niebieski) | failed | failed | AC1 |

W trybie mock: plan jest wczytywany z pliku, executor jest regułowy (dopasowuje cytowane nazwy z kroków do snapshotu a11y), a kryterium wizualne AC1 rozstrzyga wyłącznie diff pikselowy względem buildu bazowego. Czas pojedynczego runu z porównaniem base: ~12 s.

## Uruchomienie z modelem

```bash
export ANTHROPIC_API_KEY=...          # albo `ant auth login`
node sample-app/server.mjs 3077 &
node dist/cli.js verify \
  --context fixtures/pr88/task_context.json \
  --url "http://localhost:3077/?variant=pr&bug=toast-name" \
  --base-url "http://localhost:3077/?variant=base" \
  --model claude-opus-5-5 --votes 3 --out .revlee-run/real-1
bash bench/run.sh --model claude-opus-5-5
```

- Planner: `messages.parse` ze schematem zod (`VerificationPlan`), effort `high`; walidator odrzuca plan bez `source_ref`, bez pokrycia AC, z refami/współrzędnymi w krokach.
- Executor: manualna pętla tool-use na `client.beta.messages` z `fallbacks: "default"` (beta `server-side-fallback-2026-07-01`), effort `medium`, obowiązkowe `note_expectation` przed akcją mutującą, maks. 2 obrazy w kontekście (starsze usuwane), budżety `--max-usd` / `--max-turns`.
- Sędzia: `messages.parse` z rubryką, N głosów, widzi tylko obserwacje (screenshoty + drzewa a11y, obraz A/B/C: przed, po, base). `pass` tylko przy jednomyślności.
- Model domyślny: `claude-opus-5-5` dla wszystkich ról (`--model`, `REVLEE_MODEL`); docelowo osobne modele per rola (docs/12).

> Tryb z modelem nie został uruchomiony w sandboxie (brak klucza API). Kod kompiluje się z typami SDK 0.133, ale pierwsze uruchomienie z kluczem należy traktować jako test.

## agent-device (iOS / Android)

```bash
npm i -g agent-device@0.21.27
# iOS Simulator (Mac z Xcode): zbuduj .app, zainstaluj, potem:
node dist/cli.js verify --context fixtures/pr88/task_context.json --platform ios --adapter agent-device \
  --url com.acme.shop --base-url com.acme.shop.base --device <UDID> --model mock --plan fixtures/pr88/plan.mock.json
# Android emulator:
node dist/cli.js verify ... --platform android --url com.acme.shop --device emulator-5554
```

Adapter `agentDevice.ts` używa `open --relaunch --foreground`, `snapshot -i --force-full --json`, `press/fill/scroll --settle`, `wait text|absent`, `screenshot <path>`, `close`, zawsze z `--session` i `--platform`. Parsuje JSON (`data.nodes`) lub tekstowe linie `@e12 [button] label="..."`. Gramatyka zweryfikowana przez `agent-device help <cmd>` (0.21.27); **sterowanie realnym symulatorem/emulatorem nie było testowane w sandboxie** (brak Xcode/KVM). Backend web agent-device wymaga Node ≥ 24 i pobrania Chromium z googlechromelabs (zablokowane w sandboxie), stąd adapter Playwright dla web.

## Co spike potwierdza (i czego nie)

Potwierdzone:
- Kontrakt danych z dokumentacji (TaskContext → ImpactMap → VerificationPlan → Observation/ActionRecord → CriterionVerdict) jest implementowalny i wystarczający.
- Orakula deterministyczne na drzewie a11y + diff pikselowy względem base dają poprawną macierz werdyktów bez żadnego modelu; sędzia VLM jest potrzebny tylko dla cech wizualnych i tam jest tylko jednym z głosów.
- Replay semantyczny (rola/nazwa/testID) tych samych kroków na buildzie bazowym działa i daje kontrole negatywne „za darmo”.
- Raport w formacie komentarza PR (tabela AC → werdykt → orakulum → dowód → pewność, kontrole negatywne, stopka JSON) generuje się z dowodów.

Nie potwierdzone (następne kroki fazy 0):
1. Jakość i koszt Plannera/Executora/Sędziego z prawdziwym modelem (`bash bench/run.sh --model claude-opus-5-5`); cel: 4/4, ≤ 2 USD/run.
2. agent-device na iOS Simulator i Android Emulator na Macu (adapter + pomiar czasu bootu).
3. Bogatszy benchmark: 10 historycznych PR-ów + mutacje, w tym PR bez AC (tryb `diff_driven`) i PR z regresją na innym ekranie (smoke).
4. Cache kroków między pushami i `handed_off` przy drifcie (dziś replay jest tylko dla base).

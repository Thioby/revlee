# 09 · Raport i integracja z GitHub

## 1. Kanały wyjścia

| Kanał | Co | Wymagania |
|---|---|---|
| **Komentarz PR** (jeden, idempotentny, znacznik `<!-- revlee:comment -->`) | nagłówek z werdyktem, tabela kryteriów, pasek kroków z miniaturami, wideo, sekcja „nie zweryfikowano”, stopka JSON | `pull-requests: write`; media przez `gh pr comment --attach` (gh ≥ 2.99) |
| **Check run** `Revlee / <platforma>` | `status`, `conclusion`, `output.summary` (ta sama tabela), `output.images[]` (URL-e S3), `annotations` dla ustaleń mapowalnych na linie diffu | GitHub App (`checks: write`); `GITHUB_TOKEN` nie tworzy check runów w check suite PR-a |
| **Artefakt Actions** `revlee-<platform>-<sha7>` | cały `evidence/` | `actions: write`, retencja 14 dni |
| **S3/MinIO** | `report.html`, wideo, `trace.zip`, screenshoty, presigned URL | klucz w Orchestratorze |
| **JUnit / JSON** | `junit.xml` (1 testcase = 1 kryterium), `report.json` | do dashboardów CI, test management |
| **App Map** | obserwacje ekranów | baza zespołu |

## 2. Komentarz PR: układ

```markdown
<!-- revlee:comment pr=88 -->
## ✅ Revlee · Ready · pewność 0.92
**PR #88 · a1b2c3d** · Android (Pixel 7 / API 35) · build 3m10s · weryfikacja 5m30s · 1,80 USD · base porównany na 4 ekranach
Zadanie: [SHOP-412](https://acme.atlassian.net/browse/SHOP-412) · kontekst: 3 AC, test plan ✓, mapa ekranów ✓

| Kryterium | Werdykt | Orakulum | Dowód | Pewność |
|---|---|---|---|---|
| AC1 Kolor CTA #1DB954 | ✅ pass | odiff (base ≠ PR) + sędzia 3/3 | [#S2.1](…) · [diff](…) | 0.88 |
| AC2 Toast po tapnięciu, znika ≤ 3 s | ✅ pass | a11y | [#S1.3](…) [#S1.4](…) | 0.96 |
| AC3 Licznik koszyka +1 | ✅ pass | stan (testID cart-badge: 0 → 1) | [#S1.4](…) | 0.95 |
| B4 Toast nie zasłania tab bara *(wyprowadzone z diffu)* | ✅ pass | sędzia 3/3 | [#S1.3](…) | 0.72 |
| always: start do Home bez crasha | ✅ pass | a11y + logi | [#AV1](…) | 1.00 |
| smoke Home, Cart (theme.ts) | ✅ brak niezamierzonych zmian | odiff 0.00 % / 0.03 % | [K1](…) [K2](…) | — |

### Przebieg S1 · Dodanie do koszyka
| 1 · ekran produktu | 2 · licznik = 0 | 3 · tap „Dodaj do koszyka” → toast | 4 · po 3,5 s toast znikł, licznik = 1 |
|---|---|---|---|
| ![](shot_14.png) | ![](shot_15.png) | ![](shot_17.png) | ![](shot_18.png) |
`replay 1 · agent 3` · kontrola negatywna N1 (base bez toasta) ✅

<details><summary>Przebieg S2 · Kolor CTA (base vs PR)</summary>
| base | PR | heatmapa |
|---|---|---|
| ![](base_shot_3.png) | ![](shot_14.png) | ![](diff_O5.png) |
Sędziowie: Sonnet 5.5 ×2 „zielony (#1EB85A)”, GPT-5.4 „zielony” → 3/3
</details>

### 🎬 Nagranie
(run.mp4 osadzony przez --attach)

### Nie zweryfikowano
— (wszystkie kryteria wykonane)

<details><summary>Jak to zweryfikowano</summary>
plan.json · 9 kroków (1 replay, 8 agent) · 18 wywołań modelu · sędzia: 2 rodziny modeli · diff pikselowy odiff 0.1 % próg z ignore-regions · urządzenie świeże (-read-only AVD), sieć przez mitmproxy z allow-listą · wideo 5:12
</details>

[Pełny raport](https://evidence.acme.dev/revlee/pr88/a1b2c3d/android/report.html) · [plan](…) · [artefakt](…) · komendy: `/verify again`, `/verify ios`, `/verify "tylko koszyk"`
<!-- revlee:summary {"verdict":"ready","confidence":0.92,"criteria":{"pass":4,"fail":0,"inconclusive":0,"unable_to_verify":0},"findings":{"blocker":0,"issue":0,"polish":0},"cost_usd":1.8,"duration_s":330,"sha":"a1b2c3d","platform":"android"} -->
```

Warianty nagłówka: `❌ Failed`, `⚠️ Ready with issues`, `❔ Inconclusive`, `⛔ Unable to verify (setup: auth bypass failed)`, `⏭ Skipped (no user-visible change)`.

Reguły:
- komentarz jest **edytowany w miejscu** po każdym pushu (jak Revyl, Momentic, TesterArmy); historia w linku „poprzednie runy”,
- maks. 6 miniatur w pasku kroków; reszta w `<details>`,
- każdy `fail` ma blok **Oczekiwane / Zaobserwowane / Dowód / Jak odtworzyć** (deep link, kroki, `.ad` skrypt do pobrania),
- ustalenia poza zakresem AC (smoke, polish) są oddzielone od werdyktu kryteriów,
- przy braku AC: blok „Potrzebuję kryteriów akceptacji…” z instrukcją,
- przy `fork`: komentarz informuje, że weryfikacja wymaga `/verify` od maintainera.

## 3. Check run

```json
{
  "name": "Revlee / android",
  "head_sha": "a1b2c3d…",
  "status": "completed",
  "conclusion": "success",
  "details_url": "https://evidence.acme.dev/revlee/pr88/a1b2c3d/android/report.html",
  "output": {
    "title": "Ready · 4/4 kryteriów · pewność 0.92",
    "summary": "<tabela jak w komentarzu, Markdown>",
    "text": "<sekcja 'Jak to zweryfikowano' + lista kroków>",
    "images": [{ "alt": "S1 krok 3: toast", "image_url": "https://evidence.acme.dev/…/shot_17.png", "caption": "AC2 dowód" }],
    "annotations": [{ "path": "src/components/Toast.tsx", "start_line": 41, "end_line": 41, "annotation_level": "warning", "title": "Toast nachodzi na tab bar na 5.4\" (finding F-3, polish)", "message": "…" }]
  }
}
```

Mapowanie werdyktów na `conclusion` opisane w [04 §5](04-przeplyw-pr-do-werdyktu.md). Konfiguracja gatingu:

```yaml
report:
  check_run:
    enabled: true
    gating: neutral        # neutral | failure | strict
```
- `neutral`: nigdy nie blokuje (jak Claude Code Review), zespół czyta.
- `failure`: `failed` → `failure` (można ustawić jako required check).
- `strict`: dodatkowo `inconclusive`/`ready_with_issues` → `action_required`.

Check run w stanie `in_progress` publikowany jest od razu po starcie, z linkiem do live podglądu (opcjonalny strumień WebRTC/VNC z urządzenia, faza 3).

## 4. Media w komentarzu

Preferowany mechanizm: `gh pr comment <n> --body-file report.md --attach evidence/shot_17.png#'S1 krok 3' --attach evidence/run.mp4` (gh ≥ 2.99.0, 1.09.2026; wymaga push access; wideo musi być samo w akapicie). Ścieżki lokalne w treści są podmieniane na URL-e `user-attachments`.

Fallbacki (w kolejności): URL-e z S3/MinIO (publiczny bucket lub presigned 30 dni) w zwykłym Markdown; GIF 8 fps z ffmpeg zamiast MP4 na GHES; wyłącznie linki do `report.html`.

Do zweryfikowania na starcie wdrożenia: czy `--attach` akceptuje token instalacyjny GitHub App / `GITHUB_TOKEN` (dokumentacja wymienia OAuth i klasyczny PAT). Jeśli nie, komentarz publikuje job `workflow_run` z tokenem App, a media idą przez S3.

## 5. `report.html` (statyczny)

Jedna strona generowana z `evidence/`: timeline kroków zsynchronizowany z wideo (znaczniki `mark`), panel snapshotu a11y per krok, przełącznik base/PR z heatmapą, logi i sieć filtrowane, plan i werdykty, pobieranie `.ad` i `plan.json`. Bez backendu, działa z S3 (CORS) i z artefaktu po rozpakowaniu.

## 6. App Map i historia

Po każdym runie: nowe obserwacje ekranów (fingerprint, screenshot, build, platforma) i przejścia trafiają do bazy. Komentarz pokazuje, gdy ekran był widziany pierwszy raz („nowy ekran w App Map: `toast`”). `revlee map open` renderuje graf (Mermaid/HTML) z heatem i ostatnimi screenshotami; `revlee map diff <shaA> <shaB>` listuje ekrany ze zmianami między buildami.

## 7. Komendy i uprawnienia

| Kto | Co może |
|---|---|
| `OWNER`, `MEMBER`, `COLLABORATOR` (write) | wszystkie komendy `/verify …`, trigger na forkach |
| autor PR bez write | `/verify again` tylko gdy repo ustawi `triggers.allow_author_rerun: true`; nigdy na forku |
| boty | ignorowane (allow-lista `triggers.allowed_bots`) |

Reakcje 👍/👎 pod komentarzem są zbierane (webhook App lub skan przy kolejnym runie) jako sygnał kalibracji sędziego i raportowane w `revlee stats`.

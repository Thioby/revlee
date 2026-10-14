# 09 · Report and GitHub Integration

## 1. Output channels

| Channel | What | Requirements |
|---|---|---|
| **PR comment** (single, idempotent, marker `<!-- revlee:comment -->`) | header with verdict, criteria table, step strip with thumbnails, video, "not verified" section, JSON footer | `pull-requests: write`; media via `gh pr comment --attach` (gh ≥ 2.99) |
| **Check run** `Revlee / <platform>` | `status`, `conclusion`, `output.summary` (the same table), `output.images[]` (S3 URLs), `annotations` for findings mappable to diff lines | GitHub App (`checks: write`); `GITHUB_TOKEN` does not create check runs in the PR's check suite |
| **Actions artifact** `revlee-<platform>-<sha7>` | the entire `evidence/` | `actions: write`, 14-day retention |
| **S3/MinIO** | `report.html`, video, `trace.zip`, screenshots, presigned URL | key in the Orchestrator |
| **JUnit / JSON** | `junit.xml` (1 testcase = 1 criterion), `report.json` | for CI dashboards, test management |
| **App Map** | screen observations | team database |

## 2. PR comment: layout

```markdown
<!-- revlee:comment pr=88 -->
## ✅ Revlee · Ready · confidence 0.92
**PR #88 · a1b2c3d** · Android (Pixel 7 / API 35) · build 3m10s · verification 5m30s · 1.80 USD · base compared on 4 screens
Task: [SHOP-412](https://acme.atlassian.net/browse/SHOP-412) · context: 3 AC, test plan ✓, screen map ✓

| Criterion | Verdict | Oracle | Evidence | Confidence |
|---|---|---|---|---|
| AC1 CTA color #1DB954 | ✅ pass | odiff (base ≠ PR) + judge 3/3 | [#S2.1](…) · [diff](…) | 0.88 |
| AC2 Toast after tap, disappears ≤ 3 s | ✅ pass | a11y | [#S1.3](…) [#S1.4](…) | 0.96 |
| AC3 Cart counter +1 | ✅ pass | state (testID cart-badge: 0 → 1) | [#S1.4](…) | 0.95 |
| B4 Toast does not cover the tab bar *(derived from the diff)* | ✅ pass | judge 3/3 | [#S1.3](…) | 0.72 |
| always: launch to Home without a crash | ✅ pass | a11y + logs | [#AV1](…) | 1.00 |
| smoke Home, Cart (theme.ts) | ✅ no unintended changes | odiff 0.00 % / 0.03 % | [K1](…) [K2](…) | — |

### Flow S1 · Add to cart
| 1 · product screen | 2 · counter = 0 | 3 · tap "Add to cart" → toast | 4 · after 3.5 s the toast is gone, counter = 1 |
|---|---|---|---|
| ![](shot_14.png) | ![](shot_15.png) | ![](shot_17.png) | ![](shot_18.png) |
`replay 1 · agent 3` · negative control N1 (base without the toast) ✅

<details><summary>Flow S2 · CTA color (base vs PR)</summary>
| base | PR | heatmap |
|---|---|---|
| ![](base_shot_3.png) | ![](shot_14.png) | ![](diff_O5.png) |
Judges: Sonnet 5.5 ×2 "green (#1EB85A)", GPT-5.4 "green" → 3/3
</details>

### 🎬 Recording
(run.mp4 embedded via --attach)

### Not verified
— (all criteria executed)

<details><summary>How this was verified</summary>
plan.json · 9 steps (1 replay, 8 agent) · 18 model calls · judge: 2 model families · odiff pixel diff, 0.1 % threshold with ignore-regions · fresh device (-read-only AVD), network through mitmproxy with an allow-list · video 5:12
</details>

[Full report](https://evidence.acme.dev/revlee/pr88/a1b2c3d/android/report.html) · [plan](…) · [artifact](…) · commands: `/verify again`, `/verify ios`, `/verify "cart only"`
<!-- revlee:summary {"verdict":"ready","confidence":0.92,"criteria":{"pass":4,"fail":0,"inconclusive":0,"unable_to_verify":0},"findings":{"blocker":0,"issue":0,"polish":0},"cost_usd":1.8,"duration_s":330,"sha":"a1b2c3d","platform":"android"} -->
```

Header variants: `❌ Failed`, `⚠️ Ready with issues`, `❔ Inconclusive`, `⛔ Unable to verify (setup: auth bypass failed)`, `⏭ Skipped (no user-visible change)`.

Rules:
- the comment is **edited in place** after every push (like Revyl, Momentic, TesterArmy); history under the "previous runs" link,
- at most 6 thumbnails in the step strip; the rest in `<details>`,
- every `fail` has an **Expected / Observed / Evidence / How to reproduce** block (deep link, steps, downloadable `.ad` script),
- findings outside the scope of the AC (smoke, polish) are kept separate from the criteria verdict,
- when there are no AC: an "I need acceptance criteria…" block with instructions,
- for a `fork`: the comment states that verification requires `/verify` from a maintainer.

## 3. Check run

```json
{
  "name": "Revlee / android",
  "head_sha": "a1b2c3d…",
  "status": "completed",
  "conclusion": "success",
  "details_url": "https://evidence.acme.dev/revlee/pr88/a1b2c3d/android/report.html",
  "output": {
    "title": "Ready · 4/4 criteria · confidence 0.92",
    "summary": "<table as in the comment, Markdown>",
    "text": "<'How this was verified' section + list of steps>",
    "images": [{ "alt": "S1 step 3: toast", "image_url": "https://evidence.acme.dev/…/shot_17.png", "caption": "AC2 evidence" }],
    "annotations": [{ "path": "src/components/Toast.tsx", "start_line": 41, "end_line": 41, "annotation_level": "warning", "title": "Toast overlaps the tab bar on 5.4\" (finding F-3, polish)", "message": "…" }]
  }
}
```

The mapping of verdicts to `conclusion` is described in [04 §5](04-flow-pr-to-verdict.md). Gating configuration:

```yaml
report:
  check_run:
    enabled: true
    gating: neutral        # neutral | failure | strict
```
- `neutral`: never blocks (like Claude Code Review), the team reads it.
- `failure`: `failed` → `failure` (can be set as a required check).
- `strict`: additionally `inconclusive`/`ready_with_issues` → `action_required`.

A check run in the `in_progress` state is published immediately after start, with a link to a live preview (optional WebRTC/VNC stream from the device, phase 3).

## 4. Media in the comment

Preferred mechanism: `gh pr comment <n> --body-file report.md --attach evidence/shot_17.png#'S1 step 3' --attach evidence/run.mp4` (gh ≥ 2.99.0, Sep 1, 2026; requires push access; the video must be alone in its paragraph). Local paths in the body are replaced with `user-attachments` URLs.

Fallbacks (in order): S3/MinIO URLs (public bucket or 30-day presigned) in plain Markdown; an 8 fps GIF from ffmpeg instead of MP4 on GHES; links to `report.html` only.

To verify at the start of the rollout: whether `--attach` accepts a GitHub App installation token / `GITHUB_TOKEN` (the documentation lists OAuth and classic PAT). If not, the comment is published by a `workflow_run` job with the App token, and media go through S3.

## 5. `report.html` (static)

A single page generated from `evidence/`: a step timeline synchronized with the video (`mark` markers), an a11y snapshot panel per step, a base/PR toggle with heatmap, filtered logs and network, the plan and verdicts, download of `.ad` and `plan.json`. No backend; works from S3 (CORS) and from the unpacked artifact.

## 6. App Map and history

After every run: new screen observations (fingerprint, screenshot, build, platform) and transitions go into the database. The comment shows when a screen was seen for the first time ("new screen in App Map: `toast`"). `revlee map open` renders the graph (Mermaid/HTML) with heat and the latest screenshots; `revlee map diff <shaA> <shaB>` lists screens with changes between builds.

## 7. Commands and permissions

| Who | What they can do |
|---|---|
| `OWNER`, `MEMBER`, `COLLABORATOR` (write) | all `/verify …` commands, triggering on forks |
| PR author without write | `/verify again` only when the repo sets `triggers.allow_author_rerun: true`; never on a fork |
| bots | ignored (allow-list `triggers.allowed_bots`) |

👍/👎 reactions under the comment are collected (App webhook or a scan during the next run) as a judge calibration signal and reported in `revlee stats`.

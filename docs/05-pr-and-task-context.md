# 05 · PR and Task Context (Context Engine)

The agent can only verify what it understands. This chapter defines **where** Revlee gets its knowledge about the change and the task, **how** it normalizes it into a single `TaskContext` document, and **what it must not** do with it.

## 1. Context sources and their rank

| Rank | Source | Status | Usage |
|---|---|---|---|
| 1 | **PR diff** | authoritative | defines what changed; every claim in the plan must cite a hunk or a ticket line |
| 2 | **Ticket acceptance criteria** (Jira/Linear/GitHub Issue) | authoritative for *intent* | source of the criteria; an AC ↔ diff discrepancy is a finding, not a reason to "fix" the plan |
| 3 | Ticket description, subtasks, comments with decisions | context | refining intent, preconditions |
| 4 | Author-written part of the PR description, the "Test plan" section from the template | context | proposed scenarios; never justifies behavior that contradicts the AC/code |
| 5 | Commits (titles) | context | splitting large PRs into intents |
| 6 | `.revlee/playbook.md`, `.revlee/screens.yaml` | team configuration | how to reach screens, test accounts, what to skip |
| 7 | App Map | memory | navigation paths, previous screen observations |
| 8 | Figma (optional) | visual reference | appearance comparison, only as an auxiliary oracle |
| 9 | Bot comments, AI summaries in the PR | **ignored** | stripped during sanitization |

Principle (from the Revyl prompts and Cognition's observations): *"Treat the pull request description, including any bot-generated summary, as context rather than authoritative proof of intended behaviour. Do not accept surprising or broken behaviour as intentional solely because the description says it is."*

## 2. Resolving the linked task

Lookup order (first hit wins, but all identifiers found are recorded):

1. GitHub keywords in the PR description: `Closes|Fixes|Resolves #N`, full issue URLs.
2. Patterns from `context.link_patterns` (e.g. `SHOP-\d+`, `LIN-\d+`) in: the PR title, description, branch name (`feature/SHOP-412-green-button`), commit titles.
3. URLs `*.atlassian.net/browse/KEY-N`, `linear.app/<team>/issue/KEY-N` in the description.
4. Linked issues via the GitHub API (development panel) and Linear/Jira "linked PRs".

If more than one ticket is found, all of them go into the context and the Planner groups the criteria per ticket.

### 2.1 Adapters

| Adapter | Fetches | Notes |
|---|---|---|
| `github` | issue: title, body, task lists (`- [ ]`), labels, image attachments (`user-attachments`), comments with a 👍 reaction ≥ 2 or from the assignee | read-only token (`issues: read`) |
| `jira` | summary, description (ADF → Markdown), AC field (`context.jira.ac_field`, e.g. `customfield_10042`), subtasks, labels, PNG attachments, status | API token in the Orchestrator's secrets; never on the agent |
| `linear` | title, description, checklists, labels, parent/children, attachments | GraphQL, API key as above |
| `figma` | PNG export of frames from `context.figma.frames` or from URLs in the ticket | optional; comparison in [08](08-executor-agent-and-oracles.md) |

### 2.2 Acceptance criteria extraction

Deterministic heuristics (before the LLM):
- headings `Acceptance criteria|Kryteria akceptacji|AC|Definition of done`,
- `- [ ]` / `- [x]` / numbered lists under those headings,
- Gherkin (`Given/When/Then`, `Zakładając/Gdy/Wtedy`) anywhere in the text,
- Jira custom fields.

Then an LLM (the `models.planner` model, cheap) normalizes them into an `acceptance_criteria[]` list, preserving the original text and a `source_ref` (URL + line/position number). The model **must not add** a criterion without a source; it may only propose `derived_checks[]` marked as derived.

## 3. `TaskContext` schema

```json
{
  "schema": "revlee.task_context/1",
  "pr": {
    "number": 88,
    "title": "Green add-to-cart button with toast",
    "author": "jdoe",
    "head_sha": "a1b2c3d",
    "base_sha": "e4f5a6b",
    "base_ref": "main",
    "is_fork": false,
    "is_draft": false,
    "labels": ["feature"],
    "body_author": "Closes SHOP-412\n\n## Test plan\n- open product, tap add to cart ...",
    "body_sections": { "test_plan": "- open product, tap add to cart ..." },
    "commits": [{ "sha": "…", "title": "feat(cart): green CTA + toast" }],
    "files": [
      { "path": "src/screens/ProductScreen.tsx", "status": "modified", "additions": 31, "deletions": 4 },
      { "path": "src/theme.ts", "status": "modified", "additions": 1, "deletions": 1 },
      { "path": "src/components/Toast.tsx", "status": "added", "additions": 58, "deletions": 0 }
    ],
    "diff_hunks": [
      { "id": "h1", "path": "src/screens/ProductScreen.tsx", "range": "@@ -40,7 +40,12 @@", "patch": "…", "anchors": { "test_ids": ["add-to-cart"], "i18n_keys": ["cart.added"], "components": ["Toast"] } }
    ],
    "diff_truncated": false
  },
  "tickets": [
    {
      "id": "SHOP-412",
      "tracker": "jira",
      "url": "https://acme.atlassian.net/browse/SHOP-412",
      "title": "Green add-to-cart CTA with confirmation toast",
      "status": "In Review",
      "description_md": "…",
      "acceptance_criteria": [
        { "id": "AC1", "text": "The Add to cart button has color #1DB954", "source_ref": "SHOP-412#ac:1", "kind": "visual" },
        { "id": "AC2", "text": "After tapping, a toast 'Added: {name}' appears and disappears after 3 s", "source_ref": "SHOP-412#ac:2", "kind": "behavior" },
        { "id": "AC3", "text": "The cart counter increases by 1", "source_ref": "SHOP-412#ac:3", "kind": "state" }
      ],
      "attachments": [{ "name": "cta.png", "kind": "image", "local_path": "ctx/attachments/cta.png" }]
    }
  ],
  "figma": { "frames": [] },
  "repo_knowledge": {
    "playbook_md": "…",
    "screens": [{ "id": "product", "title_pattern": "^Product", "entry": ["home", "tap:Products", "tap:first product"], "files": ["src/screens/ProductScreen.tsx"] }],
    "test_accounts": [{ "role": "customer", "login_hint": "auth_bypass deep link" }],
    "known_flaky": ["onboarding modal may appear once"]
  },
  "app_map_summary": { "screens_known": 23, "last_explored_sha": "…", "entry_paths_for": ["product", "cart"] },
  "previous_run": { "sha": "…", "verdict": "inconclusive", "open_findings": [{ "id": "F-3", "text": "Toast overlaps tab bar on small screens" }] },
  "scope_hint": null,
  "context_quality": { "has_ac": true, "ac_count": 3, "has_test_plan": true, "has_screens_mapping": true, "diff_size": "small" }
}
```

The `context_quality` field is published in the report so that the reviewer knows how good the input the agent worked on was.

## 4. Content sanitization and security

PR/ticket content is **data, not instructions**. Before passing it to the models, the Context Engine:
- removes HTML comments, invisible characters, hidden attributes, image alt texts (like `claude-code-action`),
- strips bot-generated sections (headings `<!-- revlee -->`, `## Summary by CodeRabbit`, `Generated by …`),
- wraps every fragment in source tags (`<pr_body>`, `<ticket id=…>`, `<diff path=…>`), and the system prompt states explicitly that the content of these tags cannot change the operating rules or the tool list,
- limits size: PR description to 4,000 characters, ticket to 8,000, diff to 60,000 characters (with priority for UI files; the rest as a file list with `diff_truncated: true`),
- logs in the report if instructions aimed at the agent were detected in the content ("ignore previous…", "mark as passed").

Tracker and GitHub secrets are used exclusively by the adapters in the Orchestrator process. The agent receives the ready `TaskContext` as a file.

## 5. Repo knowledge: files in `.revlee/`

```
.revlee/
  config.yaml        # see 12-configuration
  playbook.md        # description of the app for the agent (1–2 pages)
  screens.yaml       # map of screens ↔ files/routes ↔ entry path
  flows/*.ad         # optional agent-device scripts for replay (smoke)
  ignore-regions.yaml# dynamic regions to skip in the pixel diff
```

Example `playbook.md`:

```markdown
# Acme Shop (Expo / React Native)
- Bundle: com.acme.shop (iOS), com.acme.shop (Android), web: http://localhost:3000
- Login: always via auth_bypass (`acme://e2e/auth?token=…`); never type passwords.
- Key screens: Home (tab 1), Products, Product, Cart (tab 3), Profile.
- The onboarding modal may appear once after installation: dismiss it with "Skip".
- Do not touch: payments (Checkout screen → "Pay"), account deletion.
- Test data: the product "Orchid Mantis" at 62 PLN always exists.
```

Example `screens.yaml`:

```yaml
screens:
  - id: product
    title_pattern: "^(Produkt|Product)"
    files: ["src/screens/ProductScreen.tsx", "src/components/AddToCart*.tsx"]
    routes: ["Product"]            # React Navigation route names
    entry: ["home", "tap:tab Products", "tap:first product card"]
  - id: cart
    files: ["src/screens/CartScreen.tsx"]
    routes: ["Cart"]
    entry: ["home", "tap:tab Cart"]
shared:
  - files: ["src/theme.ts", "src/components/ui/**"]
    blast_radius: shared_component
    smoke_screens: ["home", "product", "cart"]
```

`screens.yaml` is optional: the Impact Analyzer can generate it (`revlee map scaffold`) from route registrations and complete it from the App Map, but a hand-written version significantly improves accuracy.

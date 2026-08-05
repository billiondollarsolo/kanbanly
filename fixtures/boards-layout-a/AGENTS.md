# kanbanly agent conventions

This repo is a **kanbanly boards** repository. Cards are markdown files with YAML frontmatter.

## Layout A

Each board lives in its own subdirectory with `board.yml` and a `cards/` folder:

```
backend/
  board.yml
  cards/
    c-xxxx-title.md
web/
  board.yml
  cards/
```

## Card schema (worked example)

```markdown
---
id: c-8f3a
title: Refactor auth middleware
column: doing
order: "0|hzzzzz:"
priority: P1
labels: [backend, security]
assignee: claude
due: 2026-08-09
pr: mj/api-service#418
updated: 2026-08-04T12:53:00Z
---

## Status
Auth middleware split into validate/issue. Tests green.

## Log
- 2026-08-02 claude: created from issue #214
- 2026-08-03 claude: extracted validateSession()
- 2026-08-04 claude: tests green, 12 added
```

## Order rule

- **Agents always append to the end of a column.**
- Humans may drag anywhere (order between neighbours).

## Status vs Log

- `## Status` — **overwrite** on every state change (the "now").
- `## Log` — **append-only**, dated and attributed. Never edit another author's Log lines.

## Required frontmatter

`id`, `title`, `column`, `order`, `updated` are required. Bump `updated` to ISO-8601 UTC on every write.

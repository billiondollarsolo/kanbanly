import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { defaultBoardYaml } from "./board.ts";

const POINTER_MARKER = "<!-- kanbanly -->";

export type SetupOptions = {
  /** Code repo root (where .kanbanly.yml is written) */
  codeRepoPath: string;
  /** Boards repo path (local clone) */
  boardsRepoPath: string;
  /** Remote URL for boards */
  remote: string;
  /** Board id for layout A; omit for layout B */
  board?: string;
  /** Path to merge-driver executable or command */
  mergeDriverCommand?: string;
};

function ensureFile(path: string, content: string): void {
  if (!existsSync(path)) {
    writeFileSync(path, content, "utf8");
  }
}

function appendPointerLine(filePath: string, line: string): void {
  let existing = "";
  if (existsSync(filePath)) {
    existing = readFileSync(filePath, "utf8");
  }
  if (existing.includes(POINTER_MARKER) || existing.includes(line.trim())) {
    return; // idempotent
  }
  const sep = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  const block = `${sep}\n${POINTER_MARKER}\n${line}\n`;
  if (existsSync(filePath)) {
    appendFileSync(filePath, block, "utf8");
  } else {
    writeFileSync(filePath, block.trimStart() + "\n", "utf8");
  }
}

/**
 * Scaffold a boards repo and wire a code repo to it.
 */
export function kanbanlySetup(options: SetupOptions): {
  kanbanlyYml: string;
  gitattributes: string;
  boardYml?: string;
} {
  const { codeRepoPath, boardsRepoPath, remote, board } = options;

  mkdirSync(codeRepoPath, { recursive: true });
  mkdirSync(boardsRepoPath, { recursive: true });

  // .kanbanly.yml in code repo
  const ymlLines = [`remote: ${remote}`];
  if (board) ymlLines.push(`board:  ${board}`);
  const kanbanlyYml = ymlLines.join("\n") + "\n";
  writeFileSync(join(codeRepoPath, ".kanbanly.yml"), kanbanlyYml, "utf8");

  // Pointer lines in AGENTS.md and CLAUDE.md
  const pointer = `Boards live at ${remote}${board ? ` (board: ${board})` : ""}. See .kanbanly.yml.`;
  appendPointerLine(join(codeRepoPath, "AGENTS.md"), pointer);
  appendPointerLine(join(codeRepoPath, "CLAUDE.md"), pointer);

  // Boards repo: .gitattributes
  const gitattributes = "**/cards/*.md merge=kanbanly\n";
  const gaPath = join(boardsRepoPath, ".gitattributes");
  if (existsSync(gaPath)) {
    const cur = readFileSync(gaPath, "utf8");
    if (!cur.includes("merge=kanbanly")) {
      appendFileSync(gaPath, gitattributes, "utf8");
    }
  } else {
    writeFileSync(gaPath, gitattributes, "utf8");
  }

  // Scaffold board.yml + cards/
  let boardYml: string | undefined;
  const boardRoot = board ? join(boardsRepoPath, board) : boardsRepoPath;
  mkdirSync(join(boardRoot, "cards"), { recursive: true });
  const byPath = join(boardRoot, "board.yml");
  if (!existsSync(byPath)) {
    boardYml = defaultBoardYaml();
    writeFileSync(byPath, boardYml, "utf8");
  }

  // Boards-repo AGENTS.md
  const agentsPath = join(boardsRepoPath, "AGENTS.md");
  if (!existsSync(agentsPath)) {
    writeFileSync(agentsPath, boardsAgentsMd(), "utf8");
  }

  // git config merge driver in boards clone
  const driver =
    options.mergeDriverCommand ?? "kanbanly merge-driver %O %A %B %L %P";
  if (existsSync(join(boardsRepoPath, ".git"))) {
    spawnSync("git", ["config", "merge.kanbanly.name", "kanbanly card merge"], {
      cwd: boardsRepoPath,
    });
    spawnSync("git", ["config", "merge.kanbanly.driver", driver], {
      cwd: boardsRepoPath,
    });
  }

  return { kanbanlyYml, gitattributes, boardYml };
}

/** Install skill into known harness directories. */
export function skillInstall(options?: {
  path?: string;
  skillContent?: string;
  home?: string;
}): { installed: string[]; skipped: string[] } {
  const home = options?.home ?? process.env.HOME ?? "";
  const content =
    options?.skillContent ??
    `# kanbanly skill\n\nRun \`kanbanly setup\` to wire a code repo to a boards git remote.\n`;

  const installed: string[] = [];
  const skipped: string[] = [];

  if (options?.path) {
    mkdirSync(options.path, { recursive: true });
    const dest = join(options.path, "kanbanly", "SKILL.md");
    mkdirSync(join(options.path, "kanbanly"), { recursive: true });
    writeFileSync(dest, content, "utf8");
    installed.push(dest);
    return { installed, skipped };
  }

  const candidates = [
    join(home, ".claude", "skills"),
    join(home, ".codex", "skills"),
    join(home, ".agents", "skills"),
  ];

  for (const dir of candidates) {
    if (!existsSync(dir)) {
      skipped.push(dir);
      continue;
    }
    const destDir = join(dir, "kanbanly");
    mkdirSync(destDir, { recursive: true });
    const dest = join(destDir, "SKILL.md");
    writeFileSync(dest, content, "utf8");
    installed.push(dest);
  }

  return { installed, skipped };
}

export function boardsAgentsMd(): string {
  return `# kanbanly agent conventions

This repo is a **kanbanly boards** repository. Cards are markdown files with YAML frontmatter.

## Card schema (worked example)

\`\`\`markdown
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
JWT rotation still open — blocked on picking a key store.

## Log
- 2026-08-02 claude: created from issue #214
- 2026-08-03 claude: extracted validateSession()
- 2026-08-04 claude: tests green, 12 added
\`\`\`

## ID generation (executable steps)

1. List files in this board's \`cards/\` directory.
2. Collect existing ids matching \`c-[a-z0-9]+\`.
3. Mint \`c-\` + 4–6 random base36 characters.
4. If the id already exists, retry.
5. Filename: \`<id>-<slugified-title>.md\`.

## Order rule

- **Agents always append to the end of a column:**
  1. Read all cards in the target column.
  2. Take the largest \`order\` value.
  3. Mint a new key that sorts **after** it.
  4. **Never insert between** neighbours.
- Humans may drag anywhere (order between neighbours).

## Status vs Log

- \`## Status\` — **overwrite** on every state change (the "now").
- \`## Log\` — **append-only**, dated and attributed. Never edit another author's Log lines.

### Good Status rewrite

Before: \`Exploring auth options.\`
After: \`Auth middleware split into validate/issue. Tests green.\`

### Good Log append

\`- 2026-08-04 claude: tests green, 12 added\`

## Column transitions

| Event | Column |
|-------|--------|
| Start work | Doing |
| Open PR | Review |
| Finish | Done |

## Shared checkouts

Re-read the card file immediately before write. No lock files — races are a known limit.

## Required frontmatter

\`id\`, \`title\`, \`column\`, \`order\`, \`updated\` are required. Bump \`updated\` to ISO-8601 UTC on every write.
`;
}

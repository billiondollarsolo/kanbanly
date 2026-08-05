/**
 * Project cockpit helpers: code-repo binding + notes paths + git-log parsing.
 * Pure where possible — no I/O except types for settings shapes.
 */

export type CodeBinding = {
  /** Absolute (or resolved) path to the project git root. */
  path?: string;
  /** Optional remote URL (documentation / future clone-on-demand). */
  remote?: string;
};

export type ProjectCommit = {
  sha: string;
  date: string;
  author: string;
  subject: string;
};

/** Extract code binding from board.yml `settings` bag. */
export function resolveCodeBinding(
  settings: Record<string, unknown> | undefined | null,
): CodeBinding | null {
  if (!settings || typeof settings !== "object") return null;
  const raw = settings.code;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const path = typeof o.path === "string" ? o.path.trim() : "";
  const remote = typeof o.remote === "string" ? o.remote.trim() : "";
  if (!path && !remote) return null;
  return {
    path: path || undefined,
    remote: remote || undefined,
  };
}

/** Merge code binding into settings without dropping other keys. */
export function mergeCodeBindingSettings(
  settings: Record<string, unknown> | undefined | null,
  binding: CodeBinding | null,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...(settings ?? {}) };
  if (!binding || (!binding.path && !binding.remote)) {
    delete next.code;
    return next;
  }
  const code: Record<string, string> = {};
  if (binding.path?.trim()) code.path = binding.path.trim();
  if (binding.remote?.trim()) code.remote = binding.remote.trim();
  next.code = code;
  return next;
}

/**
 * Parse `git log --format=%H%x09%aI%x09%an%x09%s` lines into commits.
 */
export function parseGitLogLines(stdout: string): ProjectCommit[] {
  const entries: ProjectCommit[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const [sha, date, author, ...rest] = line.split("\t");
    if (!sha) continue;
    entries.push({
      sha,
      date: date ?? "",
      author: author ?? "",
      subject: rest.join("\t"),
    });
  }
  return entries;
}

/** Relative path of notes file inside a board directory. */
export function boardNotesRelPath(boardId: string): string {
  if (boardId === "." || boardId === "") return "NOTES.md";
  return `${boardId.replace(/\\/g, "/").replace(/\/+$/, "")}/NOTES.md`;
}

export function defaultProjectNotes(title?: string): string {
  const name = title?.trim() || "Project";
  return `# ${name}

## Intent
What we are building and why.

## Decisions
- (add dated decisions here)

## Open risks
- 

## Agent standing orders
- Read this file and the board before starting work.
- Work only via cards; overwrite Status; append Log.
- After code commits, log the short SHA on the card.
`;
}

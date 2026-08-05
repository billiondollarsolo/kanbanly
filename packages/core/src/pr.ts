/**
 * PR / forge link helpers (pure).
 * Card frontmatter `pr:` e.g. "mj/api-service#418" or full GitHub URL.
 */

export type ParsedPrRef = {
  /** Original pr: string */
  raw: string;
  owner?: string;
  repo?: string;
  number?: number;
  /** https URL when parseable as GitHub-style */
  url?: string;
  /** Short label for badge, e.g. "#418" or full raw */
  label: string;
};

const OWNER_REPO_NUM = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#(\d+)$/;
const HASH_ONLY = /^#?(\d+)$/;
const GITHUB_URL =
  /^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)/i;

/**
 * Parse a `pr:` frontmatter value into structured ref + URL when possible.
 */
export function parsePrRef(raw: string | undefined | null): ParsedPrRef | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;

  const gh = s.match(GITHUB_URL);
  if (gh) {
    const number = Number(gh[3]);
    return {
      raw: s,
      owner: gh[1],
      repo: gh[2],
      number,
      url: `https://github.com/${gh[1]}/${gh[2]}/pull/${number}`,
      label: `#${number}`,
    };
  }

  const m = s.match(OWNER_REPO_NUM);
  if (m) {
    const number = Number(m[3]);
    return {
      raw: s,
      owner: m[1],
      repo: m[2],
      number,
      url: `https://github.com/${m[1]}/${m[2]}/pull/${number}`,
      label: `#${number}`,
    };
  }

  const n = s.match(HASH_ONLY);
  if (n) {
    return { raw: s, number: Number(n[1]), label: `#${n[1]}` };
  }

  // Unknown shape — still show raw as badge
  return {
    raw: s,
    url: s.startsWith("http") ? s : undefined,
    label: s.length > 24 ? s.slice(0, 22) + "…" : s,
  };
}

export type PrState = "open" | "closed" | "merged" | "draft" | "unknown";

export type PrStatus = {
  ref: ParsedPrRef;
  state: PrState;
  title?: string;
  /** Suggested column when PR is open (docs: lands REVIEW). */
  suggestedColumn?: string;
  source: "static" | "github";
};

/**
 * Suggest pending-work target column from PR state (docs overlay).
 */
export function suggestedColumnForPr(state: PrState): string | undefined {
  if (state === "open" || state === "draft") return "review";
  if (state === "merged") return "done";
  return undefined;
}

/**
 * Build static PR status from frontmatter only (no network).
 */
export function staticPrStatus(raw: string | undefined | null): PrStatus | null {
  const ref = parsePrRef(raw);
  if (!ref) return null;
  return {
    ref,
    state: "unknown",
    suggestedColumn: "review",
    source: "static",
  };
}

/**
 * Fetch GitHub PR status when GITHUB_TOKEN (or opts.token) is available.
 * Falls back to static status on failure / missing token.
 */
export async function fetchPrStatus(
  raw: string | undefined | null,
  options?: { token?: string; fetchImpl?: typeof fetch },
): Promise<PrStatus | null> {
  const ref = parsePrRef(raw);
  if (!ref) return null;

  const token = options?.token ?? process.env.GITHUB_TOKEN;
  if (!token || !ref.owner || !repoOk(ref)) {
    return staticPrStatus(raw);
  }

  const fetchFn = options?.fetchImpl ?? fetch;
  try {
    const url = `https://api.github.com/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`;
    const res = await fetchFn(url, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "user-agent": "kanbanly",
      },
    });
    if (!res.ok) return staticPrStatus(raw);
    const body = (await res.json()) as {
      state?: string;
      draft?: boolean;
      merged?: boolean;
      title?: string;
    };
    let state: PrState = "unknown";
    if (body.merged) state = "merged";
    else if (body.draft) state = "draft";
    else if (body.state === "open") state = "open";
    else if (body.state === "closed") state = "closed";
    return {
      ref,
      state,
      title: body.title,
      suggestedColumn: suggestedColumnForPr(state),
      source: "github",
    };
  } catch {
    return staticPrStatus(raw);
  }
}

function repoOk(ref: ParsedPrRef): boolean {
  return !!(ref.owner && ref.repo && ref.number);
}

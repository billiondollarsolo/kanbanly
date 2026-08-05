/**
 * Classify git push / network errors for OSS error banners (§5.3).
 */

export type PushErrorKind =
  | "offline"
  | "credential"
  | "conflict"
  | "unknown";

export type ClassifiedPushError = {
  kind: PushErrorKind;
  /** Short banner title */
  title: string;
  /** Actionable detail (scope / file names when known) */
  detail: string;
  /** Whether local commits should keep working (always true for these kinds). */
  localWritesOk: boolean;
  /** Sync freeze for this remote until user resolves (conflict). */
  freezeSync: boolean;
};

/**
 * Classify stderr/stdout from failed git push / network errors.
 */
export function classifyPushError(
  message: string,
  options?: { files?: string[] },
): ClassifiedPushError {
  const m = message ?? "";
  const lower = m.toLowerCase();

  // No credential was supplied at all. git fell back to an interactive prompt
  // and died because there is no TTY. This is NOT a rejected token: the remote
  // was never even asked. Telling the user to re-enter a valid PAT sends them
  // to fix the one thing that is not broken, so it gets its own message.
  const noCredentialSupplied =
    /could not read username|could not read password|terminal prompts disabled/i.test(
      m,
    ) && !/\b401\b|unauthorized|bad credentials|invalid username or token/i.test(m);
  if (noCredentialSupplied) {
    return {
      kind: "credential",
      title: "No credential supplied to git",
      detail:
        "git had no username/token to send, so the remote was never contacted — " +
        "this is a binding problem, not a bad PAT. Check that this connection " +
        "has a saved credential selected (Settings → Repositories).",
      localWritesOk: true,
      freezeSync: false,
    };
  }

  // Explicit HTTP status first (may appear alongside "unable to access")
  const has401 = /\b401\b|unauthorized|authentication failed|invalid username or token|bad credentials|terminal prompts disabled|ghp_[a-z0-9]+.*invalid/i.test(
    m,
  );
  const has403 = /\b403\b|forbidden|write access not granted|permission denied \(publickey\)|insufficient.*scope|missing.*scope/i.test(
    m,
  );
  // Prefer 401 when both-ish signals (e.g. "Access denied" + "401")
  if (has401 || has403) {
    let scope = "";
    const scopeMatch = m.match(
      /(?:missing|required|insufficient)\s+scopes?\s*[:=]?\s*([a-z0-9_:,\s-]+)/i,
    );
    if (scopeMatch) scope = scopeMatch[1]!.trim();
    // If message contains 401, treat as 401 even if "access denied" present
    const as401 = has401 && (/\b401\b/i.test(m) || !has403);
    return {
      kind: "credential",
      title: as401
        ? "Credential invalid or expired (401)"
        : "Credential lacks permission (403)",
      detail: scope
        ? `Missing or insufficient scope: ${scope}. Re-enter credentials (SSH agent or PAT).`
        : as401
          ? "Authentication failed — re-enter PAT or unlock SSH agent, then retry."
          : "Access denied — check repo write access / token scopes, then retry.",
      localWritesOk: true,
      freezeSync: false,
    };
  }

  // Network / offline (after auth — "unable to access" often co-occurs with 401/403)
  if (
    /could not resolve host|network is unreachable|nodename nor servname|temporary failure in name resolution|connection refused|connection timed out|failed to connect|unable to access|ssl.*error|the remote end hung up|could not read from remote/i.test(
      m,
    ) ||
    /enotfound|econnrefused|etimedout|enetunreach/i.test(lower)
  ) {
    return {
      kind: "offline",
      title: "Offline — remote unreachable",
      detail:
        "Local commits keep working. Pushes will retry when the network is back.",
      localWritesOk: true,
      freezeSync: false,
    };
  }

  // Remaining credential-ish without explicit status
  if (
    /access denied|repository not found|authentication|bad credentials/i.test(m)
  ) {
    return {
      kind: "credential",
      title: "Credential invalid or missing access",
      detail:
        "Check SSH agent / PAT (repo write access). Re-enter credentials and retry push.",
      localWritesOk: true,
      freezeSync: false,
    };
  }

  // Merge / non-ff conflict after retries
  if (
    /conflict|non-fast-forward|failed to merge|diverged|could not apply|unmerged paths|resolve.*conflict/i.test(
      m,
    )
  ) {
    const files = options?.files?.filter(Boolean) ?? [];
    const filePart =
      files.length > 0
        ? ` Diverged: ${files.slice(0, 8).join(", ")}${files.length > 8 ? "…" : ""}.`
        : "";
    return {
      kind: "conflict",
      title: "Unresolvable conflict — sync frozen",
      detail: `Push/rebase failed after retries.${filePart} Use keep-mine / keep-theirs on diverged cards, then retry.`,
      localWritesOk: true,
      freezeSync: true,
    };
  }

  return {
    kind: "unknown",
    title: "Push failed",
    detail: m.slice(0, 280) || "Unknown push error. Retry when ready.",
    localWritesOk: true,
    freezeSync: false,
  };
}

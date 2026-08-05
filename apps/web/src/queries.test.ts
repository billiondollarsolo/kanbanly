import { describe, expect, test } from "bun:test";
import { QueryObserver } from "@tanstack/react-query";
import {
  PR_POLL_MS,
  SYNC_POLL_MS,
  codeHistoryQuery,
  commitsByCardId,
  createQueryClient,
  makeInvalidators,
  prRefsFromCards,
  qk,
} from "./queries.ts";
import type { CodeHistoryResponse, ProjectCommit } from "./api.ts";

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function unboundResponse(boardId: string): CodeHistoryResponse {
  return {
    boardId,
    source: "code",
    bound: false,
    binding: null,
    codePath: null,
    error: "No source code repo bound.",
    commits: [],
    count: 0,
  };
}

describe("qk", () => {
  test("every key hangs off one root so the live channel can sweep it", () => {
    for (const key of [
      qk.boards(),
      qk.board("b1"),
      qk.portfolio(),
      qk.sync(),
      qk.codeHistory("b1", 200),
      qk.cardHistory("b1", "c-1"),
    ]) {
      expect(key[0]).toBe(qk.all[0]);
    }
  });

  test("a board key is stable and separates boards", () => {
    expect(qk.board("b1")).toEqual(qk.board("b1"));
    expect(qk.board("b1")).not.toEqual(qk.board("b2"));
  });

  test("code history is keyed on board AND limit", () => {
    // The card modal reads 200 commits, the history modal reads 50. They are
    // genuinely different reads and must not share a cache slot.
    expect(qk.codeHistory("b1", 200)).not.toEqual(qk.codeHistory("b1", 50));
    expect(qk.codeHistory("b1", 200).slice(0, 3)).toEqual([
      ...qk.codeHistoryRoot(),
      "b1",
    ]);
  });

  test("the family prefix is a prefix of each instance", () => {
    expect(qk.board("b1").slice(0, 2)).toEqual([...qk.boardRoot()]);
    expect(qk.activity("b1", 80).slice(0, 2)).toEqual([...qk.activityRoot()]);
    expect(qk.boardNotes("b1").slice(0, 2)).toEqual([...qk.boardNotesRoot()]);
  });

  test("pr-status keys collapse to the ref list, not the cards array", () => {
    expect(qk.prStatuses(["a#1", "b#2"])).toEqual(qk.prStatuses(["a#1", "b#2"]));
    expect(qk.prStatuses([])).toEqual(qk.prStatuses([]));
  });
});

describe("createQueryClient defaults", () => {
  test("no retries — a failure surfaces as fast as the old bare fetch did", () => {
    const d = createQueryClient().getDefaultOptions();
    expect(d.queries?.retry).toBe(false);
    expect(d.mutations?.retry).toBe(false);
  });

  test("focus does not refetch; SSE is the freshness channel", () => {
    const d = createQueryClient().getDefaultOptions();
    expect(d.queries?.refetchOnWindowFocus).toBe(false);
    expect(d.queries?.refetchOnReconnect).toBe(true);
  });

  test("a short staleTime collapses the burst of reads one drag used to fire", () => {
    expect(createQueryClient().getDefaultOptions().queries?.staleTime).toBe(
      5_000,
    );
  });

  test("the poll cadences match the intervals they replaced", () => {
    expect(SYNC_POLL_MS).toBe(1_500);
    expect(PR_POLL_MS).toBe(60_000);
  });
});

describe("code history cannot self-cancel", () => {
  test("a response that lands after the last observer left still populates the cache", async () => {
    // The regression this guards: the old effect kept its own marker in its
    // dependency array, so re-running it tore down the very request it started
    // and the card modal showed no commits.
    const qc = createQueryClient();
    const d = deferred<CodeHistoryResponse>();
    let calls = 0;

    const observer = new QueryObserver(qc, {
      ...codeHistoryQuery("b1", 200),
      queryFn: () => {
        calls += 1;
        return d.promise;
      },
    });
    const unsubscribe = observer.subscribe(() => undefined);

    // Card modal closes while the request is still in the air.
    unsubscribe();
    d.resolve({
      boardId: "b1",
      source: "code",
      bound: true,
      binding: { path: "/src" },
      codePath: "/src",
      error: null,
      commits: [{ sha: "abc1234", subject: "fix c-1", author: "mj", date: "2026-01-01" }],
      count: 1,
    });
    await d.promise;
    await Promise.resolve();

    expect(calls).toBe(1);
    expect(
      qc.getQueryData<CodeHistoryResponse>(qk.codeHistory("b1", 200))?.commits,
    ).toHaveLength(1);
    qc.clear();
  });

  test("opening two cards on the same board fires one request, not two", async () => {
    const qc = createQueryClient();
    let calls = 0;
    const opts = {
      ...codeHistoryQuery("b1", 200),
      queryFn: async () => {
        calls += 1;
        return unboundResponse("b1");
      },
    };
    await Promise.all([qc.fetchQuery(opts), qc.fetchQuery(opts)]);
    expect(calls).toBe(1);
    qc.clear();
  });
});

describe("unbound source repo", () => {
  test("an unbound board yields no commits for any card", () => {
    const res = unboundResponse("b1");
    const byCard = commitsByCardId(res.commits);
    // DetailPanel renders the section only when this list is non-empty.
    expect(byCard.size).toBe(0);
    expect(byCard.get("c-a1b2") ?? []).toEqual([]);
  });

  test("a failed read (no data at all) is also just an empty list", () => {
    expect(commitsByCardId(undefined).size).toBe(0);
  });
});

describe("commitsByCardId", () => {
  const commits: ProjectCommit[] = [
    {
      sha: "aaa1111",
      subject: "c-A1 ship it",
      author: "mj",
      date: "2026-01-02",
      cardIds: ["c-a1"],
    },
    {
      sha: "bbb2222",
      subject: "c-A1 c-b2 follow up",
      author: "mj",
      date: "2026-01-03",
      cardIds: ["c-a1", "c-b2"],
    },
    {
      sha: "ccc3333",
      subject: "chore",
      author: "mj",
      date: "2026-01-04",
    },
  ];

  test("one commit can name several cards", () => {
    const m = commitsByCardId(commits);
    expect(m.get("c-a1")?.map((c) => c.sha)).toEqual(["aaa1111", "bbb2222"]);
    expect(m.get("c-b2")?.map((c) => c.sha)).toEqual(["bbb2222"]);
  });

  test("lookup is case-folded, matching how the detail panel asks", () => {
    const m = commitsByCardId([
      { sha: "d", subject: "s", author: "a", date: "d", cardIds: ["C-Upper"] },
    ]);
    expect(m.get("c-upper")).toHaveLength(1);
  });

  test("commits naming no card are dropped", () => {
    expect(commitsByCardId(commits).has("chore")).toBe(false);
  });
});

describe("prRefsFromCards", () => {
  test("dedupes and sorts, so an unchanged board keeps one cache key", () => {
    const a = prRefsFromCards([
      { pr: "o/r#2" },
      { pr: "o/r#1" },
      { pr: "o/r#2" },
      {},
    ]);
    const b = prRefsFromCards([{ pr: "o/r#1" }, { pr: "o/r#2" }]);
    expect(a).toEqual(["o/r#1", "o/r#2"]);
    expect(qk.prStatuses(a)).toEqual(qk.prStatuses(b));
  });

  test("a board with no PR refs asks for nothing", () => {
    expect(prRefsFromCards([{}, {}])).toEqual([]);
    expect(prRefsFromCards(undefined)).toEqual([]);
  });
});

describe("invalidators", () => {
  test("a live sha does not disturb the source-repo commit list", async () => {
    const qc = createQueryClient();
    qc.setQueryData(qk.codeHistory("b1", 200), unboundResponse("b1"));
    qc.setQueryData(qk.board("b1"), { id: "b1" });

    await makeInvalidators(qc).live();

    expect(qc.getQueryState(qk.codeHistory("b1", 200))?.isInvalidated).toBe(
      false,
    );
    expect(qc.getQueryState(qk.board("b1"))?.isInvalidated).toBe(true);
    qc.clear();
  });

  test("a board write marks the board, the board list and the portfolio stale", async () => {
    const qc = createQueryClient();
    qc.setQueryData(qk.board("b1"), { id: "b1" });
    qc.setQueryData(qk.board("b2"), { id: "b2" });
    qc.setQueryData(qk.boards(), { boards: [], sha: null });
    qc.setQueryData(qk.portfolio(), { tiles: [] });

    await makeInvalidators(qc).boardWrite("b1");

    expect(qc.getQueryState(qk.board("b1"))?.isInvalidated).toBe(true);
    expect(qc.getQueryState(qk.boards())?.isInvalidated).toBe(true);
    expect(qc.getQueryState(qk.portfolio())?.isInvalidated).toBe(true);
    // Other boards are untouched — a write is scoped to the board it hit.
    expect(qc.getQueryState(qk.board("b2"))?.isInvalidated).toBe(false);
    qc.clear();
  });

  test("codeHistory(boardId) scopes to one board across both limits", async () => {
    const qc = createQueryClient();
    qc.setQueryData(qk.codeHistory("b1", 50), unboundResponse("b1"));
    qc.setQueryData(qk.codeHistory("b1", 200), unboundResponse("b1"));
    qc.setQueryData(qk.codeHistory("b2", 50), unboundResponse("b2"));

    await makeInvalidators(qc).codeHistory("b1");

    expect(qc.getQueryState(qk.codeHistory("b1", 50))?.isInvalidated).toBe(true);
    expect(qc.getQueryState(qk.codeHistory("b1", 200))?.isInvalidated).toBe(
      true,
    );
    expect(qc.getQueryState(qk.codeHistory("b2", 50))?.isInvalidated).toBe(
      false,
    );
    qc.clear();
  });
});

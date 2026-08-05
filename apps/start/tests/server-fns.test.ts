/**
 * TanStack Start board-service (real git fixture) + route structure proof.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, cpSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const fixture = join(import.meta.dir, "../../../fixtures/boards-layout-a");

function git(cwd: string, args: string[]) {
  return spawnSync("git", args, { cwd, encoding: "utf8" });
}

describe("Start board-service (real git)", () => {
  let repo: string;
  let prevRepo: string | undefined;

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "kanbanly-start-"));
    cpSync(fixture, repo, { recursive: true });
    git(repo, ["init"]);
    git(repo, ["config", "user.name", "t"]);
    git(repo, ["config", "user.email", "t@t"]);
    git(repo, ["checkout", "-b", "main"]);
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "init"]);
    prevRepo = process.env.KANBANLY_REPO;
    process.env.KANBANLY_REPO = repo;
    process.env.KANBANLY_FETCH_REMOTE = "0";
  });

  afterAll(() => {
    if (prevRepo === undefined) delete process.env.KANBANLY_REPO;
    else process.env.KANBANLY_REPO = prevRepo;
    try {
      rmSync(repo, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  test("session + health", async () => {
    const { getSession } = await import("../src/server/session.ts");
    const s = await getSession();
    expect(s.connected.path).toBe(repo);

    const { health } = await import("../src/server/board-service.ts");
    const h = await health();
    expect(h.ok).toBe(true);
    expect(h.product).toBe("kanbanly-start");
    expect(h.repo).toBe(repo);
  });

  test("listBoards + getBoard + createCard commits", async () => {
    const svc = await import("../src/server/board-service.ts");
    const list = await svc.listBoards();
    expect(list.boards.some((b) => b.id === "backend")).toBe(true);

    const board = await svc.getBoard("backend");
    expect(board.id).toBe("backend");
    expect(board.cards.length).toBeGreaterThan(0);

    const created = await svc.createCard("backend", "Start card", "backlog");
    expect(created.ok).toBe(true);
    expect(created.card.title).toBe("Start card");
    expect(created.card.id).toMatch(/^c-/);

    const log = git(repo, ["log", "-1", "--pretty=%s"]);
    expect(log.stdout).toMatch(/create c-/);
  });

  test("moveCard via service", async () => {
    const svc = await import("../src/server/board-service.ts");
    const created = await svc.createCard("backend", "Move me", "backlog");
    const moved = await svc.moveCard(
      "backend",
      created.card.id,
      "doing",
      "z9",
    );
    expect(moved.ok).toBe(true);
    expect(moved.column).toBe("doing");
    const board = await svc.getBoard("backend");
    const card = board.cards.find((c) => c.id === created.card.id);
    expect(card?.column).toBe("doing");
  });

  test("Start routes + board-fns wrap createServerFn", async () => {
    const root = join(import.meta.dir, "../src/routes");
    expect(existsSync(join(root, "index.tsx"))).toBe(true);
    expect(existsSync(join(root, "b.$boardId.tsx"))).toBe(true);
    expect(existsSync(join(root, "__root.tsx"))).toBe(true);
    expect(existsSync(join(root, "api.events.ts"))).toBe(true);

    const boardRoute = await Bun.file(join(root, "b.$boardId.tsx")).text();
    expect(boardRoute).toContain("BoardApp");
    expect(boardRoute).toContain("createFileRoute");
    expect(boardRoute).toContain("/b/$boardId");

    const sse = await Bun.file(join(root, "api.events.ts")).text();
    expect(sse).toContain("/api/events");
    expect(sse).toContain("live.subscribe");

    const boardUi = await Bun.file(
      join(import.meta.dir, "../src/components/board/Board.tsx"),
    ).text();
    expect(boardUi).toContain("staticPrStatus");
    expect(boardUi).toContain("PrBadge");

    const fns = await Bun.file(
      join(import.meta.dir, "../src/server/board-fns.ts"),
    ).text();
    expect(fns).toContain("createServerFn");
    expect(fns).toContain("listBoardsFn");
    expect(fns).toContain("moveCardFn");

    const pkg = JSON.parse(
      await Bun.file(join(import.meta.dir, "../package.json")).text(),
    );
    expect(pkg.dependencies["@tanstack/react-start"]).toBeTruthy();
    expect(pkg.dependencies["@kanbanly/core"]).toBeTruthy();
    expect(pkg.dependencies["@kanbanly/server"]).toBeTruthy();
  });

  test("LiveHub SSE hello from session", async () => {
    const { getSession } = await import("../src/server/session.ts");
    const s = await getSession();
    const res = s.live.subscribe();
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value);
      if (buf.includes("\n\n")) break;
    }
    await reader.cancel();
    expect(buf).toContain("event: board");
    expect(buf).toContain("hello");
  });
});


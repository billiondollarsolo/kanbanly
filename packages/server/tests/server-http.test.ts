import { describe, expect, test, afterEach } from "bun:test";
import { connectLocalRepo } from "../src/connect.ts";
import { BoardIndexStore } from "../src/index-store.ts";
import { startServer } from "../src/app.ts";
import { makeTempRepoFromFixture, freePort } from "./helpers.ts";

describe("HTTP server (Bun.serve on loopback)", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  test("GET /health returns { ok: true }", async () => {
    const port = await freePort();
    const server = startServer({ host: "127.0.0.1", port });
    cleanups.push(() => server.stop(true));

    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; live?: unknown };
    expect(body.ok).toBe(true);
  });

  test("GET /api/boards lists layout A boards", async () => {
    const ctx = makeTempRepoFromFixture();
    cleanups.push(ctx.cleanup);

    const store = new BoardIndexStore();
    const connected = await connectLocalRepo(ctx.repoPath, { indexStore: store });
    const port = await freePort();
    const server = startServer({
      host: "127.0.0.1",
      port,
      connected,
      indexStore: store,
    });
    cleanups.push(() => server.stop(true));

    const res = await fetch(`http://127.0.0.1:${port}/api/boards`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      boards: Array<{ id: string; cardCount: number }>;
      sha: string;
    };
    expect(body.boards.map((b) => b.id).sort()).toEqual(["backend", "web"]);
    const backend = body.boards.find((b) => b.id === "backend")!;
    expect(backend.cardCount).toBe(2);
    expect(body.sha).toMatch(/^[0-9a-f]{40}$/);
  });

  test("GET /api/boards/:boardId returns board.yml columns + cards by column", async () => {
    const ctx = makeTempRepoFromFixture();
    cleanups.push(ctx.cleanup);

    const store = new BoardIndexStore();
    const connected = await connectLocalRepo(ctx.repoPath, { indexStore: store });
    const port = await freePort();
    const server = startServer({
      host: "127.0.0.1",
      port,
      connected,
      indexStore: store,
    });
    cleanups.push(() => server.stop(true));

    const res = await fetch(`http://127.0.0.1:${port}/api/boards/backend`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      columns: Array<{ id: string; name: string }>;
      cardsByColumn: Record<string, Array<{ id: string; title: string }>>;
      cards: Array<{ id: string; title: string }>;
    };

    expect(body.id).toBe("backend");
    expect(body.columns.map((c) => c.id)).toEqual([
      "backlog",
      "doing",
      "review",
      "done",
    ]);
    expect(body.cardsByColumn["backlog"]!.some((c) => c.title === "Setup auth middleware")).toBe(
      true,
    );
    expect(body.cardsByColumn["doing"]!.some((c) => c.title === "Wire up rate limiter")).toBe(
      true,
    );
    expect(body.cards.length).toBe(2);
  });

  test("GET / serves React board UI shell (not empty 200)", async () => {
    const ctx = makeTempRepoFromFixture();
    cleanups.push(ctx.cleanup);

    const store = new BoardIndexStore();
    const connected = await connectLocalRepo(ctx.repoPath, { indexStore: store });
    const port = await freePort();
    const server = startServer({
      host: "127.0.0.1",
      port,
      connected,
      indexStore: store,
    });
    cleanups.push(() => server.stop(true));

    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    const body = await res.text();
    expect(body).toContain('id="root"');
    expect(body).toContain("/assets/main.js");
    expect(body).toContain("kanbanly");

    // Bundle is served and includes Pragmatic DnD wiring
    const jsRes = await fetch(`http://127.0.0.1:${port}/assets/main.js`);
    expect(jsRes.status).toBe(200);
    const js = await jsRes.text();
    expect(js.length).toBeGreaterThan(1000);
    // Pragmatic package leaves identifiable strings when bundled
    expect(
      js.includes("pragmatic") ||
        js.includes("draggable") ||
        js.includes("dropTarget") ||
        js.includes("closestEdge"),
    ).toBe(true);

    // Page data path the UI consumes: board JSON with real fixture cards
    const api = await fetch(`http://127.0.0.1:${port}/api/boards/backend`);
    expect(api.status).toBe(200);
    const data = (await api.json()) as {
      columns: Array<{ id: string; name: string }>;
      cards: Array<{ id: string; title: string }>;
    };
    expect(data.columns.map((c) => c.id)).toEqual([
      "backlog",
      "doing",
      "review",
      "done",
    ]);
    expect(data.cards.some((c) => c.id === "c-a1b2")).toBe(true);
    expect(data.cards.some((c) => c.title === "Setup auth middleware")).toBe(true);
  });

  test("GET /static-board still dumps fixture columns/cards for simple agents", async () => {
    const ctx = makeTempRepoFromFixture();
    cleanups.push(ctx.cleanup);

    const store = new BoardIndexStore();
    const connected = await connectLocalRepo(ctx.repoPath, { indexStore: store });
    const port = await freePort();
    const server = startServer({
      host: "127.0.0.1",
      port,
      connected,
      indexStore: store,
    });
    cleanups.push(() => server.stop(true));

    const res = await fetch(`http://127.0.0.1:${port}/static-board`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Board: backend");
    expect(body).toContain("Setup auth middleware");
    expect(body).toContain("c-a1b2");
    expect(body).toContain("data-column-id=\"backlog\"");
  });
});

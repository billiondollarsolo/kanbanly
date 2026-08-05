import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileS3Client, S3Storage, defaultBoardYaml, parseCard } from "../src/index.ts";
import { orderInitial } from "../src/order.ts";

describe("FileS3Client CAS", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  test("get/put round-trip with etag", async () => {
    const root = mkdtempSync(join(tmpdir(), "file-s3-"));
    dirs.push(root);
    const s3 = new FileS3Client(root);
    const put = await s3.put("a/b.md", "hello");
    expect("etag" in put && put.etag).toBeTruthy();
    if ("conflict" in put) throw new Error("unexpected conflict");
    const got = await s3.get("a/b.md");
    expect(got?.body).toBe("hello");
    expect(got?.etag).toBe(put.etag);
  });

  test("If-Match mismatch returns conflict", async () => {
    const root = mkdtempSync(join(tmpdir(), "file-s3-"));
    dirs.push(root);
    const s3 = new FileS3Client(root);
    await s3.put("x.md", "v1");
    const bad = await s3.put("x.md", "v2", { ifMatch: '"stale"' });
    expect("conflict" in bad).toBe(true);
    const good = await s3.get("x.md");
    expect(good?.body).toBe("v1");
  });

  test("If-Match success updates body and etag", async () => {
    const root = mkdtempSync(join(tmpdir(), "file-s3-"));
    dirs.push(root);
    const s3 = new FileS3Client(root);
    const p1 = await s3.put("x.md", "v1");
    if ("conflict" in p1) throw new Error("fail");
    const p2 = await s3.put("x.md", "v2", { ifMatch: p1.etag });
    if ("conflict" in p2) throw new Error("fail2");
    expect(p2.etag).not.toBe(p1.etag);
    expect((await s3.get("x.md"))?.body).toBe("v2");
  });

  test("S3Storage over FileS3Client uses git-identical markdown + CAS", async () => {
    const root = mkdtempSync(join(tmpdir(), "file-s3-"));
    dirs.push(root);
    const client = new FileS3Client(root);
    const storage = new S3Storage({ client, prefix: "tenants/acme" });
    await storage.putBoard("backend", defaultBoardYaml());
    const card = {
      frontmatter: {
        id: "c-file1",
        title: "File S3 card",
        column: "backlog",
        order: orderInitial(),
        updated: "2026-08-04T00:00:00Z",
        labels: [] as string[],
      },
      status: "_Not started._",
      log: ["2026-08-04 human: created"],
    };
    const w = await storage.writeCard("backend", card);
    expect(w.ok).toBe(true);
    const listed = await storage.listCards("backend");
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const obj = await client.get(listed.value[0]!.path);
    expect(obj?.body).toContain("## Status");
    const parsed = parseCard(obj!.body);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.card.frontmatter.id).toBe("c-file1");

    // stale etag fails
    card.frontmatter.title = "Updated";
    const fail = await storage.writeCard("backend", card, {
      expectedEtag: '"stale"',
    });
    expect(fail.ok).toBe(false);
  });

  test("list returns keys under prefix", async () => {
    const root = mkdtempSync(join(tmpdir(), "file-s3-"));
    dirs.push(root);
    const s3 = new FileS3Client(root);
    await s3.put("tenants/a/boards/b/cards/c.md", "x");
    await s3.put("tenants/a/boards/b/board.yml", "y");
    await s3.put("other/z.md", "z");
    const list = await s3.list("tenants/a/");
    expect(list.some((o) => o.key.includes("cards/c.md"))).toBe(true);
    expect(list.some((o) => o.key.includes("board.yml"))).toBe(true);
    expect(list.every((o) => o.key.startsWith("tenants/a/"))).toBe(true);
  });
});

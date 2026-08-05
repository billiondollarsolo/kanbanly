import { describe, expect, test } from "bun:test";
import { InMemoryS3, S3Storage } from "../src/storage/s3.ts";
import { defaultBoardYaml } from "../src/board.ts";
import { serializeCard, type Card } from "../src/card.ts";
import { orderInitial } from "../src/order.ts";

function makeCard(id: string, title: string, column = "backlog"): Card {
  return {
    frontmatter: {
      id,
      title,
      column,
      order: orderInitial(),
      updated: "2026-08-04T00:00:00Z",
      labels: [],
    },
    status: "_Not started._",
    log: ["2026-08-04 human: created"],
  };
}

describe("S3Storage CAS", () => {
  test("get → put → conditional put with wrong etag fails", async () => {
    const client = new InMemoryS3();
    const storage = new S3Storage({ client, prefix: "tenants/acme" });
    await storage.putBoard("backend", defaultBoardYaml());

    const card = makeCard("c-s3aa", "S3 card");
    const w1 = await storage.writeCard("backend", card);
    expect(w1.ok).toBe(true);
    if (!w1.ok) return;
    expect(w1.value.etag).toBeTruthy();

    // Read to get etag
    const read = await storage.readCard("backend", "c-s3aa");
    expect(read.ok).toBe(true);

    // Stale etag should fail
    card.frontmatter.title = "Updated";
    card.frontmatter.updated = "2026-08-04T01:00:00Z";
    const w2 = await storage.writeCard("backend", card, {
      expectedEtag: '"etag-stale"',
    });
    expect(w2.ok).toBe(false);
    if (w2.ok) return;
    expect(w2.error.kind).toBe("cas_failed");

    // Correct etag succeeds
    const etag = (read.value as Card & { etag?: string }).etag;
    const w3 = await storage.writeCard("backend", card, { expectedEtag: etag });
    expect(w3.ok).toBe(true);
  });

  test("card format is git-identical markdown", async () => {
    const client = new InMemoryS3();
    const storage = new S3Storage({ client, prefix: "t/x" });
    const card = makeCard("c-fmt1", "Format check");
    await storage.writeCard("b", card);
    const listed = await storage.listCards("b");
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const obj = await client.get(listed.value[0]!.path);
    expect(obj).toBeTruthy();
    expect(obj!.body).toContain("---");
    expect(obj!.body).toContain("## Status");
    expect(obj!.body).toContain("## Log");
    expect(obj!.body).toBe(serializeCard(card));
  });
});

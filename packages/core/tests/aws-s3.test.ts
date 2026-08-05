import { describe, expect, test } from "bun:test";
import {
  AwsS3Client,
  parseListObjectsV2,
  signAwsRequest,
} from "../src/storage/aws-s3.ts";
import { S3Storage } from "../src/storage/s3.ts";
import { defaultBoardYaml } from "../src/board.ts";
import { orderInitial } from "../src/order.ts";
import type { Card } from "../src/card.ts";

describe("signAwsRequest", () => {
  test("produces AWS4-HMAC-SHA256 authorization header", () => {
    const url = new URL("https://mybucket.s3.us-east-1.amazonaws.com/key.txt");
    const headers = signAwsRequest({
      method: "PUT",
      url,
      headers: { "content-type": "text/plain" },
      body: "hello",
      region: "us-east-1",
      service: "s3",
      accessKeyId: "AKIAEXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      now: new Date("2026-08-04T12:00:00Z"),
    });
    expect(headers["x-amz-date"]).toBe("20260804T120000Z");
    expect(headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE\//);
    expect(headers.authorization).toContain("SignedHeaders=");
    expect(headers.authorization).toContain("Signature=");
    expect(headers["x-amz-content-sha256"]).toHaveLength(64);
  });
});

describe("parseListObjectsV2", () => {
  test("extracts keys and etags from XML", () => {
    const xml = `<?xml version="1.0"?>
<ListBucketResult>
  <Contents>
    <Key>tenants/a/boards/b/cards/c.md</Key>
    <ETag>&quot;abc123&quot;</ETag>
  </Contents>
  <Contents>
    <Key>tenants/a/boards/b/board.yml</Key>
    <ETag>"def456"</ETag>
  </Contents>
</ListBucketResult>`;
    const items = parseListObjectsV2(xml);
    expect(items).toHaveLength(2);
    expect(items[0]!.key).toBe("tenants/a/boards/b/cards/c.md");
    expect(items[0]!.etag).toContain("abc123");
    expect(items[1]!.key).toEndWith("board.yml");
  });
});

describe("AwsS3Client with mock fetch", () => {
  test("get/put/list/delete against mock", async () => {
    const objects = new Map<string, { body: string; etag: string }>();
    let seq = 0;

    const fetchImpl = async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = new URL(String(input));
      const method = (init?.method ?? "GET").toUpperCase();
      // path-style: /bucket/key...
      const path = url.pathname.replace(/^\/test-bucket\/?/, "");

      if (url.searchParams.get("list-type") === "2") {
        const prefix = url.searchParams.get("prefix") ?? "";
        const contents = [...objects.entries()]
          .filter(([k]) => k.startsWith(prefix))
          .map(
            ([k, v]) =>
              `<Contents><Key>${k}</Key><ETag>${v.etag}</ETag></Contents>`,
          )
          .join("");
        return new Response(
          `<?xml version="1.0"?><ListBucketResult>${contents}</ListBucketResult>`,
          { status: 200 },
        );
      }

      const key = decodeURIComponent(path);
      if (method === "GET") {
        const o = objects.get(key);
        if (!o) return new Response("not found", { status: 404 });
        return new Response(o.body, {
          status: 200,
          headers: { etag: o.etag },
        });
      }
      if (method === "PUT") {
        const ifMatch = (init?.headers as Record<string, string>)?.["if-match"] ??
          (init?.headers as Record<string, string>)?.["If-Match"];
        // headers may be plain object from our client
        const h = init?.headers as Record<string, string> | undefined;
        const match = h
          ? Object.entries(h).find(([k]) => k.toLowerCase() === "if-match")?.[1]
          : undefined;
        const existing = objects.get(key);
        if (match !== undefined && (!existing || existing.etag !== match)) {
          return new Response("precondition", { status: 412 });
        }
        seq += 1;
        const etag = `"e${seq}"`;
        objects.set(key, { body: String(init?.body ?? ""), etag });
        return new Response(null, { status: 200, headers: { etag } });
      }
      if (method === "DELETE") {
        objects.delete(key);
        return new Response(null, { status: 204 });
      }
      return new Response("nope", { status: 400 });
    };

    const client = new AwsS3Client({
      bucket: "test-bucket",
      region: "us-east-1",
      accessKeyId: "AKIA",
      secretAccessKey: "secret",
      forcePathStyle: true,
      endpoint: "https://s3.example.com",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const put1 = await client.put("tenants/t/boards/b/board.yml", "v1");
    expect("etag" in put1).toBe(true);
    if (!("etag" in put1)) return;

    const got = await client.get("tenants/t/boards/b/board.yml");
    expect(got?.body).toBe("v1");

    const casFail = await client.put("tenants/t/boards/b/board.yml", "v2", {
      ifMatch: '"stale"',
    });
    expect("conflict" in casFail).toBe(true);

    const casOk = await client.put("tenants/t/boards/b/board.yml", "v2", {
      ifMatch: put1.etag,
    });
    expect("etag" in casOk).toBe(true);

    const listed = await client.list("tenants/t/");
    expect(listed.some((x) => x.key.includes("board.yml"))).toBe(true);

    // Works with S3Storage CAS path
    const storage = new S3Storage({ client, prefix: "tenants/t/boards" });
    await storage.putBoard("backend", defaultBoardYaml());
    const card: Card = {
      frontmatter: {
        id: "c-aws1",
        title: "AWS card",
        column: "backlog",
        order: orderInitial(),
        updated: "2026-08-04T00:00:00Z",
        labels: [],
      },
      status: "ok",
      log: ["2026-08-04 human: created"],
    };
    const w = await storage.writeCard("backend", card);
    expect(w.ok).toBe(true);
  });

  test("fromEnv returns null without required vars", () => {
    expect(AwsS3Client.fromEnv({})).toBeNull();
    const c = AwsS3Client.fromEnv({
      S3_BUCKET: "b",
      AWS_ACCESS_KEY_ID: "a",
      AWS_SECRET_ACCESS_KEY: "s",
      AWS_REGION: "eu-west-1",
    });
    expect(c).not.toBeNull();
  });
});

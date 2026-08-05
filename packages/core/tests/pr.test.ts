import { describe, expect, test } from "bun:test";
import {
  fetchPrStatus,
  parsePrRef,
  staticPrStatus,
  suggestedColumnForPr,
} from "../src/pr.ts";

describe("parsePrRef", () => {
  test("owner/repo#num", () => {
    const r = parsePrRef("mj/api-service#418");
    expect(r?.owner).toBe("mj");
    expect(r?.repo).toBe("api-service");
    expect(r?.number).toBe(418);
    expect(r?.url).toBe("https://github.com/mj/api-service/pull/418");
    expect(r?.label).toBe("#418");
  });

  test("github pull URL", () => {
    const r = parsePrRef("https://github.com/acme/app/pull/12");
    expect(r?.number).toBe(12);
    expect(r?.owner).toBe("acme");
  });

  test("empty returns null", () => {
    expect(parsePrRef("")).toBeNull();
    expect(parsePrRef(undefined)).toBeNull();
  });
});

describe("staticPrStatus + suggested column", () => {
  test("static suggests review", () => {
    const s = staticPrStatus("mj/x#1");
    expect(s?.source).toBe("static");
    expect(s?.suggestedColumn).toBe("review");
  });

  test("suggestedColumnForPr", () => {
    expect(suggestedColumnForPr("open")).toBe("review");
    expect(suggestedColumnForPr("merged")).toBe("done");
    expect(suggestedColumnForPr("closed")).toBeUndefined();
  });
});

describe("fetchPrStatus", () => {
  test("uses github API when token + fetch provided", async () => {
    const fetchImpl = async () =>
      new Response(
        JSON.stringify({
          state: "open",
          draft: false,
          merged: false,
          title: "Fix auth",
        }),
        { status: 200 },
      );
    const s = await fetchPrStatus("mj/api#9", {
      token: "fake",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(s?.source).toBe("github");
    expect(s?.state).toBe("open");
    expect(s?.title).toBe("Fix auth");
    expect(s?.suggestedColumn).toBe("review");
  });

  test("falls back to static without token", async () => {
    const prev = process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;
    const s = await fetchPrStatus("mj/api#9");
    expect(s?.source).toBe("static");
    if (prev !== undefined) process.env.GITHUB_TOKEN = prev;
  });
});

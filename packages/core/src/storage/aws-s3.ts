/**
 * Production AWS S3 (or S3-compatible) client implementing S3Client.
 * Uses fetch + SigV4 — no AWS SDK dependency.
 * Supports If-Match on PutObject for CAS.
 */

import { createHash, createHmac } from "node:crypto";
import type { S3Client } from "./s3.ts";

export type AwsS3ClientOptions = {
  bucket: string;
  region?: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  /** Custom endpoint (MinIO, LocalStack, R2). */
  endpoint?: string;
  /** Force path-style URLs (required for many minio/localstack setups). */
  forcePathStyle?: boolean;
  fetchImpl?: typeof fetch;
};

function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

function amzDate(d = new Date()): { amz: string; date: string } {
  const iso = d.toISOString().replace(/[:-]|\.\d{3}/g, "");
  // 20260804T120000Z
  return { amz: iso, date: iso.slice(0, 8) };
}

/**
 * AWS Signature Version 4 signer for S3 REST requests.
 */
export function signAwsRequest(opts: {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: string | Buffer;
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  now?: Date;
}): Record<string, string> {
  const { amz, date } = amzDate(opts.now);
  const payloadHash = sha256Hex(opts.body);
  const headers: Record<string, string> = {
    ...opts.headers,
    host: opts.url.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amz,
  };
  if (opts.sessionToken) {
    headers["x-amz-security-token"] = opts.sessionToken;
  }

  const signedHeaderNames = Object.keys(headers)
    .map((h) => h.toLowerCase())
    .sort();
  const canonicalHeaders = signedHeaderNames
    .map((name) => {
      const key = Object.keys(headers).find((k) => k.toLowerCase() === name)!;
      return `${name}:${headers[key]!.trim().replace(/\s+/g, " ")}\n`;
    })
    .join("");
  const signedHeaders = signedHeaderNames.join(";");

  // Canonical query: sorted, encoded
  const params = [...opts.url.searchParams.entries()].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  const canonicalQuery = params
    .map(
      ([k, v]) =>
        `${encodeURIComponent(k)}=${encodeURIComponent(v).replace(/%20/g, "+")}`,
    )
    .join("&");

  const canonicalUri = opts.url.pathname
    .split("/")
    .map((seg) => encodeURIComponent(decodeURIComponent(seg)))
    .join("/")
    .replace(/%2F/gi, "/");

  const canonicalRequest = [
    opts.method,
    canonicalUri || "/",
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const credentialScope = `${date}/${opts.region}/${opts.service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amz,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const kDate = hmac(`AWS4${opts.secretAccessKey}`, date);
  const kRegion = hmac(kDate, opts.region);
  const kService = hmac(kRegion, opts.service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning)
    .update(stringToSign, "utf8")
    .digest("hex");

  headers.authorization = `AWS4-HMAC-SHA256 Credential=${opts.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return headers;
}

export class AwsS3Client implements S3Client {
  private bucket: string;
  private region: string;
  private accessKeyId: string;
  private secretAccessKey: string;
  private sessionToken?: string;
  private endpoint?: string;
  private forcePathStyle: boolean;
  private fetchImpl: typeof fetch;

  constructor(options: AwsS3ClientOptions) {
    this.bucket = options.bucket;
    this.region = options.region ?? "us-east-1";
    this.accessKeyId = options.accessKeyId;
    this.secretAccessKey = options.secretAccessKey;
    this.sessionToken = options.sessionToken;
    this.endpoint = options.endpoint?.replace(/\/$/, "");
    this.forcePathStyle =
      options.forcePathStyle ?? Boolean(options.endpoint);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** Build from standard env vars (AWS_*, S3_BUCKET, S3_ENDPOINT). */
  static fromEnv(
    env: NodeJS.ProcessEnv = process.env,
    overrides?: Partial<AwsS3ClientOptions>,
  ): AwsS3Client | null {
    const bucket = overrides?.bucket ?? env.S3_BUCKET ?? env.AWS_S3_BUCKET;
    const accessKeyId =
      overrides?.accessKeyId ?? env.AWS_ACCESS_KEY_ID ?? env.S3_ACCESS_KEY_ID;
    const secretAccessKey =
      overrides?.secretAccessKey ??
      env.AWS_SECRET_ACCESS_KEY ??
      env.S3_SECRET_ACCESS_KEY;
    if (!bucket || !accessKeyId || !secretAccessKey) return null;
    return new AwsS3Client({
      bucket,
      accessKeyId,
      secretAccessKey,
      region: overrides?.region ?? env.AWS_REGION ?? env.S3_REGION ?? "us-east-1",
      sessionToken:
        overrides?.sessionToken ?? env.AWS_SESSION_TOKEN ?? env.S3_SESSION_TOKEN,
      endpoint: overrides?.endpoint ?? env.S3_ENDPOINT ?? env.AWS_ENDPOINT_URL_S3,
      forcePathStyle: overrides?.forcePathStyle,
      fetchImpl: overrides?.fetchImpl,
    });
  }

  private objectUrl(key: string, query?: Record<string, string>): URL {
    const encodedKey = key
      .split("/")
      .map((s) => encodeURIComponent(s))
      .join("/");
    let base: string;
    if (this.endpoint) {
      if (this.forcePathStyle) {
        base = `${this.endpoint}/${this.bucket}/${encodedKey}`;
      } else {
        // virtual-host style with custom endpoint is rare; still path-style
        base = `${this.endpoint}/${this.bucket}/${encodedKey}`;
      }
    } else if (this.forcePathStyle) {
      base = `https://s3.${this.region}.amazonaws.com/${this.bucket}/${encodedKey}`;
    } else {
      base = `https://${this.bucket}.s3.${this.region}.amazonaws.com/${encodedKey}`;
    }
    const url = new URL(base);
    if (query) {
      for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    }
    return url;
  }

  private async request(
    method: string,
    key: string,
    body: string = "",
    extraHeaders: Record<string, string> = {},
    query?: Record<string, string>,
  ): Promise<Response> {
    const url = this.objectUrl(key, query);
    const headers = signAwsRequest({
      method,
      url,
      headers: {
        "content-type": "application/octet-stream",
        ...extraHeaders,
      },
      body,
      region: this.region,
      service: "s3",
      accessKeyId: this.accessKeyId,
      secretAccessKey: this.secretAccessKey,
      sessionToken: this.sessionToken,
    });
    return this.fetchImpl(url.toString(), { method, headers, body: body || undefined });
  }

  async get(key: string): Promise<{ body: string; etag: string } | null> {
    const res = await this.request("GET", key);
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(`S3 GET ${key} failed: ${res.status} ${await res.text()}`);
    }
    const body = await res.text();
    const etag = (res.headers.get("etag") ?? `"${sha256Hex(body).slice(0, 16)}"`).trim();
    return { body, etag };
  }

  async put(
    key: string,
    body: string,
    options?: { ifMatch?: string },
  ): Promise<{ etag: string } | { conflict: true; etag?: string }> {
    const extra: Record<string, string> = {};
    if (options?.ifMatch !== undefined) {
      extra["if-match"] = options.ifMatch;
    }
    const res = await this.request("PUT", key, body, extra);
    // 412 Precondition Failed = CAS miss
    if (res.status === 412) {
      const current = await this.get(key);
      return { conflict: true, etag: current?.etag };
    }
    if (!res.ok) {
      throw new Error(`S3 PUT ${key} failed: ${res.status} ${await res.text()}`);
    }
    const etag =
      (res.headers.get("etag") ?? `"${sha256Hex(body).slice(0, 16)}"`).trim();
    return { etag };
  }

  async list(prefix: string): Promise<Array<{ key: string; etag: string }>> {
    // ListObjectsV2 via path "" with query on bucket root
    const url = this.objectUrl("", {
      "list-type": "2",
      prefix,
    });
    // objectUrl with empty key leaves trailing slash — normalize for list
    const listUrl = new URL(url.toString().replace(/\/\?/, "?"));
    // Fix: empty key produces .../bucket/ — good for path-style list
    const headers = signAwsRequest({
      method: "GET",
      url: listUrl,
      headers: {},
      body: "",
      region: this.region,
      service: "s3",
      accessKeyId: this.accessKeyId,
      secretAccessKey: this.secretAccessKey,
      sessionToken: this.sessionToken,
    });
    const res = await this.fetchImpl(listUrl.toString(), {
      method: "GET",
      headers,
    });
    if (!res.ok) {
      throw new Error(`S3 LIST failed: ${res.status} ${await res.text()}`);
    }
    const xml = await res.text();
    return parseListObjectsV2(xml);
  }

  async delete(key: string): Promise<void> {
    const res = await this.request("DELETE", key);
    if (!res.ok && res.status !== 404) {
      throw new Error(`S3 DELETE ${key} failed: ${res.status} ${await res.text()}`);
    }
  }
}

/** Minimal ListObjectsV2 XML parser (Contents Key + ETag). */
export function parseListObjectsV2(
  xml: string,
): Array<{ key: string; etag: string }> {
  const out: Array<{ key: string; etag: string }> = [];
  const contents = xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g);
  for (const m of contents) {
    const block = m[1] ?? "";
    const key = block.match(/<Key>([\s\S]*?)<\/Key>/)?.[1];
    const etag = block.match(/<ETag>([\s\S]*?)<\/ETag>/)?.[1];
    if (key) {
      out.push({
        key: decodeXml(key),
        etag: decodeXml(etag ?? '""').replace(/&quot;/g, '"'),
      });
    }
  }
  return out;
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

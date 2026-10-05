import http from "node:http";
import https from "node:https";

// Minimal HTTP client for the HTTP-speaking engines (ClickHouse, OpenSearch).
// node:http(s) rather than fetch so that the instance's TLS flag can accept the
// internal self-signed certificates (same semantics as the pg/mysql/redis drivers:
// TLS without CA verification, see README "Limits").

export type HttpResult = { status: number; text: string };

export function httpRequest(opts: { url: URL; method?: string; headers?: Record<string, string>; body?: string; timeoutMs: number; insecureTls?: boolean }): Promise<HttpResult> {
  const mod = opts.url.protocol === "https:" ? https : http;
  return new Promise<HttpResult>((resolve, reject) => {
    const req = mod.request(
      opts.url,
      {
        method: opts.method ?? "GET",
        headers: { ...(opts.headers ?? {}), ...(opts.body !== undefined ? { "Content-Length": String(Buffer.byteLength(opts.body)) } : {}) },
        timeout: opts.timeoutMs,
        ...(opts.url.protocol === "https:" ? { rejectUnauthorized: !opts.insecureTls } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (d: Buffer) => chunks.push(d));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error(`HTTP request timed out after ${opts.timeoutMs} ms`)));
    req.on("error", reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

export const basicAuth = (user: string | null | undefined, password: string | undefined): Record<string, string> => (user ? { Authorization: `Basic ${Buffer.from(`${user}:${password ?? ""}`).toString("base64")}` } : {});

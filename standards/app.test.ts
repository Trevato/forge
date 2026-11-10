/** Conformance, app side: APP_URL, and APP_ADAPTER=1 for an adapter. */
import { describe } from "bun:test";
import { APP_ADAPTER, APP_URL, conform, must } from "./conform.ts";

const on = APP_URL !== "";
const get = (path: string, headers: Record<string, string> = {}) => fetch(APP_URL + path, { headers, redirect: "manual" });

describe.skipIf(!on)("an app", () => {
  conform("app-manifest", "GET /healthz answers 2xx with ok: true", async () => {
    const res = await get("/healthz");
    must(res.status >= 200 && res.status < 300, `answered ${res.status}`);
    must(((await res.json()) as { ok?: unknown }).ok === true, "body.ok is not true");
  });

  const forged: [string, Record<string, string>][] = [
    ["a forged admin with a wrong signature", { "x-forge-identity": "1|root|admin|4102444800000", "x-forge-signature": "AAAA" }],
    ["a malformed identity", { "x-forge-identity": "garbage", "x-forge-signature": "" }],
    ["a signature without an identity", { "x-forge-signature": "AAAA" }],
  ];
  for (const [what, headers] of forged)
    conform("identity", `${what} is treated as no headers at all`, async () => {
      const anon = await get("/");
      const res = await get("/", headers);
      must(res.status === anon.status, `anonymous got ${anon.status}, ${what} got ${res.status}`);
      must(res.status < 500, `${res.status}`);
    });

  conform("feedback", "a note from another origin is refused", async () => {
    const res = await fetch(`${APP_URL}/__forge/note`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify({ text: "x" }),
    });
    must(res.status === 403 || res.status === 404, `answered ${res.status}`);
    must(res.status !== 201, "a cross-origin note was filed");
  });

  conform(
    "adapters",
    "POST /pull without a signed admin is refused",
    async () => {
      const res = await fetch(`${APP_URL}/pull`, { method: "POST" });
      must(res.status === 401 || res.status === 403, `answered ${res.status}`);
    },
    APP_ADAPTER,
  );
});

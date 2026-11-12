/** The OpenAPI document describes feed interactions and sharing. */
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { createUser } from "../src/core/users.ts";
import { serve } from "../src/http/server.ts";
import { tokenFor } from "./helpers/tokens.ts";
import { openapi } from "../src/contract/openapi.ts";

test("both writes are in the document with the refusals they answer", () => {
  const doc = openapi("https://f.test", "1", "admin") as any;
  for (const [path, codes] of [
    ["/api/v1/feed/interactions", ["invalid_item", "invalid_kind", "not_found"]],
    ["/api/v1/share", ["invalid_item", "invalid_target", "not_found"]],
  ] as const) {
    const op = doc.paths[path]?.post;
    expect(op, path).toBeDefined();
    expect(op.responses["201"]).toBeDefined();
    for (const c of codes) expect(JSON.stringify(op), `${path} ${c}`).toContain(`\`${c}\``);
  }
});

test("the refusals are what the routes answer", async () => {
  const dir = await mkdtemp(join(tmpdir(), "forge-oa-feed-"));
  const app = createApp({ dataDir: dir, port: 0 });
  const servers = await serve(app);
  try {
    const a = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "alice@forge.test", password: "a-good-passphrase", adminIfFirst: true });
    if (!a.ok) throw new Error(a.error);
    const token = await tokenFor(app, "alice", "admin");
    const call = async (path: string, body: unknown) => {
      const res = await fetch(`${servers.url}${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: (await res.json()) as any };
    };
    const I = "/api/v1/feed/interactions";
    expect(await call(I, { item: "!!", kind: "opened" })).toMatchObject({ status: 422, body: { error: "invalid_item" } });
    expect(await call(I, { item: "event:abc", kind: "nope" })).toMatchObject({ status: 422, body: { error: "invalid_kind" } });
    expect(await call(I, { item: "event:abc", kind: "opened" })).toMatchObject({ status: 404, body: { error: "not_found" } });
    const S = "/api/v1/share";
    expect(await call(S, { item: "!!" })).toMatchObject({ status: 422, body: { error: "invalid_item" } });
    expect(await call(S, { item: "event:abc", to: "bad name!" })).toMatchObject({ status: 422, body: { error: "invalid_target" } });
    expect(await call(S, { item: "event:abc", to: "bob" })).toMatchObject({ status: 404, body: { error: "not_found" } });
  } finally {
    servers.stop();
    app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

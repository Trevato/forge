/** The OpenAPI document describes issue dependencies, a crew seat, a secret and the front page. */
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createUser } from "../src/core/users.ts";
import { serve } from "../src/http/server.ts";
import { tokenFor } from "./helpers/tokens.ts";
import { openapi } from "../src/contract/openapi.ts";

const R = "/api/v1/repos/{owner}/{name}";
const WANT: readonly (readonly [string, string, string])[] = [
  [`${R}/issues/{number}/dependencies`, "get", ""],
  [`${R}/issues/{number}/dependencies`, "post", "no_such_issue"],
  [`${R}/crew/{username}`, "put", "no_such_agent"],
  [`${R}/crew/{username}`, "delete", "no_such_agent"],
  ["/api/v1/secrets/{scope}", "get", "invalid_scope"],
  ["/api/v1/secrets/{scope}/{name}", "put", "invalid_name"],
  ["/api/v1/front", "get", ""],
  ["/api/v1/front", "put", "forbidden"],
];

test("each path and method is served, with a refusal code the route answers", () => {
  const doc = openapi("https://f.test", "1", "admin") as any;
  for (const [path, m, code] of WANT) {
    const op = doc.paths[path]?.[m];
    expect(op, `${m} ${path}`).toBeDefined();
    if (code) expect(JSON.stringify(op), `${m} ${path}`).toContain(`\`${code}\``);
  }
  expect(doc.paths[`${R}/issues/{number}/dependencies`].post.responses["201"]).toBeDefined();
  expect(doc.paths["/api/v1/secrets/{scope}/{name}"].put.summary).toContain("write-only");
  expect(doc.paths["/api/v1/secrets/{scope}"].get.summary).toContain("never a value");
});

test("one refusal per row is what the route answers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "forge-oa-5242-"));
  const app = createApp({ dataDir: dir, port: 0 });
  const servers = await serve(app);
  try {
    const a = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "alice@forge.test", password: "a-good-passphrase", adminIfFirst: true });
    if (!a.ok) throw new Error(a.error);
    const made = await createRepo(app, a.value, { name: "site", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    const token = await tokenFor(app, "alice", "admin");
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(`${servers.url}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, body: (await res.json()) as any };
    };
    const repo = "/api/v1/repos/alice/site";
    const issue = await call("POST", `${repo}/issues`, { title: "one" });
    expect(issue.status).toBe(201);
    const n = issue.body.number;
    expect((await call("GET", `${repo}/issues/${n}/dependencies`)).body).toEqual({ blockedBy: [], blocks: [] });
    expect(await call("POST", `${repo}/issues/${n}/dependencies`, { blockedBy: 99 })).toMatchObject({ status: 422, body: { error: "no_such_issue" } });
    expect(await call("POST", `${repo}/issues/${n}/dependencies`, { blockedBy: n })).toMatchObject({ status: 422, body: { error: "self" } });
    expect(await call("PUT", `${repo}/crew/nobody`)).toMatchObject({ status: 422, body: { error: "no_such_agent" } });
    expect(await call("PUT", "/api/v1/secrets/forge/bad", { value: "v" })).toMatchObject({ status: 422, body: { error: "invalid_name" } });
    expect(await call("GET", "/api/v1/secrets/nope")).toMatchObject({ status: 422, body: { error: "invalid_scope" } });
    expect((await call("GET", "/api/v1/front")).status).toBe(200);
    expect(await call("PUT", "/api/v1/front", { pinned: "x" })).toMatchObject({ status: 422, body: { error: "invalid" } });
  } finally {
    servers.stop();
    app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

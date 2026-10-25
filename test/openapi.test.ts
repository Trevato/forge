/** The OpenAPI document names every route the manifest names. */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { serve } from "../src/http/server.ts";
import { openapi, ROUTES } from "../src/contract/openapi.ts";

test("every http route the manifest names is described", () => {
  const src = readFileSync("src/actions/here.ts", "utf8");
  const named = [...src.matchAll(/http: [`"]([^`"]+)[`"]/g)].flatMap((m) =>
    m[1]!.split(", then ").map((one) => {
      const [method, path] = one.replace(" {headRepo}", "").replace(/\?.*/, "").split(" ");
      return [method!.toLowerCase(), path!.replaceAll("${r}", "/api/v1/repos/{owner}/{name}")] as const;
    }),
  );
  expect(named.length).toBeGreaterThan(5);
  const doc = openapi("https://f.test", "1") as any;
  for (const [method, path] of named) {
    const p = path.replace(/\{(\w+)\}/g, "{$1}");
    expect(doc.paths[p]?.[method], `${method} ${p}`).toBeDefined();
  }
  expect(doc.openapi).toBe("3.1.0");
  expect(doc.paths["/api/v1/repos/{owner}/{name}/issues"].post.security).toBeDefined();
});

test("every described route is registered in the router", () => {
  const src = ["src/http/server.ts", "src/http/api.ts", "src/http/mcp.ts", "src/http/passport_edge.ts"]
    .map((f) => readFileSync(f, "utf8"))
    .join("\n")
    // A route registered in a loop over issues and pulls is two routes.
    .replace(/"(PUT)",\s*`([^`]*)\$\{kind\}([^`]*)`/g, (_, m, a, b) => `"${m}", "${a}issues${b}"\n"${m}", "${a}pulls${b}"`);
  const registered = new Set(
    [...src.matchAll(/"(GET|POST|PATCH|DELETE|PUT)",\s*"([^"]+)"/g)].map((m) => `${m[1]} ${m[2]}`),
  );
  const shape = (p: string) => p.replace(/\{\w+\}|[:*]\w+/g, ":");
  const shapes = new Set([...registered].map((r) => shape(r)));
  for (const r of ROUTES) {
    const want = shape(`${r.method.toUpperCase()} ${r.path}`);
    const literal = shape(`${r.method.toUpperCase()} ${r.path.replace("production", ":")}`);
    expect(shapes.has(want) || shapes.has(literal), `${r.method} ${r.path}`).toBe(true);
  }
});

test("the map, plan and dependency routes are described", () => {
  const doc = openapi("https://f.test", "1") as any;
  const R = "/api/v1/repos/{owner}/{name}";
  expect(doc.paths[`${R}/map`].get.security).toBeUndefined();
  expect(doc.paths[`${R}/plan`].post.requestBody.content["application/json"].schema.properties.issues.type).toBe("array");
  expect(doc.paths[`${R}/issues/{number}/dependencies`].post.security).toBeDefined();
  const del = doc.paths[`${R}/issues/{number}/dependencies/{blocker}`].delete;
  expect(del.parameters.find((p: any) => p.name === "blocker").schema.type).toBe("integer");
});

test("starting a migration and reading its job are described", () => {
  const doc = openapi("https://f.test", "1") as any;
  const start = doc.paths["/api/v1/migrate"].post;
  expect(start.security).toBeDefined();
  expect(Object.keys(start.requestBody.content["application/json"].schema.properties)).toEqual(
    ["source", "owner", "name", "visibility", "branch", "after", "crew"],
  );
  const read = doc.paths["/api/v1/migrate/{job}"].get;
  expect(read.security).toBeDefined();
  expect(read.parameters.find((p: any) => p.name === "job").in).toBe("path");
});

test("listing issues and pulls is described with the query the handlers read", () => {
  const doc = openapi("https://f.test", "1") as any;
  const R = "/api/v1/repos/{owner}/{name}";
  for (const kind of ["issues", "pulls"]) {
    const get = doc.paths[`${R}/${kind}`].get;
    expect(get.security).toBeUndefined();
    const q = get.parameters.filter((p: any) => p.in === "query");
    const base = ["state", "limit", "cursor", "label", "author"];
    expect(q.map((p: any) => p.name)).toEqual(kind === "issues" ? [...base, "fields"] : base);
    if (kind === "issues") expect(q.find((p: any) => p.name === "fields").schema.enum).toEqual(["brief"]);
    expect(q.find((p: any) => p.name === "limit").schema.type).toBe("integer");
    expect(q.find((p: any) => p.name === "state").schema.enum).toEqual(["open", "closed", "all"]);
    expect(get.parameters.filter((p: any) => p.in === "path").length).toBe(2);
  }
});

test("reading one pull describes its diff switch", () => {
  const doc = openapi("https://f.test", "1") as any;
  const get = doc.paths["/api/v1/repos/{owner}/{name}/pulls/{number}"].get;
  const diff = get.parameters.find((p: any) => p.in === "query" && p.name === "diff");
  expect(diff.schema.enum).toEqual(["0", "1"]);
  expect(diff.schema.default).toBe("1");
});

test("reading and closing one issue and reading one pull are described", () => {
  const doc = openapi("https://f.test", "1") as any;
  const R = "/api/v1/repos/{owner}/{name}";
  const issue = doc.paths[`${R}/issues/{number}`];
  expect(issue.get.security).toBeUndefined();
  expect(issue.patch.security).toBeDefined();
  const props = issue.patch.requestBody.content["application/json"].schema.properties;
  expect(Object.keys(props).sort()).toEqual(["into", "reason", "state"]);
  expect(props.into.type).toBe("integer");
  expect(issue.patch.parameters.find((p: any) => p.name === "number").in).toBe("path");
  expect(doc.paths[`${R}/pulls/{number}`].get.security).toBeUndefined();
});

test("making and listing apps is described with every field the route reads", () => {
  const doc = openapi("https://f.test", "1") as any;
  expect(doc.paths["/api/v1/apps"].get.security).toBeUndefined();
  const post = doc.paths["/api/v1/apps"].post;
  expect(post.security).toBeDefined();
  expect(post.responses["201"]).toBeDefined();
  expect(post.responses["200"]).toBeUndefined();
  expect(doc.paths["/api/v1/apps"].get.responses["200"]).toBeDefined();
  const src = readFileSync("src/http/api.ts", "utf8");
  const start = src.indexOf('router.add("POST", "/api/v1/apps"');
  const handler = src.slice(start, src.indexOf("\n  });", start));
  const read = new Set([...handler.matchAll(/\binput\.(\w+)/g)].map((m) => m[1]!));
  expect(read.size).toBeGreaterThan(3);
  const described = Object.keys(post.requestBody.content["application/json"].schema.properties);
  for (const field of read) expect(described, `field ${field}`).toContain(field!);
  for (const field of described) expect([...read], `described ${field}`).toContain(field);
  for (const code of ["unverified", "app_limit", "no_such_agent", "name_taken"])
    expect(post.responses.default.description).toContain(`\`${code}\``);
});

test("an issue's teams and labels, a pull's labels and an issue's private repository are described", () => {
  const doc = openapi("https://f.test", "1") as any;
  const R = "/api/v1/repos/{owner}/{name}";
  for (const [method, path] of [
    ["get", `${R}/issues/{number}/teams`],
    ["put", `${R}/issues/{number}/teams`],
    ["put", `${R}/issues/{number}/labels`],
    ["put", `${R}/pulls/{number}/labels`],
    ["post", `${R}/issues/{number}/private`],
  ] as const) expect(doc.paths[path]?.[method], `${method} ${path}`).toBeDefined();
  expect(doc.paths[`${R}/issues/{number}/teams`].put.requestBody.content["application/json"].schema.properties.teams.type).toBe("array");
  expect(doc.paths[`${R}/issues/{number}/private`].post.responses["201"]).toBeDefined();
  expect(doc.paths[`${R}/issues/{number}/teams`].get.security).toBeUndefined();
  expect(doc.paths[`${R}/pulls/{number}/labels`].put.security).toBeDefined();
});

test("no method and path is described twice, so no row is dead", () => {
  const seen = new Set<string>();
  for (const r of ROUTES) {
    const key = `${r.method} ${r.path}`;
    expect(seen.has(key), `duplicate ${key}`).toBe(false);
    seen.add(key);
  }
});

test("the front reads say what they answer and refuse", () => {
  const doc = openapi("https://f.test", "1") as any;
  expect(JSON.stringify(doc.paths["/api/v1/here"].get)).toContain("not_found");
  expect(JSON.stringify(doc.paths["/api/v1/forge"].get)).toContain("not_found");
  expect(doc.paths["/api/v1/forge"].get.summary).toContain("lastActivityAt");
  expect(doc.paths["/api/v1/front"].get.summary).toContain("featured");
  expect(doc.paths["/api/v1/contribute"].get.summary).toContain("welcomeLabel");
});

test("signing up, signing in and the first admin are described", () => {
  const doc = openapi("https://f.test", "1") as any;
  const want: [string, string, number][] = [
    ["post", "/api/v1/users", 201],
    ["post", "/api/v1/sessions", 201],
    ["delete", "/api/v1/sessions", 200],
    ["post", "/api/v1/first-admin", 201],
    ["post", "/api/v1/first-admin/recover", 201],
  ];
  for (const [method, path, status] of want) {
    const op = doc.paths[path]?.[method];
    expect(op, `${method} ${path}`).toBeDefined();
    expect(op.responses[String(status)], `${method} ${path} ${status}`).toBeDefined();
    expect(op.security, `${method} ${path}`).toBeUndefined();
  }
  const props = (p: string) => doc.paths[p].post.requestBody.content["application/json"].schema.properties;
  expect(props("/api/v1/users").password.type).toBe("string");
  expect(props("/api/v1/first-admin").expiresIn.type).toBe("integer");
});

test("the served document carries the sign-up and sign-in routes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "forge-openapi-"));
  const app = createApp({ dataDir: dir, port: 0 });
  const servers = await serve(app);
  try {
    const res = await fetch(`${servers.url}/contract/openapi.json`);
    expect(res.status).toBe(200);
    const doc = (await res.json()) as any;
    expect(doc.paths["/api/v1/users"].post).toBeDefined();
    expect(doc.paths["/api/v1/sessions"].post).toBeDefined();
    expect(doc.paths["/api/v1/sessions"].delete).toBeDefined();
    expect(doc.paths["/api/v1/first-admin"].post).toBeDefined();
    expect(doc.paths["/api/v1/first-admin/recover"].post).toBeDefined();
  } finally {
    servers.stop();
    app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("an app's routes are described, and env values are never read back", () => {
  const doc = openapi("https://f.test", "1") as any;
  const A = "/api/v1/repos/{owner}/{name}/app";
  const want: Record<string, string[]> = {
    [A]: ["get", "post", "patch", "delete"],
    [`${A}/members`]: ["get", "put"],
    [`${A}/domains`]: ["get", "post"],
    [`${A}/domains/{host}`]: ["delete"],
    [`${A}/domains/{host}/check`]: ["post"],
    [`${A}/env`]: ["get"],
    [`${A}/env/{var}`]: ["put", "delete"],
    [`${A}/{env}/redeploy`]: ["post"],
    [`${A}/{env}/stop`]: ["post"],
  };
  for (const [path, methods] of Object.entries(want))
    for (const m of methods) expect(doc.paths[path]?.[m], `${m} ${path}`).toBeDefined();
  for (const m of ["post", "patch"])
    expect(Object.keys(doc.paths[A][m].requestBody.content["application/json"].schema.properties)).toEqual(["slug", "access", "previewData"]);
  expect(doc.paths[`${A}/env/{var}`].put.summary).toContain("never read back");
  expect(doc.paths[`${A}/env`].get.summary).toContain("never read back");
  expect(doc.paths[`${A}/{env}/redeploy`].post.responses["202"]).toBeDefined();
});

test("a person's sign-ins and ending one are described, with no session secret", () => {
  const doc = openapi("https://f.test", "1") as any;
  const list = doc.paths["/api/v1/users/{username}/signins"]?.get;
  const end = doc.paths["/api/v1/users/{username}/sessions/{id}"]?.delete;
  expect(list).toBeDefined();
  expect(end).toBeDefined();
  expect(list.security).toBeDefined();
  expect(list.summary).toContain("admin-scope");
  expect(end.responses["204"]).toBeDefined();
  expect(end.responses.default.description).toContain("not_found");
  expect(list.responses.default.description).toContain("unauthorized");
  expect(list.responses.default.description).toContain("forbidden");
});

test("a repository's code writes are described: branches and contents", () => {
  const doc = openapi("https://f.test", "1") as any;
  const R = "/api/v1/repos/{owner}/{name}";
  expect(doc.paths[`${R}/branches`]?.post).toBeDefined();
  expect(doc.paths[`${R}/branches/{branch}`]?.delete).toBeDefined();
  expect(doc.paths[`${R}/contents`]?.post).toBeDefined();
  expect(doc.paths[`${R}/branches`].post.responses["201"]).toBeDefined();
  expect(doc.paths[`${R}/branches/{branch}`].delete.responses["204"]).toBeDefined();
});

test("the contents row names the refusals of its own handler, protection and size caps included", () => {
  const doc = openapi("https://f.test", "1") as any;
  const R = "/api/v1/repos/{owner}/{name}";
  const text = JSON.stringify(doc.paths[`${R}/contents`].post.responses);
  expect(text).toContain("path_conflict");
  expect(text).toContain("protected_branch");
  expect(text).toContain("file_too_large");
});

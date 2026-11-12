/** The OpenAPI document names every route the manifest names. */
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
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
      return [method!.toLowerCase(), path!
        .replaceAll("${r}", "/api/v1/repos/{owner}/{name}")
        .replace("/orgs/${account.username}/", "/orgs/{org}/")
        .replace("/users/${account.username}/", "/users/{username}/")] as const;
    }),
  );
  expect(named.length).toBeGreaterThan(5);
  const doc = openapi("https://f.test", "1", "admin") as any;
  // The sign-up and sign-in pages are HTML for a person, not part of the API.
  const pages = new Set(["/signup", "/signin"]);
  for (const [method, path] of named) {
    if (pages.has(path)) continue;
    const p = path.replace(/\{(\w+)\}/g, "{$1}");
    expect(doc.paths[p]?.[method], `${method} ${p}`).toBeDefined();
  }
  expect(doc.openapi).toBe("3.1.0");
  expect(doc.paths["/api/v1/repos/{owner}/{name}/issues"].post.security).toBeDefined();
});

test("every described route is registered in the router", () => {
  const src = ["src/http/server.ts", "src/http/api.ts", "src/http/mcp.ts", "src/http/passport_edge.ts", "src/http/feed.ts", "src/http/checks_recheck.ts", "src/contract/served.ts",
    ...readdirSync("src/http/api").map((f) => `src/http/api/${f}`)]
    .map((f) => readFileSync(f, "utf8"))
    .join("\n")
    // A route registered in a loop over issues and pulls is two routes.
    // So is the one over PUT and DELETE of a milestone's watch.
    .replace(/\bmethod,\s*("[^"]*\/milestones\/:number\/watch")/g, '"PUT", $1\n"DELETE", $1')
    .replace(/"(PUT)",\s*`([^`]*)\$\{kind\}([^`]*)`/g, (_, m, a, b) => `"${m}", "${a}issues${b}"\n"${m}", "${a}pulls${b}"`);
  const browse = /const BROWSE = "([^"]+)"/.exec(src)![1]!;
  const registered = new Set(
    [...src.matchAll(/"(GET|POST|PATCH|DELETE|PUT)",\s*(?:"([^"]+)"|`\$\{BROWSE\}([^`]*)`|(BROWSE)\s*,)/g)].map(
      (m) => `${m[1]} ${m[2] ?? browse + (m[3] ?? "")}`,
    ),
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
  const doc = openapi("https://f.test", "1", "admin") as any;
  const R = "/api/v1/repos/{owner}/{name}";
  expect(doc.paths[`${R}/map`].get.security).toEqual([]);
  expect(doc.paths[`${R}/plan`].post.requestBody.content["application/json"].schema.properties.issues.type).toBe("array");
  expect(doc.paths[`${R}/issues/{number}/dependencies`].post.security).toBeDefined();
  const del = doc.paths[`${R}/issues/{number}/dependencies/{blocker}`].delete;
  expect(del.parameters.find((p: any) => p.name === "blocker").schema.type).toBe("integer");
});

test("starting a migration and reading its job are described", () => {
  const doc = openapi("https://f.test", "1", "admin") as any;
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
  const doc = openapi("https://f.test", "1", "admin") as any;
  const R = "/api/v1/repos/{owner}/{name}";
  for (const kind of ["issues", "pulls"]) {
    const get = doc.paths[`${R}/${kind}`].get;
    expect(get.security).toEqual([]);
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
  const doc = openapi("https://f.test", "1", "admin") as any;
  const get = doc.paths["/api/v1/repos/{owner}/{name}/pulls/{number}"].get;
  const diff = get.parameters.find((p: any) => p.in === "query" && p.name === "diff");
  expect(diff.schema.enum).toEqual(["0", "1"]);
  expect(diff.schema.default).toBe("1");
});

test("reading and closing one issue and reading one pull are described", () => {
  const doc = openapi("https://f.test", "1", "admin") as any;
  const R = "/api/v1/repos/{owner}/{name}";
  const issue = doc.paths[`${R}/issues/{number}`];
  expect(issue.get.security).toEqual([]);
  expect(issue.patch.security).toBeDefined();
  const props = issue.patch.requestBody.content["application/json"].schema.properties;
  expect(Object.keys(props).sort()).toEqual(["into", "reason", "state"]);
  expect(props.into.type).toBe("integer");
  expect(issue.patch.parameters.find((p: any) => p.name === "number").in).toBe("path");
  expect(doc.paths[`${R}/pulls/{number}`].get.security).toEqual([]);
});

test("making and listing apps is described with every field the route reads", () => {
  const doc = openapi("https://f.test", "1", "admin") as any;
  expect(doc.paths["/api/v1/apps"].get.security).toEqual([]);
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

test("the caller's own routes are described, pinning included", () => {
  const doc = openapi("https://f.test", "1", "admin") as any;
  const want: Record<string, string[]> = {
    "/api/v1/user": ["get", "patch"],
    "/api/v1/user/keys": ["get", "post"],
    "/api/v1/user/keys/{id}": ["delete"],
    "/api/v1/user/pins": ["get"],
    "/api/v1/user/pins/{owner}/{name}": ["put", "delete"],
    "/api/v1/user/assigned": ["get"],
    "/api/v1/user/orgs": ["get"],
  };
  for (const [path, methods] of Object.entries(want))
    for (const m of methods) {
      expect(doc.paths[path]?.[m], `${m} ${path}`).toBeDefined();
      expect(doc.paths[path][m].security).toBeDefined();
    }
  expect(doc.paths["/api/v1/user/keys"].post.summary).toContain("scope rw");
  const refusals = (path: string, m: string): string => doc.paths[path][m].responses.default.description;
  for (const code of ["forbidden", "invalid_commit_email", "invalid_email", "email_taken", "display_name_reserved", "display_name_mixed_script"])
    expect(refusals("/api/v1/user", "patch")).toContain(`\`${code}\``);
  for (const code of ["invalid_key", "key_exists"]) expect(refusals("/api/v1/user/keys", "post")).toContain(`\`${code}\``);
  expect(refusals("/api/v1/user/keys/{id}", "delete")).toContain("`not_found`");
  expect(refusals("/api/v1/user/keys/{id}", "delete")).toContain("404");
  for (const m of ["put", "delete"]) expect(refusals("/api/v1/user/pins/{owner}/{name}", m)).toContain("`not_found`");
  for (const [path, m] of [["/api/v1/user/keys", "post"], ["/api/v1/user/keys/{id}", "delete"], ["/api/v1/user/pins/{owner}/{name}", "put"], ["/api/v1/user/pins/{owner}/{name}", "delete"]] as [string, string][])
    for (const code of ["unauthorized", "forbidden"]) expect(refusals(path, m), `${m} ${path}`).toContain(`\`${code}\``);
  const assigned = doc.paths["/api/v1/user/assigned"].get;
  expect(assigned.summary).toContain("next_cursor is always null");
  expect(assigned.parameters?.map((p: any) => p.name) ?? []).not.toContain("limit");
  for (const path of ["/api/v1/user/keys", "/api/v1/user/orgs", "/api/v1/user/pins"]) {
    const get = doc.paths[path].get;
    expect(get.summary, path).toContain("{ items");
    expect(get.summary, path).toContain("next_cursor");
    expect(get.summary, path).not.toContain("array");
    expect(get.parameters.map((p: any) => p.name), path).toEqual(expect.arrayContaining(["limit", "cursor"]));
  }
});

test("the boards routes are described", () => {
  const doc = openapi("https://f.test", "1", "admin") as any;
  const B = "/api/v1/boards";
  const want: [string, string][] = [
    ["get", B], ["get", `${B}/{slug}`], ["put", `${B}/{slug}`], ["delete", `${B}/{slug}`],
    ["get", `${B}/{slug}/panels/{id}`], ["get", `${B}/pins`], ["post", `${B}/pins`],
    ["get", `${B}/sources`], ["post", `${B}/query`],
  ];
  for (const [m, p] of want) expect(doc.paths[p]?.[m]?.security, `${m} ${p}`).toBeDefined();
  const q = doc.paths[`${B}/query`].post;
  expect(q.requestBody.content["application/json"].schema.properties.source.type).toBe("string");
  expect(q.responses.default.description).toContain("unknown source");
});

test("a repository's reads are described: branches, commits, contents, labels, milestones", () => {
  const doc = openapi("https://f.test", "1", "admin") as any;
  const R = "/api/v1/repos/{owner}/{name}";
  for (const path of ["branches", "commits", "commits/{oid}", "contents", "labels", "milestones", "milestones/{number}"])
    expect(doc.paths[`${R}/${path}`]?.get, path).toBeDefined();
  const contents = doc.paths[`${R}/contents`].get.parameters.map((p: any) => p.name);
  expect(contents).toEqual(expect.arrayContaining(["path", "ref"]));
  const commits = doc.paths[`${R}/commits`].get.parameters.map((p: any) => p.name);
  expect(commits).toEqual(expect.arrayContaining(["ref", "limit"]));
});

test("an issue's teams and labels, a pull's labels and an issue's private repository are described", () => {
  const doc = openapi("https://f.test", "1", "admin") as any;
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
  expect(doc.paths[`${R}/issues/{number}/teams`].get.security).toEqual([]);
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
  const doc = openapi("https://f.test", "1", "admin") as any;
  expect(JSON.stringify(doc.paths["/api/v1/here"].get)).toContain("not_found");
  expect(JSON.stringify(doc.paths["/api/v1/forge"].get)).toContain("not_found");
  expect(doc.paths["/api/v1/forge"].get.summary).toContain("lastActivityAt");
  expect(doc.paths["/api/v1/front"].get.summary).toContain("featured");
  expect(doc.paths["/api/v1/contribute"].get.summary).toContain("welcomeLabel");
});

test("signing up, signing in and the first admin are described", () => {
  const doc = openapi("https://f.test", "1", "admin") as any;
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
    expect(op.security, `${method} ${path}`).toEqual([]);
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
  const doc = openapi("https://f.test", "1", "admin") as any;
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

test("triage, confirming a wait, a limb and proposal tokens are described", () => {
  const doc = openapi("https://f.test", "1", "admin") as any;
  const R = "/api/v1/repos/{owner}/{name}";
  for (const [path, status] of [
    [`${R}/reports/{id}/accept`, "201"],
    [`${R}/reports/{id}/dismiss`, "200"],
    [`${R}/issues/{number}/dependencies/{blocker}/confirm`, "204"],
    [`${R}/milestones/{number}/limb`, "200"],
    [`${R}/proposal-tokens`, "201"],
  ] as const) {
    const op = doc.paths[path]?.post;
    expect(op, path).toBeDefined();
    expect(op.security, path).toBeDefined();
    expect(op.responses[status], `${path} ${status}`).toBeDefined();
  }
  expect(doc.paths[`${R}/milestones/{number}/limb`].post.responses["201"]).toBeDefined();
  const confirm = doc.paths[`${R}/issues/{number}/dependencies/{blocker}/confirm`].post.responses.default.description;
  expect(confirm).toContain("no account (401)");
  expect(confirm).not.toContain("422");
});

test("browsing an origin's code is described, and a refusal matches what the route answers", async () => {
  const doc = openapi("https://f.test", "1", "admin") as any;
  const B = "/api/v1/user/origins/{id}/browse/{owner}/{name}";
  for (const tail of ["branches", "tags", "labels", "paths/{ref}", "tree/{ref}", "tree/{ref}/{path}", "blob/{ref}/{path}", "commits", "commits/{sha}"]) {
    const op = doc.paths[`${B}/${tail}`]?.get;
    expect(op, tail).toBeDefined();
    expect(op.security, tail).toBeDefined();
    expect(op.responses.default.description, tail).toContain("`origin_unreachable`");
    expect(op.summary, tail).toContain("(the connecting user only)");
  }
  expect(doc.paths[`${B}/tree/{ref}/{path}`].get.summary).toContain("src/a/b:");
  expect(doc.paths[`${B}/commits`].get.parameters.map((p: any) => p.name)).toContain("cursor");
  expect(doc.paths[`${B}/blob/{ref}/{path}`].get.responses.default.description).toContain("`too_large`");

  const dir = await mkdtemp(join(tmpdir(), "forge-openapi-"));
  const app = createApp({ dataDir: dir, port: 0 });
  const servers = await serve(app);
  try {
    const live = ["branches", "tags", "labels", "paths/main", "tree/main", "tree/main/a", "blob/main/a/b", "commits", "commits/abc"];
    const docTails = ["branches", "tags", "labels", "paths/{ref}", "tree/{ref}", "tree/{ref}/{path}", "blob/{ref}/{path}", "commits", "commits/{sha}"];
    for (const [i, tail] of live.entries()) {
      const res = await fetch(`${servers.url}/api/v1/user/origins/x/browse/o/n/${tail}`);
      expect(res.status, tail).toBe(401);
      expect(((await res.json()) as any).error, tail).toBe("unauthorized");
      expect(doc.paths[`${B}/${docTails[i]}`].get.responses.default.description, tail).toContain("`unauthorized`");
    }
  } finally {
    servers.stop();
    app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("mirroring and forking from an origin, its job and stream, and origin apps are described", () => {
  const doc = openapi("https://f.test", "1", "admin") as any;
  const want: [string, string][] = [
    ["/api/v1/user/origins/{id}/mirror", "post"],
    ["/api/v1/user/origins/{id}/fork", "post"],
    ["/api/v1/user/origins/{id}/mirror/{job}", "get"],
    ["/api/v1/user/origins/{id}/mirror/{job}/stream", "get"],
    ["/api/v1/migrate/{job}/stream", "get"],
    ["/api/v1/user/origin-apps", "get"],
    ["/api/v1/user/origin-apps", "post"],
    ["/api/v1/user/origin-apps/{id}", "delete"],
  ];
  for (const [path, method] of want) {
    expect(doc.paths[path]?.[method]).toBeDefined();
    expect(doc.paths[path][method].security).toBeDefined();
  }
  const row = ROUTES.find((r: any) => r.path === "/api/v1/user/origins/{id}/mirror/{job}/stream") as any;
  expect(row.summary).toContain("text/event-stream");
  expect(row.summary).toContain("mirror.done");
});

test("the caller's origins are described, from listing to removal, with no token in the document", () => {
  const doc = openapi("https://f.test", "1", "admin") as any;
  const O = "/api/v1/user/origins";
  const want: Record<string, string[]> = {
    [O]: ["get", "post"],
    [`${O}/oauth`]: ["post"],
    [`${O}/oauth/{id}`]: ["get"],
    [`${O}/{id}`]: ["delete"],
    [`${O}/{id}/sync`]: ["post"],
    [`${O}/{id}/repos`]: ["get"],
  };
  for (const [path, methods] of Object.entries(want))
    for (const m of methods) expect(doc.paths[path]?.[m], `${m} ${path}`).toBeDefined();
  expect(doc.paths[O].post.responses["201"]).toBeDefined();
  expect(doc.paths[`${O}/oauth`].post.responses["201"]).toBeDefined();
  expect(JSON.stringify(doc.paths[O])).not.toMatch(/ghp_|github_pat_/);
});

test("the admin's writes are described: a capacity setting, a limit and a team", () => {
  const doc = openapi("https://f.test", "1", "admin") as any;
  for (const path of ["capacity/{key}", "limits/{key}", "teams/{slug}"]) {
    const put = doc.paths[`/api/v1/admin/${path}`]?.put;
    expect(put, path).toBeDefined();
    expect(put.security).toBeDefined();
    expect(put.requestBody).toBeDefined();
  }
  expect(doc.paths["/api/v1/admin/capacity/{key}"].put.summary).toContain("egress");
  expect(doc.paths["/api/v1/admin/limits/{key}"].put.summary).toContain("api.anonymous_per_source");
});

test("a pull comment, a pull variant, a steered run and a prompt run are described", () => {
  const doc = openapi("https://f.test", "1", "admin") as any;
  const R = "/api/v1/repos/{owner}/{name}";
  for (const path of ["pulls/{number}/comments", "pulls/{number}/variant", "runs/{id}/steer", "prompts/{id}/run"]) {
    expect(doc.paths[`${R}/${path}`]?.post?.security, path).toBeDefined();
  }
  expect(doc.paths[`${R}/pulls/{number}/comments`].post.responses["201"]).toBeDefined();
  expect(doc.paths[`${R}/pulls/{number}/variant`].post.responses["201"]).toBeDefined();
  const steer = doc.paths[`${R}/runs/{id}/steer`].post;
  expect(Object.keys(steer.requestBody.content["application/json"].schema.properties)).toEqual(["text"]);
});

test("a person's sign-ins and ending one are described, with no session secret", () => {
  const doc = openapi("https://f.test", "1", "admin") as any;
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
  const doc = openapi("https://f.test", "1", "admin") as any;
  const R = "/api/v1/repos/{owner}/{name}";
  expect(doc.paths[`${R}/branches`]?.post).toBeDefined();
  expect(doc.paths[`${R}/branches/{branch}`]?.delete).toBeDefined();
  expect(doc.paths[`${R}/contents`]?.post).toBeDefined();
  expect(doc.paths[`${R}/branches`].post.responses["201"]).toBeDefined();
  expect(doc.paths[`${R}/branches/{branch}`].delete.responses["204"]).toBeDefined();
});

test("the contents row names the refusals of its own handler, protection and size caps included", () => {
  const doc = openapi("https://f.test", "1", "admin") as any;
  const R = "/api/v1/repos/{owner}/{name}";
  const text = JSON.stringify(doc.paths[`${R}/contents`].post.responses);
  expect(text).toContain("path_conflict");
  expect(text).toContain("protected_branch");
  expect(text).toContain("file_too_large");
});

test("the tell row names its body, its answer and the refusals of its handler", () => {
  const doc = openapi("https://f.test", "1", "admin") as any;
  const op = doc.paths["/api/v1/feed/tells"]?.post;
  expect(op).toBeDefined();
  expect(op.responses["201"]).toBeDefined();
  const text = JSON.stringify(op);
  for (const w of ["app", "text", "variants", "from", "invalid_text", "invalid_variants", "invalid_from", "unverified", "forbidden"])
    expect(text).toContain(w);
});

test("the origin applications are described, and a client secret is written, never read back", () => {
  const doc = openapi("https://f.test", "1", "admin") as any;
  const list = doc.paths["/api/v1/user/origin-apps"];
  const add = list.post;
  expect(add.requestBody).toBeDefined();
  expect(Object.keys(add.responses)).toContain("201");
  expect(JSON.stringify(add.responses.default)).toContain("private_host");
  expect(JSON.stringify(doc.paths["/api/v1/user/origin-apps/{id}"].delete.responses)).toContain("not_found");
  const reply = JSON.stringify(list.get.responses["200"]);
  expect(reply).not.toContain("clientSecret");
  // A bare array, so the 200 must not claim to be one application object.
  expect(reply).not.toContain('"id"');
  expect(list.get.summary).toContain("bare array [{ id,");
  expect(list.get.summary).toContain("hasSecret");
  expect(JSON.stringify(add.responses["201"])).not.toContain("clientSecret");
});

test("labels made and removed, a commit's check and a file read by path are described", () => {
  const doc = openapi("https://f.test", "1", "admin") as any;
  const R = "/api/v1/repos/{owner}/{name}";
  const make = doc.paths[`${R}/labels`].post;
  expect(make.security).toBeDefined();
  expect(Object.keys(make.requestBody.content["application/json"].schema.properties)).toEqual(["name", "color"]);
  expect(make.responses["201"]).toBeDefined();
  const del = doc.paths[`${R}/labels/{id}`].delete;
  expect(del.security).toBeDefined();
  expect(del.responses["204"]).toBeDefined();
  const check = doc.paths[`${R}/commits/{oid}/check`].get;
  expect(check.security).toEqual([]);
  expect(check.parameters.find((p: any) => p.name === "oid").in).toBe("path");
  const read = doc.paths[`${R}/contents/{path}`].get;
  expect(read.security).toEqual([]);
  expect(read.parameters.map((p: any) => p.name)).toEqual(["owner", "name", "path", "ref"]);
});

test("the feed, chips and asks routes are described, and the bulk default is a preview", () => {
  const doc = openapi("https://f.test", "1", "admin") as any;
  const want: Record<string, string[]> = {
    "/api/v1/feed": ["get"],
    "/api/v1/feed/chips": ["get", "post"],
    "/api/v1/feed/interactions": ["post"],
    "/api/v1/feed/tells": ["post"],
    "/api/v1/asks": ["get"],
    "/api/v1/asks/bulk": ["post"],
    "/api/v1/asks/bulk/{id}/undo": ["post"],
    "/api/v1/asks/decide": ["post"],
    "/api/v1/asks/decide/{id}/undo": ["post"],
    "/api/v1/asks/proposal/{id}/{verb}": ["post"],
  };
  for (const [path, methods] of Object.entries(want))
    for (const m of methods) expect(doc.paths[path]?.[m]?.security, `${m} ${path}`).toBeDefined();
  const bulk = doc.paths["/api/v1/asks/bulk"].post;
  expect(bulk.summary).toContain("default is a preview");
  expect(bulk.responses["201"]).toBeDefined();
  expect(bulk.responses["200"]).toBeDefined();
  expect(Object.keys(bulk.requestBody.content["application/json"].schema.properties)).toEqual(["action", "items", "reason", "preview"]);
  expect(bulk.responses.default.description).toContain("too_many");
  expect(doc.paths["/api/v1/asks/decide"].post.responses.default.description).toContain("too_many");
});

test("every feed and asks route src/http/feed.ts registers is described", () => {
  const src = readFileSync("src/http/feed.ts", "utf8");
  const doc = openapi("https://f.test", "1", "admin") as any;
  const registered = [...src.matchAll(/router\.add\("(\w+)",\s*"([^"]+)"/g)].filter((m) => /^\/api\/v1\/(feed|asks)\b/.test(m[2]!))
    .map((m) => [m[1]!.toLowerCase(), m[2]!.replace(/:(\w+)/g, "{$1}")] as const);
  expect(registered.length).toBeGreaterThan(8);
  for (const [method, path] of registered) expect(doc.paths[path]?.[method], `${method} ${path}`).toBeDefined();
});

test("the served document is tagged by version and origin and answers 304 to its tag", async () => {
  const { openapiText } = await import("../src/contract/served.ts");
  const { weakEtag } = await import("../src/http/etag.ts");
  const a = openapiText("https://a.example", "1", "admin");
  expect(openapiText("https://a.example", "1", "admin")).toBe(a);
  expect(a.etag).toBe(weakEtag(a.text));
  expect(openapiText("https://a.example", "2", "admin").etag).not.toBe(a.etag);
  expect(openapiText("https://b.example", "1", "admin").etag).not.toBe(a.etag);

  const dir = await mkdtemp(join(tmpdir(), "forge-openapi-"));
  const app = createApp({ dataDir: dir, port: 0 });
  const servers = await serve(app);
  try {
    const first = await fetch(`${servers.url}/contract/openapi.json`);
    const etag = first.headers.get("etag")!;
    expect(etag).toBeTruthy();
    await first.text();
    const again = await fetch(`${servers.url}/contract/openapi.json`, { headers: { "if-none-match": etag } });
    expect(again.status).toBe(304);
    expect(await again.text()).toBe("");
  } finally {
    servers.stop();
    app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("people, organizations and agents are described", () => {
  const doc = openapi("https://f.test", "1", "admin") as any;
  for (const path of [
    "/api/v1/users/{username}",
    "/api/v1/users/{username}/repos",
    "/api/v1/orgs/{org}",
    "/api/v1/orgs/{org}/teams",
    "/api/v1/orgs/{org}/teams/{team}/members",
    "/api/v1/agents",
  ])
    expect(doc.paths[path]?.get, `get ${path}`).toBeDefined();
  for (const path of [
    "/api/v1/users/{username}/repos",
    "/api/v1/orgs/{org}/teams",
    "/api/v1/orgs/{org}/teams/{team}/members",
  ]) {
    const get = doc.paths[path].get;
    expect(get.parameters.filter((p: any) => p.in === "query").map((p: any) => p.name), path).toEqual(["limit", "cursor"]);
    expect(get.summary, path).toContain("next_cursor");
    expect(get.summary, path).not.toContain("bare array");
  }
});

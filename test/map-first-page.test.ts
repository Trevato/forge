/**
 * The First button on the map page (#7808): a writer posts a same-origin
 * form and the ready list puts that issue first, marked "first, by <who>".
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { openIssue, setIssueState } from "../src/actions/issues.ts";
import { createRepo } from "../src/actions/repos.ts";
import { addDependency } from "../src/core/dependencies.ts";
import { getIssueById } from "../src/core/issues.ts";
import { getRepoById } from "../src/core/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

describe("First on the map page", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let cookie: string;
  let alpha = 0;
  let beta = 0;
  let blocked = 0;
  let closed = 0;

  const user = async (username: string, first: boolean): Promise<User> => {
    const made = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username,
      email: `${username}@forge.local`,
      password: "a-good-passphrase",
      adminIfFirst: first,
    });
    if (!made.ok) throw new Error(made.error);
    return made.value;
  };
  const signIn = async (username: string): Promise<string> => {
    const res = await fetch(`${base}/signin`, {
      method: "POST",
      body: new URLSearchParams({ username, password: "a-good-passphrase" }),
      redirect: "manual",
    });
    return (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  };
  const ready = async (c: string): Promise<string> => {
    const text = await (await fetch(`${base}/alice/plan/map`, { headers: { cookie: c } })).text();
    const at = text.indexOf("Ready now");
    return text.slice(at, text.indexOf("Blocked on", at));
  };
  const order = (section: string): number[] =>
    [...section.matchAll(/#(\d+) ·/g)].map((m) => Number(m[1])).filter((n) => n === alpha || n === beta);

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-map-first-page-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = `http://127.0.0.1:${servers.port}`;
    const alice = await user("alice", true);
    await user("bob", false);
    const made = await createRepo(app, alice, { name: "plan", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    for (const title of ["Alpha work", "Beta work"]) {
      const o = openIssue(app, alice, made.value, { title });
      if (!o.ok) throw new Error(String(o.error));
      if (title === "Alpha work") alpha = o.value.number;
      else beta = o.value.number;
    }
    const repo = made.value;
    const gamma = openIssue(app, alice, repo, { title: "Gamma work" });
    const delta = openIssue(app, alice, repo, { title: "Delta work" });
    const epsilon = openIssue(app, alice, repo, { title: "Epsilon work" });
    if (!gamma.ok || !delta.ok || !epsilon.ok) throw new Error("issues");
    // Delta waits for Gamma; Epsilon is closed.
    addDependency(app.db, delta.value, gamma.value, alice.id);
    setIssueState(app, alice, getRepoById(app.db, repo.id)!, getIssueById(app.db, epsilon.value.id)!, "closed");
    blocked = delta.value.number;
    closed = epsilon.value.number;
    cookie = await signIn("alice");
  });

  afterAll(async () => {
    await servers.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  const post = (n: number, headers: Record<string, string> = {}) =>
    fetch(`${base}/alice/plan/issues/${n}/first`, {
      method: "POST",
      headers: { cookie, origin: base, ...headers },
      body: new URLSearchParams({ back: "/alice/plan/map" }),
      redirect: "manual",
    });

  test("a reader sees no First button, a writer does", async () => {
    const reader = await ready(await signIn("bob"));
    expect(reader).toContain("Alpha work");
    expect(reader).not.toContain(`/issues/${beta}/first`);
    const writer = await ready(cookie);
    expect(writer).toContain(`action="/alice/plan/issues/${beta}/first"`);
  });

  test("a cross-origin post is refused and changes nothing", async () => {
    expect((await post(beta, { origin: "https://evil.example" })).status).toBe(403);
    expect(order(await ready(cookie))).toEqual([alpha, beta]);
  });

  test("posting the form puts the issue first and says by whom", async () => {
    expect((await post(beta)).status).toBe(303);
    const section = await ready(cookie);
    expect(order(section)).toEqual([beta, alpha]);
    expect(section).toContain("first, by alice");
    expect(section.match(/first, by/g)?.length).toBe(1);
  });

  test("a blocked or closed issue is refused with a flash, and nothing changes", async () => {
    for (const n of [blocked, closed]) {
      const res = await post(n);
      expect(res.status).toBe(303);
      const flash = decodeURIComponent((res.headers.get("set-cookie") ?? "").split(";")[0]!.split("=").slice(1).join("="));
      expect(flash).toContain("nothing waits in front of");
    }
    expect(order(await ready(cookie))).not.toContain(blocked);
    expect(app.db.query("SELECT 1 FROM issue_first WHERE issue_id IN (SELECT id FROM issue WHERE number IN (?1, ?2))").all(blocked, closed)).toHaveLength(0);
  });

  test("a signed-out post goes to sign in; a reader's post is refused; a read-only token too", async () => {
    const before = order(await ready(cookie));
    const out = await post(alpha, { cookie: "" });
    expect(out.status).toBe(303);
    expect(out.headers.get("location")).toContain("/signin");
    const bobCookie = await signIn("bob");
    const reader = await post(alpha, { cookie: bobCookie });
    expect(reader.status).toBe(303);
    expect(decodeURIComponent(reader.headers.get("set-cookie") ?? "")).toContain("write access");
    const ro = createToken(app.db, getUserByName(app.db, "alice")!.id, "ro", "ro").token;
    const denied = await post(alpha, { cookie: "", authorization: `Bearer ${ro}` });
    expect(denied.status).toBe(403);
    expect(order(await ready(cookie))).toEqual(before);
  });

  test("a script asking for JSON gets JSON, ok or not", async () => {
    const bad = await post(blocked, { accept: "application/json" });
    expect(bad.status).toBe(422);
    expect(((await bad.json()) as { ok: boolean }).ok).toBe(false);
    const good = await post(alpha, { accept: "application/json" });
    expect(good.status).toBe(200);
    expect(await good.json()).toMatchObject({ ok: true });
    expect(order(await ready(cookie))[0]).toBe(alpha);
  });

  test("the map page's live region listens for issue.first", async () => {
    const text = await (await fetch(`${base}/alice/plan/map`, { headers: { cookie } })).text();
    expect(text).toMatch(/data-live="[^"]*issue\.\*/);
  });
});

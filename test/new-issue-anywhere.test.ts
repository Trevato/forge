import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { shellJs } from "../src/web/client.ts";
import { cleanFrom, newIssueHref, withFromLine } from "../src/web/issue_from.ts";
import { adminCookie } from "./helpers/admin.ts";

describe("a new issue from any page", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let cookie = "";

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-newissue-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    cookie = await adminCookie(app, { username: "mel", email: "mel@f.dev", password: "issue-tracker-pass" });
    await fetch(`${base}/new`, {
      method: "POST",
      headers: { cookie },
      body: new URLSearchParams({ name: "proj", visibility: "public" }),
      redirect: "manual",
    });
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("the menu carries the link for a signed-in person and a guest, with no script", async () => {
    const signedIn = await (await fetch(`${base}/mel/proj`, { headers: { cookie } })).text();
    expect(signedIn).toContain('href="/new/issue?from=%2Fmel%2Fproj"');
    const guest = await (await fetch(`${base}/mel/proj`)).text();
    expect(guest).toContain('href="/new/issue?from=%2Fmel%2Fproj"');
    // The guest's link leads to sign in, never to a form (next test).
    // Read-only origin browse has no such link.
    const origin = await (await fetch(`${base}/origins/none/r/x/y`, { headers: { cookie } })).text();
    expect(origin).not.toContain("/new/issue");
  });

  test("c and Shift C open the door from the page, and the help names each case", () => {
    expect(shellJs).toContain("['c', 'C'], openNewIssue]");
    expect(shellJs).toContain("['C'], openNewIssue]");
    expect(shellJs).toContain("['c'], function (e) { if (focusBox()) e.preventDefault(); else openNewIssue(e); }]");
    expect(shellJs).toContain("'/new/issue?from=' + encodeURIComponent(p)");
    // A page with its own box (or its own c) shows Shift C alone; any other, both keys.
    expect(shellJs).toContain("var ownC = pageBox() || doc.querySelector('[data-shortcut=\"c\"]');");
    expect(shellJs).toContain("ownC ? ['Shift C', 'New issue from this page', ['C'], openNewIssue] : ['c / Shift C'");
    expect(shellJs).toContain("out.push(['c', doc.querySelector('[data-box]')");
  });

  test("from a page in a repository the link lands on its form, prefilled", async () => {
    const door = await fetch(`${base}/new/issue?from=${encodeURIComponent("/mel/proj/pulls")}`, { headers: { cookie }, redirect: "manual" });
    expect(door.status).toBe(303);
    const to = door.headers.get("location")!;
    expect(to.startsWith("/mel/proj/issues/new?from=")).toBe(true);
    const text = await (await fetch(`${base}${to}`, { headers: { cookie } })).text();
    expect(text).toContain('<input type="hidden" name="from" value="/mel/proj/pulls"');
  });

  test("outside a repository it is a picker over the repositories the viewer may write", async () => {
    const res = await fetch(`${base}/new/issue?from=${encodeURIComponent("/explore")}`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('href="/mel/proj/issues/new?from=%2Fexplore"');
  });

  test("the issue ends with the line naming the page; a foreign from is dropped", async () => {
    const post = (from: string) =>
      fetch(`${base}/mel/proj/issues/new`, {
        method: "POST",
        headers: { cookie },
        body: new URLSearchParams({ title: "Broken", body: "It breaks.", from }),
        redirect: "manual",
      });
    const first = await post("/mel/proj/pulls");
    expect(first.status).toBe(303);
    const issue = await (await fetch(`${base}/mel/proj/issues/1`)).text();
    expect(issue).toContain("Opened from <code>/mel/proj/pulls</code>");
    await post("https://evil.example/x");
    const second = await (await fetch(`${base}/mel/proj/issues/2`)).text();
    expect(second).not.toContain("Opened from");
    expect(second).not.toContain("evil.example");
  });

  test("a guest gets the sign-in path, never a form", async () => {
    const res = await fetch(`${base}/new/issue?from=${encodeURIComponent("/mel/proj")}`, { redirect: "manual" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain("/signin");
    const repoForm = await (await fetch(`${base}/mel/proj/issues/new?from=%2Fmel%2Fproj`)).text();
    expect(repoForm).not.toContain('action="/mel/proj/issues/new"');
  });

  test("from is a same-origin path only", () => {
    expect(cleanFrom("/a/b")).toBe("/a/b");
    for (const bad of ["//evil.example", "https://x", "a/b", "/a b", "/a\\b", "", "/x".repeat(200), "/a)[x](http://e)", "/a`b", "/a<b", "/a#b", "/a![i](u)", "/a?b=c"])
      expect(cleanFrom(bad)).toBeUndefined();
    expect(newIssueHref("/new/issue")).toBe("/new/issue");
    expect(withFromLine("hi", "/x")).toBe("hi\n\nOpened from `/x`");
    expect(withFromLine("", "/x")).toBe("Opened from `/x`");
  });
});

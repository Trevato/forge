/** A phone share sheet reaches the crew: manifest → composer → one tell (#10390). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { COMPOSER_FIELDS, SHARE_PARAMS, claimShare, forgetShares, releaseShare } from "../src/web/share_target.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dataDir: string;
let app: App;
let servers: Servers;
let cookie = "";

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-share-target-"));
  app = createApp({ dataDir, port: 0, host: "forge.test" });
  servers = await serve(app);
  const made = await createUser(app.db, {
    origin: "seed", trusted: true, username: "alice", email: "alice@forge.local",
    password: "a-good-passphrase", adminIfFirst: true,
  });
  if (!made.ok) throw new Error(made.error);
  const res = await fetch(`${servers.url}/signin`, {
    method: "POST",
    body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }),
    redirect: "manual",
  });
  cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
}, 120_000);

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

const shareQuery = (o: Record<string, string>) => new URLSearchParams(o).toString();
const thoughts = () => app.db.query<{ n: number }, []>("SELECT count(*) AS n FROM thought").get()!.n;

test("the manifest declares the same names the composer uses", async () => {
  const m = (await (await fetch(`${servers.url}/manifest.webmanifest`)).json()) as { share_target: { action: string; method: string; params: Record<string, string> } };
  expect(m.share_target).toEqual({ action: "/", method: "GET", params: { ...SHARE_PARAMS } });
});

test("a share opens the composer with title, text and url joined, escaped", async () => {
  const q = shareQuery({ title: "Nice <b>page</b>", text: "look at this", url: "https://example.com/a?b=1&c=<x>" });
  const out = await (await fetch(`${servers.url}/?${q}`, { headers: { cookie } })).text();
  const area = /<input[^>]*name="text"[^>]*value="([^"]*)"/.exec(out)?.[1] ?? "";
  expect(area).toBe("Nice &lt;b&gt;page&lt;/b&gt; look at this https://example.com/a?b=1&amp;c=&lt;x&gt;");
  expect(out).not.toContain("<b>page</b>");
});

test("an enormous share is cut to what the composer takes", async () => {
  const out = await (await fetch(`${servers.url}/?${shareQuery({ text: "x".repeat(6_000) })}`, { headers: { cookie } })).text();
  const area = /<input[^>]*name="text"[^>]*value="([^"]*)"/.exec(out)?.[1] ?? "";
  expect(area.length).toBe(2000);
});

test("a signed-out sharer is sent to sign in with the way back, same-origin only", async () => {
  const q = shareQuery({ text: "hello", url: "https://example.com/" });
  const out = await (await fetch(`${servers.url}/?${q}`)).text();
  expect(out).toContain(`/signin?next=${encodeURIComponent("/?" + q)}`);
  // The sign-in page only ever returns to a path on this origin.
  for (const evil of ["//evil.example/", "https://evil.example/", "/\\evil.example"]) {
    const res = await fetch(`${servers.url}/signin?next=${encodeURIComponent(evil)}`, {
      method: "POST",
      body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }),
      redirect: "manual",
    });
    expect(res.headers.get("location") ?? "/").not.toContain("evil.example");
  }
  const ok = await fetch(`${servers.url}/signin?next=${encodeURIComponent("/?" + q)}`, {
    method: "POST",
    body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }),
    redirect: "manual",
  });
  expect(ok.headers.get("location")).toBe("/?" + q);
});

test("the shared composer, posted twice, queues one thought", async () => {
  const q = shareQuery({ text: "make the header blue", url: "https://example.com/h" });
  const page = await (await fetch(`${servers.url}/?${q}`, { headers: { cookie } })).text();
  const once = /name="once" value="([0-9a-f]+)"/.exec(page)?.[1];
  expect(once).toBeDefined();
  const before = thoughts();
  const post = () =>
    fetch(`${servers.url}/tell`, {
      method: "POST",
      headers: { cookie, origin: servers.url },
      body: new URLSearchParams({
        [COMPOSER_FIELDS.text]: "make the header blue\nhttps://example.com/h",
        [COMPOSER_FIELDS.app]: "forge",
        [COMPOSER_FIELDS.once]: once!,
      }),
      redirect: "manual",
    });
  await post();
  await post();
  expect(thoughts()).toBe(before + 1);
});

const postTell = (fields: Record<string, string>) =>
  fetch(`${servers.url}/tell`, { method: "POST", headers: { cookie, origin: servers.url }, body: new URLSearchParams(fields), redirect: "manual" });

test("the feed composer carries the draft in its textarea, escaped, with a once token", async () => {
  const q = shareQuery({ text: "fix <script>x</script>", url: "https://example.com/f" });
  const out = await (await fetch(`${servers.url}/feed?${q}`, { headers: { cookie } })).text();
  const area = /<textarea[^>]*name="text"[^>]*>([^<]*)<\/textarea>/.exec(out)?.[1] ?? "";
  expect(area).toBe("fix &lt;script&gt;x&lt;/script&gt;\nhttps://example.com/f");
  expect(out).not.toContain("<script>x</script>");
  expect(/name="once" value="[0-9a-f]{24}"/.test(out)).toBe(true);
  expect(out).toContain(`name="${COMPOSER_FIELDS.back}" value="/feed"`);
});

test("a failed post does not burn the token: the retry is queued", async () => {
  const once = "a".repeat(24);
  const before = thoughts();
  await postTell({ [COMPOSER_FIELDS.text]: "   ", [COMPOSER_FIELDS.app]: "forge", [COMPOSER_FIELDS.once]: once });
  expect(thoughts()).toBe(before);
  await postTell({ [COMPOSER_FIELDS.text]: "second try", [COMPOSER_FIELDS.app]: "forge", [COMPOSER_FIELDS.once]: once });
  expect(thoughts()).toBe(before + 1);
  await postTell({ [COMPOSER_FIELDS.text]: "second try", [COMPOSER_FIELDS.app]: "forge", [COMPOSER_FIELDS.once]: once });
  expect(thoughts()).toBe(before + 1);
});

test("a malformed token is refused; no token is an ordinary tell", async () => {
  const before = thoughts();
  await postTell({ [COMPOSER_FIELDS.text]: "bad token", [COMPOSER_FIELDS.app]: "forge", [COMPOSER_FIELDS.once]: "nope" });
  expect(thoughts()).toBe(before);
  await postTell({ [COMPOSER_FIELDS.text]: "no token", [COMPOSER_FIELDS.app]: "forge" });
  await postTell({ [COMPOSER_FIELDS.text]: "no token", [COMPOSER_FIELDS.app]: "forge" });
  expect(thoughts()).toBe(before + 2);
});

test("claimShare evicts only the oldest when full, and release gives a token back", () => {
  forgetShares();
  const hex = (n: number) => n.toString(16).padStart(24, "0");
  for (let i = 0; i < 2000; i++) expect(claimShare("u", hex(i), 1000 + i)).toBe("fresh");
  expect(claimShare("u", hex(5000), 4000)).toBe("fresh");
  expect(claimShare("u", hex(1999), 4001)).toBe("seen"); // recent ones survive
  expect(claimShare("u", hex(0), 4002)).toBe("fresh"); // the oldest went
  expect(claimShare("u", "zz", 4003)).toBe("bad");
  releaseShare("u", hex(1999));
  expect(claimShare("u", hex(1999), 4004)).toBe("fresh");
  forgetShares();
});

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import type { Repo } from "../src/core/repos.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { mergedPull, waveNaming } from "./helpers/wave-pulls.ts";
import { waveRow } from "../src/web/pages/waves.ts";
import { writeWave, type Wave } from "../src/story/wave.ts";

const PASSWORD = "a-good-passphrase";

const wave = (version: string, date: string, headline: string): Wave => ({
  version,
  date,
  headline,
  highlights: [1, 2, 3].map((n) => ({ title: `Thing ${n}`, why: "because" })),
  pulls: [{ title: "#1 A pull", url: "https://forge.example/o/r/pulls/1" }],
});
const text = (w: Wave): string => {
  const r = writeWave(w);
  if (!r.ok) throw r.error;
  return r.value;
};

describe("waves page", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let alice: User;
  let cookie = "";
  let pub: Repo;
  let priv: Repo;
  let bare: Repo;

  const must = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    return r.value;
  };
  const put = async (repo: Repo, files: { path: string; content: string }[]) =>
    must(await commitToBranch(app, alice, repo, { message: "waves", files }));
  const get = (path: string, withCookie = true) =>
    fetch(`${servers.url}${path}`, {
      headers: withCookie ? { cookie } : {},
    });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-waves-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    alice = must(
      await createUser(app.db, {
        origin: "seed",
        trusted: true,
        username: "alice",
        email: "alice@f.dev",
        password: PASSWORD,
        adminIfFirst: true,
      }),
    );
    cookie = `forge_session=${createSession(app.db, alice.id).token}; forge_mode=dev`;
    pub = must(await createRepo(app, alice, { name: "pub", visibility: "public" }));
    priv = must(await createRepo(app, alice, { name: "priv", visibility: "private" }));
    bare = must(await createRepo(app, alice, { name: "bare", visibility: "public" }));
    await put(bare, [{ path: "README.md", content: "hi\n" }]);
    await put(pub, [
      { path: "waves/0.9.0.md", content: text(wave("0.9.0", "2026-01-01", "Ninth")) },
      { path: "waves/0.10.0.md", content: text(wave("0.10.0", "2026-02-01", "Tenth")) },
      { path: "waves/0.2.0.md", content: text(wave("0.2.0", "2025-12-01", "<script>alert(1)</script> & Zeta")) },
      { path: "waves/0.3.0.md", content: text({ ...wave("0.3.0", "2025-12-15", "Evil <b>links</b>"), highlights: [{ title: "T<i>1</i>", why: "why <u>one</u>" }, { title: "Two", why: "w" }, { title: "Three", why: "w" }] }) },
      { path: "waves/0.5.0.md", content: text(wave("0.5.0", "2025-12-16", "Js")).replace("https://forge.example/o/r/pulls/1", "javascript:alert(1)") },
      { path: "waves/0.4.0.md", content: "no front matter here\n" },
      { path: "waves/broken.md", content: "no front matter here\n" },
    ]);
    await put(priv, [
      { path: "waves/1.0.0.md", content: text(wave("1.0.0", "2026-03-01", "Secret launch")) },
    ]);
    const shown = await mergedPull(app, alice, pub, "Shown work");
    const secret = await mergedPull(app, alice, priv, "Secret work");
    await put(pub, [
      {
        path: "waves/0.1.0.md",
        content: waveNaming("0.1.0", [
          { owner: "alice", name: "pub", number: shown },
          { owner: "alice", name: "priv", number: secret },
        ]),
      },
    ]);
  }, 60_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("lists newest version first, numerically", async () => {
    const res = await get("/alice/pub/waves");
    expect(res.status).toBe(200);
    const body = await res.text();
    const at = (s: string) => body.indexOf(s);
    expect(at("Tenth")).toBeGreaterThan(-1);
    expect(at("Tenth")).toBeLessThan(at("Ninth"));
    expect(at("Ninth")).toBeLessThan(at("Zeta"));
    expect(body).toContain("0.10.0 · 2026-02-01 · 0 pulls");
    expect(body).toContain("0.9.0 · 2026-01-01 · 0 pulls");
    expect(at("0.10.0 · 2026-02-01")).toBeLessThan(at("0.9.0 · 2026-01-01"));
    expect(body).toContain('href="/alice/pub/waves/0.10.0"');
  });

  test("a headline with markup comes out inert", async () => {
    const body = await (await get("/alice/pub/waves")).text();
    expect(body).not.toContain("<script>alert(1)</script>");
    expect(body).toContain("&lt;script&gt;alert(1)&lt;/script&gt; &amp; Zeta");
  });

  test("an unparsable file is listed with its reason and the rest still shows", async () => {
    const body = await (await get("/alice/pub/waves")).text();
    expect(body).toContain("broken.md");
    expect(body).toContain("missing front matter");
    expect(body).toContain("Tenth");
  });

  test("settings links to the list from the Cut a wave card", async () => {
    const body = await (await get("/alice/pub/settings")).text();
    expect(body).toContain('href="/alice/pub/waves"');
  });

  test("the repository home draws the newest wave in one line, linked", async () => {
    const res = await get("/alice/pub");
    const body = await res.text();
    expect(body).toContain("latest-wave");
    expect(body).toContain('href="/alice/pub/waves/0.10.0"');
    expect(body).toContain("Tenth · 2026-02-01");
    expect(body).not.toContain("Ninth");
    expect(res.headers.get("server-timing")).toContain("wave");
  });

  test("the repository home without waves draws no wave line", async () => {
    const body = await (await get("/alice/bare")).text();
    expect(body).not.toContain("latest-wave");
  });

  test("no waves/ gets the empty state", async () => {
    const res = await get("/alice/bare/waves");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("No waves yet");
  });

  test("the empty state says what a wave is; an admin gets Cut a wave, a reader does not", async () => {
    const admin = await (await get("/alice/bare/waves")).text();
    expect(admin).toContain("A wave is a release note");
    expect(admin).toContain('action="/alice/bare/settings/wave"');
    expect(admin).toContain("Cut a wave");
    const reader = await (await get("/alice/bare/waves", false)).text();
    expect(reader).toContain("A wave is a release note");
    expect(reader).not.toContain("Cut a wave");
    expect(reader).not.toContain("/settings/wave");
  });

  test("the waves pages mark no tab as current", async () => {
    for (const path of ["/alice/pub/waves", "/alice/bare/waves", "/alice/pub/waves/0.10.0"]) {
      const body = await (await get(path)).text();
      expect(body).not.toContain('aria-current="page"');
    }
  });

  test("a private repository is refused to an outsider as any other page is", async () => {
    const waves = await get("/alice/priv/waves", false);
    const other = await get("/alice/priv/branches", false);
    expect(waves.status).toBe(other.status);
    expect(waves.status).toBe(404);
    expect(await waves.text()).not.toContain("Secret launch");
    const owner = await get("/alice/priv/waves");
    expect(await owner.text()).toContain("Secret launch");
  });

  test("one wave renders headline, date, highlights with why, pulls as links", async () => {
    const res = await get("/alice/pub/waves/0.10.0");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Tenth");
    expect(body).toContain("2026-02-01");
    expect(body).toContain("Thing 1");
    expect(body).toContain("because");
  });

  test("values are escaped and a javascript: pull is not a link", async () => {
    const body = await (await get("/alice/pub/waves/0.3.0")).text();
    expect(body).toContain("Evil &lt;b&gt;links&lt;/b&gt;");
    expect(body).toContain("why &lt;u&gt;one&lt;/u&gt;");
    expect(body).not.toContain("<b>links");
    const js = await (await get("/alice/pub/waves/0.5.0")).text();
    expect(js).not.toContain('href="javascript:');
  });

  test("an unknown or malformed version is a 404; an unparsable file shows its reason", async () => {
    expect((await get("/alice/pub/waves/9.9.9")).status).toBe(404);
    expect((await get("/alice/pub/waves/nope")).status).toBe(404);
    expect((await get("/alice/pub/waves/..%2Fx")).status).toBe(404);
    const bad = await get("/alice/pub/waves/0.4.0");
    expect(bad.status).toBe(200);
    expect(await bad.text()).toContain("missing front matter");
  });

  test("a private repository's wave is refused to an outsider", async () => {
    const out = await get("/alice/priv/waves/1.0.0", false);
    expect(out.status).toBe(404);
    expect(await out.text()).not.toContain("Secret launch");
    expect(await (await get("/alice/priv/waves/1.0.0")).text()).toContain("Secret launch");
  });

  test("waves.atom is Atom, one entry per wave, newest first", async () => {
    const res = await get("/alice/pub/waves.atom");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/atom+xml");
    const body = await res.text();
    expect(body.match(/<entry>/g)?.length).toBe(5);
    expect(body.indexOf("Tenth")).toBeLessThan(body.indexOf("Ninth"));
    expect(body).toContain('href="http://');
    expect(body).toContain("/alice/pub/waves/0.10.0");
  });

  test("a row counts the pulls this viewer can see, as the wave's page lists them", async () => {
    const body = await (await get("/alice/pub/waves")).text();
    expect(body).toContain("0.1.0 · 2026-03-05 · 2 pulls");
    const guest = await (await get("/alice/pub/waves", false)).text();
    expect(guest).toContain("0.1.0 · 2026-03-05 · 1 pull<");
    expect(guest).not.toContain("2 pulls");
    expect(guest).not.toContain("Secret work");
    const page = await (await get("/alice/pub/waves/0.1.0", false)).text();
    expect(page).toContain("Shown work");
    expect(page).not.toContain("Secret work");
  });

  test("a row is the headline with the first highlight's why under it, in a list with no card or Waves heading", async () => {
    const body = await (await get("/alice/pub/waves")).text();
    expect(body).toContain('<h1 class="sr-only">Waves</h1>');
    expect(body).not.toContain("<h2>Waves</h2>");
    expect(body).not.toContain('class="card');
    expect(body).toMatch(/class="row-title"[^>]*>Tenth<[\s\S]*?class="row-meta">\s*because\s*</);
    expect(body).not.toContain("title=\"0.10.0 ·");
  });

  test("a wave whose first why is empty has a row with no sentence and no stray separator", () => {
    const w = { ...wave("0.9.0", "2026-01-01", "Quiet"), highlights: [{ title: "T", why: "" }] };
    const r = waveRow(w, "/x", 1).text;
    expect(r).toContain("Quiet");
    expect(r).not.toContain("row-meta");
    expect(r).toContain("0.9.0 · 2026-01-01 · 1 pull");
    expect(r).not.toMatch(/·\s*·/);
  });

  test("waves.atom titles an entry with the headline", async () => {
    const body = await (await get("/alice/pub/waves.atom")).text();
    expect(body).toContain("<title>Tenth</title>");
  });

  test("waves.atom escapes markup in headlines and notes", async () => {
    const body = await (await get("/alice/pub/waves.atom")).text();
    expect(body).not.toContain("<script>");
    expect(body).not.toContain("<b>");
    expect(body).toContain("&amp;lt;u&amp;gt;one&amp;lt;/u&amp;gt;");
  });

  test("waves.atom of a private repository is a 404 to a stranger", async () => {
    expect((await get("/alice/priv/waves.atom", false)).status).toBe(404);
    expect((await get("/alice/priv/waves.atom")).status).toBe(200);
  });

  test("waves.atom answers a repeat with 304", async () => {
    const first = await get("/alice/pub/waves.atom");
    const etag = first.headers.get("etag")!;
    const again = await fetch(`${servers.url}/alice/pub/waves.atom`, {
      headers: { cookie, "if-none-match": etag },
    });
    expect(again.status).toBe(304);
  });

  test("the waves page advertises the feed", async () => {
    const body = await (await get("/alice/pub/waves")).text();
    expect(body).toContain('href="/alice/pub/waves.atom"');
    expect(body).toContain("application/atom+xml");
  });
});

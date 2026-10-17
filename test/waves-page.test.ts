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
import { webUrl } from "../src/web/pages/waves.ts";
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
    expect(body).toContain("0.10.0");
    expect(body).toContain("2026-02-01");
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

  test("no waves/ gets the empty state", async () => {
    const res = await get("/alice/bare/waves");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("No waves yet");
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
    expect(body).toContain('href="https://forge.example/o/r/pulls/1"');
  });

  test("values are escaped and a javascript: pull is not a link", async () => {
    const body = await (await get("/alice/pub/waves/0.3.0")).text();
    expect(body).toContain("Evil &lt;b&gt;links&lt;/b&gt;");
    expect(body).toContain("why &lt;u&gt;one&lt;/u&gt;");
    expect(body).not.toContain("<b>links");
    const js = await (await get("/alice/pub/waves/0.5.0")).text();
    expect(js).not.toContain('href="javascript:');
    expect(webUrl("javascript:alert(1)")).toBe(false);
    expect(webUrl("https://x.example/p/1")).toBe(true);
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
});

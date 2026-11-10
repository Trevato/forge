/** The story opens wave → pull → conversation, one tap each, and back to the same wave (#10702). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { backToWave } from "../src/story/waves.ts";
import { writeWave } from "../src/story/wave.ts";
import { quietLogs } from "./helpers/globals.ts";
import { mergedPull } from "./helpers/wave-pulls.ts";

quietLogs();

let root = "";
let app: App;
let servers: Servers;
let cookie = "";

const must = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "forge-story-walk-"));
  app = createApp({ dataDir: root, port: 0 });
  servers = await serve(app);
  const u = must(
    await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "keeper",
      email: "keeper@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    }),
  );
  cookie = `forge_session=${createSession(app.db, u.id).token}; forge_mode=dev`;
  const repo = must(await createRepo(app, u, { name: "alpha", visibility: "public" }));
  must(await commitToBranch(app, u, repo, { message: "init", files: [{ path: "README.md", content: "hi\n" }] }));
  const n = await mergedPull(app, u, repo, "Add the thing");
  const wave = (version: string, pulls: { title: string; url: string }[]) => {
    const w = writeWave({
      version,
      date: "2026-03-05",
      headline: `Wave ${version}`,
      highlights: [1, 2, 3].map((k) => ({ title: `Thing ${k}`, why: "because" })),
      pulls,
    });
    if (!w.ok) throw w.error;
    return { path: `waves/${version}.md`, content: w.value };
  };
  must(
    await commitToBranch(app, u, repo, {
      message: "waves",
      files: [
        wave("0.1.0", []),
        wave("0.2.0", [{ title: `#${n} Add the thing`, url: `https://forge.example/keeper/alpha/pulls/${n}` }]),
      ],
    }),
  );
}, 30_000);
afterAll(() => {
  servers.stop();
  app.close();
  rmSync(root, { recursive: true, force: true });
});

const get = async (path: string) => {
  const res = await fetch(`${servers.url}${path}`, { headers: { cookie } });
  return { res, body: await res.text() };
};
const href = (body: string, re: RegExp): string => {
  const m = re.exec(body);
  if (!m) throw new Error(`no link matching ${re}`);
  return m[1]!.replaceAll("&amp;", "&");
};
const fast = (res: Response) => {
  const app = /app;dur=([\d.]+)/.exec(res.headers.get("server-timing") ?? "");
  expect(app).not.toBeNull();
  expect(Number(app![1])).toBeLessThan(500); // loose: a slow machine must not flake it
};

test("waves → newest wave → its pull → the conversation, and back to the same wave", async () => {
  const list = await get("/keeper/alpha/waves");
  expect(list.res.status).toBe(200);
  const waveHref = href(list.body, /href="(\/keeper\/alpha\/waves\/0\.2\.0)"/);

  const wave = await get(waveHref);
  expect(wave.res.status).toBe(200);
  await get(waveHref); // warm
  fast((await get(waveHref)).res);
  const pullHref = href(wave.body, /href="(\/keeper\/alpha\/pulls\/\d+\?from=[^"]+)"/);

  const pull = await get(pullHref);
  expect(pull.res.status).toBe(200);
  expect(pull.body).toContain("Add the thing");
  expect(pull.body).toContain('id="pull-check"');
  fast((await get(pullHref)).res);

  expect(href(pull.body, /href="([^"]*)">Wave 0\.2\.0/)).toBe(waveHref);
  expect((await get(waveHref)).res.status).toBe(200);
});

test("a level with nothing below it shows no link", async () => {
  const empty = await get("/keeper/alpha/waves/0.1.0");
  expect(empty.res.status).toBe(200);
  expect(empty.body).toContain("No pulls to show here.");
  expect(empty.body).not.toMatch(/\/pulls\/\d+/);
});

test("a pull without a wave, or with a malformed one, shows no back link", () => {
  expect(backToWave(null)).toBeNull();
  expect(backToWave("../../x@1.0.0")).toBeNull();
  expect(backToWave("a/b@<script>")).toBeNull();
  expect(backToWave("a/b@1.0.0")).toEqual({ href: "/a/b/waves/1.0.0", version: "1.0.0" });
});

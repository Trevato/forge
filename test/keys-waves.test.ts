/** The waves list joins the shell's j/k row traversal: one data-nav per linked row, none on the empty page. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { writeWave } from "../src/story/wave.ts";

const must = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};

let dataDir: string;
let app: App;
let servers: Servers;
let cookie = "";

const wave = (version: string): string =>
  must(
    writeWave({
      version,
      date: "2026-03-05",
      headline: `Headline ${version}`,
      highlights: [1, 2, 3].map((n) => ({ title: `Thing ${n}`, why: "because" })),
      pulls: [],
    }),
  );

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-keys-waves-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const alice = must(
    await createUser(app.db, {
      origin: "seed", trusted: true, username: "alice", email: "alice@forge.local",
      password: "a-good-passphrase", adminIfFirst: true,
    }),
  );
  cookie = `forge_session=${createSession(app.db, alice.id).token}; forge_mode=dev`;
  const empty = must(await createRepo(app, alice, { name: "none", visibility: "public" }));
  must(await commitToBranch(app, alice, empty, { message: "init", files: [{ path: "README.md", content: "hi\n" }] }));
  const full = must(await createRepo(app, alice, { name: "some", visibility: "public" }));
  must(
    await commitToBranch(app, alice, full, {
      message: "waves",
      files: [
        { path: "waves/1.0.0.md", content: wave("1.0.0") },
        { path: "waves/1.1.0.md", content: wave("1.1.0") },
        { path: "waves/notes.md", content: "not a wave\n" },
      ],
    }),
  );
}, 60_000);

afterAll(async () => {
  await servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

const get = async (name: string) =>
  (await fetch(`${servers.url}/alice/${name}/waves`, { headers: { cookie } })).text();
const NAV = /class="row"[^>]*data-nav tabindex="-1"/g;

test("each linked wave row, including a file that is not a wave, is one data-nav row", async () => {
  const text = await get("some");
  expect(text.match(NAV)?.length).toBe(3);
  expect(text).toContain("Headline 1.1.0");
});

test("the empty waves page draws no data-nav row", async () => {
  const text = await get("none");
  expect(text).toContain("No waves yet");
  expect(text).not.toMatch(/class="row"[^>]*data-nav tabindex="-1"/);
});

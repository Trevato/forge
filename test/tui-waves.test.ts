import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { signUp } from "../src/actions/users.ts";
import { createApp, type App as Forge } from "../src/app.ts";
import type { Repo } from "../src/core/repos.ts";
import type { User } from "../src/core/users.ts";
import { writeWave, type Wave } from "../src/story/wave.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { waveLines, wavesScreen } from "../src/tui/screens/waves.ts";
import type { RepoSource } from "../src/view/source.ts";
import { local } from "../src/tui/screens/where.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";
import { fixtureSlot } from "./helpers/slot.ts";
import { seedAdmin } from "./helpers/admin.ts";

quietLogs();

const wave = (version: string, date: string, headline: string): Wave => ({
  version,
  date,
  headline,
  highlights: [1, 2, 3].map((n) => ({ title: `Thing ${n}`, why: "because" })),
  pulls: [{ title: "#1 A pull", url: "https://forge.example/o/r/pulls/1" }],
});
/** The same source, read live from another forge. */
const remoteOf = (src: RepoSource): RepoSource => ({
  ...src,
  where: {
    kind: "origin",
    origin: {
      id: "o1",
      userId: "u1",
      kind: "github",
      apiUrl: "https://api.github.test",
      webUrl: "https://github.test",
      login: "someone",
      createdAt: "2026-01-01T00:00:00Z",
      lastSyncAt: null,
      lastError: "",
      authKind: "pat",
      expiresAt: null,
      needsReauth: false,
    },
    fullName: "someone/else",
    htmlUrl: "https://github.test/someone/else",
  },
});
const text = (w: Wave): string => {
  const r = writeWave(w);
  if (!r.ok) throw r.error;
  return r.value;
};

describe("waves in the terminal", () => {
  let dataDir: string;
  let forge: Forge;
  let alice: User;
  let bob: User;
  let pub: Repo;
  let priv: Repo;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-tui-waves-"));
    forge = createApp({ dataDir, port: 0 });
    const a = await seedAdmin(forge, { username: "alice", email: "a@f.test", password: "a-long-passphrase" });
    const b = await signUp(forge, { username: "bob", email: "b@f.test", password: "a-long-passphrase" }, { slot: fixtureSlot(forge) });
    if (!a.ok || !b.ok) throw new Error("signup failed");
    alice = a.value;
    bob = b.value;
    const p = await createRepo(forge, alice, { name: "pub", visibility: "public" });
    const q = await createRepo(forge, alice, { name: "priv", visibility: "private" });
    if (!p.ok || !q.ok) throw new Error("repo failed");
    pub = p.value;
    priv = q.value;
    const put = (repo: Repo, files: { path: string; content: string }[]) =>
      commitToBranch(forge, alice, repo, { message: "waves", files });
    await put(pub, [
      { path: "waves/0.9.0.md", content: text(wave("0.9.0", "2026-01-01", "Ninth")) },
      { path: "waves/0.10.0.md", content: text(wave("0.10.0", "2026-02-01", "Tenth")) },
      { path: "waves/broken.md", content: "no front matter\n" },
    ]);
    await put(priv, [
      { path: "waves/1.0.0.md", content: text(wave("1.0.0", "2026-03-01", "Secret launch")) },
    ]);
  });

  afterAll(async () => {
    forge.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const open = async (
    user: User,
    repo: Repo,
    keys: string[] = [],
    remote = false,
  ): Promise<{ text: string; stop(): void }> => {
    const terminal = headlessTerminal(120, 40);
    const { app, session } = createForgeApp(
      forge,
      { sshUsername: user.username, remoteAddress: "127.0.0.1", fingerprint: "SHA256:t", user },
      { terminal, exitHooks: false },
    );
    app.start();
    await settleApp(app);
    const here = local(session, repo);
    const src = remote ? remoteOf(here) : here;
    app.push(wavesScreen(session, app.ctx, src));
    await settleApp(app);
    for (const k of keys) {
      terminal.feed(k === "enter" ? "\r" : k);
      await settleApp(app);
    }
    return { text: app.screen.toText(), stop: () => app.stop() };
  };

  test("lists the web page's rows in the same order, bad files last", async () => {
    const h = await open(alice, pub);
    h.stop();
    const at = (s: string) => h.text.indexOf(s);
    expect(at("Tenth")).toBeGreaterThan(-1);
    expect(at("Tenth")).toBeLessThan(at("Ninth"));
    expect(at("Ninth")).toBeLessThan(at("broken.md"));
    expect(h.text).toContain("0.10.0");
  });

  test("a reader who cannot read the repository sees no waves", async () => {
    const h = await open(bob, priv);
    h.stop();
    expect(h.text).not.toContain("Secret launch");
    expect(h.text).toContain("No waves yet");
  });

  test("enter opens one wave: headline, version, date, highlights with why, pulls", async () => {
    const h = await open(alice, pub, ["enter"]);
    h.stop();
    expect(h.text).toContain("Tenth");
    expect(h.text).toContain("0.10.0  2026-02-01");
    expect(h.text).toContain("Thing 1 - because");
    expect(h.text).toContain("#1 A pull");
    expect(h.text).toContain("https://forge.example/o/r/pulls/1");
  });

  test("enter on an unparsable row shows its reason", async () => {
    const h = await open(alice, pub, ["j", "j", "enter"]);
    h.stop();
    expect(h.text).toContain("broken.md");
    expect(h.text).toContain("Not a wave:");
  });

  test("wave text carries no escape or control characters", () => {
    const lines = waveLines({
      ok: true,
      file: "1.0.0.md",
      wave: {
        version: "1.0.0",
        date: "2026-01-01",
        headline: "Hi\u001b[31m red\u0007\u202e",
        highlights: [{ title: "T\u001b]0;x\u0007", why: "w\nz" }],
        pulls: [{ title: "P", url: "https://x.example/\u001b[2J" }],
      },
    });
    expect(lines.join("\n")).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/);
  });

  test("a live browse says waves are only read on this forge", async () => {
    const h = await open(alice, pub, [], true);
    h.stop();
    expect(h.text).toContain("only read on this forge");
    expect(h.text).not.toContain("no waves/ directory");
  });
});

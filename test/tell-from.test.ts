/** `from` on a tell is a place on this forge, or an app's own address from that app (#7092). */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { tell } from "../src/actions/tell.ts";
import { listIssues } from "../src/core/issues.ts";
import type { Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";

let dir: string;
let app: App;
let alice: User;
let repo: Repo;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-tellfrom2-"));
  app = createApp({ dataDir: dir, port: 0 });
  const u = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "alice@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!u.ok) throw new Error(u.error);
  alice = u.value;
  const r = await createRepo(app, alice, { name: "notes", visibility: "public" });
  if (!r.ok) throw new Error(String(r.error));
  repo = r.value;
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const stored = () => listIssues(app.db, repo.id, {}).length;

describe("tell from", () => {
  test("a page on this forge is kept on the issue", async () => {
    const t = await tell(app, alice, repo, "Page tell", 1, "/alice/notes/pulls/3");
    expect(t.ok).toBe(true);
    if (!t.ok) return;
    expect(t.value.issue.body).toContain("Told from [/alice/notes/pulls/3](/alice/notes/pulls/3)");
  });

  test("another host, javascript:, or a control character is bad_from and stores nothing", async () => {
    const before = stored();
    for (const from of [
      "https://evil.example/alice/notes",
      "//evil.example/x",
      "javascript:alert(1)",
      "/alice/notes\nInjected",
      "/alice/notes\x00",
      "/alice/notes\x7f",
    ]) {
      for (const fromApp of [false, true]) {
        const t = await tell(app, alice, repo, "Nope", 1, from, fromApp);
        if (fromApp && from.startsWith("https://")) continue; // an app address, below
        expect(t.ok).toBe(false);
        if (!t.ok) expect(t.error).toBe("bad_from");
      }
    }
    expect(stored()).toBe(before);
  });

  test("an app's own address is accepted only when the tell comes from that app", async () => {
    const address = "https://notes--alice.apps.example";
    const before = stored();
    const web = await tell(app, alice, repo, "From the web", 1, address);
    expect(web.ok).toBe(false);
    if (!web.ok) expect(web.error).toBe("bad_from");
    expect(stored()).toBe(before);
    const fromApp = await tell(app, alice, repo, "From the app", 1, address, true);
    expect(fromApp.ok).toBe(true);
    if (fromApp.ok) expect(fromApp.value.issue.body).toContain(`Told from [${address}]`);
    // Even from an app, only scheme and host: no path, no javascript:.
    for (const from of [`${address}/x`, "javascript:alert(1)", "https://a b.example"]) {
      const t = await tell(app, alice, repo, "Bad app", 1, from, true);
      expect(t.ok).toBe(false);
    }
  });
});

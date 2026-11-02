/** The terminal's pull screen lists the pull's looks with a full URL; none, no heading (#7917). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App as Forge } from "../src/app.ts";
import { previewEnv } from "../src/apps/data.ts";
import { createApp as insertApp } from "../src/core/apps.ts";
import { pullLooks } from "../src/looks/readable.ts";
import { recordLook, type RecordLookInput } from "../src/core/looks.ts";
import type { Pull } from "../src/core/pulls.ts";
import type { Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { pullScreen } from "../src/tui/screens/pull.ts";
import { local } from "../src/tui/screens/where.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

let dataDir: string;
let forge: Forge;
let alice: User;
let bob: User;
const made: Record<string, { repo: Repo; pull: Pull }> = {};

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-tui-looks-"));
  forge = createApp({ dataDir, port: 0, url: "https://forge.test" });
  const a = await seedAdmin(forge, { username: "alice", email: "alice@forge.test", password: "a-long-passphrase" });
  if (!a.ok) throw new Error("signup failed");
  alice = a.value;
  const b = await createUser(forge.db, {
    origin: "seed",
    trusted: true,
    username: "bob",
    email: "bob@forge.test",
    password: "a-long-passphrase",
  });
  if (!b.ok) throw new Error(b.error);
  bob = b.value;
  for (const name of ["pictured", "plain", "hush", "ownerly"]) {
    const r = await createRepo(forge, alice, { name, visibility: "public" });
    if (!r.ok) throw new Error("repo creation failed");
    await commitToBranch(forge, alice, r.value, { message: "seed", files: [{ path: "README.md", content: "# s\n" }] });
    await commitToBranch(forge, alice, r.value, {
      branch: "feature/one",
      base: "main",
      message: "One",
      files: [{ path: "one.ts", content: "export const one = 1;\n" }],
    });
    const o = await openPull(forge, alice, r.value, {
      title: "Pull one",
      body: "",
      baseBranch: "main",
      headBranch: "feature/one",
    });
    if (!o.ok) throw new Error(String(o.error));
    made[name] = { repo: r.value, pull: o.value };
  }
  const take = (name: string, access: "public" | "private", extra: Partial<RecordLookInput>) => {
    const inserted = insertApp(forge.db, { repoId: made[name]!.repo.id, slug: name, access });
    if (!inserted.ok) throw new Error(inserted.error);
    recordLook(forge.db, {
      appId: inserted.value.id,
      env: previewEnv(made[name]!.pull.number),
      commitOid: "a".repeat(40),
      kind: "phone",
      path: "looks/x.png",
      takenAs: "nobody",
      note: "the empty state reads well",
      attachedBy: "alice",
      ...extra,
    });
  };
  take("pictured", "public", {});
  take("hush", "private", {});
  take("ownerly", "public", { takenAs: "owner" });
  insertApp(forge.db, { repoId: made["plain"]!.repo.id, slug: "plain", access: "public" });
});

afterAll(async () => {
  forge.close();
  await rm(dataDir, { recursive: true, force: true });
});

async function text(name: string, user: User = alice, cols = 160): Promise<string> {
  const { repo, pull } = made[name]!;
  const { app, session } = createForgeApp(
    forge,
    { sshUsername: "alice", remoteAddress: "127.0.0.1", user },
    { terminal: headlessTerminal(cols, 50), exitHooks: false },
  );
  app.start();
  await settleApp(app);
  app.push(pullScreen(session, app.ctx, local(session, repo), pull.number));
  await settleApp(app);
  const out = app.screen.toText();
  app.stop();
  return out;
}

const fullUrl = (name: string) => {
  const { repo, pull } = made[name]!;
  const [look] = pullLooks(forge, repo, pull, alice);
  return `https://forge.test${look!.url}`;
};

test("a pull with a look shows its width, line and full absolute URL", async () => {
  const out = await text("pictured");
  expect(out).toContain("Looks (1)");
  expect(out).toContain("phone · alice · the empty state reads well");
  expect(out).toContain(fullUrl("pictured"));
});

test("on a narrow terminal the line is cut and the whole URL still shows", async () => {
  const url = fullUrl("pictured");
  const out = await text("pictured", alice, 50);
  // The link wraps rather than clips: rejoined, every character is there.
  const rows = out.split("\n").map((r) => r.trim());
  const at = rows.findIndex((r) => url.startsWith(r) && r.startsWith("https://"));
  expect(at).toBeGreaterThan(-1);
  let joined = "";
  for (let i = at; joined.length < url.length; i++) joined += rows[i]!.replace(/\s*[│|].*$/, "");
  expect(joined.startsWith(url)).toBe(true);
});

test("a pull without looks has no Looks heading", async () => {
  expect(await text("plain")).not.toContain("Looks (");
});

test("a reader who may not fetch a look does not see it listed", async () => {
  // A private app's look, to someone it does not name.
  expect(await text("hush", bob)).not.toContain("Looks (");
  // An owner-taken look on a public app: the writers', not a reader's.
  expect(await text("ownerly", bob)).not.toContain("Looks (");
  // The writer sees both.
  expect(await text("hush")).toContain("Looks (1)");
  expect(await text("ownerly")).toContain("Looks (1)");
});

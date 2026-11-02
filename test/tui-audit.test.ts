/**
 * "Who can do what" in the terminal reads the page's `audit()` over the
 * page's visibility: a reader sees their app's doors, a stranger only the
 * public apps, an app with no contract reads "unread", and Enter opens the
 * app's repository.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enableApp, newApp } from "../src/actions/apps.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { createUser, type User } from "../src/core/users.ts";
import type { Ctx } from "../src/tui/app/app.ts";
import { createForgeApp, forgeCommands, Session } from "../src/tui/forge.ts";
import { auditedFor, auditRows, doorLines } from "../src/tui/screens/audit.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

let dir: string;
let app: App;
let alice: User;
const stranger = { sshUsername: "git", remoteAddress: "127.0.0.1", fingerprint: "SHA256:test" };
const as = (user: User) => ({ sshUsername: "t", remoteAddress: "127.0.0.1", user });

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-tui-audit-"));
  app = createApp({ dataDir: dir, port: 0 });
  const made = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "alice@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!made.ok) throw new Error(made.error);
  alice = made.value;
  const notes = await newApp(app, alice, { name: "notes", visibility: "public" });
  if (!notes.ok) throw new Error(String(notes.error));
  const secret = await newApp(app, alice, { name: "secret", visibility: "private" });
  if (!secret.ok) throw new Error(String(secret.error));
  const bare = await createRepo(app, alice, { name: "bare", visibility: "public" });
  if (!bare.ok) throw new Error(String(bare.error));
  const seeded = await commitToBranch(app, alice, bare.value, {
    message: "no contract",
    files: [{ path: "README.md", content: "# bare\n" }],
  });
  if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
  expect(enableApp(app, alice, bare.value).ok).toBe(true);
}, 60_000);

afterAll(async () => {
  app.close();
  await rm(dir, { recursive: true, force: true });
});

const names = (rows: { title: string }[]) => rows.map((r) => r.title).sort();

test("a reader sees every app they can read, with its doors; no contract reads unread", async () => {
  const audited = await auditedFor(new Session(app, as(alice)));
  expect(names(auditRows(audited))).toEqual(["alice/bare", "alice/notes", "alice/secret"]);
  const notes = audited.find((a) => a.repo.name === "notes")!;
  const doors = doorLines(notes);
  expect(doors.some(([k, v]) => /^\w+\.read$/.test(k) && /\b(yes|own|no)\b/.test(v))).toBe(true);
  expect(doors).toContainEqual(["crew", "only members direct its crew"]);
  const bare = audited.find((a) => a.repo.name === "bare")!;
  expect(auditRows([bare])[0]!.meta).toContain("unread");
  expect(doorLines(bare)[0]![0]).toBe("unread");
});

test("a stranger sees only the public apps", async () => {
  const audited = await auditedFor(new Session(app, stranger));
  expect(names(auditRows(audited))).toEqual(["alice/bare", "alice/notes"]);
});

test("the palette offers it, the screen paints it, and Enter opens the repository", async () => {
  expect(forgeCommands(new Session(app, stranger))({} as Ctx).some((c) => c.id === "audit")).toBe(true);
  const { app: tui } = createForgeApp(app, as(alice), { terminal: headlessTerminal(140, 36), exitHooks: false });
  tui.start();
  const key = async (k: string, ctrl = false) => {
    tui.dispatch({ type: "key", key: k, ctrl, alt: false, shift: false });
    await settleApp(tui);
  };
  await key("k", true);
  for (const ch of "Who can do what") await key(ch);
  await key("enter");
  const text = tui.screen.toText();
  expect(text).toContain("alice/notes");
  expect(text).toContain("alice/bare");
  expect(text).toMatch(/unread/);
  expect(text).toMatch(/direct its crew/);
  const first = auditRows(await auditedFor(new Session(app, as(alice))))[0]!.title;
  await key("enter");
  const opened = tui.screen.toText();
  expect(opened).toContain(first.split("/")[1]!);
  expect(opened).not.toMatch(/direct its crew/);
  tui.stop();
});

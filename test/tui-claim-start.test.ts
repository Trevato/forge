/** Taking an agent's work in the terminal (#10912): the claim page's gate and effect. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBuilding } from "../src/actions/start.ts";
import { createApp, type App as Forge } from "../src/app.ts";
import { startByClaim } from "../src/core/starts.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { tokenOfLink } from "../src/tui/screens/claim_start.ts";
import { entry } from "../src/tui/screens/claim_start.ts";
import { Session } from "../src/tui/session.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();
let dir = "";
let forge: Forge;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-tui-claim-"));
  forge = createApp({ dataDir: dir, port: 0 });
  const made = await createUser(forge.db, { origin: "seed", trusted: true, username: "bob", email: "b@f.test", password: "a-good-passphrase" });
  if (!made.ok) throw new Error(made.error);
});
afterAll(async () => {
  forge.close();
  await rm(dir, { recursive: true, force: true });
});

test("the token is the last part of a pasted link", () => {
  expect(tokenOfLink(" https://f.test/claim/start/claim_abc?x=1 ")).toBe("claim_abc");
  expect(tokenOfLink("claim_abc")).toBe("claim_abc");
});

test("a person pastes the link, confirms, and the repository is theirs; an agent is not offered it", async () => {
  const made = await startBuilding(forge, { name: "term" }, "203.0.113.5", "http://f.test");
  if (!made.ok) throw new Error(made.error.error);
  const link = made.value.claim.url;
  const bob = getUserByName(forge.db, "bob")!;
  const { app } = createForgeApp(forge, { sshUsername: "t", remoteAddress: "127.0.0.1", user: bob }, { terminal: headlessTerminal(140, 32), exitHooks: false });
  app.start();
  const k = (key: string) => app.dispatch({ type: "key", key, ctrl: false, alt: false, shift: false });
  app.dispatch({ type: "key", key: "k", ctrl: true, alt: false, shift: false });
  for (const ch of "Take an agent") k(ch);
  k("enter");
  await settleApp(app);
  k("t");
  for (const ch of link.split("/").pop()!) k(ch);
  k("enter");
  await settleApp(app);
  expect(app.screen.toText()).toContain("term");
  k("enter");
  await settleApp(app);
  await Bun.sleep(200);
  await settleApp(app);
  expect(app.screen.toText()).toContain("Taken");
  expect(startByClaim(forge.db, link.split("/").pop()!)!.claimedBy).toBe(bob.id);
  app.stop();
  const agent = { ...bob, kind: "agent" } as typeof bob;
  expect(entry.offered(new Session(forge, { sshUsername: "t", remoteAddress: "127.0.0.1", user: agent }))).toBe(false);
});

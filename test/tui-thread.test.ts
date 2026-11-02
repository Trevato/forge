/**
 * The issue thread in the terminal, against a real forge. A comment is
 * markdown anyone with access can write, so the question is whether a
 * terminal escape in it can reach the viewer's terminal: a clipboard write
 * (OSC 52), a disguised link (OSC 8), a colour that outlives the line, a bell.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addComment, openIssue } from "../src/actions/issues.ts";
import { createRepo } from "../src/actions/repos.ts";
import { signUp } from "../src/actions/users.ts";
import { createApp, type App as Forge } from "../src/app.ts";
import { listComments, getIssue } from "../src/core/issues.ts";
import type { Repo } from "../src/core/repos.ts";
import type { User } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import type { TuiIdentity } from "../src/tui/session.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { fixtureSlot } from "./helpers/slot.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

const ESC = "\x1b";
const BEL = "\x07";
const BODY = [
  `Lamp ${ESC}[31mred${ESC}[0m text`,
  `Link ${ESC}]8;;https://evil.example${BEL}click here${ESC}]8;;${BEL} done`,
  `Clip ${ESC}]52;c;ZXZpbA==${BEL}copied`,
  `Bare${BEL}bell`,
].join("\n\n");
const COMMENT = [
  `Reply ${ESC}[1;31mloud${ESC}[0m words`,
  `${ESC}]52;c;ZXZpbA==${ESC}\\after-st`,
  `ring${BEL}end`,
].join("\n\n");

/** Our renderer's own cursor and colour sequences, which are not the text's. */
const OWN = /\x1b\[[0-9;:?]*[A-Za-z]/g;

describe("the issue thread in the terminal", () => {
  let dataDir: string;
  let forge: Forge;
  let alice: User;
  let bob: User;
  let tower: Repo;

  const as = (user: User): TuiIdentity => ({
    sshUsername: user.username,
    remoteAddress: "127.0.0.1",
    fingerprint: "SHA256:test",
    user,
  });

  function boot(user: User) {
    const terminal = headlessTerminal(120, 32);
    const { app } = createForgeApp(forge, as(user), {
      terminal,
      exitHooks: false,
    });
    app.start();
    const press = async (key: string): Promise<void> => {
      const ctrl = key.startsWith("ctrl+");
      app.dispatch({
        type: "key",
        key: ctrl ? key.slice(5) : key,
        ctrl,
        alt: false,
        shift: false,
      });
      await settleApp(app);
    };
    const typeText = async (text: string): Promise<void> => {
      for (const ch of text)
        app.dispatch({ type: "key", key: ch, ctrl: false, alt: false, shift: false });
      await settleApp(app);
    };
    return { app, terminal, press, typeText, text: () => app.screen.toText() };
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-tui-thread-"));
    forge = createApp({ dataDir, port: 0, disk: () => ({ freeBytes: 95, totalBytes: 100 }) });
    const a = await seedAdmin(forge, {
      username: "alice",
      email: "alice@forge.test",
      password: "a-long-passphrase",
    });
    const b = await signUp(
      forge,
      { username: "bob", email: "bob@forge.test", password: "another-long-passphrase" },
      { slot: fixtureSlot(forge) },
    );
    if (!a.ok || !b.ok) throw new Error("signup failed");
    alice = a.value;
    bob = b.value;
    const t = await createRepo(forge, alice, { name: "tower", visibility: "public" });
    const v = await createRepo(forge, alice, { name: "crypt", visibility: "private" });
    if (!t.ok || !v.ok) throw new Error("repo creation failed");
    tower = t.value;
    const issue = openIssue(forge, bob, tower, { title: "Escapes", body: BODY });
    if (!issue.ok) throw new Error("issue failed");
    const said = addComment(forge, bob, tower, issue.value, COMMENT);
    if (!said.ok) throw new Error("comment failed");
    const secret = openIssue(forge, alice, v.value, { title: "Hidden title zebra" });
    if (!secret.ok) throw new Error("issue failed");
  });

  afterAll(async () => {
    forge.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  async function openThread(h: ReturnType<typeof boot>): Promise<void> {
    await settleApp(h.app);
    await h.press("/");
    await h.typeText("tower");
    await h.press("enter");
    await h.press("enter");
    await h.press("i");
    await h.press("enter");
  }

  test("no escape or bell from an issue body or a comment reaches the output", async () => {
    const h = boot(alice);
    await openThread(h);
    const text = h.text();
    expect(text).toContain("Escapes");
    // The words still read, whatever was wrapped around them.
    for (const word of ["Lamp", "red", "click here", "copied", "Bare", "bell"])
      expect(text).toContain(word);
    for (const word of ["Reply", "loud", "words", "end"])
      expect(text).toContain(word);
    expect(text).not.toContain(ESC);
    expect(text).not.toContain(BEL);

    const wire = h.terminal.output();
    expect(wire).not.toContain(BEL);
    expect(wire).not.toContain(`${ESC}]`);
    // Only our own sequences are left once the renderer's are taken out.
    expect(wire.replace(OWN, "")).not.toContain(ESC);
    h.app.stop();
  });

  test("a viewer who cannot read the repository gets the refusal and no title", async () => {
    const h = boot(bob);
    await settleApp(h.app);
    await h.press("ctrl+k");
    await h.typeText("Open a repository");
    await h.press("enter");
    await h.typeText("alice/crypt");
    await h.press("enter");
    expect(h.text()).toContain("not found");
    expect(h.text()).not.toContain("zebra");
    expect(h.terminal.output()).not.toContain("zebra");
    h.app.stop();
  });

  test("the composer posts as the signed-in person and it shows in the timeline", async () => {
    const h = boot(alice);
    await openThread(h);
    await h.press("c");
    await h.typeText("Fixed it, bell and all.");
    await h.press("ctrl+d");
    const issue = getIssue(forge.db, tower.id, 1)!;
    const mine = listComments(forge.db, issue.id).filter(
      (c) => c.body === "Fixed it, bell and all.",
    );
    expect(mine).toHaveLength(1);
    expect(mine[0]!.authorId).toBe(alice.id);
    expect(h.text()).toContain("Fixed it, bell and all.");
    h.app.stop();
  });
});

/**
 * The terminal's side of #7336: a reader of a forge repository proposes a
 * change from the workspace (a branch on their fork, a pull back), and a
 * commit that breaks a JSON file's schema is refused before it is written,
 * as the web form refuses it.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { setRole } from "../src/actions/roles.ts";
import { createApp, type App as Forge } from "../src/app.ts";
import { getRepo } from "../src/core/repos.ts";
import { listPulls } from "../src/core/pulls.ts";
import type { User } from "../src/core/users.ts";
import { blobForRender } from "../src/git/read.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import type { TuiIdentity } from "../src/tui/session.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp, settleUntil } from "./helpers/tui.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { signUpProven } from "./helpers/verified.ts";

quietLogs();

const LIMITS = '{\n  "max": 5\n}\n';

describe("proposing and checking from the terminal", () => {
  let dataDir: string;
  let forge: Forge;
  let alice: User;
  let kim: User;

  const as = (user: User): TuiIdentity => ({
    sshUsername: user.username,
    remoteAddress: "127.0.0.1",
    fingerprint: "SHA256:test",
    user,
  });

  function boot(identity: TuiIdentity) {
    const terminal = headlessTerminal(120, 40);
    const { app } = createForgeApp(forge, identity, { terminal, exitHooks: false });
    app.start();
    const send = (key: string): void => {
      const ctrl = key.startsWith("ctrl+");
      app.dispatch({ type: "key", key: ctrl ? key.slice(5) : key, ctrl, alt: false, shift: false });
    };
    return {
      text: () => app.screen.toText(),
      async press(...keys: string[]) {
        for (const key of keys) send(key);
        await settleApp(app);
      },
      async type(text: string) {
        for (const ch of text) send(ch);
        await settleApp(app);
      },
      settle: () => settleApp(app),
      until: (what: string) => settleUntil(app, what),
      stop: () => app.stop(),
    };
  }
  type Harness = ReturnType<typeof boot>;

  async function openBeacon(h: Harness): Promise<void> {
    await h.settle();
    await h.press("/");
    await h.type("beacon");
    await h.press("enter");
    await h.press("enter");
    await h.until("alice/beacon");
  }

  async function openFile(h: Harness, query: string): Promise<void> {
    await h.press("t");
    await h.type(query);
    await h.press("enter");
  }

  const fileAt = async (owner: string, ref: string, path: string): Promise<string | undefined> => {
    const blob = await blobForRender(join(forge.reposRoot, owner, "beacon.git"), ref, path, 1 << 20);
    return blob.kind === "text" ? new TextDecoder().decode(blob.body) : undefined;
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-tui-propose-"));
    forge = createApp({ dataDir, port: 0 });
    const a = await seedAdmin(forge, { username: "alice", email: "alice@forge.test", password: "a-long-passphrase" });
    const k = await signUpProven(forge, { username: "kim", email: "kim@forge.test", password: "a-long-passphrase" });
    if (!a.ok || !k.ok) throw new Error("signup failed");
    alice = a.value;
    kim = k.value;
    if (!setRole(forge, alice, "kim", "member").ok) throw new Error("role failed");
    const made = await createRepo(forge, alice, { name: "beacon", visibility: "public" });
    if (!made.ok) throw new Error("repo failed");
    await commitToBranch(forge, alice, made.value, {
      message: "seed",
      files: [
        { path: "README.md", content: "# Beacon\n" },
        { path: "notes.txt", content: "a note\n" },
        { path: "limits.json", content: LIMITS },
        { path: "limits.schema.json", content: '{"properties":{"max":{"type":"integer","maximum":100}}}' },
      ],
    });
  });

  afterAll(async () => {
    forge.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a commit that breaks the file's schema is refused, and nothing lands", async () => {
    const h = boot(as(alice));
    try {
      await openBeacon(h);
      await openFile(h, "limitsjson");
      await h.press("e", "down", "end");
      await h.type("00");
      await h.press("esc", "c");
      await h.until("Commit limits.json");
      await h.press("ctrl+s");
      await h.until("breaks limits.schema.json");
      expect(h.text()).toContain("/max must be at most");
      expect(await fileAt("alice", "main", "limits.json")).toBe(LIMITS);
    } finally {
      h.stop();
    }
  });

  test("a reader proposes from the terminal: a branch on their fork and a pull back", async () => {
    const h = boot(as(kim));
    try {
      await openBeacon(h);
      await openFile(h, "notes");
      await h.press("e", "end");
      await h.type(" from kim");
      await h.press("esc", "c");
      await h.until("Propose a change");
      await h.press("ctrl+s");
      await h.until("opened pull #");
      const beacon = getRepo(forge.db, "alice", "beacon")!;
      const pulls = listPulls(forge.db, beacon.id, { state: "open" });
      expect(pulls).toHaveLength(1);
      const fork = getRepo(forge.db, "kim", "beacon")!;
      expect(pulls[0]!.headRepoId).toBe(fork.id);
      expect(await fileAt("kim", pulls[0]!.headBranch, "notes.txt")).toBe("a note from kim\n");
      // Nothing moved on the repository the reader cannot write.
      expect(await fileAt("alice", "main", "notes.txt")).toBe("a note\n");
    } finally {
      h.stop();
    }
  });
});

/**
 * An open app terminal is listed beside the machine shells (#10549) and
 * stops like one: Stop and Stop all idle hang up its pty, and one with no
 * input and no output for the idle limit ends itself.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serveTerminal, startTerminal, type TtyHost } from "../src/apps/tty.ts";
import { appTtysOf, openAppTty } from "../src/apps/tty_registry.ts";
import { createUser } from "../src/core/users.ts";
import { myShells, stopIdleShells, stopShell, stopShells } from "../src/machines/shell.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let app: App;
let aliceId: string;
let bobId: string;

beforeAll(async () => {
  app = createApp({ dataDir: mkdtempSync(join(tmpdir(), "app-tty-")), port: 0 });
  const a = await createUser(app.db, { username: "alice", email: "alice@x.test", password: "correct horse battery", origin: "seed", isAdmin: true, trusted: true });
  const b = await createUser(app.db, { username: "bob", email: "bob@x.test", password: "correct horse battery", origin: "seed", isAdmin: false, trusted: true });
  if (!a.ok || !b.ok) throw new Error("seed");
  aliceId = a.value.id;
  bobId = b.value.id;
});

afterAll(() => {
  stopShells(app);
  app.close();
});

/** A host that records what the pty printed and hands the test its callbacks. */
function fakeHost() {
  const out: string[] = [];
  let data: (chunk: Uint8Array) => void = () => {};
  let close: () => void = () => {};
  const host: TtyHost = {
    cols: 80,
    rows: 24,
    term: "xterm",
    write: (bytes) => void out.push(new TextDecoder().decode(bytes)),
    onData: (cb) => void (data = cb),
    onResize: () => {},
    onClose: (cb) => void (close = cb),
  };
  return { host, out, send: (text: string) => data(new TextEncoder().encode(text)), hangUp: () => close() };
}

/** What `runAppTty` hands `serveTerminal`: the real bridge, on a real pty. */
function open(userId: string | undefined, command = "exec sleep 300", idleMs = 600_000, checkMs?: number) {
  const fake = fakeHost();
  let pid = 0;
  let id = "";
  const done = serveTerminal(fake.host, {
    command,
    env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
    cwd: tmpdir(),
    cell: undefined,
    register: (program) => {
      pid = program.pid;
      const handle = openAppTty(app, { userId, repository: "alice/notes", slug: "notes", env: "preview-12", hangup: program.hangup, idleMs: () => idleMs, ...(checkMs ? { checkMs } : {}) });
      id = handle.id;
      return handle;
    },
  });
  return { ...fake, done, pid, id };
}

/** Make a person's terminals look idle for `ms` without waiting for it. */
function age(userId: string, ms: number) {
  for (const e of appTtysOf(app, userId)) {
    e.lastInput = Date.now() - ms;
    e.lastOutput = Date.now() - ms;
  }
}

async function until(ok: () => boolean) {
  for (let i = 0; i < 600 && !ok(); i++) await Bun.sleep(25);
  expect(ok()).toBe(true);
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("an open app terminal is listed, as an app row, for its holder only", async () => {
  const { done } = open(aliceId);
  const rows = myShells(app, aliceId);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ kind: "app", repository: "alice/notes", machine: "notes · preview-12", peers: 0, endedAt: null });
  expect(myShells(app, bobId)).toEqual([]);
  expect(stopShell(app, bobId, rows[0]!.id)).toBe(false);
  expect(stopShell(app, aliceId, rows[0]!.id)).toBe(true);
  await done;
});

test("Stop hangs up the pty and its process ends", async () => {
  const { done, pid } = open(aliceId);
  expect(alive(pid)).toBe(true);
  const id = myShells(app, aliceId)[0]!.id;
  expect(stopShell(app, aliceId, id)).toBe(true);
  await done;
  expect(myShells(app, aliceId)).toEqual([]);
  expect(stopShell(app, aliceId, id)).toBe(false);
});

test("the real bridge stamps input and output, and forgets the terminal when the host goes", async () => {
  const t = open(aliceId, "exec cat");
  age(aliceId, 500_000);
  const before = appTtysOf(app, aliceId)[0]!;
  const [oldIn, oldOut] = [before.lastInput, before.lastOutput];
  t.send("hello\n");
  await until(() => t.out.join("").includes("hello"));
  const e = appTtysOf(app, aliceId)[0]!;
  expect(e.lastInput).toBeGreaterThan(oldIn + 400_000);
  expect(e.lastOutput).toBeGreaterThan(oldOut + 400_000);
  t.hangUp();
  await t.done;
  expect(appTtysOf(app, aliceId)).toEqual([]);
});

test("a program that exits by itself is forgotten and its code returned", async () => {
  const t = open(aliceId, "exit 3");
  expect(await t.done).toBe(3);
  expect(appTtysOf(app, aliceId)).toEqual([]);
});

test("a hangup straight after the start still ends the process", async () => {
  for (let i = 0; i < 5; i++) {
    const program = startTerminal("exec sleep 300", {
      terminal: new Bun.Terminal({ cols: 80, rows: 24, data: () => {} }),
      env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
      cwd: tmpdir(),
      cell: undefined,
    });
    program.hangup();
    await program.exited;
    expect(alive(program.pid)).toBe(false);
  }
});

test("Stop all idle stops an app terminal past half the limit, not a busy one", async () => {
  const idle = open(aliceId);
  const busy = open(aliceId);
  const aged = appTtysOf(app, aliceId).find((e) => e.id === idle.id)!;
  aged.lastInput = aged.lastOutput = Date.now() - 400_000;
  expect(stopIdleShells(app, aliceId, 600_000)).toBe(1);
  await idle.done;
  expect(appTtysOf(app, aliceId).map((e) => e.id)).toEqual([busy.id]);
  expect(stopShell(app, aliceId, busy.id)).toBe(true);
  await busy.done;
});

test("one with no input and no output for the idle limit ends itself", async () => {
  const { done } = open(aliceId, "exec sleep 300", 600_000, 10);
  expect(myShells(app, aliceId)).toHaveLength(1);
  age(aliceId, 3_600_000);
  await done;
  expect(myShells(app, aliceId)).toEqual([]);
});

test("a guest's terminal is listed to no one but still ends when idle", async () => {
  // A tiny limit, and the test only waits for the end: no margin to lose.
  const { done } = open(undefined, "exec sleep 300", 50, 10);
  expect(myShells(app, aliceId)).toEqual([]);
  await done;
});

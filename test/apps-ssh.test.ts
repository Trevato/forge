/**
 * A terminal for every app (docs/APPS.md): `ssh <slug>@forge` opens the
 * app's `tty` command on a pty over the same data its web page uses;
 * `<slug>--<n>@forge` opens a preview's; any other name still opens the
 * forge's own terminal UI; a private app's terminal answers only to a key
 * the forge knows; and an environment that is not running says so.
 *
 * Driven with the real OpenSSH client against the real listener.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { AppsRuntime } from "../src/apps/runtime.ts";
import { parseAppLogin } from "../src/apps/tty.ts";
import { newApp } from "../src/actions/apps.ts";
import { listRuns } from "../src/core/runs.ts";
import { createUser, type User } from "../src/core/users.ts";
import { getRepo } from "../src/core/repos.ts";
import { serve, type Servers } from "../src/http/server.ts";
import type { SshServer } from "../src/ssh/server.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { openAppTerminal } from "../src/tui/screens/apptty.ts";
import { serveForgeSsh } from "../src/tui/ssh.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { getAppBySlug } from "../src/core/apps.ts";
import { grantedCookie } from "./helpers/identity.ts";
import { settleApp } from "./helpers/tui.ts";
import { missing } from "./helpers/tools.ts";

const SSH = "/usr/bin/ssh";
const SSH_KEYGEN = "/usr/bin/ssh-keygen";
/** These drive the real OpenSSH client; without it they skip, loudly. */
const NO_OPENSSH = missing(SSH, SSH_KEYGEN);

describe.skipIf(NO_OPENSSH)("a terminal for every app, over ssh", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let runtime: AppsRuntime;
  let ssh: SshServer;
  let alice: User;
  let key: string;

  /** Open an interactive ssh session as `login`, type `keys`, collect output. */
  async function session(
    login: string,
    keys = "",
    waitMs = 1500,
  ): Promise<{ out: string; code: number }> {
    const proc = Bun.spawn(
      [
        SSH,
        "-tt",
        "-p",
        String(ssh.port),
        "-i",
        key,
        "-o",
        "StrictHostKeyChecking=no",
        "-o",
        "UserKnownHostsFile=/dev/null",
        "-o",
        "IdentitiesOnly=yes",
        "-o",
        "LogLevel=ERROR",
        "-o",
        "ConnectTimeout=5",
        `${login}@127.0.0.1`,
      ],
      {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, TERM: "xterm-256color" },
      },
    );
    const chunks: string[] = [];
    const reader = (async () => {
      for await (const chunk of proc.stdout)
        chunks.push(new TextDecoder().decode(chunk));
    })();
    const errs = (async () => {
      for await (const chunk of proc.stderr)
        chunks.push(new TextDecoder().decode(chunk));
    })();
    await Bun.sleep(waitMs);
    if (keys !== "") {
      proc.stdin.write(keys);
      proc.stdin.flush();
      await Bun.sleep(600);
    }
    const done = await Promise.race([
      proc.exited,
      Bun.sleep(4000).then(() => -1),
    ]);
    if (done === -1) proc.kill("SIGKILL");
    const code = await proc.exited;
    await Promise.all([reader, errs]);
    return {
      out: chunks.join("").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ""),
      code,
    };
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-apps-ssh-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    ssh = await serveForgeSsh(app, { port: 0, hostname: "127.0.0.1" });
    runtime = new AppsRuntime(app, {
      domain: "apps.test",
      scheme: "http",
      publicPort: servers.port,
      forgeUrl: servers.url,
    });
    await runtime.start();
    key = join(dataDir, "guest_key");
    const gen = Bun.spawn(
      [SSH_KEYGEN, "-q", "-t", "ed25519", "-N", "", "-f", key],
      { stdout: "ignore", stderr: "ignore" },
    );
    expect(await gen.exited).toBe(0);
    const created = await createUser(app.db, { origin: "seed", trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!created.ok) throw new Error(created.error);
    alice = created.value;
    const made = await newApp(app, alice, {
      name: "hello",
      description: "notes",
      visibility: "public",
    });
    if (!made.ok) throw new Error(String(made.error));
    const privately = await newApp(app, alice, {
      name: "secret",
      description: "",
      visibility: "private",
    });
    if (!privately.ok) throw new Error(String(privately.error));
    // Wait for both productions to come up.
    const deadline = Date.now() + 60_000;
    for (;;) {
      const ok = [made.value.repo, privately.value.repo].every((repo) =>
        listRuns(app.db, repo.id, { env: "production" }).some(
          (r) => r.state === "ok",
        ),
      );
      if (ok) break;
      if (Date.now() > deadline) throw new Error("production did not come up");
      await Bun.sleep(100);
    }
  }, 90_000);

  afterAll(async () => {
    await runtime.stop();
    ssh.stop();
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("the login name names the app, or its preview", () => {
    expect(parseAppLogin("hello")).toEqual({
      slug: "hello",
      env: "production",
    });
    expect(parseAppLogin("Hello--12")).toEqual({
      slug: "hello",
      env: "pull-12",
    });
    expect(parseAppLogin("hello--0")).toBeUndefined();
    expect(parseAppLogin("--1")).toBeUndefined();
    expect(parseAppLogin("a b")).toBeUndefined();
  });

  test("ssh hello@forge opens the app's terminal, over its own data", async () => {
    // Add a note through the app's web side, then see it in the terminal.
    const form = new FormData();
    form.set("body", "seen from the terminal");
    const posted = await fetch(`${servers.url}/notes`, {
      method: "POST",
      body: form,
      headers: {
        host: "hello.apps.test",
        cookie: await grantedCookie(
          app,
          servers.url,
          alice,
          getAppBySlug(app.db, "hello")!,
        ),
      },
      redirect: "manual",
    });
    expect(posted.status).toBe(303);
    const { out, code } = await session("hello", "q");
    expect(out).toContain("hello");
    expect(out).toContain("seen from the terminal");
    expect(out).toContain("j/k move");
    expect(code).toBe(0);
  }, 30_000);

  test("any other login still opens the forge's terminal UI", async () => {
    const { out } = await session("anything", "q");
    expect(out).toContain("forge");
    expect(out).not.toContain("j/k move · a add");
  }, 30_000);

  test("a preview that does not exist says so", async () => {
    const { out, code } = await session("hello--99");
    expect(out).toContain("hello--99 is not running");
    expect(code).toBe(1);
  }, 30_000);

  test("the forge's own terminal runs an app's terminal on the same pty, then comes back", async () => {
    const terminal = headlessTerminal(100, 30, "xterm-256color");
    const { app: tui, session } = createForgeApp(
      app,
      {
        sshUsername: "alice",
        remoteAddress: "127.0.0.1",
        fingerprint: "SHA256:alice",
        user: alice,
      },
      { terminal, exitHooks: false },
    );
    tui.start();
    await settleApp(tui);
    // What a pull's `T` does for its preview, here for production: the
    // dashboard steps aside for the app's own terminal.
    terminal.takeOutput();
    const hello = getRepo(app.db, "alice", "hello")!;
    const ran = openAppTerminal(session, tui.ctx, hello, "production");
    const deadline = Date.now() + 10_000;
    while (!terminal.output().includes("j/k move") && Date.now() < deadline)
      await Bun.sleep(50);
    if (!terminal.output().includes("j/k move")) throw new Error(`never came: still waiting while !terminal.output().includes("j/k move")`);
    // The app's own terminal drew on our pty…
    expect(terminal.output()).toContain("hello");
    expect(terminal.output()).toContain("j/k move");
    // …and `q` ends it, which is when the forge's UI comes back.
    terminal.feed("q");
    const back = Date.now() + 10_000;
    await ran;
    while (
      !tui.screen.toText().includes("filter repositories") &&
      Date.now() < back
    ) {
      await Bun.sleep(50);
      await settleApp(tui);
    }
    expect(tui.screen.toText()).toContain("alice/hello");
    tui.stop();
  }, 40_000);

  test("a private app's terminal is not there for a stranger", async () => {
    const { out, code } = await session("secret");
    expect(out).toContain("no app named secret");
    expect(code).toBe(1);
  }, 30_000);
});

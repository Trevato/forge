import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmod,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { resetConnectLimit } from "../src/actions/origins.ts";
import {
  advertiseRefs,
  isGitService,
  serviceRpc,
} from "../src/git/smart-http.ts";
import { parseHookStdin } from "../src/git/hook-protocol.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { newFakeState, serveFakeForge, type FakeForge } from "./fake-origin.ts";

/**
 * Adversarial push-through. The pusher is the attacker: a local writer on a
 * mirror who wants the forge to push somewhere else, push something else,
 * push without a lease, leave the mirror ahead of its origin, or read the
 * owner's origin credential back out of the failure path.
 *
 * Three pieces of instrumentation, all real:
 *
 * - a fake *git host* standing in for the origin — the forge's own smart
 *   HTTP plumbing over a local bare repo, with a pre-receive hook that
 *   records what arrived and can be told to refuse, or to echo the
 *   credential back (a hostile origin);
 * - a `git` wrapper first on PATH that records the argv of every `push` the
 *   forge spawns, so the refspec/lease/argv claims are asserted on what
 *   actually ran, not on what the code says it builds;
 * - a raw receive-pack client, for ref names a real git client would refuse
 *   to send.
 */

const ORIGIN_LOGIN = "octo";
const ORIGIN_TOKEN = "octo-origin-secret-71bd-do-not-leak";
const ALICE_PASSWORD = "alice-login-secret";
const BOB_PASSWORD = "bob-login-secret";
const ZERO = "0".repeat(40);

const basic = (user: string, secret: string): string =>
  `Basic ${Buffer.from(`${user}:${secret}`).toString("base64")}`;
/** The exact header the forge must send the origin, and nothing else. */
const ORIGIN_HEADER = basic(ORIGIN_LOGIN, ORIGIN_TOKEN);
const ORIGIN_HEADER_B64 = ORIGIN_HEADER.slice("Basic ".length);

const read = async <T>(response: Response): Promise<T> =>
  (await response.json()) as T;

// Captured before the PATH wrapper goes in, so the *client* git in these
// tests is the real one and only the forge's spawns are recorded.
const ORIGINAL_PATH = process.env.PATH ?? "/usr/bin:/bin";
const clientEnv = {
  ...process.env,
  PATH: ORIGINAL_PATH,
  GIT_AUTHOR_NAME: "Alice",
  GIT_AUTHOR_EMAIL: "alice@forge.test",
  GIT_COMMITTER_NAME: "Alice",
  GIT_COMMITTER_EMAIL: "alice@forge.test",
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

async function git(
  args: string[],
  cwd: string,
): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(
    [Bun.which("git", { PATH: ORIGINAL_PATH })!, ...args],
    {
      cwd,
      env: clientEnv,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out: out.trim(), err: err.trim() };
}

// ---- the fake git host (the origin's git side) ----

interface GitHost {
  url: string;
  readonly dir: string;
  /** Every POST to git-receive-pack, with the credential it carried. */
  readonly pushes: { authorization: string; path: string }[];
  /** Every request of any kind, for "nothing reached the origin" claims. */
  readonly requests: string[];
  /** When non-empty, the origin's pre-receive refuses with this text.
   * `{secret}` is replaced with the plaintext credential the push carried —
   * a hostile origin quoting the token back. */
  rejectWith: string;
  hookLog(): Promise<string>;
  stop: () => void;
}

async function serveGitHost(root: string): Promise<GitHost> {
  const dir = join(root, "origin-gears.git");
  expect(
    (await git(["init", "-q", "--bare", "-b", "main", dir], root)).code,
  ).toBe(0);
  const hookLog = join(root, "origin-hook.log");
  await Bun.write(hookLog, "");
  const hook = join(dir, "hooks", "pre-receive");
  await Bun.write(
    hook,
    `#!/bin/sh
{
  echo "push-options=\${GIT_PUSH_OPTION_COUNT:-none}"
  while read old new ref; do echo "update $old $new $ref"; done
  echo "--"
} >> "${hookLog}"
if [ -n "$FAKE_REJECT" ]; then
  echo "$FAKE_REJECT" >&2
  exit 1
fi
exit 0
`,
  );
  await chmod(hook, 0o755);

  const host: GitHost = {
    url: "",
    dir,
    pushes: [],
    requests: [],
    rejectWith: "",
    hookLog: () => readFile(hookLog, "utf8"),
    stop: () => {},
  };
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      host.requests.push(`${request.method} ${url.pathname}${url.search}`);
      const match =
        /^\/octo\/gears\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(
          url.pathname,
        );
      if (!match) return new Response("not found", { status: 404 });
      const authorization = request.headers.get("authorization") ?? "";
      if (authorization !== ORIGIN_HEADER) {
        return new Response("Unauthorized", {
          status: 401,
          headers: { "www-authenticate": 'Basic realm="origin"' },
        });
      }
      if (match[1] === "info/refs") {
        const service = url.searchParams.get("service");
        if (!isGitService(service))
          return new Response("smart only", { status: 400 });
        return advertiseRefs(dir, service, request);
      }
      if (match[1] === "git-upload-pack")
        return serviceRpc(dir, "git-upload-pack", request);
      host.pushes.push({ authorization, path: url.pathname });
      const plaintext = Buffer.from(
        authorization.slice("Basic ".length),
        "base64",
      )
        .toString()
        .split(":")
        .slice(1)
        .join(":");
      const env: Record<string, string> = {};
      if (host.rejectWith !== "")
        env.FAKE_REJECT = host.rejectWith.replaceAll("{secret}", plaintext);
      return serviceRpc(dir, "git-receive-pack", request, { env });
    },
  });
  // Mutated in place: the fetch closure above reads `host`, and tests flip
  // `rejectWith` on the very same object.
  host.url = `http://localhost:${server.port}`;
  host.stop = () => server.stop(true);
  return host;
}

// ---- the argv recorder ----

interface SpawnRecord {
  readonly cwd: string;
  readonly args: readonly string[];
}

/** A `git` first on PATH that logs every `push` it is asked for, then execs
 * the real one. The forge's own env builder (`gitEnv`) takes PATH from the
 * process, so this catches exactly the spawns the forge makes. */
async function installGitRecorder(root: string): Promise<{
  pushes(): Promise<SpawnRecord[]>;
  clear(): Promise<void>;
}> {
  const real = Bun.which("git", { PATH: ORIGINAL_PATH });
  if (!real) throw new Error("no git on PATH");
  const bin = join(root, "bin");
  const log = join(root, "git-spawns.log");
  await Bun.write(log, "");
  const wrapper = join(bin, "git");
  await Bun.write(
    wrapper,
    `#!/bin/sh
if [ "$1" = "push" ]; then
  { printf '%s' "$PWD"; for a in "$@"; do printf '\\037%s' "$a"; done; printf '\\n'; } >> "${log}"
fi
exec "${real}" "$@"
`,
  );
  await chmod(wrapper, 0o755);
  process.env.PATH = `${bin}:${ORIGINAL_PATH}`;
  return {
    async pushes() {
      const text = await readFile(log, "utf8");
      return text
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => {
          const [cwd = "", ...args] = line.split("\x1f");
          return { cwd, args };
        });
    },
    clear: () => Bun.write(log, "").then(() => {}),
  };
}

// ---- a raw receive-pack client ----

const pkt = (payload: string): string =>
  (Buffer.byteLength(payload) + 4).toString(16).padStart(4, "0") + payload;

/** `PACK`, version 2, zero objects, trailing sha1 — what a push of only
 * already-present objects carries. */
function emptyPack(): Uint8Array {
  const header = new Uint8Array([
    0x50, 0x41, 0x43, 0x4b, 0, 0, 0, 2, 0, 0, 0, 0,
  ]);
  const sha = new Uint8Array(
    new Bun.CryptoHasher("sha1").update(header).digest(),
  );
  const out = new Uint8Array(header.length + sha.length);
  out.set(header);
  out.set(sha, header.length);
  return out;
}

interface RawPushResult {
  readonly status: number;
  /** report-status lines (`unpack …`, `ok …`, `ng …`). */
  readonly report: string[];
  /** What the far side printed (sideband 2 and 3), i.e. the hook's words. */
  readonly said: string;
}

/**
 * Speak receive-pack directly: a git client validates ref names before it
 * will send them, and the whole point is to see what the *server* does with
 * a name the client would have refused.
 */
async function rawPush(
  remote: string,
  authorization: string,
  commands: readonly { old: string; new: string; ref: string }[],
): Promise<RawPushResult> {
  const lines = commands
    .map(
      (c, i) =>
        `${c.old} ${c.new} ${c.ref}${i === 0 ? "\0report-status side-band-64k" : ""}\n`,
    )
    .map(pkt)
    .join("");
  const head = new TextEncoder().encode(`${lines}0000`);
  const needsPack = commands.some((c) => !/^0+$/.test(c.new));
  const pack = needsPack ? emptyPack() : new Uint8Array();
  const body = new Uint8Array(head.length + pack.length);
  body.set(head);
  body.set(pack, head.length);

  const response = await fetch(`${remote}/git-receive-pack`, {
    method: "POST",
    headers: {
      authorization,
      "content-type": "application/x-git-receive-pack-request",
    },
    body,
  });
  const bytes = new Uint8Array(await response.arrayBuffer());
  const report: string[] = [];
  let said = "";
  let at = 0;
  const decoder = new TextDecoder();
  while (at + 4 <= bytes.length) {
    const len = parseInt(decoder.decode(bytes.subarray(at, at + 4)), 16);
    if (len === 0) {
      at += 4;
      continue;
    }
    const payload = bytes.subarray(at + 4, at + len);
    at += len;
    const band = payload[0];
    const text = decoder.decode(payload.subarray(1));
    if (band === 1) {
      // Band 1 carries pkt-lines of its own.
      let inner = 0;
      const data = payload.subarray(1);
      while (inner + 4 <= data.length) {
        const l = parseInt(decoder.decode(data.subarray(inner, inner + 4)), 16);
        if (l === 0) {
          inner += 4;
          continue;
        }
        report.push(decoder.decode(data.subarray(inner + 4, inner + l)).trim());
        inner += l;
      }
    } else if (band === 2 || band === 3) {
      said += text;
    }
  }
  return { status: response.status, report, said };
}

// ---- the suite ----

describe("push-through, adversarially", () => {
  let root: string;
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let fake: FakeForge;
  let origin: GitHost;
  let recorder: Awaited<ReturnType<typeof installGitRecorder>>;
  let originId = "";
  let base = "";
  let clone = "";
  let mirrorDir = "";

  const api = (path: string, init?: RequestInit & { as?: string }) => {
    const headers = new Headers(init?.headers);
    if (init?.body !== undefined)
      headers.set("content-type", "application/json");
    headers.set(
      "authorization",
      init?.as === "bob"
        ? basic("bob", BOB_PASSWORD)
        : basic("alice", ALICE_PASSWORD),
    );
    return fetch(`${base}${path}`, { ...init, headers });
  };

  const localMain = async (): Promise<string> => {
    const branches = await read<{ name: string; oid: string }[]>(
      await api("/api/v1/repos/alice/gears/branches"),
    );
    return branches.find((b) => b.name === "main")?.oid ?? "";
  };
  const originRef = async (ref: string): Promise<string> =>
    (await git(["rev-parse", "--verify", "--quiet", ref], origin.dir)).out;

  const remoteFor = (user: string, password: string): string =>
    `http://${user}:${password}@localhost:${servers.port}/alice/gears.git`;
  const mirrorRemote = (): string =>
    `http://localhost:${servers.port}/alice/gears.git`;

  /** A fresh commit on the clone's current branch; returns its oid. */
  const commitFile = async (name: string, content: string): Promise<string> => {
    await Bun.write(join(clone, name), content);
    expect((await git(["add", "."], clone)).code).toBe(0);
    expect((await git(["commit", "-q", "-m", `add ${name}`], clone)).code).toBe(
      0,
    );
    return (await git(["rev-parse", "HEAD"], clone)).out;
  };

  /** Everything on disk under the mirror's bare repo, relative. */
  const mirrorInventory = async (): Promise<string[]> => {
    const entries = await readdir(mirrorDir, { recursive: true });
    return entries.map(String).sort();
  };
  const grepMirrorFor = async (needle: string): Promise<string[]> => {
    const hits: string[] = [];
    for (const entry of await readdir(mirrorDir, { recursive: true })) {
      const path = join(mirrorDir, String(entry));
      const info = await stat(path);
      if (!info.isFile()) continue;
      const bytes = await readFile(path);
      if (bytes.includes(needle)) hits.push(String(entry));
    }
    return hits;
  };

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "forge-sec-push-"));
    dataDir = join(root, "data");
    recorder = await installGitRecorder(root);
    origin = await serveGitHost(root);

    // Seed the origin with one commit on main, through plumbing so no hook
    // and no push are involved.
    const seed = join(root, "seed");
    expect((await git(["init", "-q", "-b", "main", seed], root)).code).toBe(0);
    await Bun.write(join(seed, "a.txt"), "one\n");
    await git(["add", "."], seed);
    await git(["commit", "-q", "-m", "first"], seed);
    expect(
      (await git(["push", "-q", origin.dir, "main:main"], seed)).code,
    ).toBe(0);
    await recorder.clear();

    const state = newFakeState("forgejo", ORIGIN_LOGIN, ORIGIN_TOKEN);
    state.repos.push({
      id: 3,
      fullName: "octo/gears",
      cloneUrl: `${origin.url}/octo/gears.git`,
      defaultBranch: "main",
    });
    fake = serveFakeForge(state);

    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    for (const [username, password] of [
      ["alice", ALICE_PASSWORD],
      ["bob", BOB_PASSWORD],
    ]) {
      await fetch(`${base}/api/v1/users`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          username,
          email: `${username}@forge.test`,
          password,
        }),
      });
    }
    resetConnectLimit();

    const connected = await read<{ id: string }>(
      await api("/api/v1/user/origins", {
        method: "POST",
        body: JSON.stringify({ host: fake.url, token: ORIGIN_TOKEN }),
      }),
    );
    originId = connected.id;
    const mirrored = await api(`/api/v1/user/origins/${originId}/mirror`, {
      method: "POST",
      body: JSON.stringify({ fullName: "octo/gears" }),
    });
    expect(mirrored.status).toBe(201);
    mirrorDir = join(dataDir, "repos", "alice", "gears.git");

    clone = join(root, "clone");
    expect(
      (
        await git(
          ["clone", "-q", remoteFor("alice", ALICE_PASSWORD), clone],
          root,
        )
      ).code,
    ).toBe(0);
    await recorder.clear();
    origin.pushes.length = 0;
  });

  afterAll(async () => {
    process.env.PATH = ORIGINAL_PATH;
    fake.stop();
    origin.stop();
    servers.stop();
    app.close();
    await rm(root, { recursive: true, force: true });
  });

  // ---- 1 + 2 + 7: destination, refspec, lease, argv hygiene ----

  test("the forwarded push names an explicit refspec, an explicit lease, and only the stored URL", async () => {
    const before = await localMain();
    const tip = await commitFile("b.txt", "two\n");
    expect((await git(["push", "-q", "origin", "main"], clone)).code).toBe(0);

    const spawned = (await recorder.pushes()).filter((p) =>
      p.args.includes("--porcelain"),
    );
    expect(spawned).toHaveLength(1);
    const push = spawned[0]!;
    // Spawned inside the mirror, pushing to the origin row's URL and nowhere
    // the pusher could name.
    expect(await realpath(push.cwd)).toBe(await realpath(mirrorDir));
    expect(push.args).toEqual([
      "push",
      "--porcelain",
      "--atomic",
      `--force-with-lease=refs/heads/main:${before}`,
      `${origin.url}/octo/gears.git`,
      `${tip}:refs/heads/main`,
    ]);
    // No wholesale flags could sneak in — the argv is exactly the above, but
    // say it in words for the next reader.
    for (const flag of ["--mirror", "--all", "--force", "--prune", "--tags"])
      expect(push.args).not.toContain(flag);
    // The credential is not in argv (`ps` would show it) …
    const joined = push.args.join(" ");
    expect(joined).not.toContain(ORIGIN_TOKEN);
    expect(joined).not.toContain(ORIGIN_HEADER_B64);
    // … it travelled as the Authorization header, scoped to the origin …
    expect(origin.pushes).toHaveLength(1);
    expect(origin.pushes[0]!.authorization).toBe(ORIGIN_HEADER);
    // … and nothing about it landed on disk in the mirror.
    expect(await grepMirrorFor(ORIGIN_TOKEN)).toEqual([]);
    expect(await grepMirrorFor(ORIGIN_HEADER_B64)).toEqual([]);
    const config = await readFile(join(mirrorDir, "config"), "utf8");
    expect(config).not.toContain("@");
    expect(config).not.toContain("extraHeader");

    // Both sides moved to the same commit.
    expect(await originRef("refs/heads/main")).toBe(tip);
    expect(await localMain()).toBe(tip);
  });

  test("push options never reach the origin", async () => {
    const tip = await commitFile("c.txt", "three\n");
    origin.pushes.length = 0;
    await recorder.clear();
    const pushed = await git(
      ["push", "-q", "-o", "url=http://evil.invalid/x.git", "origin", "main"],
      clone,
    );
    // The mirror does not advertise push-options, so the client cannot even
    // send them; nothing is forwarded on their behalf either way.
    expect(pushed.code).not.toBe(0);
    expect(pushed.err).toContain("push options");
    expect(origin.pushes).toHaveLength(0);
    expect(await recorder.pushes()).toHaveLength(0);
    expect(await originRef("refs/heads/main")).not.toBe(tip);
    expect(await origin.hookLog()).not.toContain("push-options=1");

    // Land it normally so the clone and both repos stay in step.
    expect((await git(["push", "-q", "origin", "main"], clone)).code).toBe(0);
    expect(await originRef("refs/heads/main")).toBe(tip);
  });

  test("ref names a client would refuse are refused before any argv is built", async () => {
    const tip = await localMain();
    const auth = basic("alice", ALICE_PASSWORD);
    await recorder.clear();
    origin.pushes.length = 0;
    const hookBefore = await origin.hookLog();

    const hostile = [
      "-f",
      "--mirror",
      "refs/heads/a:refs/heads/b",
      "refs/heads/x\x01y",
      "refs/heads/../../tmp/x",
      "refs/heads/sp ace",
    ];
    for (const ref of hostile) {
      const result = await rawPush(mirrorRemote(), auth, [
        { old: ZERO, new: tip, ref },
      ]);
      expect(result.status).toBe(200);
      // Either git itself calls it a funny refname, or the forge refuses it
      // in pre-receive — never a push spawned with it.
      expect(result.report.some((line) => line.startsWith("ng "))).toBe(true);
      expect(result.report.some((line) => line.startsWith("ok "))).toBe(false);
    }
    expect(await recorder.pushes()).toHaveLength(0);
    expect(origin.pushes).toHaveLength(0);
    expect(await origin.hookLog()).toBe(hookBefore);
    // None of them exists locally either — refused means refused.
    const local = (
      await git(["for-each-ref", "--format=%(refname)"], mirrorDir)
    ).out;
    for (const ref of hostile) expect(local).not.toContain(ref);
    // And no *truncation* of a hostile name became a different, legal ref:
    // "refs/heads/sp ace" must not have travelled upstream as "refs/heads/sp".
    expect(await originRef("refs/heads/sp")).toBe("");
    expect(
      (await git(["for-each-ref", "--format=%(refname)"], origin.dir)).out
        .split("\n")
        .sort(),
    ).toEqual(["refs/heads/main"]);
  });

  test("hook stdin keeps a ref name whole, spaces and all", () => {
    // The hook line is `<old> <new> <ref>`; a ref carrying a space is funny
    // to git but must reach the forge intact so it is refused as itself,
    // not forwarded as its first word.
    expect(
      parseHookStdin(`${ZERO} ${"a".repeat(40)} refs/heads/sp ace\n`),
    ).toEqual([
      { oldOid: ZERO, newOid: "a".repeat(40), ref: "refs/heads/sp ace" },
    ]);
  });

  test("a ref whose last component looks like a flag is forwarded, positionally", async () => {
    // `refs/heads/--mirror` is a legal git ref. It must travel as a refspec
    // value (`<oid>:refs/heads/--mirror`) and a lease value, never as a
    // bare argument git could read as `--mirror`.
    const tip = await localMain();
    await recorder.clear();
    const pushed = await rawPush(
      mirrorRemote(),
      basic("alice", ALICE_PASSWORD),
      [{ old: ZERO, new: tip, ref: "refs/heads/--mirror" }],
    );
    expect(pushed.report).toContain("ok refs/heads/--mirror");

    const spawned = (await recorder.pushes()).filter((p) =>
      p.args.includes("--porcelain"),
    );
    expect(spawned).toHaveLength(1);
    const args = spawned[0]!.args;
    expect(args).toEqual([
      "push",
      "--porcelain",
      "--atomic",
      "--force-with-lease=refs/heads/--mirror:",
      `${origin.url}/octo/gears.git`,
      `${tip}:refs/heads/--mirror`,
    ]);
    expect(await originRef("refs/heads/--mirror")).toBe(tip);
    // The origin still has every other branch: it was not a --mirror push.
    expect(await originRef("refs/heads/main")).toBe(tip);

    // Clean up through the same path — an explicit, leased deletion.
    await recorder.clear();
    const deleted = await rawPush(
      mirrorRemote(),
      basic("alice", ALICE_PASSWORD),
      [{ old: tip, new: ZERO, ref: "refs/heads/--mirror" }],
    );
    expect(deleted.report).toContain("ok refs/heads/--mirror");
    expect(await originRef("refs/heads/--mirror")).toBe("");
  });

  // ---- 3: deletions ----

  test("a branch deletion is forwarded as an explicit, leased delete", async () => {
    await git(["checkout", "-q", "-b", "topic"], clone);
    const tip = await commitFile("d.txt", "four\n");
    expect((await git(["push", "-q", "origin", "topic"], clone)).code).toBe(0);
    expect(await originRef("refs/heads/topic")).toBe(tip);
    await git(["checkout", "-q", "main"], clone);

    await recorder.clear();
    expect((await git(["push", "-q", "origin", ":topic"], clone)).code).toBe(0);
    const spawned = (await recorder.pushes()).filter((p) =>
      p.args.includes("--porcelain"),
    );
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.args).toEqual([
      "push",
      "--porcelain",
      "--atomic",
      `--force-with-lease=refs/heads/topic:${tip}`,
      `${origin.url}/octo/gears.git`,
      ":refs/heads/topic",
    ]);
    expect(await originRef("refs/heads/topic")).toBe("");
    expect(
      (await git(["for-each-ref", "refs/heads/topic"], mirrorDir)).out,
    ).toBe("");
  });

  // ---- 2: the lease is live ----

  test("a stale lease is rejected when the origin moved behind the mirror's back", async () => {
    // Move the origin directly — a colleague pushed upstream, and the mirror
    // has not fetched yet.
    const mirrorMain = await localMain();
    const tree = (await git(["rev-parse", "main^{tree}"], origin.dir)).out;
    const moved = (
      await git(
        ["commit-tree", tree, "-p", "main", "-m", "upstream moved"],
        origin.dir,
      )
    ).out;
    expect(
      (
        await git(
          ["update-ref", "refs/heads/main", moved, mirrorMain],
          origin.dir,
        )
      ).code,
    ).toBe(0);

    const tip = await commitFile("e.txt", "five\n");
    const pushed = await git(["push", "-q", "origin", "main"], clone);
    expect(pushed.code).not.toBe(0);
    expect(pushed.err.toLowerCase()).toContain("stale");
    // Neither side moved to the pusher's commit: the origin kept its own
    // history and the mirror did not accept what it could not forward.
    expect(await originRef("refs/heads/main")).toBe(moved);
    expect(await localMain()).toBe(mirrorMain);
    expect(await localMain()).not.toBe(tip);

    // Recover: sync the mirror, rebase the clone, land it.
    const synced = await api(`/api/v1/user/origins/${originId}/sync`, {
      method: "POST",
    });
    expect(synced.status).toBe(200);
    expect(await localMain()).toBe(moved);
    expect((await git(["fetch", "-q", "origin"], clone)).code).toBe(0);
    expect((await git(["rebase", "-q", "origin/main"], clone)).code).toBe(0);
    expect((await git(["push", "-q", "origin", "main"], clone)).code).toBe(0);
    expect(await originRef("refs/heads/main")).toBe(await localMain());
  });

  // ---- 4 + 5: fail closed, leave nothing behind ----

  test("an origin that refuses leaves the mirror unchanged and clean", async () => {
    const before = await localMain();
    const inventory = await mirrorInventory();
    const config = await readFile(join(mirrorDir, "config"), "utf8");

    origin.rejectWith = "policy: nope, not today";
    const tip = await commitFile("f.txt", "six\n");
    const pushed = await git(["push", "-q", "origin", "main"], clone);
    origin.rejectWith = "";
    expect(pushed.code).not.toBe(0);
    // The origin's words, attributed to the origin.
    expect(pushed.err).toContain("octo/gears");
    expect(pushed.err).toContain("nope, not today");

    expect(await localMain()).toBe(before);
    expect(await originRef("refs/heads/main")).toBe(before);
    // The pushed commit is not lying around in the mirror's object store.
    expect((await git(["cat-file", "-e", tip], mirrorDir)).code).not.toBe(0);

    // Quarantine gone, no lock files, no temp remotes, config untouched.
    const after = await mirrorInventory();
    expect(
      after.filter((e) => /incoming-|\.lock$|tmp_|\.tmp$/.test(e)),
    ).toEqual([]);
    expect(after).toEqual(inventory);
    expect(await readFile(join(mirrorDir, "config"), "utf8")).toBe(config);
    expect((await git(["remote"], mirrorDir)).out).toBe("origin");
    expect((await git(["for-each-ref", "refs/remotes"], mirrorDir)).out).toBe(
      "",
    );

    await git(["reset", "-q", "--hard", before], clone);
  });

  test("a rejected multi-ref push moves nothing locally", async () => {
    const before = await localMain();
    await git(["checkout", "-q", "-b", "side"], clone);
    const sideTip = await commitFile("g.txt", "seven\n");
    await git(["checkout", "-q", "main"], clone);
    const mainTip = await commitFile("h.txt", "eight\n");

    origin.rejectWith = "policy: no";
    const pushed = await git(["push", "-q", "origin", "main", "side"], clone);
    origin.rejectWith = "";
    expect(pushed.code).not.toBe(0);
    expect(await localMain()).toBe(before);
    expect(
      (await git(["for-each-ref", "refs/heads/side"], mirrorDir)).out,
    ).toBe("");
    expect(await originRef("refs/heads/side")).toBe("");
    expect(await originRef("refs/heads/main")).toBe(before);
    expect(sideTip).not.toBe(mainTip);

    await git(["reset", "-q", "--hard", before], clone);
    await git(["branch", "-q", "-D", "side"], clone);
  });

  // ---- 7: a hostile origin quoting the credential back ----

  test("a credential the origin echoes back never reaches the pusher", async () => {
    const before = await localMain();
    origin.rejectWith = "denied for credential {secret} (bad actor)";
    await commitFile("i.txt", "nine\n");
    const pushed = await git(["push", "-q", "origin", "main"], clone);
    origin.rejectWith = "";
    expect(pushed.code).not.toBe(0);
    // The pusher is a local writer; the token is the owner's. They must not
    // be able to read it out of a refusal, however the origin phrases it.
    expect(pushed.err).not.toContain(ORIGIN_TOKEN);
    expect(pushed.err).not.toContain(ORIGIN_HEADER_B64);
    // The rest of the origin's message survives.
    expect(pushed.err).toContain("bad actor");
    expect(await localMain()).toBe(before);
    await git(["reset", "-q", "--hard", before], clone);
  });

  // ---- 6: who may push through ----

  test("a reader cannot push through, and the origin never hears from them", async () => {
    origin.pushes.length = 0;
    await recorder.clear();
    const tip = await commitFile("j.txt", "ten\n");
    // bob can read (the mirror is public) but not write.
    expect(
      (await git(["ls-remote", "-q", remoteFor("bob", BOB_PASSWORD)], clone))
        .code,
    ).toBe(0);
    const asBob = await git(
      ["push", "-q", remoteFor("bob", BOB_PASSWORD), "main"],
      clone,
    );
    expect(asBob.code).not.toBe(0);
    // Anonymous is challenged, never let through.
    const anon = await git(["push", "-q", mirrorRemote(), "main"], clone);
    expect(anon.code).not.toBe(0);
    // A 401 challenge: git either fails auth or wants a username it cannot
    // prompt for. Either way it never got as far as receive-pack.
    expect(anon.err).toMatch(/Authentication failed|could not read Username/);
    expect(origin.pushes).toHaveLength(0);
    expect(await recorder.pushes()).toHaveLength(0);
    expect(await localMain()).not.toBe(tip);
    expect(await originRef("refs/heads/main")).not.toBe(tip);
    await git(["reset", "-q", "--hard", "origin/main"], clone);
  });

  test("a writer who did not connect the origin cannot push through it", async () => {
    // The push would travel under the OWNER's stored credential, so the same
    // rule as write-through applies: only the account that connected the
    // origin may send it. A site admin is a writer everywhere and is still
    // refused — and the origin never hears from them.
    app.db.query("UPDATE user SET is_admin = 1 WHERE username = 'bob'").run();
    origin.pushes.length = 0;
    const before = await localMain();
    const tip = await commitFile("k.txt", "eleven\n");
    const asBob = await git(
      ["push", "-q", remoteFor("bob", BOB_PASSWORD), "main"],
      clone,
    );
    expect(asBob.code).not.toBe(0);
    expect(asBob.err).toContain("only the account that connected");
    expect(origin.pushes).toHaveLength(0);
    expect(await localMain()).toBe(before);
    expect(await localMain()).not.toBe(tip);
    await git(["reset", "-q", "--hard", "HEAD~1"], clone);
    app.db.query("UPDATE user SET is_admin = 0 WHERE username = 'bob'").run();
  });

  // ---- 4 + 6: origin down, credential gone ----

  test("an unreachable origin refuses the push, and no credential leaks in the failure", async () => {
    const before = await localMain();
    origin.stop();
    const tip = await commitFile("l.txt", "twelve\n");
    const pushed = await git(["push", "-q", "origin", "main"], clone);
    expect(pushed.code).not.toBe(0);
    expect(pushed.err).toContain("octo/gears");
    expect(pushed.err).not.toContain(ORIGIN_TOKEN);
    expect(pushed.err).not.toContain(ORIGIN_HEADER_B64);
    expect(await localMain()).toBe(before);
    expect(await localMain()).not.toBe(tip);
    expect((await git(["cat-file", "-e", tip], mirrorDir)).code).not.toBe(0);
  });

  test("an origin that needs re-authentication refuses the push before touching git", async () => {
    const before = await localMain();
    app.db
      .query("UPDATE origin SET needs_reauth = 1 WHERE id = ?1")
      .run(originId);
    await recorder.clear();
    const pushed = await git(["push", "-q", "origin", "main"], clone);
    expect(pushed.code).not.toBe(0);
    expect(pushed.err).toContain("reconnected");
    expect(await recorder.pushes()).toHaveLength(0);
    expect(await localMain()).toBe(before);
    app.db
      .query("UPDATE origin SET needs_reauth = 0 WHERE id = ?1")
      .run(originId);
  });

  test("a mirror whose origin row lost its clone URL refuses the push", async () => {
    const before = await localMain();
    app.db.query("DELETE FROM origin_repo WHERE origin_id = ?1").run(originId);
    await recorder.clear();
    const pushed = await git(["push", "-q", "origin", "main"], clone);
    expect(pushed.code).not.toBe(0);
    expect(pushed.err).toContain("no upstream clone URL");
    expect(await recorder.pushes()).toHaveLength(0);
    expect(await localMain()).toBe(before);
  });

  test("a disconnected origin fails closed: the mirror refuses pushes until reconnected", async () => {
    // Disconnecting keeps the repo readable and stops syncing, but the repo
    // still says it mirrors something. Accepting a push would let it drift
    // from an upstream it claims to track, so the push is refused with a
    // reason, and nothing is forwarded anywhere.
    const gone = await api(`/api/v1/user/origins/${originId}`, {
      method: "DELETE",
    });
    expect(gone.status).toBe(200);
    await recorder.clear();
    const before = await localMain();
    await commitFile("m.txt", "twelve\n");
    const pushed = await git(["push", "-q", "origin", "main"], clone);
    expect(pushed.code).not.toBe(0);
    expect(pushed.err).toContain("disconnected");
    expect(await localMain()).toBe(before);
    expect(await recorder.pushes()).toHaveLength(0);
  });
});

/**
 * Strangers cannot exhaust the forge (#2920): every door open to someone
 * with no session and no token — the API, a clone, a code search, an event
 * stream, a spawn plan — is limited per address and for every stranger
 * together, and while strangers flood each one a signed-in push still
 * lands. Addresses are told apart by `X-Forwarded-For`, which the forge
 * reads from this machine (`http/peer.ts`).
 */
import { GREP_LIMITS, grepSlots } from "../src/search/grep_slots.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createApp as createAppRecord } from "../src/core/apps.ts";
import { createToken } from "../src/core/tokens.ts";
import type { User } from "../src/core/users.ts";
import { transferGate } from "../src/git/env.ts";
import { serve, type Servers } from "../src/http/server.ts";
import {
  heldChanged,
  heldNow,
  setStrangerClock,
  setStrangerLimits,
  STRANGER_LIMITS,
  strangerCodeSearch,
} from "../src/http/strangers.ts";
import { Fresh } from "../src/kernel/fresh.ts";
import type { Ctx } from "../src/tui/app/app.ts";
import { forgeSearch } from "../src/tui/forge.ts";
import { Session } from "../src/tui/session.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { gitClientEnv } from "./helpers/git-client.ts";

describe("Fresh: one piece of work per key per while", () => {
  test("kept for ttl, made again after, by the clock it is given", () => {
    let at = 1_000;
    let made = 0;
    const kept = new Fresh<number>(30_000, 16, () => at);
    expect(kept.get("k", () => ++made)).toBe(1);
    at += 29_999;
    expect(kept.get("k", () => ++made)).toBe(1);
    at += 1; // 30 000 ms after the first: stale
    expect(kept.get("k", () => ++made)).toBe(2);
  });

  test("callers inside a making share one promise; a rejection is forgotten", async () => {
    const kept = new Fresh<Promise<string>>(60_000, 16, () => 0);
    let calls = 0;
    const a = kept.get("x", async () => {
      calls++;
      throw new Error("no");
    });
    const b = kept.get("x", async () => "never");
    expect(b).toBe(a);
    await expect(a).rejects.toThrow("no");
    expect(await kept.get("x", async () => "again")).toBe("again");
    expect(calls).toBe(1);
  });

  test("keys are bounded, the oldest dropped first", () => {
    const kept = new Fresh<string>(60_000, 2, () => 0);
    kept.get("a", () => "a1");
    kept.get("b", () => "b1");
    kept.get("c", () => "c1");
    expect(kept.get("a", () => "a2")).toBe("a2");
    expect(kept.get("c", () => "c2")).toBe("c1");
  });
});

describe("strangers at every door", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let port: number;
  let token: string;
  let ada: User;
  let next = 1;
  /** A fresh address, so one test's minute is never another's. */
  const address = (): string => `203.0.113.${next++}`;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-strangers-"));
    app = createApp({ dataDir, port: 0 });
    // The windows stand still: a slow request on a loaded machine never
    // slides one, so a count is the same count however long the test takes.
    setStrangerClock(app, () => 1_000_000);
    servers = await serve(app);
    base = servers.url;
    port = servers.port;
    const owner = await seedAdmin(app, {
      username: "ada",
      email: "ada@f.dev",
      password: "owner-passphrase",
    });
    if (!owner.ok) throw new Error(owner.error);
    token = createToken(app.db, owner.value.id, "t", "admin").token;
    ada = owner.value;
    for (const name of ["garden", "shed"]) {
      const repo = await createRepo(app, owner.value, { name, visibility: "public" });
      if (!repo.ok) throw new Error(repo.error);
    }
    // Hashing a password and making two repositories outrun bun's 5 s hook
    // default on a loaded check machine, which fails the suite unnamed.
  }, 60_000);
  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  }, 30_000);

  const from = (ip: string, extra: Record<string, string> = {}) => ({
    "x-forwarded-for": ip,
    ...extra,
  });
  const status = async (path: string, headers: Record<string, string>) => {
    const res = await fetch(`${base}${path}`, { headers });
    await res.arrayBuffer();
    return res.status;
  };
  // Waits on the event it means: every hold or release wakes it to look again.
  // No deadline of its own: the test's timeout is the only bound.
  const until = async (done: () => boolean): Promise<boolean> => {
    while (!done()) await heldChanged(app);
    return true;
  };

  /**
   * A fetch's negotiation opened and never sent: the headers of a chunked
   * POST to upload-pack, then nothing. Resolves with the socket and, if the
   * forge answers before the body would, its status line.
   */
  function stall(ip: string): { socket: Socket; answer: Promise<string> } {
    const socket = connect(port, "127.0.0.1");
    let text = "";
    const answer = new Promise<string>((resolve) => {
      socket.on("data", (chunk) => {
        text += chunk.toString("latin1");
        if (text.includes("\r\n")) resolve(text.slice(0, text.indexOf("\r\n")));
      });
      socket.on("close", () => resolve(text.slice(0, text.indexOf("\r\n"))));
      socket.on("error", () => resolve(""));
    });
    socket.write(
      `POST /ada/garden.git/git-upload-pack HTTP/1.1\r\nHost: x\r\nX-Forwarded-For: ${ip}\r\nContent-Type: application/x-git-upload-pack-request\r\nTransfer-Encoding: chunked\r\n\r\n`,
    );
    return { socket, answer };
  }

  test("a stranger's health checks are never throttled", async () => {
    const ip = address();
    for (let i = 0; i < 20; i++) expect(await status("/healthz", from(ip))).toBe(200);
  });

  test("anonymous API reads: per address, then every stranger together; a token is its own", async () => {
    setStrangerLimits(app, {
      perAddress: { ...STRANGER_LIMITS.perAddress, api: 5 },
      forge: { ...STRANGER_LIMITS.forge, api: 8 },
    });
    try {
      const a = address();
      for (let i = 0; i < 5; i++) expect(await status("/api/v1/repos", from(a))).toBe(200);
      const refused = await fetch(`${base}/api/v1/repos`, { headers: from(a) });
      expect(refused.status).toBe(429);
      expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
      expect(((await refused.json()) as { error: string }).error).toBe("rate_limited");
      // Another address has its own five — until the forge's eight are spent.
      const b = address();
      for (let i = 0; i < 3; i++) expect(await status("/api/v1/repos", from(b))).toBe(200);
      expect(await status("/api/v1/repos", from(b))).toBe(429);
      // A page is a person's, and a token is counted as a token.
      expect(await status("/explore", from(a))).toBe(200);
      expect(
        await status("/api/v1/repos", from(a, { authorization: `Bearer ${token}` })),
      ).toBe(200);
    } finally {
      setStrangerLimits(app, STRANGER_LIMITS);
    }
  });

  test("a window slides with the clock it is given, never with the time a request took", async () => {
    let at = 5_000_000;
    setStrangerClock(app, () => at);
    setStrangerLimits(app, { perAddress: { ...STRANGER_LIMITS.perAddress, api: 2 } });
    try {
      const ip = address();
      expect(await status("/api/v1/repos", from(ip))).toBe(200);
      expect(await status("/api/v1/repos", from(ip))).toBe(200);
      expect(await status("/api/v1/repos", from(ip))).toBe(429);
      at += 59_999;
      expect(await status("/api/v1/repos", from(ip))).toBe(429);
      at += 1;
      expect(await status("/api/v1/repos", from(ip))).toBe(200);
    } finally {
      setStrangerClock(app, () => 1_000_000);
      setStrangerLimits(app, STRANGER_LIMITS);
    }
  });

  test("anonymous ref advertisements are counted per address", async () => {
    setStrangerLimits(app, { perAddress: { ...STRANGER_LIMITS.perAddress, git: 3 } });
    try {
      const ip = address();
      const refs = "/ada/garden.git/info/refs?service=git-upload-pack";
      for (let i = 0; i < 3; i++) expect(await status(refs, from(ip))).toBe(200);
      expect(await status(refs, from(ip))).toBe(429);
      expect(await status(refs, from(address()))).toBe(200);
      // Access is decided first: a repository nobody may read still asks
      // for a credential, not a retry.
      expect(await status("/ada/nothing.git/info/refs?service=git-upload-pack", from(ip))).toBe(401);
    } finally {
      setStrangerLimits(app, STRANGER_LIMITS);
    }
  });

  test("a fetch that stops sending ends, and gives its transfer back", async () => {
    setStrangerLimits(app, { transferIdleMs: 300 });
    const { socket } = stall(address());
    try {
      expect(await until(() => heldNow(app, "transfer") === 1)).toBe(true);
      expect(await until(() => heldNow(app, "transfer") === 0)).toBe(true);
    } finally {
      socket.destroy();
      setStrangerLimits(app, STRANGER_LIMITS);
    }
  });

  test("a flood of stalled anonymous clones takes its share, and a signed-in push still lands", async () => {
    const share = Math.max(1, Math.floor(transferGate.limit * STRANGER_LIMITS.transferShare));
    const stalls: ReturnType<typeof stall>[] = [];
    try {
      // One address holds its four, then is refused.
      const one = address();
      for (let i = 0; i < STRANGER_LIMITS.transfersPerAddress; i++) stalls.push(stall(one));
      expect(await until(() => heldNow(app, "transfer") === STRANGER_LIMITS.transfersPerAddress)).toBe(true);
      const own = stall(one);
      stalls.push(own);
      expect(await own.answer).toStartWith("HTTP/1.1 429");
      // Many addresses together hold the strangers' share and no more.
      for (let i = 0; i < share; i++) stalls.push(stall(address()));
      expect(await until(() => heldNow(app, "transfer") === share)).toBe(true);
      const late = stall(address());
      stalls.push(late);
      expect(await late.answer).toStartWith("HTTP/1.1 429");
      expect(heldNow(app, "transfer")).toBe(share);

      // While they hold it, a signed-in push is made and lands.
      const work = await mkdtemp(join(tmpdir(), "forge-strangers-push-"));
      try {
        const git = async (args: string[]) =>
          await Bun.spawn(["git", ...args], {
            cwd: work,
            env: gitClientEnv(),
            stdout: "ignore",
            stderr: "ignore",
          }).exited;
        expect(await git(["init", "-q", "-b", "main"])).toBe(0);
        await writeFile(join(work, "README.md"), "# shed\n");
        expect(await git(["add", "."])).toBe(0);
        expect(await git(["commit", "-q", "-m", "first"])).toBe(0);
        const remote = `${base.replace("http://", `http://ada:${token}@`)}/ada/shed.git`;
        expect(await git(["push", "-q", remote, "main"])).toBe(0);
      } finally {
        await rm(work, { recursive: true, force: true });
      }
    } finally {
      for (const s of stalls) s.socket.destroy();
    }
    // Hung up, every stalled transfer gives its permit back.
    expect(await until(() => heldNow(app, "transfer") === 0)).toBe(true);
  }, 60_000);

  test("anonymous code search: per address, and one at a time for every stranger", async () => {
    setStrangerLimits(app, { perAddress: { ...STRANGER_LIMITS.perAddress, code: 2 } });
    try {
      const ip = address();
      const code = "/api/v1/search?q=shed&kind=code";
      expect(await status(code, from(ip))).toBe(200);
      expect(await status(code, from(ip))).toBe(200);
      expect(await status(code, from(ip))).toBe(429);
      // A search that greps nothing is not a code search.
      expect(await status("/api/v1/search?q=shed&kind=repos", from(ip))).toBe(200);

      // Another stranger's search is running: a second is refused on the
      // API, and the page answers without the code and says why.
      const busy = strangerCodeSearch(app, new Request(`${base}/x`));
      expect(busy.allowed).toBe(true);
      try {
        expect(await status(code, from(address()))).toBe(429);
        const page = await fetch(`${base}/search?q=shed`, { headers: from(address()) });
        expect(page.status).toBe(200);
        expect(await page.text()).toContain("data-code-busy");
        // Someone signed in searches code as ever.
        expect(
          await status(code, from(address(), { authorization: `Bearer ${token}` })),
        ).toBe(200);
      } finally {
        if (busy.allowed) busy.release();
      }
      expect(heldNow(app, "code")).toBe(0);
    } finally {
      setStrangerLimits(app, STRANGER_LIMITS);
    }
  });

  test("a terminal guest's palette search takes the same code slot, keyed on its peer", async () => {
    const wrote = await fetch(`${base}/api/v1/repos/ada/shed/contents`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        branch: "main",
        message: "first",
        files: [{ path: "rake.txt", content: "a trowel and a wheelbarrow\n" }],
      }),
    });
    expect(wrote.status).toBeLessThan(300);
    await wrote.arrayBuffer();

    // A guest: any SSH key the forge does not know.
    const guest = new Session(app, {
      sshUsername: "anyone",
      remoteAddress: address(),
      fingerprint: "SHA256:unknown",
    });
    const toasts: string[] = [];
    const ctx = { icons: "plain", toast: (t: string) => toasts.push(t) } as unknown as Ctx;
    const ask = (q: string) =>
      forgeSearch(guest)(ctx)(q, false, new AbortController().signal);
    const code = (items: { id: string }[]) =>
      items.filter((i) => i.id.startsWith("code:") && i.id !== "code:not-searched");

    expect(code(await ask("wheelbarrow")).length).toBeGreaterThan(0);
    expect(heldNow(app, "code")).toBe(0);

    const busy = strangerCodeSearch(app, new Request(`${base}/x`));
    expect(busy.allowed).toBe(true);
    try {
      const items = await ask("wheelbarrow");
      expect(code(items)).toEqual([]);
      const note = items.find((i) => i.id === "code:not-searched");
      expect(note?.title).toBe("Code was not searched");
      // The rest of the search still answers.
      expect((await ask("shed")).some((i) => i.id.startsWith("repo:"))).toBe(true);
    } finally {
      if (busy.allowed) busy.release();
    }

    // Every stranger grep slot taken elsewhere: the search answers, says code was partial.
    const hung = Array.from({ length: GREP_LIMITS.strangers }, () => {
      let settle!: () => void;
      const done = grepSlots.run(undefined, () => new Promise<void>((r) => (settle = r)));
      return { settle: () => settle(), done };
    });
    try {
      // An uncached query, so the answer must come from a grep.
      const items = await ask("trowel");
      expect(code(items).filter((i) => i.id !== "code:skipped")).toEqual([]);
      expect(items.find((i) => i.id === "code:skipped")?.title).toBe("Some code was not searched");
    } finally {
      for (const h of hung) h.settle();
      await Promise.all(hung.map((h) => h.done));
    }
    expect((await ask("trowel")).some((i) => i.id === "code:skipped")).toBe(false);

    // A signed-in member is held to its own two slots, and told the same way.
    const member = new Session(app, {
      sshUsername: "ada",
      remoteAddress: address(),
      fingerprint: "SHA256:ada",
      user: ada,
    });
    const askAsMember = (q: string) =>
      forgeSearch(member)(ctx)(q, false, new AbortController().signal);
    const mine = Array.from({ length: GREP_LIMITS.perMember }, () => {
      let settle!: () => void;
      const done = grepSlots.run(ada.id, () => new Promise<void>((r) => (settle = r)));
      return { settle: () => settle(), done };
    });
    try {
      const items = await askAsMember("barrow");
      expect(items.some((i) => i.id.startsWith("code:ada/"))).toBe(false);
      expect(items.find((i) => i.id === "code:skipped")?.title).toBe("Some code was not searched");
    } finally {
      for (const h of mine) h.settle();
      await Promise.all(mine.map((h) => h.done));
    }
    expect((await askAsMember("barrow")).some((i) => i.id.startsWith("code:ada/"))).toBe(true);

    // Its own minute, counted under its address.
    setStrangerLimits(app, { perAddress: { ...STRANGER_LIMITS.perAddress, code: 1 } });
    try {
      expect(code(await ask("wheelbarrow")).length).toBeGreaterThan(0);
      expect(code(await ask("wheelbarrow"))).toEqual([]);
      // A blank query greps nothing and spends nothing.
      expect((await ask("   ")).some((i) => i.id === "code:not-searched")).toBe(false);
    } finally {
      setStrangerLimits(app, STRANGER_LIMITS);
    }
    expect(heldNow(app, "code")).toBe(0);
  });

  test("a blank query on the page does not take a stranger's code slot", async () => {
    const busy = strangerCodeSearch(app, new Request(`${base}/x`));
    expect(busy.allowed).toBe(true);
    try {
      const page = await fetch(`${base}/search?q=`, { headers: from(address()) });
      expect(page.status).toBe(200);
      expect(await page.text()).not.toContain("data-code-busy");
    } finally {
      if (busy.allowed) busy.release();
    }
  });

  test("event streams: per stranger address and for every stranger, given back on hang-up", async () => {
    setStrangerLimits(app, { streamsPerAddress: 2, strangerStreams: 3 });
    const open: AbortController[] = [];
    const stream = async (headers: Record<string, string>): Promise<number> => {
      const abort = new AbortController();
      open.push(abort);
      const res = await fetch(`${base}/events`, { headers, signal: abort.signal });
      if (res.status !== 200) await res.arrayBuffer();
      return res.status;
    };
    try {
      const a = address();
      expect(await stream(from(a))).toBe(200);
      expect(await stream(from(a))).toBe(200);
      expect(await stream(from(a))).toBe(429);
      expect(await stream(from(address()))).toBe(200);
      expect(await stream(from(address()))).toBe(429);
      expect(heldNow(app, "stream:strangers")).toBe(3);
      // Someone signed in is not a stranger.
      expect(await stream(from(a, { authorization: `Bearer ${token}` }))).toBe(200);
    } finally {
      for (const abort of open) abort.abort();
      setStrangerLimits(app, STRANGER_LIMITS);
    }
    expect(await until(() => heldNow(app, "stream:*") === 0)).toBe(true);
  });

  test("a stranger's spawn plans are counted per address", async () => {
    setStrangerLimits(app, { perAddress: { ...STRANGER_LIMITS.perAddress, plan: 2 } });
    try {
      const ip = address();
      const plan = () =>
        fetch(`${base}/api/v1/forges`, {
          method: "POST",
          headers: from(ip, { "content-type": "application/json", origin: base }),
          body: JSON.stringify({ name: "kiln", dryRun: true }),
        }).then(async (r) => {
          await r.arrayBuffer();
          return r.status;
        });
      expect(await plan()).not.toBe(429);
      expect(await plan()).not.toBe(429);
      expect(await plan()).toBe(429);
    } finally {
      setStrangerLimits(app, STRANGER_LIMITS);
    }
  });

  test("a stranger's HEAD to /events gives its stream back at once", async () => {
    expect(heldNow(app, "stream:*")).toBe(0);
    const res = await fetch(`${base}/events`, { method: "HEAD", headers: from(address()) });
    expect(res.status).toBe(200);
    await res.arrayBuffer();
    // The GET's stream behind the HEAD is cancelled, not left holding a slot.
    expect(await until(() => heldNow(app, "stream:*") === 0)).toBe(true);
  });

  test("the audit card is made once in its while, however many ask", async () => {
    const first = await (await fetch(`${base}/og/audit.svg`)).text();
    expect(first).toContain("<svg");
    const repo = await createRepo(app, ada, { name: "greenhouse", visibility: "public" });
    if (!repo.ok) throw new Error(String(repo.error));
    const rec = createAppRecord(app.db, { repoId: repo.value.id, slug: "greenhouse", access: "public" });
    expect(rec.ok).toBe(true);
    expect(await (await fetch(`${base}/og/audit.svg`)).text()).toBe(first);
  });

  test("the sitemap is made once a minute, however many ask", async () => {
    const first = await (await fetch(`${base}/sitemap.xml`)).text();
    expect(first).toContain("/ada/garden</loc>");
    const made = await createRepo(app, ada, {
      name: "orchard",
      visibility: "public",
    });
    expect(made.ok).toBe(true);
    expect(await (await fetch(`${base}/sitemap.xml`)).text()).toBe(first);
    // Another Host is answered under its own origin from the same rows: a
    // caller varying Host cannot make the forge read them again.
    const other = await (
      await fetch(`${base}/sitemap.xml`, { headers: { host: "elsewhere.test" } })
    ).text();
    expect(other).toContain("<loc>http://elsewhere.test/ada/garden</loc>");
    expect(other).not.toContain("orchard");
  });
});

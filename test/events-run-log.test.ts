/**
 * A run's new log lines ride the `/events` stream as `run.log` frames, to
 * people who can read the run's repository and no one else. They are not
 * history: no id, never replayed.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { openIssue } from "../src/actions/issues.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createRun, getRun } from "../src/core/runs.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { releaseValues, holdValues } from "../src/kernel/log.ts";
import {
  FRAME_MAX_BYTES,
  FRAME_MAX_LINES,
  appendRunLog,
  frameOf,
  runLogTapCount,
} from "../src/runs/log.ts";
import { resetSseDroppedCount, sseDroppedCount, viewerStream } from "../src/http/sse.ts";
import { serve, type Servers } from "../src/http/server.ts";

describe("run.log frames on /events", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let alice: User;
  let aliceToken: string;
  let bobToken: string;
  let privateRun: string;
  let publicRun: string;
  let sealedRun: string;
  let crewToken: string;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-runlog-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    const mk = async (username: string, first = false) => {
      const u = await createUser(app.db, {
        origin: "seed",
        trusted: true,
        username,
        email: `${username}@forge.local`,
        password: "a-good-passphrase",
        adminIfFirst: first,
      });
      if (!u.ok) throw new Error(u.error);
      return u.value;
    };
    alice = await mk("alice", true);
    const bob = await mk("bob");
    aliceToken = createToken(app.db, alice.id, "t", "rw").token;
    bobToken = createToken(app.db, bob.id, "t", "rw").token;
    for (const [name, visibility] of [
      ["secret", "private"],
      ["open", "public"],
    ] as const) {
      const made = await createRepo(app, alice, { name, visibility });
      if (!made.ok) throw new Error(String(made.error));
      const run = createRun(app.db, { repoId: made.value.id, kind: "check" });
      if (name === "secret") privateRun = run.id;
      else {
        publicRun = run.id;
        const bot = await createAgent(app, alice, { username: "bot" });
        if (!bot.ok) throw new Error(String(bot.error));
        if (!addToCrew(app, alice, made.value, "bot").ok) throw new Error("crew");
        crewToken = createToken(app.db, bot.value.user.id, "t", "rw").token;
        const report = openIssue(app, alice, made.value, {
          title: "Hole",
          body: "detail",
          sealed: true,
        });
        if (!report.ok) throw new Error(String(report.error));
        sealedRun = createRun(app.db, {
          repoId: made.value.id,
          kind: "agent",
          issueId: report.value.id,
        }).id;
      }
    }
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  /** Open /events, run `act`, and return the text received meanwhile. */
  async function listen(
    headers: Record<string, string>,
    act: () => void,
    path = "/events",
  ): Promise<string> {
    const ctl = new AbortController();
    const res = await fetch(`${base}${path}`, { headers, signal: ctl.signal });
    const reader = res.body!.getReader();
    await reader.read(); // ": connected"
    act();
    let text = "";
    const decoder = new TextDecoder();
    const stop = setTimeout(() => ctl.abort(), 300);
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value);
      }
    } catch {
      // aborted: that is the end of the listening
    }
    clearTimeout(stop);
    return text;
  }

  const auth = (t: string) => ({ authorization: `Bearer ${t}` });

  test("a reader receives the frame, without an id", async () => {
    const text = await listen(auth(aliceToken), () =>
      appendRunLog(dataDir, privateRun, "hello from the run"),
    );
    expect(text).toContain("event: run.log\n");
    expect(text).not.toMatch(/^id: .*\n(?=event: run\.log)/m);
    const data = text.split("event: run.log\ndata: ")[1]!.split("\n")[0]!;
    expect(JSON.parse(data)).toEqual({
      run: privateRun,
      lines: ["hello from the run"],
      truncated: false,
    });
  });

  test("someone who cannot read the repository, or is signed out, gets nothing", async () => {
    for (const headers of [auth(bobToken), {}]) {
      const text = await listen(headers, () =>
        appendRunLog(dataDir, privateRun, "private line"),
      );
      expect(text).not.toContain("run.log");
      expect(text).not.toContain("private line");
    }
  });

  test("a public repository's log is for its writers and crew, not readers or the signed out", async () => {
    for (const headers of [{}, auth(bobToken)]) {
      const text = await listen(headers, () =>
        appendRunLog(dataDir, publicRun, "public line"),
      );
      expect(text).not.toContain("run.log");
      expect(text).not.toContain("public line");
    }
    for (const token of [aliceToken, crewToken]) {
      const text = await listen(auth(token), () =>
        appendRunLog(dataDir, publicRun, "public line"),
      );
      expect(text).toContain("public line");
    }
  });

  test("a run on a sealed issue reaches no one outside it", async () => {
    for (const headers of [{}, auth(bobToken)]) {
      const text = await listen(headers, () =>
        appendRunLog(dataDir, sealedRun, "sealed line"),
      );
      expect(text).not.toContain("sealed line");
    }
    const text = await listen(auth(aliceToken), () =>
      appendRunLog(dataDir, sealedRun, "sealed line"),
    );
    expect(text).toContain("sealed line");
  });

  test("a secret the redactor knows never appears in a frame", async () => {
    holdValues("test", ["hunter2-token-value"]);
    try {
      const text = await listen(auth(aliceToken), () =>
        appendRunLog(dataDir, privateRun, "curl -H hunter2-token-value"),
      );
      expect(text).toContain("run.log");
      expect(text).toContain("[redacted]");
      expect(text).not.toContain("hunter2-token-value");
    } finally {
      releaseValues("test");
    }
  });

  test("a reconnect with since replays no log frame", async () => {
    appendRunLog(dataDir, privateRun, "written before the reconnect");
    const text = await listen(auth(aliceToken), () => {}, "/events?since=0");
    expect(text).not.toContain("run.log");
    expect(text).not.toContain("written before");
  });

  test("a closed stream leaves no tap behind", async () => {
    await listen(auth(aliceToken), () => {});
    await Bun.sleep(50);
    expect(runLogTapCount()).toBe(0);
  });

  test("a burst to a reader that is not reading skips frames and keeps the stream open", async () => {
    resetSseDroppedCount();
    const res = viewerStream(app, alice, new Request(`${base}/events`));
    const reader = res.body!.getReader();
    const line = "x".repeat(16 * 1024);
    // Far more than the 256 KiB budget, with nobody reading.
    for (let i = 0; i < 64; i++) appendRunLog(dataDir, privateRun, line);
    expect(sseDroppedCount()).toBe(0);
    app.bus.append({
      kind: "push",
      repoId: (getRun(app.db, privateRun) as { repoId: string }).repoId,
      payload: { after: "burst" },
    });
    let text = "";
    const decoder = new TextDecoder();
    const stop = setTimeout(() => void reader.cancel(), 1000);
    while (!text.includes("event: forge")) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
    clearTimeout(stop);
    await reader.cancel();
    expect(text).toContain("event: forge");
    expect(text).toContain("event: run.log"); // some got through, not all
    expect(sseDroppedCount()).toBe(0);
  });

  test("a frame is bounded", () => {
    const many = Array.from({ length: 200 }, (_, i) => `line ${i}`);
    const framed = frameOf(many);
    expect(framed.lines).toHaveLength(FRAME_MAX_LINES);
    expect(framed.truncated).toBe(true);
    const fat = frameOf(["x".repeat(FRAME_MAX_BYTES * 2)]);
    expect(Buffer.byteLength(fat.lines[0]!)).toBeLessThanOrEqual(FRAME_MAX_BYTES);
    expect(fat.truncated).toBe(true);
    expect(frameOf(["a", "b"])).toEqual({ lines: ["a", "b"], truncated: false });
  });
});

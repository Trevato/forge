/** Shifting every cue of a subtitle file: the pure function, and the page that saves it as a commit. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addTeamMember, createOrg, createTeam } from "../src/core/orgs.ts";
import { updateRepoSettings } from "../src/core/repos.ts";
import { getUserByName } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { shiftCommands } from "../src/tui/screens/subtitle_shift.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import type { Screen } from "../src/tui/app/app.ts";
import { settleApp } from "./helpers/tui.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { signUp } from "../src/actions/users.ts";
import { createSession } from "../src/core/sessions.ts";
import { getRepo } from "../src/core/repos.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { commitLog } from "../src/git/read.ts";
import { repoDir } from "../src/git/repos.ts";
import { localSource } from "../src/view/local.ts";
import { parseOffset, shiftCues, shiftMessage } from "../src/core/subtitle_shift.ts";
import { fixtureSlot } from "./helpers/slot.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const SRT = "1\r\n00:00:01,500 --> 00:00:03,000\r\nHello <i>there</i>\r\n\r\n2\r\n01:02:03,004 --> 01:02:05,000\r\nLine one\r\n";
const VTT = "WEBVTT - demo\n\nNOTE a --> b\n\nintro\n00:01.250 --> 00:03.000 align:start\n<v Ann>Hi</v>\n\n00:01:00.000 --> 00:01:02.000\nBye\n";

describe("shiftCues", () => {
  test("+2.5 s on SRT moves start and end and keeps everything else", () => {
    const r = shiftCues(SRT, 2500);
    expect(r.cues).toBe(2);
    expect(r.text).toBe(SRT.replace("00:00:01,500 --> 00:00:03,000", "00:00:04,000 --> 00:00:05,500").replace("01:02:03,004 --> 01:02:05,000", "01:02:05,504 --> 01:02:07,500"));
  });
  test("-1 s on SRT", () => {
    expect(shiftCues(SRT, -1000).text).toContain("00:00:00,500 --> 00:00:02,000");
  });
  test("+2.5 s on WebVTT keeps the header, note, id, settings and hourless stamps", () => {
    const r = shiftCues(VTT, 2500);
    expect(r.cues).toBe(2);
    expect(r.text).toBe(VTT.replace("00:01.250 --> 00:03.000", "00:03.750 --> 00:05.500").replace("00:01:00.000 --> 00:01:02.000", "00:01:02.500 --> 00:01:04.500"));
  });
  test("-1 s on WebVTT", () => {
    expect(shiftCues(VTT, -1000).text).toContain("00:00.250 --> 00:02.000");
  });
  test("an hourless stamp grows an hour when it must", () => {
    expect(shiftCues("WEBVTT\n\n59:59.000 --> 59:59.500\nx\n", 2000).text).toContain("01:00:01.000 --> 01:00:01.500");
  });
  test("a CRLF-only file keeps every CRLF and every other byte", () => {
    const crlf = "1\r\n00:00:01,000 --> 00:00:02,000\r\nHi\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\nBye\r\n";
    const r = shiftCues(crlf, 1000);
    expect(r.text).toBe(crlf.replace("00:00:01,000 --> 00:00:02,000", "00:00:02,000 --> 00:00:03,000").replace("00:00:03,000 --> 00:00:04,000", "00:00:04,000 --> 00:00:05,000"));
    expect(r.text.split("\r\n").length).toBe(crlf.split("\r\n").length);
    expect(r.text.replace(/\r\n/g, "")).not.toContain("\n");
  });
  test("a one-digit hour keeps its width, a milliseconds field is written in three digits", () => {
    expect(shiftCues("1\n1:02:03,004 --> 1:02:05,000\nx\n", 0).text).toBe("1\n1:02:03,004 --> 1:02:05,000\nx\n");
    expect(shiftCues("1\n1:02:03,004 --> 1:02:05,000\nx\n", 1000).text).toBe("1\n1:02:04,004 --> 1:02:06,000\nx\n");
    expect(shiftCues("1\n0:00:01,5 --> 0:00:02,25\nx\n", 0).text).toBe("1\n0:00:01,500 --> 0:00:02,250\nx\n");
  });
  test("never below zero", () => {
    const r = shiftCues(SRT, -10_000);
    expect(r.text).toContain("00:00:00,000 --> 00:00:00,000");
    expect(r.text).toContain("01:01:53,004 --> 01:01:55,000");
  });
  test("a file with no cues is returned unchanged", () => {
    expect(shiftCues("nothing\n", 1000)).toEqual({ text: "nothing\n", cues: 0 });
  });
});

describe("parseOffset", () => {
  test("a signed decimal in seconds", () => {
    expect(parseOffset("+2.5")).toEqual({ ok: true, ms: 2500 });
    expect(parseOffset(" -1 ")).toEqual({ ok: true, ms: -1000 });
    expect(parseOffset("3600")).toEqual({ ok: true, ms: 3_600_000 });
  });
  test("malformed or out of range is refused with a reason", () => {
    for (const bad of ["", "abc", "1e3", "NaN", "Infinity", "1,5", "3600.001", "-3601", "--1"]) {
      const r = parseOffset(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.why.length).toBeGreaterThan(10);
    }
  });
  test("the commit message", () => {
    expect(shiftMessage(2500)).toBe("Shift subtitles by +2.5 s");
    expect(shiftMessage(-1000)).toBe("Shift subtitles by -1 s");
  });
});

describe("the subtitle page's shift form", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base = "";
  let origin = "";
  let alice = "";
  let kim = "";

  let bob = "";
  const post = (fields: Record<string, string>, cookie?: string, from = origin, repo = "alice/subs") =>
    fetch(`${base}/${repo}/edit`, {
      method: "POST",
      redirect: "manual",
      headers: { origin: from, ...(cookie === undefined ? {} : { cookie }) },
      body: new URLSearchParams(fields),
    });
  const file = async (): Promise<string> => {
    const repo = getRepo(app.db, "alice", "subs")!;
    const blob = await localSource(app, repo, undefined).blob("main", "a.srt");
    if (!blob.ok || blob.value.kind !== "text") throw new Error("no file");
    return new TextDecoder().decode(blob.value.body);
  };
  const page = async (cookie?: string) =>
    await (await fetch(`${base}/alice/subs/blob/main/a.srt`, { headers: cookie === undefined ? {} : { cookie } })).text();

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-shift-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    origin = new URL(base).origin;
    const a = await seedAdmin(app, { username: "alice", email: "a@f.dev", password: "a-long-shift-passphrase" });
    const k = await signUp(app, { username: "kim", email: "k@f.dev", password: "a-long-shift-passphrase" }, { slot: fixtureSlot(app) });
    if (!a.ok || !k.ok) throw new Error("signup failed");
    alice = `forge_session=${createSession(app.db, a.value.id).token}`;
    kim = `forge_session=${createSession(app.db, k.value.id).token}`;
    const b = await signUp(app, { username: "bob", email: "b@f.dev", password: "a-long-shift-passphrase" }, { slot: fixtureSlot(app) });
    if (!b.ok) throw new Error("signup failed");
    bob = `forge_session=${createSession(app.db, b.value.id).token}`;
    const org = createOrg(app.db, "acme", a.value.id);
    if (!org.ok) throw new Error("org failed");
    const team = createTeam(app.db, org.value.id, "devs", "write");
    if (!team.ok) throw new Error("team failed");
    addTeamMember(app.db, team.value, b.value.id);
    const widget = await createRepo(app, a.value, { name: "widget", owner: "acme", visibility: "public" });
    if (!widget.ok) throw new Error("widget failed");
    await commitToBranch(app, a.value, widget.value, { message: "first", files: [{ path: "a.srt", content: SRT }, { path: "b.vtt", content: VTT }] });
    updateRepoSettings(app.db, getRepo(app.db, "acme", "widget")!, { protectDefault: true });
    const made = await createRepo(app, a.value, { name: "subs", visibility: "public" });
    if (!made.ok) throw new Error("repo failed");
    await commitToBranch(app, a.value, made.value, { message: "first", files: [{ path: "a.srt", content: SRT }, { path: "b.vtt", content: VTT }] });
  });
  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a writer sees the form, a reader does not", async () => {
    expect(await page(alice)).toContain('name="shift"');
    expect(await page(kim)).not.toContain('name="shift"');
    expect(await page()).not.toContain('name="shift"');
  });

  test("a malformed offset is refused with a reason and writes nothing", async () => {
    const res = await post({ ref: "main", path: "a.srt", shift: "soon" }, alice);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("number of seconds");
    expect(await file()).toBe(SRT);
  });

  test("a non-writer is refused and writes nothing", async () => {
    const res = await post({ ref: "main", path: "a.srt", shift: "2.5" }, kim);
    expect(res.status).toBe(404);
    expect(await file()).toBe(SRT);
  });

  test("a cross-origin POST is refused", async () => {
    const res = await post({ ref: "main", path: "a.srt", shift: "2.5" }, alice, "https://evil.example");
    expect(res.status).toBe(403);
    expect(await file()).toBe(SRT);
  });

  test("a non-subtitle path is refused", async () => {
    const res = await post({ ref: "main", path: "README.md", shift: "2.5" }, alice);
    expect(res.status).toBe(400);
  });

  test("a writer's shift is a commit with a plain message", async () => {
    const res = await post({ ref: "main", path: "a.srt", shift: "2.5" }, alice);
    expect(res.status).toBe(303);
    expect(await file()).toBe(shiftCues(SRT, 2500).text);
    const log = await commitLog(repoDir(app.reposRoot, "alice", "subs"), "main", { limit: 1 });
    expect(log.ok && log.value[0]?.subject).toBe("Shift subtitles by +2.5 s");
  });

  test("a WebVTT file shifts through the route", async () => {
    const res = await post({ ref: "main", path: "b.vtt", shift: "-1" }, alice);
    expect(res.status).toBe(303);
    const repo = getRepo(app.db, "alice", "subs")!;
    const blob = await localSource(app, repo, undefined).blob("main", "b.vtt");
    if (!blob.ok || blob.value.kind !== "text") throw new Error("no file");
    expect(new TextDecoder().decode(blob.value.body)).toBe(shiftCues(VTT, -1000).text);
    const log = await commitLog(repoDir(app.reposRoot, "alice", "subs"), "main", { limit: 1 });
    expect(log.ok && log.value[0]?.subject).toBe("Shift subtitles by -1 s");
  });

  test("a ref that is not safe, a ref that is missing and a file that is missing are 404", async () => {
    expect((await post({ ref: "../x", path: "a.srt", shift: "1" }, alice)).status).toBe(404);
    expect((await post({ ref: "nope", path: "a.srt", shift: "1" }, alice)).status).toBe(404);
    expect((await post({ ref: "main", path: "gone.srt", shift: "1" }, alice)).status).toBe(404);
  });

  test("on a protected default an ordinary writer's shift is a new branch and a pull, with the same message", async () => {
    const widget = getRepo(app.db, "acme", "widget")!;
    const res = await post({ ref: "main", path: "a.srt", shift: "2.5" }, bob, origin, "acme/widget");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toMatch(/\/acme\/widget\/pulls\/1$/);
    const main = await localSource(app, widget, undefined).blob("main", "a.srt");
    if (!main.ok || main.value.kind !== "text") throw new Error("no file");
    expect(new TextDecoder().decode(main.value.body)).toBe(SRT);
    const branch = Bun.spawnSync(["git", "branch", "--list", "bob/shift-*"], { cwd: repoDir(app.reposRoot, "acme", "widget") }).stdout.toString().trim();
    expect(branch).toMatch(/^bob\/shift-a\.srt-/);
    const log = await commitLog(repoDir(app.reposRoot, "acme", "widget"), branch, { limit: 1 });
    expect(log.ok && log.value[0]?.subject).toBe("Shift subtitles by +2.5 s");
  });
});

describe("the terminal's shift", () => {
  let dataDir: string;
  let app: App;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-shift-tui-"));
    app = createApp({ dataDir, port: 0, host: "forge.test" });
    const a = await seedAdmin(app, { username: "alice", email: "a@f.dev", password: "a-long-shift-passphrase" });
    const k = await signUp(app, { username: "kim", email: "k@f.dev", password: "a-long-shift-passphrase" }, { slot: fixtureSlot(app) });
    if (!a.ok || !k.ok) throw new Error("signup failed");
    const made = await createRepo(app, a.value, { name: "subs", visibility: "public" });
    if (!made.ok) throw new Error("repo failed");
    await commitToBranch(app, a.value, made.value, { message: "first", files: [{ path: "a.srt", content: SRT }] });
  });
  afterAll(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const open = (username: string) => {
    const user = getUserByName(app.db, username)!;
    const { app: tui, session } = createForgeApp(
      app,
      { sshUsername: username, remoteAddress: "127.0.0.1", fingerprint: `SHA256:${username}`, user },
      { terminal: headlessTerminal(100, 30), exitHooks: false },
    );
    tui.start();
    const parent: Screen = { title: "parent", keys: [], render() {}, key: () => false };
    return { tui, command: shiftCommands(session, tui.ctx, getRepo(app.db, "alice", "subs")!, () => parent) };
  };
  const type = async (tui: ReturnType<typeof open>["tui"], text: string) => {
    for (const key of text) tui.dispatch({ type: "key", key, ctrl: false, alt: false, shift: false });
    tui.dispatch({ type: "key", key: "enter", ctrl: false, alt: false, shift: false });
    await settleApp(tui);
  };

  test("a reader is offered nothing, a writer is", () => {
    const reader = open("kim");
    expect(reader.command).toEqual([]);
    reader.tui.stop();
    const writer = open("alice");
    expect(writer.command.map((c) => c.id)).toEqual(["subtitle-shift"]);
    writer.tui.stop();
  });

  test("a writer's shift is the same commit, announced on the bus", async () => {
    const { tui, command } = open("alice");
    const events: string[] = [];
    const off = app.bus.subscribe((e) => events.push(e.kind));
    try {
      void command[0]!.run();
      await settleApp(tui);
      await type(tui, "a.srt");
      for (let i = 0; i < 3; i++) tui.dispatch({ type: "key", key: "backspace", ctrl: false, alt: false, shift: false });
      await type(tui, "2.5");
      const end = Date.now() + 10_000;
      let log = await commitLog(repoDir(app.reposRoot, "alice", "subs"), "main", { limit: 1 });
      while (!(log.ok && log.value[0]?.subject === "Shift subtitles by +2.5 s") && Date.now() < end) {
        await Bun.sleep(25);
        log = await commitLog(repoDir(app.reposRoot, "alice", "subs"), "main", { limit: 1 });
      }
      expect(log.ok && log.value[0]?.subject).toBe("Shift subtitles by +2.5 s");
      expect(events).toContain("push");
    } finally {
      off();
      tui.stop();
    }
  }, 30_000);
});

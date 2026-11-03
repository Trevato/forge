/**
 * A pull from another forge is a guest (#8964): its preview starts without
 * the app's variables or a forge token, and the crew leaves it alone, until a
 * person who can write the repository approves it once — on the page through
 * a same-origin form, or in the terminal with `G`. The approval is per pull:
 * a later push by the guest keeps it.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { AppsRuntime } from "../src/apps/runtime.ts";
import { previewEnv } from "../src/apps/data.ts";
import { listEvents } from "../src/core/events.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { GUEST_NOTE, pullScreen } from "../src/tui/screens/pull.ts";
import { local } from "../src/tui/screens/where.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { settleApp } from "./helpers/tui.ts";
import { setAppEnv } from "../src/core/app_env.ts";
import { createApp as createAppRecord } from "../src/core/apps.ts";
import { getPull, type Pull } from "../src/core/pulls.ts";
import type { Repo } from "../src/core/repos.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { forgeHttp, type ForgeHttp } from "../src/http/server.ts";
import { approveGuest, guestWaits, isGuestPull } from "../src/origins/guest.ts";
import { sendToReview } from "../src/crew/review.ts";
import { GUEST_WAITS } from "../src/web/pages/pull-guest.ts";
import { quietLogs } from "./helpers/globals.ts";
import { promote } from "./helpers/members.ts";
import { seatAs } from "./helpers/seat.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";

quietLogs();

describe("a pull from another forge is a guest until a writer approves it", () => {
  let dataDir: string;
  let app: App;
  let http: ForgeHttp;
  let alice: User;
  let carol: User;
  let lib: Repo;
  let appId: string;
  let runtime: AppsRuntime;
  let n = 0;
  const url = "http://forge.test";

  async function pull(mark: "head" | "author" | "none"): Promise<Pull> {
    const branch = `g${++n}`;
    const committed = await commitToBranch(app, alice, lib, {
      branch,
      message: "From elsewhere",
      files: [{ path: `${branch}.md`, content: "hi\n" }],
    });
    if (!committed.ok) throw new Error(JSON.stringify(committed.error));
    const opened = await openPull(app, alice, lib, {
      title: "Theirs",
      baseBranch: "main",
      headBranch: branch,
    });
    if (!opened.ok) throw new Error(String(opened.error));
    if (mark === "head")
      app.db.run("UPDATE pull SET origin_head_repo = 'octo/lib' WHERE issue_id = ?1", [opened.value.id]);
    if (mark === "author")
      app.db.run("UPDATE issue SET origin_author = 'octocat' WHERE id = ?1", [opened.value.id]);
    return getPull(app.db, lib.id, opened.value.number)!;
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-guest-pull-"));
    app = createApp({ dataDir, port: 0, host: "forge.test" });
    http = forgeHttp(app);
    const people: User[] = [];
    for (const [username, first] of [["alice", true], ["carol", false]] as const) {
      const made = await createUser(app.db, {
        origin: "seed",
        trusted: true,
        username,
        email: `${username}@forge.local`,
        password: "a-good-passphrase",
        adminIfFirst: first,
      });
      if (!made.ok) throw new Error(made.error);
      people.push(made.value);
    }
    [alice, carol] = people as [User, User];
    promote(app.db, carol);
    const made = await createRepo(app, alice, { name: "lib", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    lib = made.value;
    const seeded = await commitToBranch(app, alice, lib, {
      message: "Start",
      files: [{ path: "README.md", content: "lib\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    const record = createAppRecord(app.db, { repoId: lib.id, slug: "lib", access: "public" });
    if (!record.ok) throw new Error(record.error);
    appId = record.value.id;
    // Never started: only asked what a process it would start holds.
    runtime = new AppsRuntime(app, { domain: "apps.test", scheme: "http", forgeUrl: url, concurrency: 1 });
    const set = setAppEnv(app.db, dataDir, record.value.id, "API_KEY", "s3cret", "preview");
    if (!set.ok) throw new Error(set.error);
  }, 60_000);

  afterAll(async () => {
    http.close();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const held = (pull: Pull) => runtime.secretsFor(lib, appId, previewEnv(pull.number), "tok");

  test("a waiting guest's preview starts with no variables and no forge token; after approval it has both", async () => {
    const guest = await pull("head");
    expect(isGuestPull(app.db, guest)).toBe(true);
    expect(held(guest)).toEqual({ vars: {}, forgeToken: undefined });

    // A reader's word does not count; a writer's does, once.
    expect(approveGuest(app.db, lib, guest, carol)).toEqual({ ok: false, error: "forbidden" });
    expect(held(guest)).toEqual({ vars: {}, forgeToken: undefined });
    expect(approveGuest(app.db, lib, guest, alice)).toEqual({ ok: true, value: "approved" });
    expect(approveGuest(app.db, lib, guest, alice)).toEqual({ ok: true, value: "already" });
    expect(held(guest)).toEqual({ vars: { API_KEY: "s3cret" }, forgeToken: "tok" });
  });

  test("the approval is per pull: a later push by the guest keeps it", async () => {
    const guest = await pull("head");
    expect(approveGuest(app.db, lib, guest, alice).ok).toBe(true);
    const pushed = await commitToBranch(app, alice, lib, {
      branch: guest.headBranch,
      message: "And more",
      files: [{ path: "more.md", content: "more\n" }],
    });
    if (!pushed.ok) throw new Error(JSON.stringify(pushed.error));
    const after = getPull(app.db, lib.id, guest.number)!;
    expect(guestWaits(app.db, after)).toBe(false);
    expect(held(after).vars).toEqual({ API_KEY: "s3cret" });
  });

  test("a pull brought in from the origin is a guest too; one from here is not", async () => {
    const brought = await pull("author");
    expect(guestWaits(app.db, brought)).toBe(true);
    expect(held(brought).vars).toEqual({});
    const own = await pull("none");
    expect(isGuestPull(app.db, own)).toBe(false);
    expect(held(own)).toEqual({ vars: { API_KEY: "s3cret" }, forgeToken: "tok" });
    expect(approveGuest(app.db, lib, own, alice)).toEqual({ ok: false, error: "not_guest" });
  });

  test("the crew does not send a waiting guest to review, though a reviewer is seated", async () => {
    const agent = await createAgent(app, alice, { username: "sentinel" });
    if (!agent.ok) throw new Error(String(agent.error));
    expect(addToCrew(app, alice, lib, "sentinel").ok).toBe(true);
    expect(seatAs(app.db, lib.id, getUserByName(app.db, "sentinel")!.id, "reviewer")).toBe(true);
    const guest = await pull("head");
    expect(await sendToReview(app, lib, guest)).toBe("held");
  });

  test("the page says it is a guest; only a writer is offered the approval, same-origin", async () => {
    const guest = await pull("head");
    const as = (user: User) => `forge_session=${createSession(app.db, user.id).token}`;
    const page = (cookie: string) =>
      http
        .handle(new Request(`${url}/alice/lib/pulls/${guest.number}`, { headers: { cookie } }))
        .then((r) => r.text());
    const words = GUEST_WAITS.slice(0, 40);
    const reader = await page(as(carol));
    expect(reader).toContain(words);
    expect(reader).not.toContain("approve-guest");
    const writer = await page(as(alice));
    expect(writer).toContain(words);
    expect(writer).toContain("approve-guest");

    const post = (cookie: string, origin: string) =>
      http.handle(
        new Request(`${url}/alice/lib/pulls/${guest.number}/approve-guest`, {
          method: "POST",
          headers: { cookie, origin, "content-type": "application/x-www-form-urlencoded" },
          body: "",
        }),
      );
    await post(as(alice), "http://evil.test");
    expect(guestWaits(app.db, guest)).toBe(true);
    await post(as(carol), url);
    expect(guestWaits(app.db, guest)).toBe(true);
    await post(as(alice), url);
    expect(guestWaits(app.db, guest)).toBe(false);
    // Announced, so an open page of the pull and the preview hear it.
    expect(
      listEvents(app.db, { repoId: lib.id, kind: "pull.guest_approved" }).some(
        (e) => e.payload["number"] === guest.number,
      ),
    ).toBe(true);
    expect(await page(as(alice))).not.toContain(words);
  }, 30_000);

  test("the terminal says it is a guest; only a writer gets G, and G approves it", async () => {
    const guest = await pull("head");
    const open = async (user: User) => {
      const { app: tui, session } = createForgeApp(
        app,
        { sshUsername: user.username, remoteAddress: "127.0.0.1", fingerprint: `SHA256:${user.username}`, user },
        { terminal: headlessTerminal(200, 44), exitHooks: false },
      );
      tui.start();
      tui.ctx.push(pullScreen(session, tui.ctx, local(session, lib), guest.number));
      const end = Date.now() + 20_000;
      while (!tui.screen.toText().includes("a guest from another forge")) {
        if (Date.now() > end) throw new Error(tui.screen.toText());
        await settleApp(tui);
        await Bun.sleep(20);
      }
      return tui;
    };
    const reader = await open(carol);
    try {
      expect(reader.screen.toText()).toContain(GUEST_NOTE.slice(0, 40));
      expect(reader.screen.toText()).not.toContain("approve this guest");
      reader.dispatch({ type: "key", key: "G", ctrl: false, alt: false, shift: true });
      await settleApp(reader);
      expect(guestWaits(app.db, guest)).toBe(true);
    } finally {
      reader.stop();
    }
    const writer = await open(alice);
    try {
      expect(writer.screen.toText()).toContain("approve this guest");
      writer.dispatch({ type: "key", key: "G", ctrl: false, alt: false, shift: true });
      await settleApp(writer);
      expect(guestWaits(app.db, guest)).toBe(false);
      expect(
        listEvents(app.db, { repoId: lib.id, kind: "pull.guest_approved" }).some(
          (e) => e.payload["number"] === guest.number,
        ),
      ).toBe(true);
    } finally {
      writer.stop();
    }
  }, 60_000);
});

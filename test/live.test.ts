/**
 * One stream per viewer: everything they may see, as it happens, with
 * what they missed replayed first.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { openIssue } from "../src/actions/issues.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser, type User } from "../src/core/users.ts";
import { liveClientJs } from "../src/web/live.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { promote } from "./helpers/members.ts";
import { withScripts } from "./helpers/page-script.ts";

async function readEvents(
  res: Response,
  count: number,
  timeoutMs = 5_000,
  /** False when the wait is the point: nothing should come. */
  mustArrive = true,
): Promise<{ id: string; data: Record<string, unknown> }[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const out: { id: string; data: Record<string, unknown> }[] = [];
  const deadline = Date.now() + timeoutMs;
  while (out.length < count && Date.now() < deadline) {
    const next = await Promise.race([
      reader.read(),
      Bun.sleep(deadline - Date.now()).then(() => ({
        done: true,
        value: undefined,
      })),
    ]);
    if (next.done) break;
    buffer += decoder.decode(next.value);
    let at: number;
    while ((at = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, at);
      buffer = buffer.slice(at + 2);
      const id = /^id: (.*)$/m.exec(frame)?.[1] ?? "";
      const data = /^data: (.*)$/m.exec(frame)?.[1];
      if (data !== undefined)
        out.push({ id, data: JSON.parse(data) as Record<string, unknown> });
    }
  }
  if (mustArrive && out.length < count) throw new Error(`never came: still waiting while out.length < count`);
  await reader.cancel().catch(() => {});
  return out;
}

describe("the viewer's stream", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let alice: User;
  let cookie: string;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-live-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const a = await createUser(app.db, { origin: "seed", trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: false,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    promote(app.db, alice);
    const session = createSession(app.db, alice.id);
    cookie = `forge_session=${session.token}`;
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a private repository's events reach its reader and nobody else; the missed part is replayed", async () => {
    const made = await createRepo(app, alice, {
      name: "diary",
      visibility: "private",
    });
    if (!made.ok) throw new Error(String(made.error));
    const repo = made.value;
    await commitToBranch(app, alice, repo, {
      message: "Start",
      files: [{ path: "README.md", content: "# diary\n" }],
    });
    const first = openIssue(app, alice, repo, { title: "One" });
    if (!first.ok) throw new Error(String(first.error));

    // A stranger's stream: nothing private on it, however long they wait.
    const stranger = await fetch(`${servers.url}/events?since=0`);
    expect(stranger.headers.get("content-type")).toContain("text/event-stream");
    const nothing = await readEvents(stranger, 1, 800, false);
    expect(nothing.length).toBe(0);

    // The reader's stream, from the beginning: the opened issue is replayed.
    const mine = await fetch(`${servers.url}/events?since=0`, {
      headers: { cookie },
    });
    const replayed = await readEvents(mine, 1);
    expect(replayed.length).toBeGreaterThanOrEqual(1);
    expect(
      replayed.some(
        (e) =>
          e.data["kind"] === "issue.opened" && e.data["repo"] === "alice/diary",
      ),
    ).toBe(true);

    // Live: an event after the stream opened arrives, carrying its id.
    const live = await fetch(`${servers.url}/events`, { headers: { cookie } });
    await Bun.sleep(100);
    const second = openIssue(app, alice, repo, { title: "Two" });
    if (!second.ok) throw new Error(String(second.error));
    const arrived = await readEvents(live, 1);
    expect(arrived.length).toBe(1);
    expect(arrived[0]!.data["kind"]).toBe("issue.opened");
    expect(arrived[0]!.id).not.toBe("");
    expect((arrived[0]!.data["payload"] as { number: number }).number).toBe(
      second.value.number,
    );
  });

  test("the studio pages carry live regions and the script that keeps them fresh", async () => {
    const res = await fetch(`${servers.url}/feed`, {
      headers: { cookie: `${cookie}; forge_mode=studio` },
    });
    const page = await res.text();
    expect(page).toContain('id="live-apps"');
    expect(page).toContain('id="live-apps"');
    expect(await withScripts(servers.url, page)).toContain("new EventSource('/events')");
  });

  test("a grant to run a pull reaches a page watching that pull", async () => {
    const made = await createRepo(app, alice, {
      name: "grants",
      visibility: "public",
    });
    if (!made.ok) throw new Error(String(made.error));
    const mine = await fetch(`${servers.url}/events`, {
      headers: { cookie },
    });
    app.bus.append({
      kind: "pull.run_granted",
      repoId: made.value.id,
      actorId: alice.id,
      payload: { number: 7, commit: "abc" },
    });
    const [got] = await readEvents(mine, 1, 2_000);
    expect(got?.data.kind).toBe("pull.run_granted");
    expect((got?.data.payload as { number: number }).number).toBe(7);
    // The page subscribes to the kind by name, or the stream's event never
    // reaches its handler.
    expect(liveClientJs).toContain("'pull.run_granted'");
  });
});

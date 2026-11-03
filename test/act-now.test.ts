/**
 * Actions that answer at once (#8708): the shared script's byte budget, the
 * markup that opts a form in, the JSON refusal the script rolls back on, and
 * a stream that resumes with only what it missed.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { openIssue } from "../src/actions/issues.ts";
import { createApp, type App } from "../src/app.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { ACT_NOW_BUDGET, actNowJs } from "../src/web/act_now.ts";
import { shellAsset } from "../src/web/asset.ts";
import { flowButton } from "../src/web/flow_button.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

describe("the script that makes actions answer at once", () => {
  test("stays inside its byte budget", () => {
    const bytes = new TextEncoder().encode(actNowJs).length;
    expect(bytes).toBeLessThanOrEqual(ACT_NOW_BUDGET);
    // The budget is tight, not a ceiling nobody will reach.
    expect(bytes).toBeGreaterThan(ACT_NOW_BUDGET - 1200);
  });

  /** The script run against a stand-in page: one form, one button, one echo. */
  const submit = async (reply: () => Promise<Response>) => {
    const attrs: Record<string, string> = { "data-now": "Closed", "data-now-once": "", "data-now-into": "#echo", "data-now-from": "who" };
    const label = { nodeType: 3, nodeValue: "Close" };
    const aria: Record<string, string> = {};
    const button = {
      innerHTML: "<svg></svg>Close",
      disabled: false,
      childNodes: [{ nodeType: 1 }, label],
      appendChild: () => {},
      removeChild: () => {},
      setAttribute: (n: string, v: string) => void (aria[n] = v),
      removeAttribute: (n: string) => void delete aria[n],
    };
    const echo = { innerHTML: "bob", textContent: "bob" };
    const note: { role: string; textContent: string } = { role: "", textContent: "" };
    const select = { options: [{ text: " alice " }], selectedIndex: 0 };
    const form = {
      id: "",
      getAttribute: (n: string) => attrs[n] ?? null,
      hasAttribute: (n: string) => n in attrs,
      setAttribute: (n: string, v: string) => void (attrs[n] = v),
      querySelectorAll: (q: string) => (q === "button" ? [button] : []),
      elements: { who: select } as Record<string, unknown>,
      action: "/x",
    };
    let handler: (e: unknown) => void = () => {};
    const doc = {
      addEventListener: (_: string, h: (e: unknown) => void) => void (handler = h),
      querySelector: (q: string) => (q === "#echo" ? echo : null),
      createElement: () => note,
      createTextNode: (t: string) => ({ nodeType: 3, nodeValue: t }),
    };
    Object.assign(note, { setAttribute: (_: string, v: string) => void (note.role = v) });
    // The note is placed after the first button.
    let noteInDom = false;
    Object.assign(button, { insertAdjacentElement: () => void (noteInDom = true) });
    const seen: { now: string; echo: string; aria: string | undefined; disabled: boolean; noteInDom: boolean; noteText: string }[] = [];
    let prevented = false;
    const fetcher = () => {
      seen.push({ now: label.nodeValue, echo: echo.textContent, aria: aria["aria-disabled"], disabled: button.disabled, noteInDom, noteText: note.textContent });
      return reply();
    };
    new Function("document", "window", "fetch", "FormData", "URLSearchParams", actNowJs)(
      doc,
      { fetch: fetcher },
      fetcher,
      class {
        constructor() {
          return [["who", "alice"]];
        }
      },
      URLSearchParams,
    );
    handler({ target: form, defaultPrevented: false, preventDefault: () => (prevented = true) });
    await Bun.sleep(150);
    return { button, label, aria, echo, note, seen, prevented, attrs };
  };

  test("shows the result before the server has answered, and keeps it on success", async () => {
    const run = await submit(async () => Response.json({ ok: true, flash: "Closed." }));
    expect(run.prevented).toBe(true);
    // At the moment of the post, the page already said the result.
    expect(run.seen).toEqual([
      { now: "Closed", echo: "alice", aria: "true", disabled: false, noteInDom: true, noteText: "" },
    ]);
    // The icon is kept; only the word changes.
    expect(run.label.nodeValue).toBe("Closed");
    expect(run.button.childNodes.length).toBe(2);
    // Focus stays put: the button is never truly disabled, and stays so once done.
    expect(run.button.disabled).toBe(false);
    expect(run.aria["aria-disabled"]).toBe("true");
    expect(run.echo.textContent).toBe("alice");
    expect(run.note.role).toBe("status");
  });

  test("rolls back with the server's reason on refusal", async () => {
    const run = await submit(async () => Response.json({ ok: false, error: "Only a writer can do that." }, { status: 422 }));
    expect(run.button.innerHTML).toBe("<svg></svg>Close");
    expect(run.aria["aria-disabled"]).toBeUndefined();
    expect(run.echo.innerHTML).toBe("bob");
    expect(run.note.textContent).toBe("Only a writer can do that.");
    expect(run.note.role).toBe("alert");
  });

  test("rolls back when the forge cannot be reached", async () => {
    const run = await submit(() => Promise.reject(new Error("offline")));
    expect(run.button.innerHTML).toBe("<svg></svg>Close");
    expect(run.note.textContent).toContain("Nothing changed");
  });

  test("rides the cached shell asset, not a script of its own", () => {
    expect(shellAsset().code).toContain(actNowJs);
  });

  test("a flow button says the other word next", () => {
    const markup = String(flowButton("/a/b/issues/1/flow", false, "/a/b"));
    expect(markup).toContain('data-now="Not first"');
    expect(markup).toContain('data-now-alt="Flow first"');
    expect(markup).toContain('data-now-flip="flow"');
  });
});

describe("a form that answers at once, and what the server says when it refuses", () => {
  let dataDir = "";
  let app: App;
  let servers: Servers;
  let alice: User;
  let bob: User;
  let cookie = "";
  let reader = "";

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-act-now-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const make = async (username: string, admin: boolean) => {
      const made = await createUser(app.db, {
        origin: "seed",
        trusted: true,
        username,
        email: `${username}@f.dev`,
        password: "a-good-passphrase",
        isAdmin: admin,
      });
      if (!made.ok) throw new Error(made.error);
      return made.value;
    };
    alice = await make("alice", true);
    bob = await make("bob", false);
    cookie = `forge_session=${createSession(app.db, alice.id).token}`;
    reader = `forge_session=${createSession(app.db, bob.id).token}`;
    const repo = await createRepo(app, alice, { name: "lab", visibility: "public" });
    if (!repo.ok) throw new Error(String(repo.error));
    const opened = openIssue(app, alice, repo.value, { title: "Do it", body: "now" });
    if (!opened.ok) throw new Error(String(opened.error));
  });

  afterAll(async () => {
    await servers.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  const post = (who: string, path: string, form: Record<string, string>) =>
    fetch(`${servers.url}${path}`, {
      method: "POST",
      headers: { cookie: who, origin: servers.url, accept: "application/json" },
      body: new URLSearchParams(form),
      redirect: "manual",
    });

  test("the thread page opts its assign, label and close forms in", async () => {
    const page = await (await fetch(`${servers.url}/alice/lab/issues/1`, { headers: { cookie } })).text();
    expect(page).toContain('data-now="Assigned" data-now-into="#assignee-now" data-now-from="assignee"');
    expect(page).toContain('id="assignee-now"');
    expect(page).toContain('data-now="Closed" data-now-once');
  });

  test("assign, close and flow answer in JSON when asked", async () => {
    const assigned = await post(cookie, "/alice/lab/issues/1/assignee", { assignee: "alice" });
    expect(assigned.status).toBe(200);
    expect(await assigned.json()).toEqual({ ok: true, flash: "Assigned to alice." });
    const flowed = await post(cookie, "/alice/lab/issues/1/flow", { flow: "1" });
    expect(((await flowed.json()) as { ok: boolean }).ok).toBe(true);
    const closed = await post(cookie, "/alice/lab/issues/1/state", { state: "closed" });
    expect(await closed.json()).toEqual({ ok: true, flash: "Closed." });
  });

  test("a refusal is a 422 with the reason, and changes nothing", async () => {
    const refused = await post(reader, "/alice/lab/issues/1/assignee", { assignee: "bob" });
    expect(refused.status).toBe(422);
    const body = (await refused.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("write access");
    const unknown = await post(cookie, "/alice/lab/issues/1/assignee", { assignee: "ghost" });
    expect(unknown.status).toBe(422);
    expect(((await unknown.json()) as { error: string }).error).toContain("no account named ghost");
  });

  test("without the JSON ask, a form still redirects", async () => {
    const plain = await fetch(`${servers.url}/alice/lab/issues/1/assignee`, {
      method: "POST",
      headers: { cookie, origin: servers.url },
      body: new URLSearchParams({ assignee: "" }),
      redirect: "manual",
    });
    expect(plain.status).toBe(303);
  });

  test("a foreign origin is refused before anything happens", async () => {
    const res = await fetch(`${servers.url}/alice/lab/issues/1/assignee`, {
      method: "POST",
      headers: { cookie, origin: "https://evil.example", accept: "application/json" },
      body: new URLSearchParams({ assignee: "alice" }),
      redirect: "manual",
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  test("a stream resumed after an event gets what it missed and nothing before", async () => {
    const repoId = getRepoId();
    const ids = [1, 2, 3].map(
      (n) => app.bus.append({ kind: "issue.opened", repoId, actorId: alice.id, payload: { number: 100 + n } }).id,
    );
    const res = await fetch(`${servers.url}/events`, { headers: { cookie, "last-event-id": ids[0]! } });
    const reader2 = res.body!.getReader();
    let text = "";
    const deadline = Date.now() + 3_000;
    while (!text.includes(`id: ${ids[2]}`) && Date.now() < deadline) {
      const next = await Promise.race([reader2.read(), Bun.sleep(200).then(() => undefined)]);
      if (next === undefined || next.done) continue;
      text += new TextDecoder().decode(next.value);
    }
    if (!text.includes(`id: ${ids[2]}`)) throw new Error(`never came: still waiting while !text.includes(\`id: \${ids[2]}\`)`);
    await reader2.cancel();
    expect(text).not.toContain(`id: ${ids[0]}`);
    expect(text).toContain(`id: ${ids[1]}`);
    expect(text).toContain(`id: ${ids[2]}`);
    expect(text.indexOf(`id: ${ids[1]}`)).toBeLessThan(text.indexOf(`id: ${ids[2]}`));
  });

  function getRepoId(): string {
    const row = app.db.query("select id from repo where name = 'lab'").get() as { id: string };
    return row.id;
  }
});

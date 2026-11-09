/**
 * `/fleet` writes (#10133): a same-origin POST previews a verb over the
 * selected rows and writes nothing; apply writes through `applyFleetOp` and
 * lands on a receipt; Undo calls `undoFleetOp`. A cross-origin POST is
 * refused and a signed-out reader is not offered the form.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { openIssue } from "../src/actions/issues.ts";
import { createAgent } from "../src/actions/crew.ts";
import { createLabel, createRepo } from "../src/actions/repos.ts";
import { createSession } from "../src/core/sessions.ts";
import { getRepo } from "../src/core/repos.ts";
import { labelsFor } from "../src/core/issues.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { promote } from "./helpers/members.ts";
import { MAX_ROWS } from "../src/fleet/selection.ts";
import { components } from "../src/web/style/components.ts";

describe("fleet verbs on the web", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let cookie: string;
  const ids: string[] = [];
  const q = "issue repo:alice/engine state:open";

  const person = async (username: string, adminIfFirst = false) => {
    const made = await createUser(app.db, {
      origin: "seed", trusted: true, username, allowReserved: true,
      email: `${username}@forge.local`, password: "a-good-passphrase", adminIfFirst,
    });
    if (!made.ok) throw new Error(made.error);
    promote(app.db, made.value);
    return made.value;
  };
  const post = (path: string, body: Record<string, string>, headers: Record<string, string> = {}) =>
    fetch(`${servers.url}${path}`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie, origin: servers.url, "content-type": "application/x-www-form-urlencoded", ...headers },
      body: new URLSearchParams(body),
    });
  /** Preview, then apply with the digest the preview carried: what a person's browser does. */
  const apply = async (body: Record<string, string>, headers: Record<string, string> = {}) => {
    const shown = await (await post("/fleet", { ...body, step: "preview" }, headers)).text();
    const digest = /name="digest" value="([0-9a-f]+)"/.exec(shown)?.[1] ?? "";
    return post("/fleet", { ...body, step: "apply", digest }, headers);
  };
  const labelled = () => ids.map((id) => labelsFor(app.db, id).map((l) => l.name));

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-fleet-act-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    await person("root", true);
    const alice: User = await person("alice");
    const repo = await createRepo(app, alice, { name: "engine", visibility: "public" });
    if (!repo.ok) throw new Error(String(repo.error));
    for (const n of [1, 2]) {
      const made = openIssue(app, alice, repo.value, { title: `Task ${n}` });
      if (!made.ok) throw new Error(String(made.error));
      ids.push(made.value.id);
    }
    createLabel(app, alice, repo.value, "urgent", "ff0000");
    cookie = `forge_session=${createSession(app.db, alice.id).token}`;
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a reader is not offered the form; a writer is", async () => {
    const path = `/fleet?${new URLSearchParams({ q })}`;
    const reader = await (await fetch(`${servers.url}${path}`)).text();
    expect(reader).toContain("data-count=\"2\"");
    expect(reader).not.toContain("data-act");
    const writer = await (await fetch(`${servers.url}${path}`, { headers: { cookie } })).text();
    expect(writer).toContain("data-act");
    expect(writer).toContain('value="label"');
  });

  test("a signed-out POST is not a write", async () => {
    const res = await fetch(`${servers.url}/fleet`, {
      method: "POST", redirect: "manual",
      headers: { origin: servers.url, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ q, step: "apply", verb: "label", value: "urgent" }),
    });
    expect([303, 401, 403]).toContain(res.status);
    expect(labelled()).toEqual([[], []]);
  });

  test("a cross-origin POST is refused and writes nothing", async () => {
    const res = await post("/fleet", { q, step: "apply", verb: "label", value: "urgent" }, { origin: "https://evil.example" });
    expect(res.status).toBe(403);
    expect(labelled()).toEqual([[], []]);
  });

  test("preview shows each row's change and writes nothing; a refusal is a muted line", async () => {
    const res = await post("/fleet", { q, step: "preview", verb: "label", value: "urgent" });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("data-preview");
    expect(body).toContain("Apply to 2 rows");
    expect(body).toContain("will change");
    expect(body).toContain("none → urgent");
    expect(labelled()).toEqual([[], []]);
    const none = await (await post("/fleet", { q, step: "preview", verb: "label", value: "nope" })).text();
    expect(none).toContain("no label named nope in alice/engine");
    expect(none).toContain('class="muted"');
    const bad = await (await post("/fleet", { q, step: "preview", verb: "archive", value: "true" })).text();
    expect(bad).toContain("data-refused");
  });

  test("apply writes through the operation and lands on a receipt; Undo puts it back, once", async () => {
    const applied = await apply({ q, verb: "label", value: "urgent" });
    expect(applied.status).toBe(303);
    const at = applied.headers.get("location")!;
    expect(at).toMatch(/^\/fleet\/ops\//);
    expect(labelled()).toEqual([["urgent"], ["urgent"]]);
    const receipt = await (await fetch(`${servers.url}${at}`, { headers: { cookie } })).text();
    expect(receipt).toContain("data-receipt");
    expect(receipt).toContain(`action="${at}/undo"`);

    const undone = await post(`${at}/undo`, {});
    expect(undone.status).toBe(303);
    expect(labelled()).toEqual([[], []]);
    const after = await (await fetch(`${servers.url}${at}`, { headers: { cookie } })).text();
    expect(after).not.toContain("/undo\"");
    await post(`${at}/undo`, {});
    expect(labelled()).toEqual([[], []]);
  });

  test("a cross-origin undo is refused", async () => {
    const applied = await apply({ q, verb: "label", value: "urgent" });
    const at = applied.headers.get("location")!;
    const res = await post(`${at}/undo`, {}, { origin: "https://evil.example" });
    expect(res.status).toBe(403);
    expect(labelled()).toEqual([["urgent"], ["urgent"]]);
  });

  test("an agent's POST is not a write", async () => {
    const made = await createAgent(app, getUserByName(app.db, "root")!, { username: "botty", brief: "Be brief." });
    if (!made.ok) throw new Error(String(made.error));
    const agent = `forge_session=${createSession(app.db, made.value.user.id).token}`;
    const res = await post("/fleet", { q, step: "apply", verb: "label", value: "urgent", digest: "x" }, { cookie: agent });
    expect(res.status).toBe(404);
    expect(labelled()).toEqual([["urgent"], ["urgent"]]);
    const page = await (await fetch(`${servers.url}/fleet?${new URLSearchParams({ q })}`, { headers: { cookie: agent } })).text();
    expect(page).not.toContain("data-act");
  });

  test("a row alice does not administer is refused in apply and left alone", async () => {
    const bob = await person("bob");
    const repo = await createRepo(app, bob, { name: "other", visibility: "public" });
    if (!repo.ok) throw new Error(String(repo.error));
    const issue = openIssue(app, bob, repo.value, { title: "Theirs" });
    if (!issue.ok) throw new Error(String(issue.error));
    createLabel(app, bob, repo.value, "urgent", "ff0000");
    const alice = getUserByName(app.db, "alice")!;
    const engine = getRepo(app.db, "alice", "engine")!;
    const mineToo = openIssue(app, alice, engine, { title: "Mine" });
    if (!mineToo.ok) throw new Error(String(mineToo.error));
    const mine = "issue repo:alice/engine,bob/other";
    const applied = await apply({ q: mine, verb: "label", value: "urgent" });
    const at = applied.headers.get("location")!;
    const receipt = await (await fetch(`${servers.url}${at}`, { headers: { cookie } })).text();
    expect(receipt).toContain('data-outcome="refused"');
    expect(labelsFor(app.db, issue.value.id)).toEqual([]);
    expect(labelsFor(app.db, mineToo.value.id).map((l) => l.name)).toEqual(["urgent"]);
  });

  test("apply is bound to what was previewed: rows that moved are refused, nothing written", async () => {
    const alice = getUserByName(app.db, "alice")!;
    const repo = await createRepo(app, alice, { name: "fresh", visibility: "public" });
    if (!repo.ok) throw new Error(String(repo.error));
    createLabel(app, alice, repo.value, "urgent", "ff0000");
    const first = openIssue(app, alice, repo.value, { title: "One" });
    if (!first.ok) throw new Error(String(first.error));
    const fq = "issue repo:alice/fresh";
    const body = { q: fq, verb: "label", value: "urgent" };
    const preview = await (await post("/fleet", { ...body, step: "preview" })).text();
    const digest = /name="digest" value="([0-9a-f]+)"/.exec(preview)?.[1];
    expect(digest).toBeDefined();
    const second = openIssue(app, alice, repo.value, { title: "Two" });
    if (!second.ok) throw new Error(String(second.error));
    const stale = await post("/fleet", { ...body, step: "apply", digest: digest! });
    expect(stale.status).toBe(200);
    expect(await stale.text()).toContain("rows changed since the preview");
    expect(labelsFor(app.db, first.value.id)).toEqual([]);
    expect(labelsFor(app.db, second.value.id)).toEqual([]);
    const missing = await post("/fleet", { ...body, step: "apply" });
    expect(missing.status).toBe(200);
    expect(labelsFor(app.db, first.value.id)).toEqual([]);
    const fresh = await (await post("/fleet", { ...body, step: "preview" })).text();
    const again = /name="digest" value="([0-9a-f]+)"/.exec(fresh)![1]!;
    const ok = await post("/fleet", { ...body, step: "apply", digest: again });
    expect(ok.status).toBe(303);
    expect(labelsFor(app.db, second.value.id).map((l) => l.name)).toEqual(["urgent"]);
  });

  /** Each `<input name="pick">` on a page, as its attributes. */
  const pickBoxes = (page: string) =>
    [...page.matchAll(/<input\b([^>]*\bname="pick"[^>]*)>/g)].map((m) => {
      const attrs: Record<string, string | true> = {};
      for (const a of m[1]!.matchAll(/([a-z-]+)(?:="([^"]*)")?/g)) attrs[a[1]!] = a[2] ?? true;
      return attrs;
    });
  const send = (b: URLSearchParams) =>
    fetch(`${servers.url}/fleet`, {
      method: "POST", redirect: "manual",
      headers: { cookie, origin: servers.url, "content-type": "application/x-www-form-urlencoded" },
      body: b,
    });
  const pickRepo = async (name: string, count: number) => {
    const alice = getUserByName(app.db, "alice")!;
    const repo = await createRepo(app, alice, { name, visibility: "public" });
    if (!repo.ok) throw new Error(String(repo.error));
    createLabel(app, alice, repo.value, "urgent", "ff0000");
    return Array.from({ length: count }, (_, n) => {
      const one = openIssue(app, alice, repo.value, { title: `Pick ${n}` });
      if (!one.ok) throw new Error(String(one.error));
      return one.value.id;
    });
  };

  test("ticked rows narrow the act to themselves; a pick outside the selection never widens it", async () => {
    const made = await pickRepo("picks", 3);
    const bob = getUserByName(app.db, "bob")!;
    const outside = openIssue(app, bob, getRepo(app.db, "bob", "other")!, { title: "Not selected" });
    if (!outside.ok) throw new Error(String(outside.error));
    const pq = "issue repo:alice/picks";

    const page = await (await fetch(`${servers.url}/fleet?${new URLSearchParams({ q: pq })}`, { headers: { cookie } })).text();
    const boxes = pickBoxes(page).filter((b) => b.type === "checkbox");
    expect(boxes.map((b) => b.value).sort()).toEqual([...made].sort());
    expect(boxes.every((b) => b.form === "fleet-act" && b.checked === undefined)).toBe(true);
    expect(page).toContain('id="fleet-act"');
    expect(page).toContain("Acts on all 3 matching rows");
    const reader = await (await fetch(`${servers.url}/fleet?${new URLSearchParams({ q: pq })}`)).text();
    expect(pickBoxes(reader)).toEqual([]);

    const junk = "<script>x</script>";
    const body = new URLSearchParams({ q: pq, verb: "label", value: "urgent", step: "preview" });
    for (const id of [made[1]!, outside.value.id, junk]) body.append("pick", id);
    const preview = await (await send(body)).text();
    expect(preview).toContain("Apply to 1 row");
    expect(preview).toContain("1 picked of 3");
    expect(preview).not.toContain("script>x");
    const shown = pickBoxes(preview);
    expect(shown.find((b) => b.type === "checkbox" && b.value === made[1])?.checked).toBe(true);
    expect(shown.filter((b) => b.type === "checkbox" && b.checked === true).length).toBe(1);
    expect(shown.filter((b) => b.type === "hidden").map((b) => b.value)).toEqual([made[1]!, outside.value.id]);
    const digest = /name="digest" value="([0-9a-f]+)"/.exec(preview)![1]!;
    body.set("step", "apply");
    body.set("digest", digest);
    const applied = await send(body);
    expect(applied.status).toBe(303);
    expect(made.map((id) => labelsFor(app.db, id).map((l) => l.name))).toEqual([[], ["urgent"], []]);
    expect(labelsFor(app.db, outside.value.id)).toEqual([]);

    const none = new URLSearchParams({ q: pq, verb: "label", value: "urgent", step: "preview", pick: outside.value.id });
    expect(await (await send(none)).text()).toContain("None of the picked rows is in the selection");
  });

  test("apply with picks other than the previewed ones is refused as expired, and writes nothing", async () => {
    const made = await pickRepo("swap", 2);
    const pq = "issue repo:alice/swap";
    const body = new URLSearchParams({ q: pq, verb: "label", value: "urgent", step: "preview", pick: made[0]! });
    const digest = /name="digest" value="([0-9a-f]+)"/.exec(await (await send(body)).text())![1]!;
    const swapped = new URLSearchParams({ q: pq, verb: "label", value: "urgent", step: "apply", digest, pick: made[1]! });
    const res = await send(swapped);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("rows changed since the preview");
    expect(made.map((id) => labelsFor(app.db, id))).toEqual([[], []]);
  });

  test("more picks than a selection can hold are refused before anything is read", async () => {
    const body = new URLSearchParams({ q, verb: "label", value: "urgent", step: "preview" });
    for (let i = 0; i <= MAX_ROWS; i++) body.append("pick", `id${i}`);
    const page = await (await send(body)).text();
    expect(page).toContain(`Pick at most ${MAX_ROWS} rows.`);
    expect(page).not.toContain("data-preview");
  });

  test("on a phone the row's box is a 44px target, centred in its cell", () => {
    const coarse = [...components.matchAll(/@media \(pointer: coarse\) \{([\s\S]*?)\n\}/g)].map((m) => m[1]).join("\n");
    expect(coarse).toMatch(/\.check \{[^}]*min-height: 44px;[^}]*min-width: 44px;/);
    expect(coarse).toMatch(/\.table \.check \{[^}]*justify-content: center;/);
  });
});

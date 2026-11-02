// Holding a file goes through one form handler (#7055): the settings route
// holds and releases through it, and a missing repository is refused in the
// very words an unreadable private one is, so the refusal names neither.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import type { Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { heldFiles } from "../src/crew/file_holds.ts";
import type { Ctx } from "../src/http/context.ts";
import { serve, type Servers } from "../src/http/server.ts";
import type { Form } from "../src/web/form.ts";
import { fileHoldForm } from "../src/web/pages/file_holds.ts";

describe("the file hold form", () => {
  let dir: string;
  let app: App;
  let servers: Servers;
  let alice: User;
  let bob: User;
  let open: Repo;
  let secret: Repo;

  const person = async (username: string, first = false): Promise<User> => {
    const made = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username,
      email: `${username}@forge.local`,
      password: "a-good-passphrase",
      adminIfFirst: first,
    });
    if (!made.ok) throw new Error(made.error);
    return made.value;
  };
  const cookieOf = async (username: string): Promise<string> =>
    (
      (
        await fetch(`${servers.url}/signin`, {
          method: "POST",
          body: new URLSearchParams({ username, password: "a-good-passphrase" }),
          redirect: "manual",
        })
      ).headers.get("set-cookie") ?? ""
    ).split(";")[0]!;
  const post = (cookie: string, repo: string, body: Record<string, string>) =>
    fetch(`${servers.url}/${repo}/settings/holds`, {
      method: "POST",
      headers: { cookie, origin: servers.url },
      body: new URLSearchParams(body),
      redirect: "manual",
    });
  const formOf = (body: Record<string, string>): Promise<Form> =>
    new Request("http://forge.local/", { method: "POST", body: new URLSearchParams(body) }).formData();
  const ctxAs = (user: User | undefined): Ctx => {
    const url = new URL(`${servers.url}/boards`);
    return { app, request: new Request(url.href), url, auth: { user } } as unknown as Ctx;
  };
  // A page's nonce is fresh on every request and its alternate link echoes
  // the path asked for; neither says whether the repository exists.
  const answer = async (res: Response, asked = "") => ({
    status: res.status,
    location: res.headers.get("location"),
    cookie: res.headers.get("set-cookie"),
    body: (await res.text())
      .replace(/nonce="[^"]*"/g, 'nonce=""')
      .replaceAll(encodeURIComponent(asked), "ASKED"),
  });

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "file-hold-form-"));
    app = createApp({ dataDir: dir, port: 0 });
    alice = await person("alice", true);
    bob = await person("bob");
    servers = await serve(app);
    const a = await createRepo(app, alice, { name: "open", visibility: "public" });
    const b = await createRepo(app, alice, { name: "secret", visibility: "private" });
    if (!a.ok || !b.ok) throw new Error("repos");
    open = a.value;
    secret = b.value;
  });
  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("the settings route holds and releases, and returns to the settings card", async () => {
    const cookie = await cookieOf("alice");
    const held = await post(cookie, "alice/open", { path: "src/a.ts" });
    expect(held.status).toBe(303);
    expect(held.headers.get("location")).toBe("/alice/open/settings#file-holds");
    expect(heldFiles(app.db, open.id).map((h) => h.path)).toEqual(["src/a.ts"]);
    const released = await post(cookie, "alice/open", { verb: "release", path: "src/a.ts" });
    expect(released.status).toBe(303);
    expect(released.headers.get("location")).toBe("/alice/open/settings#file-holds");
    expect(heldFiles(app.db, open.id)).toEqual([]);
  });

  test("over the settings route, a missing and an unreadable repository answer alike", async () => {
    const cookie = await cookieOf("bob");
    for (const body of [{ path: "src/a.ts" }, { verb: "release", path: "src/a.ts" }]) {
      const missing = await answer(await post(cookie, "alice/nowhere", body), "/alice/nowhere/");
      const hidden = await answer(await post(cookie, "alice/secret", body), "/alice/secret/");
      expect(missing.status).toBe(404);
      expect(hidden).toEqual(missing);
    }
    expect(heldFiles(app.db, secret.id)).toEqual([]);
  });

  test("the shared form refuses a missing and an unreadable repository in the same words", async () => {
    const to = "/boards#holds";
    for (const user of [bob, undefined]) {
      const missing = await answer(fileHoldForm(ctxAs(user), await formOf({ path: "src/a.ts" }), undefined, to));
      const hidden = await answer(fileHoldForm(ctxAs(user), await formOf({ path: "src/a.ts" }), secret, to));
      expect(missing.status).toBe(303);
      expect(missing.location).toBe(to);
      expect(decodeURIComponent(missing.cookie ?? "")).toContain("That file could not be held.");
      expect(hidden).toEqual(missing);
      const goneRelease = await answer(
        fileHoldForm(ctxAs(user), await formOf({ verb: "release", path: "src/a.ts" }), undefined, to),
      );
      const hiddenRelease = await answer(
        fileHoldForm(ctxAs(user), await formOf({ verb: "release", path: "src/a.ts" }), secret, to),
      );
      expect(hiddenRelease).toEqual(goneRelease);
    }
    expect(heldFiles(app.db, secret.id)).toEqual([]);
  });
});

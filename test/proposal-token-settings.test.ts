/**
 * Proposal tokens on the repository settings page: mint (secret once), list,
 * revoke (after which a push with it is refused), and who may.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";
import { adminCookie } from "./helpers/admin.ts";

quietLogs();

describe("proposal tokens on the settings page", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let owner = "";
  let stranger = "";

  const form = (fields: Record<string, string>) => new URLSearchParams(fields);

  async function signup(username: string): Promise<string> {
    const res = await fetch(`${base}/signup`, {
      method: "POST",
      body: form({ username, email: `${username}@f.dev`, password: "proposal-password" }),
      redirect: "manual",
    });
    return (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  }

  const post = (cookie: string, path: string, fields: Record<string, string> = {}, origin = base) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { cookie, origin },
      body: form(fields),
      redirect: "manual",
    });

  const settings = (cookie: string) =>
    fetch(`${base}/ada/lib/settings`, { headers: { cookie } }).then((r) => r.text());

  const git = async (args: string[], cwd: string) => {
    const proc = Bun.spawn(["git", "-c", "credential.helper=", ...args], {
      cwd,
      env: {
        PATH: process.env.PATH ?? "",
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        HOME: dataDir,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    await new Response(proc.stdout).text();
    await new Response(proc.stderr).text();
    return proc.exited;
  };

  /** Mint through the form; the secret as the flash after the redirect carries it. */
  async function mint(child: string): Promise<{ secret: string; page: string }> {
    const res = await post(owner, "/ada/lib/settings/proposal-tokens", {
      child,
      origin: "https://kid.example.com/",
    });
    expect(res.status).toBe(303);
    const flash = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
    const page = await fetch(`${base}${res.headers.get("location")}`, {
      headers: { cookie: `${owner}; ${flash}` },
    }).then((r) => r.text());
    const secret = /forge_[A-Za-z0-9_-]+/.exec(page)?.[0] ?? "";
    return { secret, page };
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-proposal-settings-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    owner = await adminCookie(app, { username: "ada", email: "ada@f.dev", password: "proposal-password" });
    stranger = await signup("bob");
    await post(owner, "/new", { name: "lib", visibility: "public", description: "d" });
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("mint shows the secret once, lists the token, and revoke ends its push", async () => {
    const { secret, page } = await mint("kid");
    expect(secret).not.toBe("");
    expect(page).toContain("never shown again");

    // Gone on the next view, but the line stays.
    const after = await settings(owner);
    expect(after).not.toContain(secret);
    expect(after).toContain("kid");
    expect(after).toContain("https://kid.example.com/");
    expect(after).toContain("Revoke");

    const work = join(dataDir, "work");
    await Bun.$`mkdir -p ${work}`.quiet();
    await git(["init", "-q", "-b", "main"], work);
    await Bun.write(join(work, "a.md"), "a\n");
    await git(["add", "."], work);
    await git(["-c", "user.email=k@e.com", "-c", "user.name=k", "commit", "-q", "-m", "a"], work);
    const url = `${base.replace("://", `://child:${secret}@`)}/ada/lib.git`;
    expect(await git(["push", url, "HEAD:refs/heads/child/kid/one"], work)).toBe(0);

    // Follow the button, as a browser would: the confirm page, then its form.
    const link = /href="(\/-\/confirm\?to=[^"]+)"/.exec(after)?.[1];
    expect(link).toBeDefined();
    const confirm = await fetch(`${base}${link!.replaceAll("&amp;", "&")}`, { headers: { cookie: owner } });
    expect(confirm.status).toBe(200);
    const action = /<form method="post" action="([^"]*settings\/proposal-tokens[^"]+)"/.exec(await confirm.text())?.[1];
    expect(action).toContain("/settings/proposal-tokens/");
    expect((await post(owner, action!)).status).toBe(303);
    expect(await git(["push", url, "HEAD:refs/heads/child/kid/two"], work)).not.toBe(0);
    expect(await settings(owner)).not.toContain("https://kid.example.com/");
  });

  test("a bad child or origin mints nothing", async () => {
    const rows = (page: string) => page.match(/<tr>/g)?.length ?? 0;
    const before = rows(await settings(owner));
    for (const fields of [
      { child: "Bad Name", origin: "https://kid.example.com/" },
      { child: "ok", origin: "http://plain.example.com/" },
    ]) {
      const res = await post(owner, "/ada/lib/settings/proposal-tokens", fields);
      expect(res.status).toBe(303);
      const flash = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
      const shown = await fetch(`${base}${res.headers.get("location")}`, {
        headers: { cookie: `${owner}; ${flash}` },
      }).then((r) => r.text());
      expect(shown).not.toContain("never shown again");
      expect(shown).toMatch(/lowercase words|https address/);
    }
    expect(rows(await settings(owner))).toBe(before);
  });

  test("a cross-origin POST is refused", async () => {
    const res = await post(owner, "/ada/lib/settings/proposal-tokens", { child: "x", origin: "https://x.example.com/" }, "https://evil.example");
    expect(res.status).toBe(403);
  });

  test("a non-writer sees no section and their POSTs are 403", async () => {
    expect(await settings(stranger)).not.toContain("Proposal tokens");
    expect(await settings(owner)).toContain("Proposal tokens");
    const mintRes = await post(stranger, "/ada/lib/settings/proposal-tokens", { child: "x", origin: "https://x.example.com/" });
    expect(mintRes.status).toBe(403);
    const { secret } = await mint("keep");
    expect(secret).not.toBe("");
    const id = /proposal-tokens\/([^/"]+)\/delete/.exec(await settings(owner))?.[1];
    expect((await post(stranger, `/ada/lib/settings/proposal-tokens/${id}/delete`)).status).toBe(403);
    expect(await settings(owner)).toContain("keep");
  });
});

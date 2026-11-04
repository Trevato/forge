/**
 * Settings' refused submits draw the shared danger toast with role="alert",
 * not the retired page-local `.error-note` (#9085): the notify URL, the
 * profile's form-level refusal and a new SSH key.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

describe("account refusals", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let cookie: string;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-account-refusals-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const made = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-long-passphrase",
      adminIfFirst: true,
    });
    if (!made.ok) throw new Error(made.error);
    const signin = await fetch(`${servers.url}/signin`, {
      method: "POST",
      body: new URLSearchParams({ username: "alice", password: "a-long-passphrase" }),
      redirect: "manual",
    });
    cookie = signin.headers.get("set-cookie")!.split(";")[0]!;
  });
  afterAll(async () => {
    servers.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  const refuse = async (path: string, form: Record<string, string>) => {
    const res = await fetch(`${servers.url}${path}`, {
      method: "POST",
      headers: { cookie },
      body: new URLSearchParams(form),
      redirect: "manual",
    });
    expect(res.status).toBe(422);
    return res.text();
  };

  /** The words sit inside a danger toast that announces itself. */
  const inAlert = (page: string, words: string) => {
    const toast = page.match(
      /<div class="toast" data-tone="danger" role="alert">([\s\S]*?)<\/div>\s*<\/div>/,
    );
    expect(toast).not.toBeNull();
    expect(toast![1]).toContain(words);
    expect(page).not.toContain("error-note");
  };

  test("a refused notify URL", async () => {
    inAlert(await refuse("/settings/notify", { url: "http://ntfy.example.test/t" }), "Only https:");
  });

  test("a refused profile with nothing a field is at fault for", async () => {
    const page = await refuse("/settings", {
      displayName: "Alice",
      email: "alice@forge.local",
      commitEmail: "<b>bogus</b>",
    });
    inAlert(page, "Your profile could not be saved.");
    expect(page).not.toContain("<b>bogus</b>");
  });

  test("a refused SSH key", async () => {
    inAlert(await refuse("/settings/keys", { name: "bad", key: "nonsense" }), "supported public key");
  });
});

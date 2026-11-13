import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { sshCommand } from "../src/ssh/command.ts";
import { adminCookie } from "./helpers/admin.ts";

describe("sshCommand", () => {
  test("is undefined without a listener, and names host and port with one", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "forge-sshcmd-"));
    const app = createApp({ dataDir, port: 0, host: "forge.example" });
    try {
      expect(sshCommand(app)).toBeUndefined();
      app.config.sshPort = 2222;
      expect(sshCommand(app)).toBe("ssh -p 2222 forge.example");
      expect(sshCommand(app, "notes")).toBe("ssh -p 2222 notes@forge.example");
      app.config.sshPort = 22;
      expect(sshCommand(app)).toBe("ssh forge.example");
    } finally {
      app.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test("falls back to the public URL's host when no host is configured", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "forge-sshcmd-"));
    const app = createApp({ dataDir, port: 0, url: "https://forge.example" });
    try {
      app.config.sshPort = 2222;
      expect(sshCommand(app)).toBe("ssh -p 2222 forge.example");
    } finally {
      app.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

describe("the terminal on the website", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let cookie = "";

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-ssh-site-"));
    app = createApp({ dataDir, port: 0, host: "forge.example" });
    app.config.sshPort = 2222;
    app.config.sshHostKey =
      "SHA256:abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
    servers = await serve(app);
    base = servers.url;
    cookie = `${await adminCookie(app, { username: "ada", email: "ada@forge.example", password: "analytical-engine" })}; forge_mode=dev`;
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("the landing page does not offer ssh to a stranger: there is no way to get a forge from it yet", async () => {
    const page = await fetch(`${base}/`).then((r) => r.text());
    expect(page).not.toContain("ssh -p 2222");
  });

  test("the dashboard has a Terminal card, with the host key", async () => {
    const page = await fetch(`${base}/feed`, { headers: { cookie } }).then((r) =>
      r.text(),
    );
    expect(page).toContain("<h2>Terminal</h2>");
    expect(page).toContain("ssh -p 2222 forge.example");
    expect(page).toContain("host key SHA256:abcdefghijklmnopqrstuvwxyz");
  });

  test("the keys page leads with the command", async () => {
    const page = await fetch(`${base}/settings/keys`, {
      headers: { cookie },
    }).then((r) => r.text());
    expect(page).toContain("ssh -p 2222 forge.example");
    expect(page).toContain("host key SHA256:");
    expect(page).not.toContain("terminal-line");
    expect(page).toContain('id="terminal"');
    expect(page).toContain('<code class="mono break">');
  });

  test("the dashboard's Terminal card has no terminal-line, keeps the keys link", async () => {
    const page = await fetch(`${base}/feed`, { headers: { cookie } }).then((r) =>
      r.text(),
    );
    expect(page).not.toContain("terminal-line");
    expect(page).toContain('<a class="small" href="/settings/keys">Computer keys</a>');
    expect(page).toContain("host key SHA256:");
  });

  test("the crew form picks a model from a list", async () => {
    const page = await fetch(`${base}/settings/crew`, {
      headers: { cookie },
    }).then((r) => r.text());
    const select = page.match(
      /<select\b[^>]*\bname="model"[^>]*>([\s\S]*?)<\/select>/,
    );
    expect(select).not.toBeNull();
    const values = [...(select?.[1] ?? "").matchAll(/<option\b[^>]*\bvalue="([^"]*)"/g)].map(
      (m) => m[1],
    );
    expect(values).toContain("opus");
    expect(values).toContain("sonnet");
    expect(values).toContain("haiku");
  });
});

describe("the front page without a terminal", () => {
  test("prints nothing about it and carries no hero classes", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "forge-ssh-off-"));
    const app = createApp({ dataDir, port: 0, host: "forge.example" });
    const servers = await serve(app);
    try {
      const page = await fetch(`${servers.url}/`).then((r) => r.text());
      expect(page).toContain("Software for what you");
      expect(page).toContain('href="/signup"');
      expect(page).not.toContain("terminal-line");
      expect(page).not.toContain("terminal is off");
      expect(page).not.toContain("hero-terminal");
    } finally {
      servers.stop();
      app.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

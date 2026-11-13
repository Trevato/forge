/** The public home shows the ssh command, the host key fingerprint, once. */
import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { serve } from "../src/http/server.ts";

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

async function home(sshPort?: number, fingerprint?: string) {
  const dataDir = await mkdtemp(join(tmpdir(), "forge-door-fp-"));
  dirs.push(dataDir);
  const app = createApp({ dataDir, port: 0, host: "forge.example" });
  if (sshPort !== undefined) app.config.sshPort = sshPort;
  if (fingerprint !== undefined) app.config.sshHostKey = fingerprint;
  const servers = await serve(app);
  try {
    return { text: await (await fetch(`${servers.url}/`)).text() };
  } finally {
    servers.stop();
    app.close();
  }
}

test("a stranger sees the fingerprint, once", async () => {
  const fp = "SHA256:abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
  const { text } = await home(2222, fp);
  expect(text).toContain(`host key ${fp}`);
  expect(text.split(`host key ${fp}`).length).toBe(2);
  expect(text).not.toContain("ssh-keyscan");
});

test("with the terminal off there is no fingerprint", async () => {
  const { text } = await home();
  expect(text).not.toContain("ssh-keyscan");
  expect(text).not.toContain("host key SHA256");
});

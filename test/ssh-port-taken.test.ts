/**
 * The terminal is optional, the forge is not: a taken SSH port turns the
 * terminal off with one warning and the web keeps answering.
 */

import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { startForgeSsh } from "../src/tui/ssh.ts";

test("startForgeSsh returns an Err instead of throwing when the port is taken", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "forge-sshtaken-"));
  const squatter = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data() {} },
  });
  const forge = createApp({ dataDir, port: 0 });
  try {
    const r = await startForgeSsh(forge, {
      port: squatter.port,
      hostname: "127.0.0.1",
    });
    expect(r.ok).toBe(false);
    expect(forge.config.sshPort).toBeUndefined();
  } finally {
    squatter.stop(true);
    forge.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("main.ts keeps serving / when the SSH port is taken", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "forge-sshboot-"));
  const squatter = Bun.listen({
    hostname: "0.0.0.0",
    port: 0,
    socket: { data() {} },
  });
  const web = 20000 + Math.floor(Math.random() * 20000);
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    FORGE_DATA: dataDir,
    PORT: String(web),
    FORGE_SSH_PORT: String(squatter.port),
    FORGE_APPS: "0",
  };
  delete env.FORGE_URL;
  const proc = Bun.spawn(["bun", "run", "src/main.ts"], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    let status = 0;
    for (let i = 0; i < 100 && status === 0; i++) {
      try {
        status = (await fetch(`http://127.0.0.1:${web}/`)).status;
      } catch {
        await Bun.sleep(100);
      }
    }
    expect(status).toBe(200);
  } finally {
    proc.kill();
    await proc.exited;
    squatter.stop(true);
    await rm(dataDir, { recursive: true, force: true });
  }
});

/**
 * A handed-over port takes its kept-alive connections with it (#11682).
 * `stopAccepting` closes the old forge's listener, but a connection opened
 * before (a router's pool) was still answered by the old process for the
 * whole drain, so the public URL kept answering as the old version and the
 * release proof gave up. Now the old forge's next answer on such a
 * connection says `connection: close`, and the client's redial reaches the
 * release.
 */

import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { createUser } from "../src/core/users.ts";
import { serve } from "../src/http/server.ts";

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

test("after stopAccepting, a kept-alive connection is closed after one answer and the next request reaches the release", async () => {
  const oldDir = await mkdtemp(join(tmpdir(), "forge-keepalive-old-"));
  const newDir = await mkdtemp(join(tmpdir(), "forge-keepalive-new-"));
  dirs.push(oldDir, newDir);
  // Only the old forge knows alice, so an answer says which forge gave it.
  const oldApp = createApp({ dataDir: oldDir, port: 0, selfSwap: true });
  const oldServers = await serve(oldApp);
  const made = await createUser(oldApp.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "a@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  expect(made.ok).toBe(true);
  const url = `http://127.0.0.1:${oldServers.port}/api/v1/users/alice`;
  const ask = async () => {
    const res = await fetch(url, { signal: AbortSignal.timeout(3_000) });
    await res.arrayBuffer();
    return { status: res.status, connection: res.headers.get("connection") };
  };

  // Warm a kept-alive connection while the old forge is the only listener.
  for (let i = 0; i < 3; i++) expect((await ask()).status).toBe(200);

  const newApp = createApp({ dataDir: newDir, port: oldServers.port, selfSwap: true });
  const newServers = await serve(newApp);
  const drained = oldServers.stopAccepting(5_000);

  // The old forge answers what was already its connection once more, and ends it.
  const last = await ask();
  expect(last.status).toBe(200);
  expect(last.connection).toBe("close");
  // Every request after that is the release's.
  for (let i = 0; i < 5; i++) expect((await ask()).status).toBe(404);

  await drained;
  oldServers.stop();
  newServers.stop();
  oldApp.close();
  newApp.close();
}, 20_000);

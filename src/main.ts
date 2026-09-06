/**
 * Boot. `bun run src/main.ts` and the forge is up: data directory ensured,
 * schema migrated, all three listeners live. Configuration is
 * environment-only — a handful of variables, all with sane defaults.
 */

import { createApp } from "./app.ts";
import { reconcile } from "./core/reconcile.ts";
import { pruneSessions } from "./core/sessions.ts";
import { runDelivery } from "./core/webhooks.ts";
import { isHookName, runHookClient } from "./git/hooks.ts";
import { serve } from "./http/server.ts";
import { runSync } from "./origins/sync.ts";
import { serveForgeSsh } from "./tui/ssh.ts";

// `forge hook <name>` re-enters here from a git hook stub. It relays to the
// running forge over its socket and exits — it must never boot a server.
if (process.argv[2] === "hook") {
  const name = process.argv[3];
  if (!isHookName(name)) {
    console.error(`forge: unknown hook ${name}`);
    process.exit(1);
  }
  await runHookClient(name);
}

// SSH is on by default: the terminal UI is a first-class surface, not an
// add-on. `FORGE_SSH_PORT=0` turns the listener off entirely.
const sshPort = Number(process.env.FORGE_SSH_PORT ?? 2222);

// FORGE_URL is the address people reach the forge at when a proxy in front
// terminates TLS. Parsed once here so a typo fails the boot, not a request.
const canonicalUrl = (process.env.FORGE_URL ?? "").trim();

const app = createApp({
  dataDir: process.env.FORGE_DATA ?? "data",
  port: Number(process.env.PORT ?? 3000),
  ...(process.env.FORGE_HOST === undefined
    ? {}
    : { host: process.env.FORGE_HOST }),
  ...(canonicalUrl === "" ? {} : { url: new URL(canonicalUrl).origin }),
});

await reconcile(app);
const servers = await serve(app);
const ssh =
  sshPort > 0 ? await serveForgeSsh(app, { port: sshPort }) : undefined;

// The webhook delivery worker: poll the outbox for due deliveries. The event
// row is the source of truth, so a missed tick only delays delivery, never
// loses it. runDelivery never throws into the timer.
// Expired sessions ride the same tick: a cheap DELETE, never worth a worker.
const deliveryTimer = setInterval(() => {
  runDelivery(app.db, app.log);
  pruneSessions(app.db);
}, 5_000);
runDelivery(app.db, app.log); // sweep anything queued while we were down
pruneSessions(app.db);

// The origin sync worker, on its own slower tick. Mirrors are polled, not
// pushed to: an origin is due every ten minutes by default, and the tick only
// asks who is due — so this costs one indexed read a minute when nothing is
// connected. Like runDelivery, runSync never throws into the timer.
const syncTimer = setInterval(() => runSync(app), 60_000);
runSync(app); // one pass on boot: a forge that was down has fetching to do

app.log.info("forge is up", { url: servers.url, data: app.config.dataDir });
if (ssh)
  // The host key fingerprint on boot is what an operator compares against the
  // one their client prints on first connect.
  app.log.info("ssh is up", {
    port: ssh.port,
    hostKey: ssh.hostKey.fingerprint,
  });

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function shutdown(): void {
  app.log.info("forge shutting down");
  clearInterval(deliveryTimer);
  clearInterval(syncTimer);
  ssh?.stop();
  servers.stop();
  app.close();
  process.exit(0);
}

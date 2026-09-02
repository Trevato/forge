/**
 * Boot. `bun run src/main.ts` and the forge is up: data directory ensured,
 * schema migrated, both listeners live. Configuration is environment-only —
 * two variables, both with sane defaults.
 */

import { createApp } from "./app.ts";
import { reconcile } from "./core/reconcile.ts";
import { pruneSessions } from "./core/sessions.ts";
import { runDelivery } from "./core/webhooks.ts";
import { isHookName, runHookClient } from "./git/hooks.ts";
import { serve } from "./http/server.ts";

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

const app = createApp({
  dataDir: process.env.FORGE_DATA ?? "data",
  port: Number(process.env.PORT ?? 3000),
});

await reconcile(app);
const servers = await serve(app);

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

app.log.info("forge is up", { url: servers.url, data: app.config.dataDir });

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function shutdown(): void {
  app.log.info("forge shutting down");
  clearInterval(deliveryTimer);
  servers.stop();
  app.close();
  process.exit(0);
}

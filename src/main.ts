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
import { AppsRuntime } from "./apps/runtime.ts";
import { resolveAppDomain } from "./apps/host.ts";
import { startChecks } from "./checks/service.ts";
import { startLooks } from "./looks/service.ts";
import { startProbes } from "./contract/probes.ts";
import { startSnapshots } from "./snapshot/service.ts";
import { resolveDestination } from "./snapshot/destination.ts";
import { CHECK_KINDS, failAbandonedRuns } from "./core/runs.ts";
import { health } from "./http/health.ts";
import { STALE_AFTER_MS } from "./runs/lease.ts";
import { startCrew } from "./crew/dispatch.ts";
import { typeSafeDecider } from "./crew/decide.ts";
import { graphInstagram } from "./crew/instagram.ts";
import { startNotifier } from "./crew/notify.ts";
import { startPromptRoutine } from "./crew/prompts.ts";
import { pruneTokens } from "./core/tokens.ts";

// `forge hook <name>` re-enters here from a git hook stub. It relays to the
// running forge over its socket and exits — it must never boot a server.
if (process.argv[2] === "hook") {
  const name = process.argv[3];
  if (!isHookName(name)) {
    // CLI message on stderr for the person at the terminal.
    console.error(`forge: unknown hook ${name}`);
    process.exit(1);
  }
  await runHookClient(name);
}

// A forge can be an app of a forge (docs/APPS.md, "The forge as an app of
// itself"). The host's `FORGE_APP_*` say where this one lives and what it
// answers to; `FORGE_URL` there names the host, not this forge. Hosted, the
// defaults change to what fits inside another: no SSH listener (the host
// owns the port), app hostnames nested under this forge's own, one agent at
// a time. Anything set explicitly still wins.
const hostedAt = (process.env.FORGE_APP_URL ?? "").trim();
const hosted = hostedAt !== "";

// SSH is on by default: the terminal UI is a first-class surface, not an
// add-on. `FORGE_SSH_PORT=0` turns the listener off entirely.
const sshPort = Number(process.env.FORGE_SSH_PORT ?? (hosted ? 0 : 2222));

// FORGE_URL is the address people reach the forge at when a proxy in front
// terminates TLS. Parsed once here so a typo fails the boot, not a request.
const canonicalUrl = hosted ? hostedAt : (process.env.FORGE_URL ?? "").trim();
// FORGE_EDGE_TOKEN is the platform edge's secret: with it, the edge's
// identity headers sign people in; without it they are ignored.
const edgeToken = (process.env.FORGE_EDGE_TOKEN ?? "").trim();

const app = createApp({
  dataDir:
    process.env.FORGE_DATA ??
    (hosted ? process.env.FORGE_APP_DATA : undefined) ??
    "data",
  port: Number(process.env.PORT ?? 3000),
  ...(process.env.FORGE_HOST === undefined
    ? {}
    : { host: process.env.FORGE_HOST }),
  ...(canonicalUrl === "" ? {} : { url: new URL(canonicalUrl).origin }),
  ...(edgeToken === "" ? {} : { edgeToken }),
  // The one knob on the crew's bill: FORGE_CREW_CEILING_USD, dollars a day
  // across every repository. Unset is no forge-wide ceiling.
  ...(process.env.FORGE_MIGRATE_PRIVATE_HOSTS === "1"
    ? { migrateFromPrivateHosts: true }
    : {}),
  ...(Number(process.env.FORGE_CREW_CEILING_USD) > 0
    ? { crewCeilingUsd: Number(process.env.FORGE_CREW_CEILING_USD) }
    : {}),
  ...((process.env.FORGE_EDGE_NAME ?? "").trim() === ""
    ? {}
    : { edgeName: (process.env.FORGE_EDGE_NAME ?? "").trim() }),
  // TYPESAFE_API_KEY makes TypeSafe's Jev the forge's decider: fixed-choice
  // questions get calibrated answers instead of the rules'. Without it the
  // rules answer, as ever.
  ...((process.env.TYPESAFE_API_KEY ?? "").trim() === ""
    ? {}
    : {
        decider: typeSafeDecider({
          apiKey: (process.env.TYPESAFE_API_KEY ?? "").trim(),
          url: process.env.TYPESAFE_URL,
          model: process.env.TYPESAFE_MODEL,
        }),
      }),
});

await reconcile(app);
const servers = await serve(app);
const ssh =
  sshPort > 0 ? await serveForgeSsh(app, { port: sshPort }) : undefined;

// Apps and the crew (docs/APPS.md). Both are on unless FORGE_APPS=0: an app
// is served by Host on the same port, and the crew runs agents as child
// processes. The public URL is what apps and agents are told about the
// forge; FORGE_URL when the operator set one, the host and port otherwise.
const host = app.config.host ?? "localhost";
const forgeUrl =
  (hosted ? hostedAt : process.env.FORGE_URL)?.replace(/\/+$/, "") ??
  `http://${host}:${servers.port}`;
const publicUrl = new URL(forgeUrl);
const appsOn = process.env.FORGE_APPS !== "0";
// The host apps answer at is checked once, here: an IP-addressed forge
// hands out a hostname no URL can hold once a slug attaches to it, and an
// app that parses its own FORGE_APP_URL (the scaffold does) dies before it
// answers — every deploy, forever. docs/APPS.md, "Hostnames and the proxy".
const appDomain = appsOn
  ? resolveAppDomain({
      explicit: (process.env.FORGE_APP_DOMAIN ?? "").trim() || undefined,
      hosted,
      hostname: publicUrl.hostname,
    })
  : undefined;
if (appDomain?.ok === false) app.log.error(appDomain.reason);
if (appDomain?.ok === true && appDomain.note !== undefined)
  app.log.warn(appDomain.note);
// One crew run's length: what a run takes, and how long past its idle
// window an app busy with one is left awake.
const crewRunMs = positive(process.env.FORGE_CREW_TIMEOUT_MIN, 45) * 60_000;
const apps = appDomain?.ok
  ? new AppsRuntime(app, {
      domain: appDomain.domain,
      scheme: publicUrl.protocol === "https:" ? "https" : "http",
      publicPort:
        publicUrl.port === ""
          ? publicUrl.protocol === "https:"
            ? 443
            : 80
          : Number(publicUrl.port),
      forgeUrl,
      concurrency: positive(process.env.FORGE_APPS_CONCURRENCY, 2),
      busyGraceMs: crewRunMs,
    })
  : undefined;
await apps?.start();
// A repository's own check, on every push a pull or the default branch takes.
const checks =
  process.env.FORGE_CHECKS === "0"
    ? undefined
    : startChecks(app, {
        forgeUrl,
        concurrency: positive(process.env.FORGE_CHECKS_CONCURRENCY, 1),
      });
// The look: a picture of every environment that comes up green, taken
// through this forge's own listener.
const looks = appsOn ? startLooks(app, { localUrl: servers.url }) : undefined;
// Is it so: the forge knocks on every door of an app with a contract after
// each production deploy and once a night, and compares with the table.
const probes = apps === undefined ? undefined : startProbes(app, apps);
// The snapshot: everything that cannot be rebuilt, nightly, to what an
// operator sealed on the Backups page, else the platform's (`S3_*`) or a
// directory (`FORGE_SNAPSHOT_DIR`). A forge given none says so on that page.
const VERSION =
  ((await import("../package.json")) as { version?: string }).version ?? "0";
const snapshots = startSnapshots(
  app,
  () =>
    resolveDestination({
      db: app.db,
      dataDir: app.config.dataDir,
      bus: app.bus,
    })?.store,
  {
    version: VERSION,
    passphrase: process.env["FORGE_SNAPSHOT_PASSPHRASE"] || undefined,
  },
);
const crew = appsOn
  ? await startCrew(app, {
      forgeUrl,
      localUrl: servers.url,
      binary: process.env.FORGE_CLAUDE ?? "claude",
      concurrency: positive(process.env.FORGE_CREW_CONCURRENCY, hosted ? 1 : 2),
      budgetUsd: Number(process.env.FORGE_CREW_BUDGET_USD) || 5,
      runTimeoutMs: crewRunMs,
      allowHosts: (process.env.FORGE_CREW_ALLOW_HOSTS ?? "")
        .split(",")
        .map((h) => h.trim())
        .filter((h) => h !== ""),
      ...(process.env.FORGE_CLAUDE_CONFIG_DIR === undefined
        ? {}
        : { configDir: process.env.FORGE_CLAUDE_CONFIG_DIR }),
    })
  : undefined;
// Prompts from Instagram (docs/APPS.md): once a day, for each repository
// that connected an account, the top comment on its latest Reel is told to
// the crew. A minute's clock; nothing leaves the box until a source exists.
const prompts = startPromptRoutine(app, { client: graphInstagram() });
// What newly asks a person reaches the phone they chose (docs/APPS.md).
const notifier = startNotifier(app, { forgeUrl });

// The webhook delivery worker: poll the outbox for due deliveries. The event
// row is the source of truth, so a missed tick only delays delivery, never
// loses it. runDelivery never throws into the timer.
// Expired sessions and run tokens ride the same tick: cheap DELETEs, never
// worth a worker.
const deliveryTimer = setInterval(() => {
  runDelivery(app.db, app.log);
  pruneSessions(app.db);
  pruneTokens(app.db);
}, 5_000);
runDelivery(app.db, app.log); // sweep anything queued while we were down
pruneSessions(app.db);
pruneTokens(app.db);

function positive(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

// The origin sync worker, on its own slower tick. Mirrors are polled, not
// pushed to: an origin is due every ten minutes by default, and the tick only
// asks who is due — so this costs one indexed read a minute when nothing is
// connected. Like runDelivery, runSync never throws into the timer.
const syncTimer = setInterval(() => runSync(app), 60_000);
runSync(app); // one pass on boot: a forge that was down has fetching to do

app.log.info("forge is up", { url: servers.url, data: app.config.dataDir });
if (apps)
  app.log.info("apps are up", {
    domain: apps.options.domain,
    example: apps.urlFor(
      { slug: "hello" } as Parameters<typeof apps.urlFor>[0],
      "production",
    ),
  });
if (crew)
  app.log.info(crew.ready ? "crew is ready" : "crew is not ready", {
    detail: crew.detail,
  });
if (ssh)
  // The host key fingerprint on boot is what an operator compares against the
  // one their client prints on first connect.
  app.log.info("ssh is up", {
    port: ssh.port,
    hostKey: ssh.hostKey.fingerprint,
  });

// A run whose forge died is noticed by whichever forge is up, on boot and
// on the way: an old process finishing beside a new one keeps its runs alive
// by renewing their leases, so only a lapsed lease is a death. Deploys and
// checks are failed; agent runs are the crew's to queue again, unless there
// is no crew here to do it.
const leaseTimer = setInterval(
  () =>
    failAbandonedRuns(
      app.db,
      STALE_AFTER_MS,
      crew === undefined ? undefined : CHECK_KINDS,
    ),
  30_000,
);

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

let draining = false;

/**
 * A release does not drop a session. On SIGTERM this process stops taking
 * new work — readiness says so, and the platform already routes new
 * connections to the process that replaced it — lets the crew's runs in
 * flight finish and land, stops the apps and the checks, and keeps serving
 * whoever is connected over SSH until they leave. Only then does it go.
 */
function shutdown(): void {
  if (draining) return;
  draining = true;
  health.draining = true;
  const sessions = ssh?.sessions() ?? 0;
  app.log.info("forge draining", { sshSessions: sessions });
  clearInterval(deliveryTimer);
  clearInterval(syncTimer);
  clearInterval(leaseTimer);
  Promise.all([
    prompts.stop(),
    notifier.stop(),
    crew?.stop({ drain: true }),
    apps?.stop(),
    checks?.stop(),
    looks?.stop(),
    probes?.stop(),
    snapshots.stop(),
  ])
    .catch(() => {})
    .then(() => {
      if (sessions > 0)
        app.log.info("forge waiting for ssh sessions to end", {
          sshSessions: sessions,
        });
      return ssh?.drain();
    })
    .catch(() => {})
    .finally(() => {
      app.log.info("forge shutting down");
      ssh?.stop();
      servers.stop();
      app.close();
      process.exit(0);
    });
}

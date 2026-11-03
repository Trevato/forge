/**
 * Boot. `bun run src/main.ts` and the forge is up: data directory ensured,
 * schema migrated, all three listeners live. Configuration is
 * environment-only — a handful of variables, all with sane defaults.
 */

import { runModelReview } from "./actions/model_review.ts";
import { getRepoById } from "./core/repos.ts";
import { plannedRepoIds, tickWeeks } from "./flow/retro.ts";
import { BOOT_ACTOR, setSignup, signupFromEnv } from "./settings/signup.ts";
import { startMemorySampler } from "./boards/memory.ts";
import { startSampler } from "./boards/sampler.ts";
import { sweepStanding } from "./crew/standing.ts";
import { drainOnHandover, handover } from "./release/swap.ts";
import { parentUrlProblem } from "./core/parent_releases.ts";
import { releaseEnv } from "./release/env.ts";
import { createApp } from "./app.ts";
import { warmFlow } from "./system/flow_cache.ts";
import { backfillCarried } from "./core/carried.ts";
import { loadTrustedHosts } from "./origins/trusted-hosts.ts";
import { flushFlagUses, loadFlags } from "./core/flags.ts";
import { reconcile } from "./core/reconcile.ts";
import { offerStartingBoards } from "./actions/boards.ts";
import { syncAllPillars } from "./actions/pillars.ts";
import { bootHostedChildren } from "./spawn/host.ts";
import { firstBoot } from "./spawn/first-boot.ts";
import { previewIdentityKey } from "./spawn/preview-owner.ts";
import { PREVIEW_ADMIN, seedPreview } from "./spawn/preview-seed.ts";
import { startHeartbeat } from "./spawn/heartbeat.ts";
import { startUpstreamWatch } from "./spawn/upstream.ts";
import { startReachWatch } from "./spawn/reach.ts";
import { pruneSessions } from "./core/sessions.ts";
import { runDelivery } from "./core/webhooks.ts";
import { isHookName, runHookClient } from "./git/hooks.ts";
import { drainBudgets } from "./drain.ts";
import { drainStreams } from "./http/sse.ts";
import { serve } from "./http/server.ts";
import { checkDue } from "./actions/upstream_follow.ts";
import { runSync } from "./origins/sync.ts";
import { startForgeSsh } from "./tui/ssh.ts";
import { AppsRuntime } from "./apps/runtime.ts";
import { listApps } from "./core/apps.ts";
import { holdAppHosts, releaseAppHosts } from "./apps/holding.ts";
import { resolveAppDomain } from "./apps/host.ts";
import { LAND_SETTLE_MS, requeueAbandonedChecks, startChecks } from "./checks/service.ts";
import { VERIFY_EVERY_MS } from "./checks/verify.ts";
import { RED_HOLD_MS } from "./checks/red_main.ts";
import { stopQueue } from "./checks/queue.ts";
import { startLooks } from "./looks/service.ts";
import { startMirrorOut } from "./origins/mirror-out.ts";
import { startProbes } from "./contract/probes.ts";
import { startNightly } from "./nightly/service.ts";
import { startSnapshots } from "./snapshot/service.ts";
import { resolveDestination } from "./snapshot/destination.ts";
import { resolveMirror } from "./snapshot/mirror.ts";
import { releaseOrphans } from "./core/run_secret.ts";
import { failAbandonedRuns } from "./core/runs.ts";
import { DRAIN_LINGER_MAX_S, drainLingerMs, startDraining } from "./http/health.ts";
import { takePresence, warmBehind } from "./apps/presence.ts";
import { STALE_AFTER_MS } from "./runs/lease.ts";
import { startCrew, sweepAssigned } from "./crew/dispatch.ts";
import { configureConversation, resumeInterrupted } from "./crew/conversation.ts";
import { CREW_OFF_IN_PREVIEW, crewOffInPreview } from "./crew/preview.ts";
import { typeSafeDecider } from "./crew/decide.ts";
import { graphInstagram } from "./crew/instagram.ts";
import { peopleOnCrews } from "./core/agents.ts";
import { startNotifier } from "./crew/notify.ts";
import { expireCrewHolds } from "./actions/holds.ts";
import { startClogTick } from "./flow/clog_tick.ts";
import { startKeeper } from "./flow/keeper.ts";
import { sweepStaleAsks } from "./crew/stale_asks.ts";
import { recordAskLedger } from "./web/studio/asks.ts";
import { startPromptRoutine } from "./crew/prompts.ts";
import { pruneTokens } from "./core/tokens.ts";
import { configProblem, dataDirOf, preflight } from "./kernel/preflight.ts";
import { running } from "./kernel/version.ts";
import { record as recordDegraded } from "./kernel/degraded_history.ts";
import { vitals } from "./kernel/vitals.ts";
import { proveRunning } from "./release/prove.ts";
import { CHECK_EVERY_MS, setBehind, watchBehind } from "./release/behind.ts";
import { readLandings } from "./release/landings.ts";
import { ownTagsReader } from "./release/own_tags.ts";
import { rollProbe, tick as keeperTick } from "./keeper/keeper.ts";
import { keeperEnv, keeperPorts } from "./keeper/wire.ts";
import { snapshotPlace } from "./actions/health.ts";
import { capacityDefault } from "./core/capacity.ts";
import { bootCounts, recordBoot, recordCleanExit } from "./kernel/boots.ts";
import { census, censusWords, processRows } from "./kernel/census.ts";
import { reapLeftoverBridges } from "./crew/leftovers.ts";
import { crewRoot } from "./crew/workdir.ts";
import { createLog } from "./kernel/log.ts";
import { watchStalls } from "./kernel/loop_lag.ts";
import { startPerfWatcher, TICK_MS } from "./perf/duty.ts";
import { stallLine } from "./perf/loop.ts";
import { bootStall, gitRecord, loopWatch, perfRecord } from "./perf/live.ts";
import { timeStatements } from "./kernel/slow_sql.ts";
import { waitForPeer } from "./runs/peer.ts";

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

// `--preflight` asks whether this tree can boot and answers in one line:
// config parsed, migrations run on a copy of the database. No socket, no
// timers, and the live database is never opened.
if (process.argv.includes("--preflight")) {
  const { migrationFiles } = await import("./core/schema.ts");
  const result = preflight(process.env, import.meta.dir, migrationFiles);
  // CLI answer on the stream a person or a script reads.
  (result.ok ? console.log : console.error)(result.line);
  process.exit(result.ok ? 0 : 1);
}

// `--rollback <sha>` starts a kept release beside the running forge and
// exits once it reads healthy as that sha (release/rollback.ts).
if (process.argv[2] === "--rollback") {
  const { rollback } = await import("./release/rollback.ts");
  const port = Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`PORT must be a port number, not ${JSON.stringify(process.env.PORT ?? "").slice(0, 40)}`);
    process.exit(1);
  }
  const result = await rollback({
    dataDir: dataDirOf(process.env),
    sha: process.argv[3] ?? "",
    port,
    env: process.env,
  });
  // CLI answer on the stream a person or a script reads.
  if (result.ok) console.log(`rolled back: pid ${result.pid} is healthy; the previous forge is still running on the port, stop it yourself`);
  else console.error(result.line);
  process.exit(result.ok ? 0 : 1);
}

// `--first-admin` mints a one-time code that makes the first admin of a
// forge with none, printed to this terminal only (core/first_admin.ts).
if (process.argv[2] === "--first-admin") {
  const { firstAdminCli } = await import("./core/first_admin_cli.ts");
  const answer = firstAdminCli(process.argv.slice(3), process.env);
  // CLI answer on the streams the operator reads; never the forge's log.
  for (const line of answer.out) console.log(line);
  for (const line of answer.err) console.error(line);
  process.exit(answer.exit);
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

const dataDir = dataDirOf(process.env);
// One answer for boot and `--preflight` (kernel/preflight.ts): the data
// directory is not the tree itself (#622: a database or a host key there is
// one `git add -A` from every clone), FORGE_TRUSTED_PROXIES parses (a typo
// fails the boot, not a limit that quietly counts every stranger as one),
// and the forge's URL is one.
const problem = configProblem(process.env, import.meta.dir);
if (problem !== null) {
  console.error(problem);
  process.exit(1);
}

// FORGE_DRAIN_LINGER_S: seconds a SIGTERM'd forge keeps answering while
// routers learn it is going (`http/health.ts`).
const lingerMs = drainLingerMs(process.env.FORGE_DRAIN_LINGER_S);
if (lingerMs === null) {
  console.error(
    `FORGE_DRAIN_LINGER_S: whole seconds from 0 to ${DRAIN_LINGER_MAX_S}, not "${(process.env.FORGE_DRAIN_LINGER_S ?? "").slice(0, 20)}"`,
  );
  process.exit(1);
}

const trustedProxies = (process.env.FORGE_TRUSTED_PROXIES ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter((s) => s !== "");

// The secret and the widget's site key come together or not at all: a secret
// alone would refuse every signup on a page that cannot show the widget.
const turnstileSecret = (process.env.FORGE_TURNSTILE_SECRET ?? "").trim();
const turnstileSiteKey = (process.env.FORGE_TURNSTILE_SITEKEY ?? "").trim();
if (turnstileSecret !== "" && turnstileSiteKey === "") {
  console.error("FORGE_TURNSTILE_SECRET needs FORGE_TURNSTILE_SITEKEY: the signup page needs the widget");
  process.exit(1);
}

const parentUrl = (process.env.FORGE_PARENT_URL ?? "").trim();
const parentProblem = parentUrl === "" ? null : parentUrlProblem(parentUrl);
if (parentProblem !== null) {
  console.error(`FORGE_PARENT_URL: ${parentProblem}`);
  process.exit(1);
}

// The loop's lateness, from the first line of the boot: a stall over a
// second is a warning that names its minute (kernel/loop_lag.ts, #6957),
// draining included.
const loopLog = createLog("loop");
watchStalls(loopLog, undefined, undefined, undefined, (late, at) => {
  bootStall.note(late, at);
  const stall = loopWatch.stalled(late, at);
  if (stall !== null) loopLog.warn(stallLine(stall));
});

const previewKey = previewIdentityKey(process.env);

const app = createApp({
  dataDir,
  // A new forge starts with signup = invite (FORGE_SIGNUP below still wins).
  seedSignup: true,
  ...(parentUrl === "" ? {} : { parentUrl }),
  port: Number(process.env.PORT ?? 3000),
  ...(process.env.FORGE_HOST === undefined
    ? {}
    : { host: process.env.FORGE_HOST }),
  ...(canonicalUrl === "" ? {} : { url: new URL(canonicalUrl).origin }),
  ...(edgeToken === "" ? {} : { edgeToken }),
  // A preview of this forge hears its parent's admins as the preview admin
  // (spawn/preview-owner.ts); production is never handed the key.
  ...(previewKey === undefined ? {} : { previewIdentityKey: previewKey }),
  // Hosted, the host says how this forge's terminal is reached; printed
  // verbatim wherever the forge tells people how to connect.
  ...(hosted && (process.env.FORGE_APP_SSH ?? "").trim() !== ""
    ? { appSsh: (process.env.FORGE_APP_SSH ?? "").trim() }
    : {}),
  // The repository holding this forge's own code: a landing there is
  // checked out under releases/ and preflighted (#1662).
  ...releaseEnv(process.env),
  // The one knob on the crew's bill: FORGE_CREW_CEILING_USD, dollars a day
  // across every repository. Unset is no forge-wide ceiling.
  ...(process.env.FORGE_MIGRATE_PRIVATE_HOSTS === "1"
    ? { migrateFromPrivateHosts: true }
    : {}),
  // Mail out (email verification): SMTP submission, both or neither.
  ...((process.env.FORGE_SMTP_URL ?? "").trim() !== "" &&
  (process.env.FORGE_MAIL_FROM ?? "").trim() !== ""
    ? {
        mail: {
          url: process.env.FORGE_SMTP_URL!.trim(),
          from: process.env.FORGE_MAIL_FROM!.trim(),
        },
      }
    : {}),
  // FORGE_MAIL_DAILY: the most messages the forge sends in a day, to
  // everyone together (`actions/mail.ts`).
  ...(Number.isInteger(Number(process.env.FORGE_MAIL_DAILY)) &&
  Number(process.env.FORGE_MAIL_DAILY) > 0
    ? { mailDailyCap: Number(process.env.FORGE_MAIL_DAILY) }
    : {}),
  // Signup asks Cloudflare Turnstile when its secret is set.
  ...(turnstileSecret === ""
    ? {}
    : { turnstileSecret, turnstileSiteKey }),
  // Who may say who the client is: the ingress in front of a hosted forge.
  ...(trustedProxies.length > 0 ? { trustedProxies } : {}),
  ...((process.env.FORGE_CLIENT_IP_HEADER ?? "").trim() !== ""
    ? { clientIpHeader: process.env.FORGE_CLIENT_IP_HEADER!.trim().toLowerCase() }
    : {}),
  ...(Number(process.env.FORGE_CREW_CEILING_USD) > 0
    ? { crewCeilingUsd: Number(process.env.FORGE_CREW_CEILING_USD) }
    : {}),
  // FORGE_CREW_ISSUE_RUNS: runs one issue may start in a day before it is
  // parked for a person (`crew/guard.ts`).
  ...(Number.isInteger(Number(process.env.FORGE_CREW_ISSUE_RUNS)) &&
  Number(process.env.FORGE_CREW_ISSUE_RUNS) > 0
    ? { issueRunCap: Number(process.env.FORGE_CREW_ISSUE_RUNS) }
    : {}),
  // FORGE_CREW_DIRECTION_RUNS: planning passes the direction issue may start
  // in a day; the planner is otherwise paced, never capped (#2143).
  ...(Number.isInteger(Number(process.env.FORGE_CREW_DIRECTION_RUNS)) &&
  Number(process.env.FORGE_CREW_DIRECTION_RUNS) > 0
    ? { directionRunCap: Number(process.env.FORGE_CREW_DIRECTION_RUNS) }
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

// A statement that holds the thread past 200 ms names its caller (#6957).
timeStatements(app.db, createLog("sql"));
loadFlags(app.db);
loadTrustedHosts(app.db);
// FORGE_SIGNUP (checked in configProblem) sets who may sign up; kept like any change.
const bootSignup = signupFromEnv(process.env.FORGE_SIGNUP);
if (bootSignup.ok && bootSignup.value !== null)
  setSignup(app.db, bootSignup.value, BOOT_ACTOR);
startPerfWatcher(app, perfRecord, Date.now, TICK_MS, gitRecord);
const flagTimer = setInterval(() => flushFlagUses(app.db), 10_000);
await reconcile(app);
// Issues linked under a pillar's umbrella before pillars had labels.
const labelled = syncAllPillars(app);
if (labelled > 0) app.log.info("pillars labelled", { issues: labelled });
// The host apps answer at, resolved once and before the listener opens: an
// app host never reaches the forge's own router, so `serve` needs it from the
// first connection (#6726). Only the hostname matters here, not the port.
const appsOn = process.env.FORGE_APPS !== "0";
const appDomain = appsOn
  ? resolveAppDomain({
      explicit: (process.env.FORGE_APP_DOMAIN ?? "").trim() || undefined,
      hosted,
      hostname: new URL(
        (hosted ? hostedAt : process.env.FORGE_URL)?.trim().replace(/\/+$/, "") ||
          `http://${app.config.host ?? "localhost"}`,
      ).hostname,
    })
  : undefined;
if (appDomain?.ok === true) holdAppHosts(app, appDomain.domain);
const servers = await serve(app);
const sshStarted =
  sshPort > 0 ? await startForgeSsh(app, { port: sshPort }) : undefined;
if (sshStarted && !sshStarted.ok)
  app.log.warn("ssh is off: the terminal could not start", {
    port: sshPort,
    reason: sshStarted.error.message,
    code: (sshStarted.error as { code?: string }).code,
  });
const ssh = sshStarted?.ok ? sshStarted.value : undefined;

// Apps and the crew (docs/APPS.md). Both are on unless FORGE_APPS=0: an app
// is served by Host on the same port, and the crew runs agents as child
// processes. The public URL is what apps and agents are told about the
// forge; FORGE_URL when the operator set one, the host and port otherwise.
const host = app.config.host ?? "localhost";
const forgeUrl =
  (hosted ? hostedAt : process.env.FORGE_URL)?.replace(/\/+$/, "") ??
  `http://${host}:${servers.port}`;
const publicUrl = new URL(forgeUrl);
// An IP-addressed forge hands out a hostname no URL can hold once a slug
// attaches to it, and an app that parses its own FORGE_APP_URL (the scaffold
// does) dies before it answers — every deploy, forever. docs/APPS.md,
// "Hostnames and the proxy".
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
      // Days a pull may sit untouched before its preview sleeps; 0 keeps
      // every preview warm.
      idlePullMs: nonNegative(process.env.FORGE_PREVIEW_IDLE_DAYS, 3) * 86_400_000,
    })
  : undefined;
// Which other forge serves this data's apps, read before this one starts its own.
const presence = apps ? takePresence(app.config.dataDir) : undefined;
// The runtime is registered by its constructor: app hosts stop waiting now,
// not at the end of `start()`.
releaseAppHosts(app);
await apps?.start();
// In a rollout this forge takes no traffic until the apps it just started
// serve: the one it replaces keeps proxying to its own copies until then,
// so no request meets an app still starting (#4496). A cold start has no
// one serving in its place, and is ready at once.
if (apps && presence) warmBehind(app.log, presence, () => apps.startingCount());
// What deploys before the record carried, so ask-to-live is not blank for them.
void backfillCarried(app.db, app.reposRoot).catch((error) =>
  app.log.error("could not backfill what deploys carried", { error: String(error) }),
);
// A forge still draining on this database keeps writing for its gates and
// runs; starting ours beside it stalls the listener behind its write lock
// (#6957). The listener answers meanwhile; a signal now stops what is up.
const leaveEarly = (): void => {
  void Promise.resolve(apps?.stop())
    .catch(() => {})
    .finally(() => {
      presence?.stop();
      ssh?.stop();
      servers.stop();
      app.close();
      process.exit(0);
    });
};
const earlySignals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
for (const signal of earlySignals) process.once(signal, leaveEarly);
await waitForPeer(app.db, app.log);
for (const signal of earlySignals) process.off(signal, leaveEarly);
// A repository's own check, on every push a pull or the default branch takes.
const checks =
  process.env.FORGE_CHECKS === "0"
    ? undefined
    : startChecks(app, {
        forgeUrl,
        // Sized to the pod's CPUs unless the environment says (#2549).
        concurrency: positive(process.env.FORGE_CHECKS_CONCURRENCY, Number(capacityDefault("checks.concurrency"))),
        redHoldMs: RED_HOLD_MS,
        landSettleMs: LAND_SETTLE_MS,
        // A roll lets running checks and merge-queue gates finish this long
        // before cutting them off, and no longer: the new forge holds its
        // own queue work until this one stops writing, so the write pause
        // of a release is this budget (#7799). A gate cut off is queued
        // again and resumes on the new forge.
        drainMs: drainBudgets(process.env).checksMs,
        // Main is verified after landing at most this often (#7786).
        verifyEveryMs: VERIFY_EVERY_MS,
      });
// Migrated repositories kept as a read-only mirror push to their source.
const mirrorOut = startMirrorOut(app);
// The look: a picture of every environment that comes up green, taken
// through this forge's own listener.
const looks = appsOn ? startLooks(app, { localUrl: servers.url }) : undefined;
// Is it so: the forge knocks on every door of an app with a contract after
// each production deploy and once a night, and compares with the table.
const probes = apps === undefined ? undefined : startProbes(app, apps);
// The nightly jobs that were Forgejo workflows: the flake hunt and the run
// of what the gate excludes, filing the same `Flaky:` and `Red:` issues and
// the quarantine pull (docs/DEVELOP.md).
const nightly = appsOn ? startNightly(app, { forgeUrl, token: process.env["FORGE_TOKEN"] }) : undefined;
// The snapshot: everything that cannot be rebuilt, nightly, to what an
// operator sealed on the Backups page, else the platform's (`S3_*`) or a
// directory (`FORGE_SNAPSHOT_DIR`). A forge given none says so on that page.
const snapshots = startSnapshots(
  app,
  () =>
    resolveDestination({
      db: app.db,
      dataDir: app.config.dataDir,
      bus: app.bus,
    })?.store,
  {
    version: running().version,
    mirror: () =>
      resolveMirror({ db: app.db, dataDir: app.config.dataDir, bus: app.bus })?.store,
    passphrase: process.env["FORGE_SNAPSHOT_PASSPHRASE"] || undefined,
  },
);
// What the machine uses (boards/sampler.ts): the pod, each cell and the
// node, every 15 s into a ring the `machine` board source reads.
const sampler = startSampler(app);
const memorySampler = startMemorySampler(app);
// The starting boards, once each (actions/boards.ts).
void offerStartingBoards(app)
  .then((slugs) => slugs.length > 0 && app.log.info("starting boards offered", { slugs: slugs.join(", ") }))
  .catch((error) => app.log.warn("starting boards not offered", { error: String(error) }));
const crewHeldOff = crewOffInPreview();
if (appsOn && crewHeldOff)
  app.log.info(CREW_OFF_IN_PREVIEW, {
    why: "FORGE_APP_ENV=preview; set FORGE_CREW_IN_PREVIEW=1 to run it",
  });
const crew = appsOn && !crewHeldOff
  ? await startCrew(app, {
      forgeUrl,
      localUrl: servers.url,
      binary: process.env.FORGE_CLAUDE ?? "claude",
      concurrency: positive(process.env.FORGE_CREW_CONCURRENCY, hosted ? 1 : Number(capacityDefault("crew.concurrency"))),
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
// A conversation turn the last process was in the middle of is resumed once
// from its session (crew/conversation.ts); a shutdown leaves it running again.
const conversationsStop = new AbortController();
if (crew !== undefined) {
  const conversation = {
    binary: process.env.FORGE_CLAUDE ?? "claude",
    localUrl: servers.url,
    budgetUsd: Number(process.env.FORGE_CREW_BUDGET_USD) || 5,
    timeoutMs: crewRunMs,
    ...(process.env.FORGE_CLAUDE_CONFIG_DIR === undefined ? {} : { configDir: process.env.FORGE_CLAUDE_CONFIG_DIR }),
    signal: conversationsStop.signal,
  };
  configureConversation(app, conversation);
  for (const turn of resumeInterrupted(app, conversation))
    turn.catch((error: unknown) => app.log.error("resumed conversation turn crashed", { error: String(error) }));
}
// Hosted children come back with their apps, awake before the first visit.
// The listener is up; the children open behind it, not in front of /healthz.
void bootHostedChildren(app);
// The pipeline answer is filled in slices behind the listener, so no read computes it (#8978).
void warmFlow(app);
// A spawned child's first boot: its direction, opened once for its planner
// (spawn/first-boot.ts). A forge that was not spawned is untouched.
await firstBoot(app);
// A preview of this forge seeds its admin and a small world to look at
// (spawn/preview-seed.ts); anywhere else this is refused and says nothing.
await seedPreview(app)
  .then((seeded) => {
    if (seeded.ok && seeded.value.seeded) app.log.info("preview seeded", { admin: PREVIEW_ADMIN });
    else if (!seeded.ok && seeded.error !== "not_preview") app.log.warn("preview not seeded", { error: seeded.error });
  })
  .catch((error) => app.log.warn("preview not seeded", { error: String(error) }));
// A spawned child reports its standing to its parent (spawn/heartbeat.ts).
const heartbeatTimer = startHeartbeat(app);
// ...and looks upstream once an hour (spawn/upstream.ts).
const upstreamTimer = startUpstreamWatch(app);
// ...and this forge asks every child's public addresses what a visitor would get, every few minutes (spawn/reach.ts).
const reachTimer = startReachWatch(app);
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

function nonNegative(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

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

// Which green pulls no longer merge as they stand, so the asks can leave
// them out (`crew/stale_asks.ts`): git answers, off the request path, and an
// unchanged pull costs two ref reads. Never throws into the timer.
// The asks ledger rides the same tick, after the sweep has said what
// expired: what asked each person, and how it ended.
const tickAsks = async (): Promise<void> => {
  await sweepStaleAsks(app);
  // Repositories ruled "decider" have their hand-overs answered here.
  try {
    await sweepStanding(app);
  } catch (error) {
    app.log.error("standing rule sweep failed", { error: String(error) });
  }
  try {
    recordAskLedger(app.db);
  } catch (error) {
    app.log.error("asks ledger failed", { error: String(error) });
  }
  // The degraded history rides the same tick; it catches its own errors.
  try {
    recordDegraded(
      app.db,
      vitals({
        db: app.db,
        dataDir: app.config.dataDir,
        ...(app.config.disk ? { disk: app.config.disk } : {}),
        signals: app.signals,
        forgeUrl,
        snapshots: snapshotPlace(app),
      }).degraded,
      Date.now(),
      app.log,
    );
  } catch (error) {
    app.log.warn("degraded history: vitals failed", { error: String(error) });
  }
};
// Followed upstreams are read on a slow tick (`actions/upstream_follow.ts`):
// the tip and how far behind land on the follow row; nothing is opened.
const followTimer = setInterval(() => void checkDue(app), 60_000);
const staleTimer = setInterval(() => void tickAsks(), 120_000);
void tickAsks();

// Every start is counted, and one that follows a process that never said
// goodbye is a crash the log could not record (kernel/boots.ts, #3708).
const boot = recordBoot(app.config.dataDir);
app.log.info("forge is up", {
  url: servers.url,
  data: app.config.dataDir,
  restarts: boot.restarts,
  ...(boot.unclean === 0 ? {} : { unclean: boot.unclean }),
});
// What runs beside the forge, by name, once a minute: a helper that leaks
// (255 socat, #3708) shows on this line long before it costs a crash.
// Claude Code's sandbox bridges a finished session left behind go here.
const processTick = (): void => {
  try {
    const rows = processRows();
    const reaped = crew === undefined ? 0 : reapLeftoverBridges(rows, crewRoot(app.config.dataDir));
    const counts = bootCounts(app.config.dataDir);
    app.log.info("processes", {
      count: rows.length,
      top: censusWords(census(rows)),
      restarts: counts.restarts,
      ...(counts.unclean === 0 ? {} : { unclean: counts.unclean }),
      ...(reaped === 0 ? {} : { reapedBridges: reaped }),
    });
  } catch (error) {
    app.log.warn("process census failed", { error: String(error) });
  }
};
// The clog watch (#6524, #6757) reads the flow every minute; its state is the database's.
const stopClogTick = startClogTick(app.db, app.bus, (error) => app.log.warn("clog tick failed", { error: String(error) }), 60_000);
// The throughput keeper (#7645) names what binds landings each minute and lifts what is its to lift.
const stopKeeper = startKeeper(app, () => sweepAssigned(app));
// An agent's hold that has stood 24 h is released each minute (#6918).
const holdTimer = setInterval(() => {
  try {
    expireCrewHolds(app);
  } catch (error) {
    app.log.warn("hold expiry failed", { error: String(error) });
  }
}, 60_000);
// The weekly model review (#7815): settles last week's changes, then proposes this week's; it runs once a week whatever the tick.
const modelReviewTimer = setInterval(() => {
  try {
    runModelReview(app);
  } catch (error) {
    app.log.warn("model review failed", { error: String(error) });
  }
}, 3_600_000);
// The week is the sprint (#8704): at each weekly reset the forge writes its retrospective, unasked.
const weekTimer = setInterval(() => {
  try {
    const repos = plannedRepoIds(app.db).flatMap((id) => getRepoById(app.db, id) ?? []);
    for (const repo of tickWeeks(app.db, repos, new Date()))
      app.bus.append({ kind: "week.retro", repoId: repo.id, payload: {} });
  } catch (error) {
    app.log.warn("week retrospective failed", { error: String(error) });
  }
}, 3_600_000);
const processTimer = setInterval(processTick, 60_000);
processTick();
// A new version proves itself against the public URL; a failed one again, 5 min after and backing off to hourly (release/prove.ts).
proveRunning({
  dataDir: app.config.dataDir,
  version: running().version,
  url: forgeUrl,
  token: process.env["FORGE_TOKEN"],
  // The first app's production host: it must never answer as the forge (#6726).
  appHost: (() => {
    const first = listApps(app.db)[0];
    return apps && first ? apps.urlFor(first, "production") : undefined;
  })(),
}, app.log);
// The release tags of the forge's own repository are its shipped releases (release/shipped.ts);
// production behind the newest for over an hour is a card (release/behind.ts).
// A FORGE_REPO that is not owner/name is dropped by releaseEnv; say so, or the list stops at the frozen one unexplained.
if ((process.env.FORGE_REPO ?? "") !== "" && !app.config.forgeRepo)
  app.log.warn("FORGE_REPO is not owner/name; release tags are not read", { value: process.env.FORGE_REPO });
if (app.config.forgeRepo) {
  const watch = watchBehind({
    live: () => running().version,
    read: ownTagsReader(app, app.config.forgeRepo),
  });
  setBehind(watch);
  void watch.tick();
  setInterval(() => void watch.tick(), CHECK_EVERY_MS);
  // The no-release alarm reads what this keeps of the running commit (#7638).
  void readLandings(app);
  setInterval(() => void readLandings(app), 60_000);
}
// The release keeper (#7557): cut on cadence, promote, verify under page load, roll back to the named
// known-good image and hold. Off unless FORGE_RELEASE_KEEPER=on in a cluster (keeper/wire.ts).
const keeperOn = keeperEnv(process.env);
if (keeperOn.on) {
  const ports = keeperPorts(
    app,
    keeperOn.mode === "swap"
      ? { forgeUrl, deployment: "", container: "", swap: true }
      : { forgeUrl, deployment: keeperOn.deployment, container: keeperOn.container },
  );
  if (typeof ports === "string") app.log.warn("the release keeper is off", { why: ports });
  else {
    let said = "";
    const step = () =>
      void keeperTick(ports)
        .then((line) => {
          if (line !== said) app.log.info("release keeper", { line });
          said = line;
        })
        .catch((error) => app.log.warn("release keeper step failed", { error: String(error) }));
    step();
    setInterval(step, 60_000);
    setInterval(() => void rollProbe(ports).catch(() => {}), 1000);
  }
} else app.log.info("the release keeper is off", { why: keeperOn.why });
// Only an agent is on a crew (the `repo_crew_agents_only` trigger refuses anyone else). A person
// put on one before that is reported here for the owner to take off — the
// forge never removes it on its own.
for (const p of peopleOnCrews(app.db))
  app.log.warn("a person is on a crew; only agents belong there", {
    repo: p.repoId,
    user: p.username,
  });
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
// by renewing their leases, so only a lapsed lease is a death. Deploys are
// failed; checks are queued again while their commit heads an open pull;
// agent runs are the crew's to queue again, unless there is no crew here to
// do it.
const leaseTimer = setInterval(() => {
  failAbandonedRuns(
    app.db,
    STALE_AFTER_MS,
    crew === undefined ? ["deploy", "agent"] : ["deploy"],
  );
  requeueAbandonedChecks(app, STALE_AFTER_MS);
  // A grant whose run is no longer running is a crash's leftover: close it.
  releaseOrphans(app.db);
}, 30_000);

// A release that read healthy beside this process takes over (#1663),
// and this one lets go of the port before it drains (#2040).
const handOver = drainOnHandover(servers, () => drain("SIGTERM"), close);
handover.drain = () => {
  if (draining) return;
  draining = true;
  void handOver();
};
handover.ssh = ssh !== undefined;
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
// The terminal it ran in went away. Apps that run without a cell lead
// process groups of their own (`apps/process.ts`), so the hangup reaches
// this process alone: it stops them on the way out, as Ctrl-C does.
process.on("SIGHUP", shutdown);

let draining = false;

/**
 * A release does not drop a session. On SIGTERM this process stops taking
 * new work — readiness says so, and the platform already routes new
 * connections to the process that replaced it — lets the crew's runs in
 * flight finish and land, stops the apps and the checks, and keeps serving
 * whoever is connected over SSH until they leave. Only then does it go.
 */
function shutdown(signal: NodeJS.Signals): void {
  if (draining) return;
  draining = true;
  void drain(signal).finally(close);
}

/** Everything a leaving process finishes before it goes: `shutdown` above. */
function drain(signal: NodeJS.Signals): Promise<unknown> {
  const sessions = ssh?.sessions() ?? 0;
  startDraining(app.log, signal, { sshSessions: sessions });
  // Streams end now, with a resume hint: their browsers reconnect to the
  // process that replaced this one, not to this one while it finishes.
  drainStreams();
  clearInterval(deliveryTimer);
  clearInterval(heartbeatTimer);
  clearInterval(upstreamTimer);
  clearInterval(reachTimer);
  clearInterval(syncTimer);
  clearInterval(staleTimer);
  clearInterval(followTimer);
  stopClogTick();
  stopKeeper();
  clearInterval(processTimer);
  clearInterval(holdTimer);
  clearInterval(modelReviewTimer);
  clearInterval(weekTimer);
  clearInterval(leaseTimer);
  // The platform's SIGTERM: the listener stays open while routers learn
  // this process is going. A person's Ctrl-C does not wait for routers.
  const linger = signal === "SIGTERM" ? Bun.sleep(lingerMs ?? 0) : undefined;
  // The merge queue acts on nothing more: its gates run on through the
  // checks' drain, and a verdict is kept for the forge that carries on (#6611).
  stopQueue();
  conversationsStop.abort();
  return Promise.all([
    linger,
    prompts.stop(),
    notifier.stop(),
    crew?.stop({ drain: true, drainMs: drainBudgets(process.env).crewMs }),
    // Routers still send this process requests for the linger's length;
    // its apps answer them, and stop only after (#4496).
    (linger ?? Promise.resolve()).then(() => apps?.stop()).finally(() => presence?.stop()),
    // A step leads a process group of its own, so a terminal's Ctrl-C no
    // longer ends it: a person's stop cuts checks off (queued again) at once.
    checks?.stop({ drain: signal === "SIGTERM" }),
    mirrorOut(),
    looks?.stop(),
    probes?.stop(),
    nightly?.stop(),
    snapshots.stop(),
    sampler.stop(),
    memorySampler.stop(),
  ])
    .catch(() => {})
    .then(() => {
      if (sessions > 0)
        app.log.info("forge waiting for ssh sessions to end", {
          sshSessions: sessions,
        });
      return ssh?.drain();
    })
    .catch(() => {});
}

/** The last step of a drain: cut what is left and exit. */
async function close(): Promise<void> {
  app.log.info("forge shutting down");
  // Says Recovered if this process paged a drain: its exit is the end of it.
  await notifier.close().catch(() => {});
  ssh?.stop();
  servers.stop();
  clearInterval(flagTimer);
  flushFlagUses(app.db);
  recordCleanExit(app.config.dataDir);
  app.close();
  process.exit(0);
}

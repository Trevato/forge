/**
 * Backups, for an admin: where snapshots go, the last fourteen the store
 * holds, what the last one taken by this process said, and a button to
 * take one now. A forge given no store says so here rather than showing
 * an empty list that looks like a clean bill.
 *
 * Restoring is a command, not a button: it needs an empty data directory
 * and a stopped forge, and a person at a terminal is the one who has both.
 *
 * Below the snapshots, each failure domain (`kernel/domains.ts`): what
 * breaks, the words the forge says, and its last drill with the verdict —
 * or the sentence on why it is not drilled (`actions/resilience.ts`). It
 * was /settings/resilience, which now sends here.
 */

import {
  forgetDestination,
  saveDestination,
  testDestination,
  type DestinationInput,
} from "../../actions/destination.ts";
import { forgetMirror, saveMirror } from "../../actions/mirror.ts";
import { listResilience, type ResilienceRow } from "../../actions/resilience.ts";
import { mirrorSealedSet, mirrorNeed, MIRROR_SEALED } from "../../snapshot/mirror.ts";
import { resolveDestination, sealedSet } from "../../snapshot/destination.ts";
import { keyOf } from "../../snapshot/snapshot.ts";
import { formatMinutes, formatSpan, timeByPart, type DrillResult } from "../../snapshot/drill.ts";
import { lastDrill } from "../../snapshot/drills.ts";
import { backupVerdict } from "../../snapshot/bucket.ts";
import type { Store } from "../../snapshot/store.ts";
import { snapshotsOf, type SnapshotsHandle } from "../../snapshot/service.ts";
import { drillNow, mirrorNow, snapshotNow } from "../../actions/backups_now.ts";
import { lastSnapshotOutcome } from "../../snapshot/outcome.ts";
import type { Ctx } from "../../http/context.ts";
import {
  notePhase,
  takeSessionTime,
  timePhase,
  timePhaseAsync,
} from "../../core/route_timing.ts";
import { notFoundPage, settingsLayout, signInFirst } from "../chrome.ts";
import { field, readForm, type Form } from "../form.ts";
import { html, when, type Html } from "../html.ts";
import { liveRegionsJs } from "../client.ts";
import { flashTo, fragment, page, redirect } from "../layout.ts";
import { badge, btn, card, empty, fileSize, icon, row, time } from "../ui.ts";
import { accountSections } from "./origins.ts";

function requireAdmin(ctx: Ctx): Response | undefined {
  if (!ctx.auth.user) return signInFirst(ctx);
  if (!ctx.auth.user.isAdmin) return notFoundPage(ctx);
  return undefined;
}

function shell(ctx: Ctx, body: Html): Response {
  return page({
    ctx,
    title: "Backups",
    scriptJs: liveRegionsJs,
    body: html`<div class="page-head"><h1>Backups</h1></div>
      ${settingsLayout(
        accountSections("backups", { admin: true }),
        body,
        "Account settings",
      )}`,
  });
}

/**
 * Whether the key travels, said before anyone relies on it. The passphrase
 * is the only way back to sealed values from a bucket; lose it and they
 * are lost.
 */
function keyNote(
  wraps: boolean,
  newest:
    | Awaited<
        ReturnType<NonNullable<ReturnType<typeof snapshotsOf>>["list"]>
      >[number]
    | undefined,
): Html {
  const carried = newest === undefined ? undefined : keyOf(newest);
  const last =
    carried === undefined
      ? ""
      : carried === "wrapped"
        ? " The last snapshot carried a wrapped key."
        : carried === "raw"
          ? " The last snapshot carried the key unwrapped, as older snapshots did; take a new one."
          : " The last snapshot carried no key.";
  return wraps
    ? html`<p class="break">
        ${badge("Ready", { tone: "success", icon: "check" })} The key is wrapped under
        <code>FORGE_SNAPSHOT_PASSPHRASE</code> and travels with each
        snapshot.${last} Keep that passphrase somewhere other than this bucket:
        without it a restore brings back repositories and issues, but every
        sealed value (secrets, app variables, origin tokens) is lost and must be
        set again.
      </p>`
    : html`<p class="break">
        ${badge("At risk", { tone: "danger", icon: "alert" })} Snapshots carry no key: the bucket never holds key and
        data together, and a restore will bring back repositories and issues but
        not sealed values, which must be set again.${last} To carry the key
        wrapped, set <code>FORGE_SNAPSHOT_PASSPHRASE</code> and restart — and
        keep the passphrase elsewhere, because losing it loses those values.
      </p>`;
}

/**
 * "6 min 12 s of its 14 min budget: clone 4 min, download 58 s, ...", or
 * "6 min 12 s of its 14 min budget" when no phase was kept; empty for an
 * older drill that kept no budget.
 */
function drillTiming(d: DrillResult): string {
  if (d.budgetMs <= 0) return "";
  const spent = `${formatSpan(d.ms)} of its ${formatMinutes(d.budgetMs)} budget`;
  if (d.phases.length === 0) return spent;
  return `${spent}: ${timeByPart(d.phases)
    .map((p) => `${p.part} ${formatSpan(p.ms)}`)
    .join(", ")}`;
}

/** The last drill in one line, and the button to run another. */
function drillLine(ctx: Ctx): Html {
  const d = lastDrill(ctx.app.db);
  const timing = d === undefined ? "" : drillTiming(d);
  const line =
    d === undefined
      ? html`<p class="break">No restore drill has run yet.</p>`
      : d.verdict === "green"
        ? html`<p class="break">
            ${badge("Ready", { tone: "success", icon: "check" })} Last drill: ${time(d.at)}, ${d.ms} ms, all counts matched —
            snapshot <code>${d.snapshotId ?? ""}</code>, key opened —
            ${d.counts.users} users, ${d.counts.repositories} repositories, ${d.counts.issues} issues, ${d.counts.pulls} pulls, ${d.counts.apps} apps.${timing
              ? html` <span class="muted small">${timing}.</span>`
              : ""}
          </p>`
        : html`<p class="break">
            ${badge("At risk", { tone: "danger", icon: "alert" })} Last drill ${time(d.at)}: snapshot
            <code>${d.snapshotId ?? "none"}</code> failed at
            ${d.failedStep ?? "an unknown step"} after ${d.ms} ms${d.reason
              ? html`: ${d.reason}`
              : ""}.${timing ? html` <span class="muted small">${timing}.</span>` : ""}
          </p>`;
  return html`${line}
    <form method="post" action="/settings/backups/drill" class="mt">
      ${btn("Run a drill", { type: "submit", icon: "clock" })}
    </form>`;
}

const SNAPSHOT_FRESH_MS = 26 * 3_600_000;
const DRILL_FRESH_MS = 8 * 86_400_000;

function ago(ms: number): string {
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 48) return hours === 1 ? "1 hour" : `${hours} hours`;
  return `${Math.floor(hours / 24)} days`;
}

export interface Recovery {
  /** Whether the store answered; false when there is no store or listing failed. */
  readonly reachable: boolean;
  readonly unreachable?: string | undefined;
  readonly newest?: { finishedAt: string; key: "wrapped" | "none" | "raw" } | undefined;
  readonly drill?: { at: string; verdict: "green" | "red" } | undefined;
  readonly now: number;
}

/** "Recoverable now", or the first of four facts that stands in the way. */
export function recoverySentence(r: Recovery): string {
  const no = (why: string): string => `Not recoverable now: ${why}`;
  if (!r.reachable) return no(r.unreachable ?? "the snapshot store cannot be reached");
  if (r.newest === undefined) return no("there is no snapshot yet");
  const age = r.now - Date.parse(r.newest.finishedAt);
  if (!(age < SNAPSHOT_FRESH_MS))
    return no(
      Number.isNaN(age)
        ? "the newest snapshot has no readable date"
        : `the newest snapshot is ${ago(age)} old`,
    );
  if (r.newest.key !== "wrapped") return no("the newest snapshot does not carry a wrapped key");
  if (r.drill === undefined) return no("no restore drill has run yet");
  if (r.drill.verdict !== "green") return no("the last restore drill failed");
  const drillAge = r.now - Date.parse(r.drill.at);
  if (!(drillAge < DRILL_FRESH_MS))
    return no(
      Number.isNaN(drillAge)
        ? "the last restore drill has no readable date"
        : `the last restore drill is ${ago(drillAge)} old`,
    );
  return "Recoverable now";
}

function recoveryLine(r: Recovery): Html {
  const sentence = recoverySentence(r);
  const ok = sentence === "Recoverable now";
  return html`<p class="break" role="status">
    ${ok ? badge("Ready", { tone: "success", icon: "check" }) : badge("At risk", { tone: "danger", icon: "alert" })} <strong>${sentence}</strong>
  </p>`;
}

function drilled(d: ResilienceRow): Html {
  if (d.drill.name === null)
    return html`<span class="muted small">Not drilled: ${d.drill.why}</span>`;
  const last = d.drill.last;
  if (last === null)
    return html`<span class="muted small">${d.drill.name}: never run.</span>`;
  return html`<span class="small"
    >${d.drill.name}: ${time(last.at)} ·
    <strong class="${last.green ? "ok" : "bad"}"
      >${last.green ? "green" : "red"}</strong
    >
    — ${last.why} · back in ${String(last.backSeconds)}s (budget
    ${String(d.backMinutes)} min)</span
  >`;
}

/** Each failure domain and its last drill; nothing when the viewer may not read them. */
function domainsCard(ctx: Ctx): Html | null {
  if (!ctx.auth.user) return null;
  const listed = listResilience(ctx.app, ctx.auth.user);
  if (!listed.ok) return null;
  const rows = listed.value.map((d) => {
    const says =
      d.says.length === 0
        ? "Says nothing yet."
        : d.says.map((s) => `“${s}”`).join(" · ");
    return row({
      lead: icon("activity"),
      title: html`${d.name}`,
      meta: html`${d.breaks}<br />${says}<br />${drilled(d)}`,
    });
  });
  return html`<div id="domains">
    ${card(
      html`<ul class="list" id="resilience-list">
        ${rows}
      </ul>`,
      {
        head: html`${icon("activity")}
          <h2>Failure domains</h2>`,
        pad: false,
      },
    )}
  </div>`;
}

// GET /settings/resilience — folded into this page (#2694); old links land on the card.
export function domainsMoved(): Response {
  return redirect("/settings/backups#domains");
}

/** Build the page and name the time it took as `render`. */
const rendered = (ctx: Ctx, build: () => Response): Response =>
  timePhase(ctx.request, "render", build);

export async function backupsPage(ctx: Ctx): Promise<Response> {
  const denied = requireAdmin(ctx);
  if (denied) return denied;
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const svc = snapshotsOf(ctx.app);
  const form = html`${timePhase(ctx.request, "destination", () => destinationCard(ctx))}${timePhase(
    ctx.request,
    "mirror",
    () => mirrorCard(ctx),
  )}${timePhase(ctx.request, "domains", () => domainsCard(ctx))}`;
  if (svc === undefined || svc.store === undefined) {
    return rendered(ctx, () =>
      shell(
        ctx,
        html`${recoveryLine({
        reachable: false,
        unreachable: "no snapshot store is set",
        now: Date.now(),
      })}${empty({
        icon: "download",
        title: "No snapshots are taken",
        note: "This forge was given nowhere to put them. On the platform an app's bucket (S3_*) is the place; on a machine, FORGE_SNAPSHOT_DIR names a directory. Seal a bucket below, or restart with one set, and a snapshot is taken every night at 08:00 UTC.",
      })}${form}`,
      ),
    );
  }
  const moving = await movingPart(ctx, svc, svc.store, true);
  return rendered(ctx, () => shell(ctx, html`${moving}${form}`));
}

/** GET /settings/backups/live — the moving part alone, which the page refetches on an event. */
export async function backupsLive(ctx: Ctx): Promise<Response> {
  if (!ctx.auth.user?.isAdmin) return fragment(html``, { status: 404 });
  const svc = snapshotsOf(ctx.app);
  if (svc === undefined || svc.store === undefined) return fragment(html``, { status: 404 });
  return fragment(await movingPart(ctx, svc, svc.store), { request: ctx.request });
}

/**
 * What changes while a snapshot is taken: the recovery line, the progress,
 * the outcome and the list. It patches in place from `backup.*` events.
 */
async function movingPart(
  ctx: Ctx,
  svc: SnapshotsHandle,
  store: Store,
  timed = false,
): Promise<Html> {
  const now = Date.now();
  const read = <T>(name: string, work: () => T): T =>
    timed ? timePhase(ctx.request, name, work) : work();
  // A failure is kept on disk, so it is shown after a restart too; this
  // process's own failure is newer when the file could not be written.
  const kept = read("outcome", () => lastSnapshotOutcome(ctx.app.config.dataDir));
  const last = svc.last();
  const failing =
    kept?.failingSince !== undefined
      ? { at: kept.at, since: kept.failingSince, error: kept.error ?? "unknown reason" }
      : last.error !== undefined && (kept === undefined || (last.at ?? "") > kept.at)
        ? { at: last.at ?? "", since: last.at ?? "", error: last.error }
        : undefined;
  // The store is somewhere else; a listing that fails is a sentence on the
  // page, never a page that fails.
  let snapshots: Awaited<ReturnType<typeof svc.list>> = [];
  let listing: string | undefined;
  try {
    snapshots = timed
      ? await timePhaseAsync(ctx.request, "snapshots", () => svc.list())
      : await svc.list();
  } catch (error) {
    listing = String(error);
  }
  const d = read("drill", () => lastDrill(ctx.app.db));
  const recovery = recoveryLine({
    reachable: listing === undefined,
    unreachable: "the snapshot store could not be listed",
    ...(snapshots[0]
      ? { newest: { finishedAt: snapshots[0].finishedAt, key: keyOf(snapshots[0]) } }
      : {}),
    ...(d ? { drill: { at: d.at, verdict: d.verdict } } : {}),
    now,
  });
  const restore = snapshots[0]
    ? html`<pre class="restore-command" tabindex="0" aria-label="Restore command">bun run src/snapshot/restore.ts ${snapshots[0].name} /path/to/empty/data</pre>`
    : null;
  return html`<div id="backups-live" data-live="backup.*" data-live-src="/settings/backups/live">${recovery}${lanesCard(ctx)}${card(
      html`<p>
          Every night at 08:00 UTC the forge writes what cannot be rebuilt — its
          database, its keys, every repository, every app's production data, the
          crew's logs — to <code>${store.where}</code>, and keeps the newest
          fourteen.
        </p>
        ${keyNote(svc.wraps, snapshots[0])}
        ${when(
          svc.progress(),
          (p) =>
            html`<p class="break">
              ${badge("Running", { icon: "clock", variant: "secondary" })} A snapshot is being taken: ${p.objects} objects,
              ${fileSize(p.bytes)} so far, ${Math.round(p.elapsedMs / 1000)} s
              in.
            </p>`,
        )}
        ${when(
          failing,
          (f) =>
            html`<p class="break" role="alert">
              ${badge("Failed", { tone: "danger", icon: "alert" })} The last snapshot failed ${time(f.at)}, failing
              since ${time(f.since)}: ${f.error}
            </p>`,
        )}
        ${when(
          listing,
          (error) =>
            html`<p class="break">
              ${badge("Failed", { tone: "danger", icon: "alert" })} The store could not be listed just now: ${error}
            </p>`,
        )}
        ${drillLine(ctx)}
        <form method="post" action="/settings/backups/now" class="mt">
          ${btn("Snapshot now", {
            type: "submit",
            variant: "primary",
            icon: "download",
          })}
        </form>`,
      {
        head: html`${icon("download")}
          <h2>Where and when</h2>`,
      },
    )}
    ${
      snapshots.length === 0
        ? empty({
            icon: "clock",
            title: "None yet",
            note: "The first is taken tonight, or now with the button above.",
          })
        : card(
            html`<ul class="list">
              ${snapshots.map(
                (m) =>
                  html`<li>
                    <div class="row">
                      <span class="row-lead">${icon("download")}</span>
                      <span class="row-main">
                        <span class="row-title">${m.name}</span>
                        <span class="row-meta"
                          >${time(m.finishedAt)} · forge ${m.version} ·
                          ${
                            m.repos === 1
                              ? "one repository"
                              : `${m.repos} repositories`
                          },
                          ${m.apps === 1 ? "one app" : `${m.apps} apps`},
                          ${m.files.length} files</span
                        >
                      </span>
                      <span class="row-trail muted">${fileSize(m.bytes)}</span>
                    </div>
                  </li>`,
              )}
            </ul>
            <div class="card-body">
              <p class="muted small break">
                To restore, stop a forge, point it at an empty data directory,
                and run this with the same S3_* variables or FORGE_SNAPSHOT_DIR:
              </p>
              ${restore}
            </div>`,
            {
              pad: false,
              head: html`${icon("history")}
                <h2>Snapshots</h2>`,
            },
          )
    }
  </div>`;
}

const SOURCE: Record<string, string> = {
  sealed: "sealed in this forge (set here)",
  dir: "the directory named by FORGE_SNAPSHOT_DIR",
  env: "the host's S3_* environment variables",
};

/** The destination form: which one is in effect, and the write-only way to change it. */
function destinationCard(ctx: Ctx): Html {
  const dest = resolveDestination({
    db: ctx.app.db,
    dataDir: ctx.app.config.dataDir,
    bus: ctx.app.bus,
  });
  const set = sealedSet(ctx.app.db);
  const mark = (name: string): string =>
    set.includes(name) ? "set — leave blank to keep" : "";
  const input = (
    name: string,
    label: string,
    sealed: string,
    opts: { type?: string; placeholder?: string } = {},
  ): Html =>
    html`<label class="field"
      ><span>${label}</span
      ><input
        name="${name}"
        type="${opts.type ?? "text"}"
        autocomplete="off"
        spellcheck="false"
        placeholder="${mark(sealed) || opts.placeholder || ""}"
    /></label>`;
  return card(
    html`<p>
        In effect:
        <strong
          >${dest ? SOURCE[dest.source] : "nothing — no snapshots are taken"}</strong
        >. A destination sealed here wins over the environment; clear it and the
        environment's, if any, takes over. Keys are sealed and never shown
        again.
      </p>
      <form method="post" action="/settings/backups/destination" class="stack">
        ${input("endpoint", "Endpoint", "SNAPSHOT_S3_ENDPOINT", {
          placeholder: "https://s3.example.com",
        })}
        ${input("bucket", "Bucket", "SNAPSHOT_S3_BUCKET")}
        ${input("region", "Region (optional)", "SNAPSHOT_S3_REGION", {
          placeholder: "auto",
        })}
        ${input("access_key", "Access key", "SNAPSHOT_S3_ACCESS_KEY")}
        ${input("secret_key", "Secret key", "SNAPSHOT_S3_SECRET_KEY", {
          type: "password",
        })}
        <div class="row-actions">
          ${btn("Seal destination", {
            type: "submit",
            variant: "primary",
            icon: "lock",
          })}
          <button class="btn" type="submit" formaction="/settings/backups/test">
            Test connection
          </button>
          <button
            class="btn"
            type="submit"
            formaction="/settings/backups/clear"
            formnovalidate
          >
            Clear sealed destination
          </button>
        </div>
      </form>`,
    {
      head: html`${icon("lock")}
        <h2>Destination</h2>`,
    },
  );
}

/** The mirror: its age and reachability from the last pass, and the write-only form that seals it. */
function mirrorCard(ctx: Ctx): Html {
  const svc = snapshotsOf(ctx.app);
  const state = svc?.mirrored();
  const configured = svc?.mirror !== undefined;
  const need = mirrorNeed(state, Date.now());
  const set = mirrorSealedSet(ctx.app.db);
  const field_ = (name: string, label: string, sealed: string, type = "text"): Html =>
    html`<label class="field"
      ><span>${label}</span
      ><input
        name="${name}"
        type="${type}"
        autocomplete="off"
        spellcheck="false"
        placeholder="${set.includes(sealed) ? "set — leave blank to keep" : ""}"
    /></label>`;
  const status = !configured
    ? html`<p>No off-box mirror: snapshots live only where the destination is.
        Seal a second bucket below (or set <code>FORGE_MIRROR_S3_*</code>) and
        every snapshot is copied there within the hour.</p>`
    : state === undefined
      ? html`<p>Mirroring to <code>${svc!.mirror!.where}</code>; the first pass has not run yet.</p>`
      : html`<p class="break">
          ${need ? badge("At risk", { tone: "danger", icon: "alert" }) : badge("Ready", { tone: "success", icon: "check" })} <code>${state.where}</code> is
          ${state.reachable ? "reachable" : "unreachable"} (checked
          ${time(state.attemptAt)}).
          ${state.newest
            ? html`It holds <code>${state.newest}</code>, taken
              ${time(state.newestAt ?? "")}; confirmed level ${time(state.syncedAt ?? "")}.`
            : html`It holds no snapshot yet.`}
          ${need ? html`<br />${need.sentence}` : ""}
        </p>`;
  return card(
    html`${status}
      <form method="post" action="/settings/backups/mirror" class="stack">
        ${field_("endpoint", "Endpoint", MIRROR_SEALED.endpoint)}
        ${field_("bucket", "Bucket", MIRROR_SEALED.bucket)}
        ${field_("region", "Region (optional)", MIRROR_SEALED.region)}
        ${field_("access_key", "Access key", MIRROR_SEALED.accessKey)}
        ${field_("secret_key", "Secret key", MIRROR_SEALED.secretKey, "password")}
        <div class="row-actions">
          ${btn("Seal mirror", { type: "submit", variant: "primary", icon: "lock" })}
          <button class="btn" type="submit" formaction="/settings/backups/mirror/now" formnovalidate>
            Mirror now
          </button>
          <button class="btn" type="submit" formaction="/settings/backups/mirror/clear" formnovalidate>
            Clear sealed mirror
          </button>
        </div>
      </form>`,
    { head: html`${icon("download")}<h2>Off-box mirror</h2>` },
  );
}

function destinationInput(form: Form): DestinationInput {
  return {
    endpoint: field(form, "endpoint").trim(),
    bucket: field(form, "bucket").trim(),
    region: field(form, "region").trim(),
    accessKey: field(form, "access_key").trim(),
    secretKey: field(form, "secret_key").trim(),
  };
}

/** POST /settings/backups/destination — seal the destination. */
export async function backupsDestination(ctx: Ctx): Promise<Response> {
  const denied = requireAdmin(ctx);
  if (denied) return denied;
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const saved = saveDestination(ctx.app, ctx.auth.user, destinationInput(form));
  return flashTo(
    ctx,
    "/settings/backups",
    saved.ok
      ? { message: saved.value }
      : { tone: "danger", message: saved.error },
  );
}

/** POST /settings/backups/test — list the bucket, say what came of it. */
export async function backupsTest(ctx: Ctx): Promise<Response> {
  const denied = requireAdmin(ctx);
  if (denied) return denied;
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const said = await testDestination(
    ctx.app,
    ctx.auth.user,
    destinationInput(form),
  );
  const message = said.ok ? said.value : "Not found.";
  return flashTo(ctx, "/settings/backups", {
    tone: message.startsWith("Reached") ? "success" : "danger",
    message,
  });
}

/** POST /settings/backups/clear — forget the sealed destination. */
export async function backupsClear(ctx: Ctx): Promise<Response> {
  const denied = requireAdmin(ctx);
  if (denied) return denied;
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  forgetDestination(ctx.app, ctx.auth.user);
  return flashTo(ctx, "/settings/backups", {
    message: "The sealed destination is cleared.",
  });
}

/** POST /settings/backups/now — take a snapshot, and say what came of it. */
export async function backupsNow(ctx: Ctx): Promise<Response> {
  const denied = requireAdmin(ctx);
  if (denied) return denied;
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const taken = await snapshotNow(ctx.app, ctx.auth.user);
  return flashTo(
    ctx,
    "/settings/backups",
    taken.ok ? { message: taken.value.says } : { tone: "danger", message: taken.error.says },
  );
}

/**
 * Each lane beside its newest object and its line (#9067); a lane without a
 * line says so, as information. Nothing when no lane has been read. The
 * verdict is the in-memory read the tile uses: no disk read on the live path.
 */
export function lanesCard(ctx: Ctx): Html | "" {
  const lanes = backupVerdict(ctx.app.config.dataDir, lastDrill(ctx.app.db)).lanes;
  if (lanes.length === 0) return "";
  // The glyph is the mark that is not colour alone: ok, !, and a dash for a lane that is retired.
  const mark = { green: "✓", red: "!", retired: "–" } as const;
  const lead = { green: "open", red: "closed", retired: "draft" } as const;
  return card(
    html`<ul id="backup-lanes" class="list setting-list">
      ${lanes.map((l) =>
        row({
          lead: html`<span aria-hidden="true">${mark[l.state]}</span>`,
          state: lead[l.state],
          title: l.says,
          meta: html`${l.line}`,
          ...(l.state === "retired" ? { trail: badge("retired", { variant: "outline" }) } : {}),
          data: { lane: l.lane, "lane-state": l.state },
        }),
      )}
    </ul>`,
    { head: html`<strong>Lanes</strong>` },
  );
}

/** POST /settings/backups/drill — restore the newest snapshot, keep what came of it. */
export async function backupsDrill(ctx: Ctx): Promise<Response> {
  if (!ctx.auth.user) return signInFirst(ctx);
  if (!ctx.auth.user.isAdmin)
    return new Response("Forbidden", {
      status: 403,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const ran = await drillNow(ctx.app, ctx.auth.user);
  return flashTo(
    ctx,
    "/settings/backups",
    ran.ok && ran.value.verdict === "green"
      ? { message: ran.value.says }
      : { tone: "danger", message: ran.ok ? ran.value.says : ran.error.says },
  );
}

/** POST /settings/backups/mirror — seal the mirror. */
export async function backupsMirror(ctx: Ctx): Promise<Response> {
  const denied = requireAdmin(ctx);
  if (denied) return denied;
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const saved = saveMirror(ctx.app, ctx.auth.user, destinationInput(form));
  return flashTo(
    ctx,
    "/settings/backups",
    saved.ok ? { message: saved.value } : { tone: "danger", message: saved.error },
  );
}

/** POST /settings/backups/mirror/clear — forget the sealed mirror. */
export async function backupsMirrorClear(ctx: Ctx): Promise<Response> {
  const denied = requireAdmin(ctx);
  if (denied) return denied;
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  forgetMirror(ctx.app, ctx.auth.user);
  return flashTo(ctx, "/settings/backups", { message: "The sealed mirror is cleared." });
}

/** POST /settings/backups/mirror/now — bring the mirror level, and say what came of it. */
export async function backupsMirrorNow(ctx: Ctx): Promise<Response> {
  const denied = requireAdmin(ctx);
  if (denied) return denied;
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const level = await mirrorNow(ctx.app, ctx.auth.user);
  return flashTo(
    ctx,
    "/settings/backups",
    !level.ok
      ? { tone: "danger", message: level.error.says }
      : level.value.level
        ? { message: level.value.says }
        : { tone: "danger", message: level.value.says },
  );
}

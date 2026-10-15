/**
 * Backups, for an admin: where snapshots go, the last fourteen the store
 * holds, what the last one taken by this process said, and a button to
 * take one now. A forge given no store says so here rather than showing
 * an empty list that looks like a clean bill.
 *
 * Restoring is a command, not a button: it needs an empty data directory
 * and a stopped forge, and a person at a terminal is the one who has both.
 */

import {
  forgetDestination,
  saveDestination,
  testDestination,
  type DestinationInput,
} from "../../actions/destination.ts";
import { resolveDestination, sealedSet } from "../../snapshot/destination.ts";
import { keyOf } from "../../snapshot/snapshot.ts";
import { snapshotsOf } from "../../snapshot/service.ts";
import type { Ctx } from "../../http/context.ts";
import { notFoundPage, settingsLayout, signInFirst } from "../chrome.ts";
import { field, readForm, type Form } from "../form.ts";
import { html, when, type Html } from "../html.ts";
import { flashTo, page } from "../layout.ts";
import { btn, card, empty, fileSize, icon, time } from "../ui.ts";
import { accountSections } from "./origins.ts";

function requireAdmin(ctx: Ctx): Response | undefined {
  if (!ctx.auth.user) return signInFirst(ctx);
  if (!ctx.auth.user.isAdmin) return notFoundPage(ctx);
  return undefined;
}

function shell(ctx: Ctx, body: Html, moving = false): Response {
  return page({
    ctx,
    title: "Backups",
    ...(moving ? { refresh: { seconds: 5 } } : {}),
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
    ? html`<p>
        ${icon("check")} The key is wrapped under
        <code>FORGE_SNAPSHOT_PASSPHRASE</code> and travels with each
        snapshot.${last} Keep that passphrase somewhere other than this bucket:
        without it a restore brings back repositories and issues, but every
        sealed value (secrets, app variables, origin tokens) is lost and must be
        set again.
      </p>`
    : html`<p class="backups-error">
        ${icon("alert")} Snapshots carry no key: the bucket never holds key and
        data together, and a restore will bring back repositories and issues but
        not sealed values, which must be set again.${last} To carry the key
        wrapped, set <code>FORGE_SNAPSHOT_PASSPHRASE</code> and restart — and
        keep the passphrase elsewhere, because losing it loses those values.
      </p>`;
}

export async function backupsPage(ctx: Ctx): Promise<Response> {
  const denied = requireAdmin(ctx);
  if (denied) return denied;
  const svc = snapshotsOf(ctx.app);
  const form = destinationCard(ctx);
  if (svc === undefined || svc.store === undefined)
    return shell(
      ctx,
      html`${empty({
        icon: "download",
        title: "No snapshots are taken",
        note: "This forge was given nowhere to put them. On the platform an app's bucket (S3_*) is the place; on a machine, FORGE_SNAPSHOT_DIR names a directory. Seal a bucket below, or restart with one set, and a snapshot is taken every night at 08:00 UTC.",
      })}${form}`,
    );
  // The store is somewhere else; a listing that fails is a sentence on the
  // page, never a page that fails.
  const last = svc.last();
  let snapshots: Awaited<ReturnType<typeof svc.list>> = [];
  let listing: string | undefined;
  try {
    snapshots = await svc.list();
  } catch (error) {
    listing = String(error);
  }
  const restore = snapshots[0]
    ? html`<pre class="backups-restore">
bun run src/snapshot/restore.ts ${snapshots[0].name} /path/to/empty/data</pre>`
    : null;
  return shell(
    ctx,
    html`${card(
      html`<p>
          Every night at 08:00 UTC the forge writes what cannot be rebuilt — its
          database, its keys, every repository, every app's production data, the
          crew's logs — to <code>${svc.store.where}</code>, and keeps the newest
          fourteen.
        </p>
        ${keyNote(svc.wraps, snapshots[0])}
        ${when(
          svc.progress(),
          (p) =>
            html`<p class="backups-progress">
              ${icon("clock")} A snapshot is being taken: ${p.objects} objects,
              ${fileSize(p.bytes)} so far, ${Math.round(p.elapsedMs / 1000)} s
              in.
            </p>`,
        )}
        ${when(
          last.error,
          (error) =>
            html`<p class="backups-error">
              ${icon("alert")} The last snapshot failed ${time(last.at ?? "")}:
              ${error}
            </p>`,
        )}
        ${when(
          listing,
          (error) =>
            html`<p class="backups-error">
              ${icon("alert")} The store could not be listed just now: ${error}
            </p>`,
        )}
        <form method="post" action="/settings/backups/now" class="backups-now">
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
            </ul>`,
            {
              pad: false,
              head: html`${icon("history")}
                <h2>Snapshots</h2>`,
              foot: html`<span class="muted small"
                  >To restore, stop a forge, point it at an empty data
                  directory, and run this with the same S3_* variables or
                  FORGE_SNAPSHOT_DIR:</span
                >
                ${restore}`,
            },
          )
    }
    ${form}`,
    svc.progress() !== undefined,
  );
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
  const svc = snapshotsOf(ctx.app);
  if (svc === undefined)
    return flashTo(ctx, "/settings/backups", {
      tone: "danger",
      message: "This forge has nowhere to put a snapshot.",
    });
  try {
    const m = await svc.now();
    return flashTo(ctx, "/settings/backups", {
      message: `Snapshot ${m.name} taken: ${m.repos} repositories, ${m.apps} apps, ${fileSize(m.bytes)}.`,
    });
  } catch (error) {
    return flashTo(ctx, "/settings/backups", {
      tone: "danger",
      message: `The snapshot failed: ${String(error)}`,
    });
  }
}

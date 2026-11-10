/**
 * GET /settings/security: what an admin needs to trust the forge and to act
 * with no AI at hand, each fact beside its evidence and when it was checked.
 * A few small reads and one small file: no git and no heavy query, so it stays
 * quick while the forge is being flooded, which is when it is wanted. It shows
 * names, never the value of a token or key.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { changeShield, lastShieldChange, shieldState, SHIELD_DEFAULT, SHIELD_STATES, type ShieldState } from "../../actions/shield.ts";
import { notePhase, takeSessionTime } from "../../core/route_timing.ts";
import { backupOverdue, trafficAttention, TRAFFIC_WORDS } from "../../flow/kpi_words.ts";
import { readBackup } from "../../flow/kpis.ts";
import type { Ctx } from "../../http/context.ts";
import { violationsByDirective } from "../../http/csp_report.ts";
import { perfRecord } from "../../perf/live.ts";
import { getSignup } from "../../settings/signup.ts";
import { trafficHistory } from "../../perf/traffic_store.ts";
import { lastDrill } from "../../snapshot/drills.ts";
import { notFoundPage, settingsLayout, signInFirst } from "../chrome.ts";
import { field, readForm } from "../form.ts";
import { html, type Html } from "../html.ts";
import { flashTo, page } from "../layout.ts";
import { badge, btn, time } from "../ui.ts";
import { accountSections } from "./origins.ts";

const DAY_MS = 86_400_000;
const WINDOW_DAYS = 30;
/** One list's most rows; past it the page says so rather than seem complete. */
const MAX_ROWS = 100;
const REPORT_MAX_BYTES = 64 * 1024;
const REPORT_STALE_DAYS = 8;
const RUNBOOK = "/trevato/forge/blob/main/docs/SECURITY-RUNBOOK.md";

/**
 * `<dataDir>/security-report.json`, written whole by a timer outside the forge:
 * `at` is an ISO date, `secretScan.findings` is how many secrets the scan found
 * (a count, never the secrets), `selfTest.failed` is how many checks failed.
 * Missing or malformed, the page says "not run".
 */
export interface SecurityReport {
  readonly at: string;
  readonly secretScan: { readonly findings: number };
  readonly selfTest: { readonly passed: number; readonly failed: number };
}

const isCount = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 0;

export function readSecurityReport(dataDir: string): SecurityReport | null {
  const path = join(dataDir, "security-report.json");
  try {
    if (!existsSync(path) || statSync(path).size > REPORT_MAX_BYTES) return null;
    const r = JSON.parse(readFileSync(path, "utf8")) as Partial<SecurityReport> | null;
    if (typeof r?.at !== "string" || Number.isNaN(Date.parse(r.at))) return null;
    if (!isCount(r.secretScan?.findings) || !isCount(r.selfTest?.passed) || !isCount(r.selfTest?.failed)) return null;
    return { at: r.at, secretScan: { findings: r.secretScan.findings }, selfTest: { passed: r.selfTest.passed, failed: r.selfTest.failed } };
  } catch {
    return null;
  }
}

const SHIELD_WORDS: Record<ShieldState, { name: string; does: string }> = {
  open: {
    name: "Open",
    does: "No budget on anonymous readers or crawlers. A single crawler can slow the forge, so use this only if the ceiling is refusing people it should not.",
  },
  ceiling: {
    name: "Ceiling",
    does: "The usual setting. Anonymous readers and crawlers can read until they use up a per-minute budget, then wait.",
  },
  signin: {
    name: "Sign-in only",
    does: "Anonymous visitors get a short page asking them to sign in on file, commit, blame and diff pages. Use this when the forge is slow because of them. Repository front pages and git clone keep working.",
  },
};

/** The form that moves the Shield: one button, one state, so undoing is one click. */
/** Who came in today, and the one setting that stops more: `/admin/signup`, as on the limits page. */
function newAccountsRow(db: Database, nowMs: number): Html {
  const today = new Date(nowMs);
  today.setUTCHours(0, 0, 0, 0);
  const count =
    db
      .query<{ n: number }, [string]>(
        "SELECT COUNT(*) AS n FROM user WHERE kind = 'user' AND is_agent = 0 AND removed_at IS NULL AND created_at >= ?1",
      )
      .get(today.toISOString())?.n ?? 0;
  const signup = getSignup(db);
  return statusRow(
    "New accounts",
    html`${count} new account${count === 1 ? "" : "s"} today. Sign-up is ${signup}.`,
    html`<a href="/settings/people">See who</a>
      ${signup === "closed"
        ? null
        : html`<form method="post" action="/admin/signup" class="inline">
            <input type="hidden" name="signup" value="closed" />
            ${btn("Close sign-up now", { size: "sm", variant: "outline" })}
          </form>`}`,
    "new-accounts",
  );
}

/** One line of the page: what it is, how it stands, what you can do. */
function statusRow(label: string, state: Html, action: Html | null = null, id?: string): Html {
  return html`<div class="status-row" ${id === undefined ? null : html`id="${id}"`}>
    <dt>${label}</dt>
    <dd>${state}</dd>
    <dd class="status-act">${action}</dd>
  </div>`;
}

const shieldButton = (to: ShieldState, label: string, variant?: "primary"): Html =>
  html`<form method="post" action="/settings/security/shield" class="inline">
    <input type="hidden" name="state" value="${to}" />
    ${btn(label, { type: "submit", size: "sm", ...(variant === undefined ? {} : { variant }) })}
  </form>`;

/** The Shield: three states side by side, the one on pressed, and what it does said once below. */
function shieldCard(ctx: Ctx): Html {
  const now = shieldState(ctx.app);
  const last = lastShieldChange(ctx.app.db);
  const undo = last !== null && last.to === now ? last.from : null;
  return html`<section class="settings-block" id="shield">
    <div class="bar">
      <h2>Shield</h2>
      <div class="segmented" role="group" aria-label="Shield">
        ${SHIELD_STATES.map((state) =>
          state === now
            ? html`<span class="segmented-on" aria-current="true">${SHIELD_WORDS[state].name}</span>`
            : html`<form method="post" action="/settings/security/shield">
                <input type="hidden" name="state" value="${state}" />
                <button type="submit" aria-label="Switch to ${SHIELD_WORDS[state].name}">${SHIELD_WORDS[state].name}${state === SHIELD_DEFAULT ? html` <span class="muted">(default)</span>` : null}</button>
              </form>`,
        )}
      </div>
      ${undo === null ? null : shieldButton(undo, `Undo: back to ${SHIELD_WORDS[undo].name}`, "primary")}
    </div>
    <p class="small muted">
      ${SHIELD_WORDS[now].does} Signed-in people and tokens are never affected.
      ${last === null ? "Never changed." : html`Set by ${last.by ?? "someone since removed"} ${time(last.at)}.`}
    </p>
  </section>`;
}

/** A list under the status rows, full width, only when it has rows. */
const detail = (title: string, body: Html): Html =>
  html`<section class="settings-block"><h2>${title}</h2>${body}</section>`;

/** A small table, or the words for none, and an honest note when the list was cut. */
function list(caption: string, heads: readonly string[], rows: readonly (readonly (Html | string)[])[], none: string): Html {
  if (rows.length === 0) return html`<p class="muted">${none}</p>`;
  return html`<div class="table-scroll">
      <table class="table" data-dense>
        <caption class="sr-only">
          ${caption}
        </caption>
        <thead>
          <tr>
            ${heads.map((h) => html`<th scope="col">${h}</th>`)}
          </tr>
        </thead>
        <tbody>
          ${rows.slice(0, MAX_ROWS).map((r) => html`<tr>${r.map((c) => html`<td>${c}</td>`)}</tr>`)}
        </tbody>
      </table>
    </div>
    ${rows.length > MAX_ROWS ? html`<p class="small muted">Showing the first ${MAX_ROWS}; there are more.</p>` : null}`;
}

function peopleRows(db: Database, since: string, nowIso: string) {
  const cap = MAX_ROWS + 1;
  return {
    admins: db
      .query<{ username: string; is_agent: number; suspended_at: string | null }, []>(
        "SELECT username, is_agent, suspended_at FROM user WHERE is_admin = 1 ORDER BY username",
      )
      .all(),
    adminTokens: db
      .query<{ name: string; username: string; last_used_at: string | null }, [string, number]>(
        `SELECT t.name, u.username, t.last_used_at FROM token t JOIN user u ON u.id = t.user_id
          WHERE t.scope = 'admin' AND (t.expires_at IS NULL OR t.expires_at > ?1)
          ORDER BY t.last_used_at IS NULL, t.last_used_at DESC LIMIT ?2`,
      )
      .all(nowIso, cap),
    added: db
      .query<{ what: string; name: string; username: string; created_at: string }, [string, number]>(
        `SELECT 'Token' AS what, t.name AS name, u.username AS username, t.created_at AS created_at FROM token t JOIN user u ON u.id = t.user_id
          WHERE t.created_at >= ?1 AND u.kind = 'user' AND u.is_agent = 0
         UNION ALL
         SELECT 'SSH key' AS what, k.name AS name, u.username AS username, k.created_at AS created_at FROM user_key k JOIN user u ON u.id = k.user_id
          WHERE k.created_at >= ?1 AND u.kind = 'user' AND u.is_agent = 0
         ORDER BY created_at DESC LIMIT ?2`,
      )
      .all(since, cap),
  };
}

function deletedRows(db: Database, since: string): (readonly (Html | string)[])[] {
  const rows = db
    .query<{ payload: string; username: string | null; created_at: string }, [string, number]>(
      `SELECT e.payload, u.username, e.created_at FROM event e LEFT JOIN user u ON u.id = e.actor_id
        WHERE e.kind = 'repo.deleted' AND e.created_at >= ?1 ORDER BY e.id DESC LIMIT ?2`,
    )
    .all(since, MAX_ROWS + 1);
  return rows.map((r) => {
    let said: { repo?: unknown; door?: unknown; by?: unknown } = {};
    try {
      said = JSON.parse(r.payload) as typeof said;
    } catch {
      // An unreadable event still counts as a deletion; the row says what it can.
    }
    const door = said.door ?? said.by;
    return [
      typeof said.repo === "string" ? said.repo : "not recorded",
      r.username ?? "unknown",
      typeof door === "string" ? door : "not recorded",
      time(r.created_at),
    ];
  });
}

function reportRow(dataDir: string, nowMs: number): Html {
  const r = readSecurityReport(dataDir);
  if (r === null)
    return statusRow(
      "Secret scan and self-test",
      html`${badge("Not run", { tone: "attn" })} No readable <span class="mono">security-report.json</span> in the data directory.`,
    );
  const stale = nowMs - Date.parse(r.at) > REPORT_STALE_DAYS * DAY_MS;
  return statusRow(
    "Secret scan and self-test",
    html`${stale ? html`${badge("Out of date", { tone: "attn" })} ` : null}
      ${r.secretScan.findings === 0 ? badge("No secrets found", { tone: "success" }) : badge(`${r.secretScan.findings} found`, { tone: "danger" })}
      ${r.selfTest.failed === 0 ? badge(`${r.selfTest.passed} checks passed`, { tone: "success" }) : badge(`${r.selfTest.failed} checks failed`, { tone: "danger" })}
      <span class="muted">${time(r.at)}</span>`,
  );
}

/** What browsers said the Content-Security-Policy blocked this week, by directive; nothing when nothing was. */
function cspRow(db: Database, nowMs: number): Html | null {
  const week = violationsByDirective(db, 7, new Date(nowMs));
  if (week.length === 0) return null;
  return statusRow(
    "Blocked by the page policy, 7 days",
    html`${week.map((w, i) => html`${i > 0 ? ", " : ""}<span class="mono">${w.directive}</span> ${w.n}`)}`,
    null,
    "csp",
  );
}

export function securityPage(ctx: Ctx): Response {
  if (!ctx.auth.user) return signInFirst(ctx);
  if (!ctx.auth.user.isAdmin) return notFoundPage(ctx);
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const rendering = performance.now();
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const since = new Date(nowMs - WINDOW_DAYS * DAY_MS).toISOString();
  const db = ctx.app.db;
  const dataDir = ctx.app.config.dataDir;

  const traffic = trafficHistory(db, perfRecord.ledger, nowMs, "15m");
  const wrong = trafficAttention(traffic);
  const { admins, adminTokens, added } = peopleRows(db, since, nowIso);
  const { backup, backupAt } = readBackup(db, dataDir, nowMs);
  const drill = lastDrill(db);
  const overdue = backup !== null ? backup.state === "red" : backupOverdue(backupAt, new Date(nowMs));

  const none = (n: number, what: string) => (n === 0 ? html`<span class="muted">None</span>` : html`${n} ${what}`);
  const deleted = deletedRows(db, since);
  const body = html`<p class="small muted mb">
      Checked ${time(nowIso)}. <a href="/settings/security/controls">Each safeguard, and when it was last tested.</a> Something looks wrong? <a href="${RUNBOOK}" title="docs/SECURITY-RUNBOOK.md">The runbook</a> says what to do.
    </p>
    ${shieldCard(ctx)}
    <dl class="status-rows">
      ${newAccountsRow(db, nowMs)}
      ${statusRow(
        "Traffic",
        html`${wrong === null ? null : html`${badge("Look at this", { tone: "danger" })} ${TRAFFIC_WORDS[wrong]} took over half the answering time. `}
          ${traffic.requests} requests, ${traffic.refused} refused in 15 minutes.`,
        html`<a href="/settings/traffic">Traffic</a>`,
      )}
      ${statusRow(
        "Backup",
        backupAt === null
          ? html`${badge("None", { tone: "attn" })} No backup off the machine is known yet.`
          : html`${overdue ? badge("Overdue", { tone: "danger" }) : badge("Recent", { tone: "success" })} Last off the machine ${time(backupAt)}.`,
        html`<a href="/settings/backups">Backups</a>`,
      )}
      ${statusRow(
        "Restore drill",
        drill === undefined
          ? html`${badge("Not run", { tone: "attn" })} No restore drill has run.`
          : html`${drill.verdict === "green" ? badge("Passed", { tone: "success" }) : badge("Failed", { tone: "danger" })} Last ran ${time(drill.at)}.`,
      )}
      ${reportRow(dataDir, nowMs)}
      ${cspRow(db, nowMs)}
      ${statusRow("Admin accounts", html`${admins.map((a, i) => html`${i > 0 ? ", " : ""}${a.username}${a.is_agent === 1 ? " (agent)" : ""}${a.suspended_at === null ? "" : " (suspended)"}`)}`)}
      ${statusRow("Admin-scope tokens", none(adminTokens.length, adminTokens.length === 1 ? "token" : "tokens"))}
      ${statusRow(`Keys and tokens added, ${WINDOW_DAYS} days`, none(added.length, "added"))}
      ${statusRow(`Deleted repositories, ${WINDOW_DAYS} days`, none(deleted.length, "deleted"))}
    </dl>
    ${adminTokens.length === 0
      ? null
      : detail(
          "Admin-scope tokens",
          list(
            "Tokens with admin scope and their last use",
            ["Token name", "Account", "Last used"],
            adminTokens.map((t) => [t.name, t.username, t.last_used_at === null ? "Never" : time(t.last_used_at)]),
            "No admin-scope tokens.",
          ),
        )}
    ${added.length === 0
      ? null
      : detail(
          `Tokens and SSH keys people added, last ${WINDOW_DAYS} days`,
          list(
            "Tokens and SSH keys added by people",
            ["What", "Name", "Account", "Added"],
            added.map((a) => [a.what, a.name, a.username, time(a.created_at)]),
            `Nothing added in the last ${WINDOW_DAYS} days.`,
          ),
        )}
    ${deleted.length === 0
      ? null
      : detail(
          `Deleted repositories, last ${WINDOW_DAYS} days`,
          list("Deleted repositories", ["Repository", "By", "How", "When"], deleted, `None deleted in the last ${WINDOW_DAYS} days.`),
        )}`;
  notePhase(ctx.request, "render", performance.now() - rendering);
  return page({
    ctx,
    title: "Security",
    body: html`<div class="page-head"><h1>Security</h1></div>
      ${settingsLayout(accountSections("security", { admin: true }), body, "Account settings")}`,
  });
}

/** POST /settings/security/shield: move the Shield; the page's Undo posts here too. */
export async function securityShieldSet(ctx: Ctx): Promise<Response> {
  if (!ctx.auth.user) return signInFirst(ctx);
  if (!ctx.auth.user.isAdmin) return notFoundPage(ctx);
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const changed = changeShield(ctx.app, ctx.auth.user, field(form, "state"));
  if (!changed.ok && changed.error === "not_found") return notFoundPage(ctx);
  return flashTo(
    ctx,
    "/settings/security",
    changed.ok ? { message: `Shield is ${SHIELD_WORDS[changed.value.to].name}.` } : { tone: "danger", message: "That is not a Shield state." },
  );
}

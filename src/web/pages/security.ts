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
import { perfRecord } from "../../perf/live.ts";
import { trafficHistory } from "../../perf/traffic_store.ts";
import { lastDrill } from "../../snapshot/drills.ts";
import { notFoundPage, settingsLayout, signInFirst } from "../chrome.ts";
import { field, readForm } from "../form.ts";
import { html, type Html } from "../html.ts";
import { flashTo, page } from "../layout.ts";
import { badge, btn, card, time } from "../ui.ts";
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
const shieldButton = (to: ShieldState, label: string, variant?: "primary"): Html =>
  html`<form method="post" action="/settings/security/shield" class="mt">
    <input type="hidden" name="state" value="${to}" />
    ${btn(label, { type: "submit", ...(variant === undefined ? {} : { variant }) })}
  </form>`;

function shieldCard(ctx: Ctx): Html {
  const now = shieldState(ctx.app);
  const last = lastShieldChange(ctx.app.db);
  const undo = last !== null && last.to === now ? last.from : null;
  return card(
    html`<p>
        Now: <strong>${SHIELD_WORDS[now].name}</strong>.
        ${last === null ? "Never changed." : html`Set by ${last.by ?? "someone since removed"} ${time(last.at)}.`}
      </p>
      <p class="small muted">Signed-in people and tokens are never affected, in any state.</p>
      ${undo === null ? null : shieldButton(undo, `Undo: back to ${SHIELD_WORDS[undo].name}`, "primary")}
      ${SHIELD_STATES.map(
        (state) =>
          html`<div class="mt">
            <strong>${SHIELD_WORDS[state].name}</strong>
            ${state === now ? badge("On", { tone: "success" }) : null}
            ${state === SHIELD_DEFAULT ? badge("Default", { variant: "outline" }) : null}
            <p class="small muted">${SHIELD_WORDS[state].does}</p>
            ${state === now || state === undo ? null : shieldButton(state, `Switch to ${SHIELD_WORDS[state].name}`)}
          </div>`,
      )}`,
    { id: "shield", head: html`<h2>Shield</h2>` },
  );
}

/** A section: a head, what it shows, when that was checked. */
const section = (title: string, checked: string | null, body: Html): Html =>
  card(
    html`${body}
      <p class="small muted mt">${checked === null ? "Not checked yet." : html`Checked ${time(checked)}.`}</p>`,
    { head: html`<h2>${title}</h2>` },
  );

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

function reportSection(dataDir: string, nowMs: number): Html {
  const r = readSecurityReport(dataDir);
  if (r === null)
    return section(
      "Secret scan and self-test",
      null,
      html`<p>${badge("Not run", { tone: "attn" })} No readable report at <span class="mono">security-report.json</span> in the forge's data directory.</p>`,
    );
  const stale = nowMs - Date.parse(r.at) > REPORT_STALE_DAYS * DAY_MS;
  return section(
    "Secret scan and self-test",
    r.at,
    html`${stale ? html`<p>${badge("Out of date", { tone: "attn" })} The timer has not written a report in over ${REPORT_STALE_DAYS} days.</p>` : null}
      <p>
        ${r.secretScan.findings === 0 ? badge("No secrets found", { tone: "success" }) : badge(`${r.secretScan.findings} found`, { tone: "danger" })}
        ${r.selfTest.failed === 0 ? badge(`${r.selfTest.passed} checks passed`, { tone: "success" }) : badge(`${r.selfTest.failed} checks failed`, { tone: "danger" })}
      </p>`,
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

  const body = html`<p class="mb">
      Each section shows what the forge knows and when it checked. If something looks wrong,
      <a href="${RUNBOOK}">the security runbook</a> says what to do without any AI (<span class="mono">docs/SECURITY-RUNBOOK.md</span> in the forge's source).
    </p>
    ${shieldCard(ctx)}
    ${section(
      "Traffic",
      nowIso,
      html`<p>
        ${wrong === null ? null : html`${badge("Look at this", { tone: "danger" })} ${TRAFFIC_WORDS[wrong]} took over half the answering time. `}
        ${traffic.requests} requests and ${traffic.refused} refused in the last 15 minutes.
        <a href="/settings/traffic">See who is using the forge</a>.
      </p>`,
    )}
    ${section(
      "Admin accounts",
      nowIso,
      list(
        "Accounts with admin rights",
        ["Account", "Kind", "Standing"],
        admins.map((a) => [a.username, a.is_agent === 1 ? "Agent" : "Person", a.suspended_at === null ? "Active" : "Suspended"]),
        "No admin accounts.",
      ),
    )}
    ${section(
      "Admin-scope tokens",
      nowIso,
      list(
        "Tokens with admin scope and their last use",
        ["Token name", "Account", "Last used"],
        adminTokens.map((t) => [t.name, t.username, t.last_used_at === null ? "Never" : time(t.last_used_at)]),
        "No admin-scope tokens.",
      ),
    )}
    ${section(
      `Tokens and SSH keys people added, last ${WINDOW_DAYS} days`,
      nowIso,
      list(
        "Tokens and SSH keys added by people",
        ["What", "Name", "Account", "Added"],
        added.map((a) => [a.what, a.name, a.username, time(a.created_at)]),
        `Nothing added in the last ${WINDOW_DAYS} days.`,
      ),
    )}
    ${section(
      `Deleted repositories, last ${WINDOW_DAYS} days`,
      nowIso,
      list("Deleted repositories", ["Repository", "By", "How", "When"], deletedRows(db, since), `None deleted in the last ${WINDOW_DAYS} days.`),
    )}
    ${section(
      "Backup and restore drill",
      nowIso,
      html`<p>
          ${backupAt === null
            ? html`${badge("None", { tone: "attn" })} No backup off the machine is known yet.`
            : html`${overdue ? badge("Overdue", { tone: "danger" }) : badge("Recent", { tone: "success" })} The last backup off the machine was ${time(backupAt)}.`}
        </p>
        <p>
          ${drill === undefined
            ? html`${badge("Not run", { tone: "attn" })} No restore drill has run.`
            : html`${drill.verdict === "green" ? badge("Passed", { tone: "success" }) : badge("Failed", { tone: "danger" })} The last restore drill ran ${time(drill.at)}.`}
          <a href="/settings/backups">Backups</a>.
        </p>`,
    )}
    ${reportSection(dataDir, nowMs)}`;
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

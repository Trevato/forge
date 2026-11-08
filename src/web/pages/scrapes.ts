/**
 * /settings/traffic/scrapes: what was read, who it was, and whether one actor
 * sat behind several addresses (`perf/reads.ts`, `perf/network.ts`,
 * `perf/capture.ts`, `perf/actors.ts`). Admin only. Full addresses appear
 * here and in the export only while a capture holds them. Every statement
 * of identity stops at a network or a group, and says so.
 */

import { notePhase, takeSessionTime } from "../../core/route_timing.ts";
import type { Ctx } from "../../http/context.ts";
import { repoDir } from "../../git/repos.ts";
import { perfRecord, captureStore, readLedger } from "../../perf/live.ts";
import { groupRequests, type Group } from "../../perf/actors.ts";
import { CAPTURE_MAX, CAPTURE_MS } from "../../perf/capture.ts";
import { networkTable, parseNetworks, saveNetworks, type Network, type NetworkTable } from "../../perf/network.ts";
import { addCoverage, isCommit, READ_DAYS_MAX, readsReport, type RepoReads } from "../../perf/reads.ts";
import { trafficHistory } from "../../perf/traffic_store.ts";
import { notFoundPage, settingsLayout, signInFirst } from "../chrome.ts";
import { field, readForm } from "../form.ts";
import { html, type Html } from "../html.ts";
import { flashTo, page } from "../layout.ts";
import { badge, btn, card, empty, seg } from "../ui.ts";
import { accountSections } from "./origins.ts";

const DAYS = [1, 3, 7] as const;
const SHOWN_REQUESTS = 100;
const BASE = "/settings/traffic/scrapes";

/** What the evidence cannot show, said wherever a finding is. */
export const LIMITS =
  "This shows a network and a pattern of requests. It does not show who is behind either: a network's name is what the forge's own table says, requests that look alike may come from different people, and nothing here is proof of who did what.";

const days = (raw: string | null): number => {
  const n = Number(raw);
  return (DAYS as readonly number[]).includes(n) ? n : 1;
};

function admin(ctx: Ctx): Response | null {
  if (!ctx.auth.user) return signInFirst(ctx);
  if (!ctx.auth.user.isAdmin) return notFoundPage(ctx);
  return null;
}

function whose(n: Network | null): Html {
  if (n === null)
    return html`<span class="muted">No network on file: the evidence stops at this address range.</span>`;
  return html`${n.name}${n.operator ? html`, run by ${n.operator}` : null} (${n.country})${n.scope === "part"
      ? html` <span class="muted">— covers only part of this range</span>`
      : null}`;
}

function readsCard(r: RepoReads, from: number): Html {
  const commits = r.commits.filter((c) => isCommit(c.ref));
  return card(
    html`<p class="small">
        <strong class="break">${r.repo}</strong>: ${r.requests} reads, ${r.anonymous} anonymous,
        ${r.paths} distinct paths.
        ${r.coverage === undefined || r.coverage === null
          ? html`<span class="muted">Coverage unknown.</span>`
          : html`About ${Math.round(r.coverage * 100)}% of its ${r.files} files were read in the last ${from}
              ${from === 1 ? "day" : "days"}.`}
      </p>
      ${r.secrets.length === 0
        ? null
        : html`<p class="small">
              ${badge("Looks like a secret", { tone: "danger" })} Files read whose names look like keys or
              credentials (a guess from the name; the contents were not looked at):
            </p>
            <ul class="small">
              ${r.secrets.map((p) => html`<li class="break">${p.path} — ${p.requests}</li>`)}
            </ul>`}
      <p class="small muted mb">Most read:</p>
      <ul class="small">
        ${r.topPaths.map((p) => html`<li class="break">${p.path} — ${p.requests} (${p.anonymous} anonymous)</li>`)}
      </ul>
      ${commits.length === 0
        ? null
        : html`<p class="small muted">Commits read:
            ${commits.map((c) => html`<code>${c.ref.slice(0, 12)}</code> ${c.requests} `)}</p>`}`,
  );
}

function captureCard(now: number): Html {
  const c = captureStore.current(now);
  if (c === null)
    return card(
      html`<p class="small">
          A capture keeps full addresses and the shape of requests so one actor can be told across addresses.
          It lasts ${CAPTURE_MS / 60_000} minutes or ${CAPTURE_MAX} requests, keeps no cookies, tokens or
          query strings, skips signed-in people, and is deleted when it ends.
        </p>
        <form method="post" action="${BASE}/capture" class="inline">${btn("Start a capture", { variant: "primary" })}</form>`,
    );
  return card(
    html`<p class="small">
        Capture <code>${c.id}</code> is running: ${c.entries.length} requests kept${c.full ? " (full: later requests are not kept)" : ""},
        ends in ${Math.max(0, Math.ceil((c.expiresAt - now) / 60_000))} min and is then deleted.
        <a href="${BASE}">Refresh</a>
      </p>
      <form method="post" action="${BASE}/stop" class="inline">${btn("Stop and delete it", { size: "sm" })}</form>`,
  );
}

function groupRow(g: Group, net: NetworkTable): Html {
  return html`<tr>
    <td class="break">${g.ua || "(none)"}<br /><span class="muted small">${g.language}</span></td>
    <td class="num">${g.size}</td>
    <td class="num">${g.perMinute}/min</td>
    <td class="num">${g.addresses.length}</td>
    <td>${badge(g.confidence, { tone: g.confidence === "high" ? "danger" : "default" })}</td>
    <td class="small">${g.prefixes.slice(0, 3).map((p) => html`<div class="break">${p}: ${whose(net.find(p))}</div>`)}</td>
    <td><a href="${BASE}?group=${g.id}#group">Requests</a></td>
  </tr>`;
}

function groupDetail(g: Group, net: NetworkTable): Html {
  return card(
    html`<h2 id="group">Group ${g.id}</h2>
      <p class="small">${g.size} requests from ${g.addresses.length} addresses, confidence ${g.confidence}.</p>
      <ul class="small">${g.reasons.map((r) => html`<li>${r}</li>`)}</ul>
      <p class="small muted">${LIMITS}</p>
      ${btn("Export for an abuse report", { href: `${BASE}/export?group=${g.id}`, size: "sm" })}
      <div class="table-scroll">
        <table class="table" data-dense>
          <caption class="sr-only">Requests behind group ${g.id}</caption>
          <thead><tr><th scope="col">Address</th><th scope="col">Request</th><th scope="col" class="num">Status</th><th scope="col">Network</th></tr></thead>
          <tbody>
            ${g.requests.slice(0, SHOWN_REQUESTS).map(
              (r) => html`<tr>
                <td class="break">${r.address}</td>
                <td class="break">${r.method} ${r.path}</td>
                <td class="num">${r.status}</td>
                <td class="small">${whose(net.find(r.address))}</td>
              </tr>`,
            )}
          </tbody>
        </table>
      </div>
      ${g.size > SHOWN_REQUESTS ? html`<p class="small muted">First ${SHOWN_REQUESTS} of ${g.size} shown.</p>` : null}`,
  );
}

export async function scrapesPage(ctx: Ctx): Promise<Response> {
  const denied = admin(ctx);
  if (denied) return denied;
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const rendering = performance.now();
  const now = Date.now();
  const q = new URL(ctx.request.url).searchParams;
  const d = days(q.get("days"));
  const net = networkTable(ctx.app.db);
  const reports = await Promise.all(
    readsReport(ctx.app.db, readLedger, now, d)
      .slice(0, 8)
      .map((r) => {
        const [owner, name] = r.repo.split("/");
        return addCoverage(r, () =>
          owner && name && /^[\w.-]+$/.test(owner) && /^[\w.-]+$/.test(name)
            ? repoDir(ctx.app.reposRoot, owner, name)
            : null,
        );
      }),
  );
  const prefixes = trafficHistory(ctx.app.db, perfRecord.ledger, now, "24h").tops.prefixes;
  const cap = captureStore.current(now);
  const groups = cap === null ? [] : groupRequests(cap.entries).filter((g) => g.size >= 3);
  const picked = groups.find((g) => g.id === q.get("group"));
  const body = html`<div class="mb">
      ${seg(DAYS.map((n) => ({ label: n === 1 ? "1 day" : `${n} days`, href: `${BASE}?days=${n}`, current: n === d })))}
    </div>
    <h2>What was read</h2>
    ${reports.length === 0
      ? empty({ icon: "users", title: "No file reads recorded in this window", note: `Reads are kept up to ${READ_DAYS_MAX} days.` })
      : reports.map((r) => readsCard(r, d))}
    <h2>Who it is</h2>
    ${card(
      prefixes.length === 0
        ? html`<p class="small muted">No address prefixes in the last 24 hours.</p>`
        : html`<div class="table-scroll"><table class="table" data-dense>
            <caption class="sr-only">Address prefixes and their networks</caption>
            <thead><tr><th scope="col">Prefix</th><th scope="col" class="num">Requests</th><th scope="col">Network (from the forge's own table)</th><th scope="col">Abuse contact</th></tr></thead>
            <tbody>${prefixes.map((p) => {
              const n = net.find(p.key);
              return html`<tr><td class="break">${p.key}</td><td class="num">${p.requests}</td><td class="small">${whose(n)}</td><td class="break small">${n?.abuse || "—"}</td></tr>`;
            })}</tbody></table></div>`,
    )}
    <h2>One actor across addresses</h2>
    ${captureCard(now)}
    ${cap === null
      ? null
      : groups.length === 0
        ? html`<p class="small muted">No group of three or more similar requests yet.</p>`
        : card(html`<div class="table-scroll"><table class="table" data-dense>
            <caption class="sr-only">Groups of requests that look alike</caption>
            <thead><tr><th scope="col">User agent</th><th scope="col" class="num">Requests</th><th scope="col" class="num">Rate</th><th scope="col" class="num">Addresses</th><th scope="col">Confidence</th><th scope="col">Networks</th><th scope="col"></th></tr></thead>
            <tbody>${groups.slice(0, 20).map((g) => groupRow(g, net))}</tbody></table></div>
            <p class="small muted">Groups share a user agent and the names and order of their headers. ${LIMITS}</p>`)}
    ${picked === undefined ? null : groupDetail(picked, net)}
    <h2>Networks on file</h2>
    ${card(html`<p class="small">${net.size} ranges. Lookups are local: no visitor address is sent to anyone. Paste lines of
        <code>range, name, operator, country, abuse contact</code> from a registry you looked up yourself.</p>
      <form method="post" action="${BASE}/networks">
        <textarea name="lines" rows="4" maxlength="200000" aria-label="Network ranges" placeholder="203.0.0.0/16, Example Hosting, Example Ltd, NL, abuse@example.net"></textarea>
        ${btn("Save networks", { size: "sm" })}
      </form>`)}`;
  notePhase(ctx.request, "render", performance.now() - rendering);
  return page({
    ctx,
    title: "Scrapes",
    body: html`<div class="page-head"><h1>Scrapes</h1></div>
      ${settingsLayout(accountSections("traffic", { admin: true }), body, "Account settings")}`,
  });
}

export async function captureStart(ctx: Ctx): Promise<Response> {
  const denied = admin(ctx);
  if (denied) return denied;
  const user = ctx.auth.user!;
  if (user.kind === "agent") return notFoundPage(ctx);
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const before = captureStore.current(Date.now());
  const c = captureStore.start(Date.now(), user.username);
  if (before === null)
    ctx.app.bus.append({ kind: "traffic.capture_started", actorId: user.id, payload: { id: c.id, minutes: CAPTURE_MS / 60_000 } });
  return flashTo(ctx, BASE, { message: `Capture ${c.id} is running.` });
}

export async function captureStop(ctx: Ctx): Promise<Response> {
  const denied = admin(ctx);
  if (denied) return denied;
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  captureStore.stop();
  return flashTo(ctx, BASE, { message: "Capture deleted." });
}

export async function networksImport(ctx: Ctx): Promise<Response> {
  const denied = admin(ctx);
  if (denied) return denied;
  const user = ctx.auth.user!;
  if (user.kind === "agent") return notFoundPage(ctx);
  const form = await readForm(ctx, "admin", 300_000);
  if (form instanceof Response) return form;
  const got = parseNetworks(field(form, "lines"));
  saveNetworks(ctx.app.db, got.rows, user.username, Date.now());
  if (got.rows.length > 0)
    ctx.app.bus.append({ kind: "traffic.networks_imported", actorId: user.id, payload: { count: got.rows.length } });
  const note = got.refused.length === 0 ? "" : ` Refused: ${got.refused.slice(0, 3).join("; ")}.`;
  return flashTo(ctx, BASE, {
    ...(got.refused.length > 0 && got.rows.length === 0 ? { tone: "danger" as const } : {}),
    message: `Saved ${got.rows.length} ranges.${note}`,
  });
}

/** A plain-text report for one group: what was seen, the networks and their abuse contacts, and what it cannot show. */
export function reportOf(g: Group, net: NetworkTable, capture: { id: string; startedAt: number }): string {
  const nets = new Map<string, Network | null>(g.prefixes.map((p) => [p, net.find(p)]));
  const first = Math.min(...g.requests.map((r) => r.at));
  const last = Math.max(...g.requests.map((r) => r.at));
  return [
    `Abuse report draft: group ${g.id} (capture ${capture.id})`,
    `Window: ${new Date(first).toISOString()} to ${new Date(last).toISOString()}`,
    `Requests: ${g.size} (${g.perMinute} per minute) from ${g.addresses.length} addresses. Confidence: ${g.confidence}.`,
    `User agent: ${g.ua || "(none)"}`,
    "",
    "Why these requests were grouped:",
    ...g.reasons.map((r) => `- ${r}`),
    "",
    "Networks (from the forge's own table; send to each abuse contact):",
    ...[...nets].map(([p, n]) =>
      n === null
        ? `- ${p}: no network on file; the evidence stops here.`
        : `- ${p}: ${n.name}${n.operator ? `, ${n.operator}` : ""} (${n.country}); abuse contact: ${n.abuse || "none on file"}`,
    ),
    "",
    "Addresses:",
    ...g.addresses.map((a) => `- ${a}`),
    "",
    "Sample requests:",
    ...g.requests.slice(0, 50).map((r) => `${new Date(r.at).toISOString()} ${r.address} ${r.method} ${r.path} ${r.status}`),
    "",
    `Limits: ${LIMITS}`,
    "",
  ].join("\n");
}

export function scrapesExport(ctx: Ctx): Response {
  const denied = admin(ctx);
  if (denied) return denied;
  const cap = captureStore.current(Date.now());
  const id = new URL(ctx.request.url).searchParams.get("group");
  const g = cap === null ? undefined : groupRequests(cap.entries).find((x) => x.id === id);
  if (cap === null || g === undefined) return notFoundPage(ctx);
  return new Response(reportOf(g, networkTable(ctx.app.db), cap), {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "content-disposition": `attachment; filename="abuse-report-${g.id}.txt"`,
      "cache-control": "no-store",
    },
  });
}

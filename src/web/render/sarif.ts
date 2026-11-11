/**
 * A SARIF file (Static Analysis Results Interchange Format 2.1.0, OASIS) as
 * its findings: one row per result (level, rule id, `file:line`, message),
 * grouped under each run's tool name (§3.14 `run.tool.driver.name`), with the
 * counts by level (§3.27.10 `result.level`: error, warning, note, none; an
 * absent level is a warning) at the top. A location is a link to that line in
 * the same repository when its URI is a plain relative path and the file
 * exists at the ref (`RenderInput.exists`); otherwise it is plain text. Every string is escaped. At most `RESULT_CAP` results
 * are drawn, and the page says how many were left out. Invalid JSON, or a
 * file with no `runs` array, falls back to the source with the reason.
 */

import { escapeHtml, html, raw } from "../html.ts";
import { fileSize } from "../ui.ts";
import type { Rendered, RenderInput } from "./renderers.ts";

/** Results drawn across all runs, whatever the file holds. */
export const RESULT_CAP = 1000;

const LEVELS = ["error", "warning", "note", "none"] as const;
type Level = (typeof LEVELS)[number];

export interface Finding {
  readonly level: Level;
  readonly rule: string;
  /** Repository-relative path, or the URI as written when it is not one. */
  readonly file: string;
  readonly line: number;
  readonly message: string;
}
export interface Run {
  readonly tool: string;
  readonly results: readonly Finding[];
}
export type Sarif = { readonly runs: Run[] } | { readonly error: string };

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** A `file:` or relative URI as a path from the repository root, if it is one. */
export function relativePath(uri: string): string | undefined {
  if (uri === "" || uri.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(uri)) return undefined;
  let path: string;
  try {
    path = decodeURIComponent(uri);
  } catch {
    return undefined;
  }
  if (/[\x00-\x1f\x7f\\?#]/.test(path)) return undefined;
  const parts = path.split("/").filter((p) => p !== "" && p !== ".");
  if (parts.length === 0 || parts.some((p) => p === "..") || parts.join("/").length > 4096) return undefined;
  return parts.join("/");
}

function finding(r: unknown): Finding {
  const o = isObj(r) ? r : {};
  const level = LEVELS.find((l) => l === o.level) ?? "warning";
  const rule = str(o.ruleId) || (isObj(o.rule) ? str(o.rule.id) : "");
  const msg = isObj(o.message) ? str(o.message.text) || str(o.message.markdown) : "";
  const loc = Array.isArray(o.locations) && isObj(o.locations[0]) ? o.locations[0] : {};
  const phys = isObj(loc.physicalLocation) ? loc.physicalLocation : {};
  const uri = isObj(phys.artifactLocation) ? str(phys.artifactLocation.uri) : "";
  const start = isObj(phys.region) ? phys.region.startLine : undefined;
  const line = typeof start === "number" && Number.isInteger(start) && start > 0 ? start : 0;
  return { level, rule, file: relativePath(uri) ?? uri, line, message: msg };
}

/** Parse a SARIF file's text. Pure; never throws. */
export function parseSarif(source: string): Sarif {
  let doc: unknown;
  try {
    doc = JSON.parse(source.replace(/^﻿/, ""));
  } catch (e) {
    return { error: `it is not valid JSON (${e instanceof Error ? e.message : "parse error"})` };
  }
  if (!isObj(doc) || !Array.isArray(doc.runs)) return { error: "it has no `runs` array" };
  const runs = doc.runs.map((run): Run => {
    const r = isObj(run) ? run : {};
    const driver = isObj(r.tool) && isObj(r.tool.driver) ? r.tool.driver : {};
    return {
      tool: str(driver.name) || "Unnamed tool",
      results: Array.isArray(r.results) ? r.results.map(finding) : [],
    };
  });
  return { runs };
}

const encodePath = (path: string): string => path.split("/").map(encodeURIComponent).join("/");

export function sarif(input: RenderInput): Rendered {
  const doc = parseSarif(new TextDecoder().decode(input.body));
  if ("error" in doc) return { content: html``, lines: 0, fallback: `This file is not drawn as findings: ${doc.error}.` };
  const total = doc.runs.reduce((n, r) => n + r.results.length, 0);
  const counts: Record<Level, number> = { error: 0, warning: 0, note: 0, none: 0 };
  for (const run of doc.runs) for (const f of run.results) counts[f.level]++;

  const where = (f: Finding): string => {
    const text = f.file === "" ? "—" : escapeHtml(f.line > 0 ? `${f.file}:${f.line}` : f.file);
    if (input.repo === undefined || input.exists === undefined || !input.exists(f.file) || f.file === "" || relativePath(f.file) !== f.file) return text;
    const href = `${input.repo.base}/blob/${input.repo.ref}/${encodePath(f.file)}${f.line > 0 ? `#L${f.line}` : ""}`;
    return `<a href="${escapeHtml(href)}">${text}</a>`;
  };

  let left = RESULT_CAP;
  let groups = "";
  for (const run of doc.runs) {
    const shown = run.results.slice(0, left);
    left -= shown.length;
    let rows = "";
    for (const f of shown)
      rows += `<tr><td>${f.level}</td><td>${escapeHtml(f.rule)}</td><td>${where(f)}</td><td>${escapeHtml(f.message).replace(/\n/g, "<br>")}</td></tr>`;
    const n = run.results.length;
    groups += `<h3>${escapeHtml(run.tool)} <span class="muted small">${n.toLocaleString()} ${n === 1 ? "result" : "results"}</span></h3>`;
    groups +=
      shown.length === 0
        ? `<p class="muted small">No results.</p>`
        : `<table class="table" data-dense aria-label="${escapeHtml(run.tool)} findings"><thead><tr><th scope="col">Level</th><th scope="col">Rule</th><th scope="col">Location</th><th scope="col">Message</th></tr></thead><tbody>${rows}</tbody></table>`;
  }
  const out = total - Math.min(total, RESULT_CAP);
  const more =
    out > 0
      ? `<p class="muted small">Showing ${RESULT_CAP.toLocaleString()} of ${total.toLocaleString()} results, ${out.toLocaleString()} left out. The rest is in the raw file.</p>`
      : "";
  const tally = LEVELS.map((l) => `${counts[l].toLocaleString()} ${l}`).join(" · ");
  const content = html`<div class="sarif-view"><p>${tally}</p>${raw(groups)}${raw(more)}</div>`;
  return { content, lines: 0, summary: `${total.toLocaleString()} ${total === 1 ? "result" : "results"} · ${fileSize(input.size)}` };
}

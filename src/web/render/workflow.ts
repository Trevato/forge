/**
 * A GitHub Actions workflow (`.github/workflows/*.yml|yaml`) as what it does:
 * the `on:` triggers in one line, then one block per job with its runner,
 * its `needs`, its matrix, and each step as one row (`uses`, else the first
 * line of `run`, headed by the step's name when it has one). A file that is
 * not YAML, or not a workflow (no `jobs` map), is not drawn: the source
 * shows with the reason. Every string is escaped and cut to `TEXT_CAP`; at
 * most `JOB_CAP` jobs and `STEP_CAP` steps per job are drawn.
 */

import { escapeHtml, html, raw } from "../html.ts";
import { fileSize } from "../ui.ts";
import type { Rendered, RenderInput } from "./renderers.ts";
import { parseAllDocuments } from "./vendor/yaml.mjs";

export const JOB_CAP = 100;
export const STEP_CAP = 200;
const TEXT_CAP = 300;

export interface Step {
  readonly name: string;
  /** `uses: x` or the first line of `run`; empty when the step has neither. */
  readonly does: string;
  readonly kind: "uses" | "run" | "";
}
export interface Job {
  readonly id: string;
  readonly name: string;
  readonly runsOn: string;
  readonly needs: string[];
  /** `os: a, b` per matrix axis. */
  readonly matrix: string[];
  readonly steps: Step[];
  readonly stepsTotal: number;
}
export type Workflow =
  | { readonly name: string; readonly triggers: string[]; readonly jobs: Job[]; readonly jobsTotal: number }
  | { readonly error: string };

const cut = (s: string): string => s.slice(0, TEXT_CAP);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown): string => (typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? cut(String(v)) : "");

/** A string or a list of strings as a list of strings. */
const words = (v: unknown): string[] =>
  (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]).map(text).filter((s) => s !== "");

function triggers(on: unknown): string[] {
  if (isObj(on)) return Object.keys(on).map(cut);
  return words(on);
}

function matrixOf(strategy: unknown): string[] {
  if (!isObj(strategy) || !isObj(strategy["matrix"])) return [];
  const out: string[] = [];
  for (const [axis, v] of Object.entries(strategy["matrix"])) {
    if (axis === "include" || axis === "exclude") {
      if (Array.isArray(v)) out.push(`${axis}: ${v.length} ${v.length === 1 ? "entry" : "entries"}`);
      continue;
    }
    const vals = words(v);
    out.push(`${cut(axis)}: ${vals.length > 0 ? vals.join(", ") : text(v)}`.slice(0, TEXT_CAP));
  }
  return out;
}

function stepOf(raw: unknown): Step {
  if (!isObj(raw)) return { name: "", does: "", kind: "" };
  const name = text(raw["name"]);
  if (typeof raw["uses"] === "string") return { name, does: cut(raw["uses"]), kind: "uses" };
  if (typeof raw["run"] === "string") {
    const first = raw["run"].split(/\r?\n/).find((l) => l.trim() !== "") ?? "";
    return { name, does: cut(first.trim()), kind: "run" };
  }
  return { name, does: "", kind: "" };
}

export function parseWorkflow(source: string): Workflow {
  const docs = parseAllDocuments(source, { maxAliasCount: 100 });
  const doc = docs[0];
  if (doc === undefined || docs.length > 1) return { error: "it is not one YAML document" };
  if (doc.errors.length > 0) return { error: `it is not valid YAML (${cut(doc.errors[0]!.message.split(" at line")[0]!.split("\n")[0]!)})` };
  let top: unknown;
  try {
    top = doc.toJS({ maxAliasCount: 100 });
  } catch {
    return { error: "it is not valid YAML" };
  }
  if (!isObj(top)) return { error: "it is not a map" };
  const jobsRaw = top["jobs"];
  if (!isObj(jobsRaw)) return { error: "it has no jobs" };
  // YAML 1.1 readers turn a bare `on` key into `true`; this one keeps the string, but accept both.
  const on = top["on"] ?? top["true"];
  const ids = Object.keys(jobsRaw);
  const jobs: Job[] = [];
  for (const id of ids.slice(0, JOB_CAP)) {
    const j = jobsRaw[id];
    const o = isObj(j) ? j : {};
    const steps = Array.isArray(o["steps"]) ? o["steps"] : [];
    jobs.push({
      id: cut(id),
      name: text(o["name"]),
      runsOn: isObj(o["runs-on"]) ? words(o["runs-on"]["labels"] ?? o["runs-on"]["group"]).join(", ") : words(o["runs-on"]).join(", "),
      needs: words(o["needs"]),
      matrix: matrixOf(o["strategy"]),
      steps: steps.slice(0, STEP_CAP).map(stepOf),
      stepsTotal: steps.length,
    });
  }
  return { name: text(top["name"]), triggers: triggers(on), jobs, jobsTotal: ids.length };
}

const code = (s: string): string => `<code>${escapeHtml(s)}</code>`;

export function workflow(input: RenderInput): Rendered {
  const doc = parseWorkflow(new TextDecoder().decode(input.body));
  if ("error" in doc) return { content: html``, lines: 0, fallback: `This file is shown as YAML because it is not drawn as a workflow: ${doc.error}.` };
  const on =
    doc.triggers.length === 0 ? "No triggers are set." : `Runs on ${doc.triggers.map(code).join(" ")}.`; // code() escapes
  let out = "";
  for (const j of doc.jobs) {
    const title = j.name === "" || j.name === j.id ? j.id : `${j.id}: ${j.name}`;
    const facts: [string, string[]][] = [["Runs on", j.runsOn === "" ? [] : [j.runsOn]], ["Needs", j.needs], ["Matrix", j.matrix]];
    const dl = facts.filter(([, v]) => v.length > 0);
    const list =
      dl.length === 0
        ? ""
        : `<dl class="status-rows" aria-label="${escapeHtml(title)} facts">${dl.map(([k, v]) => `<div class="status-row"><dt>${k}</dt><dd>${v.map(code).join(" ")}</dd></div>`).join("")}</dl>`;
    let rows = "";
    for (const s of j.steps) {
      const doing = s.does === "" ? "" : `${s.kind === "uses" ? "uses " : ""}${code(s.does)}`;
      rows += `<tr><td>${escapeHtml(s.name)}</td><td>${doing}</td></tr>`;
    }
    const table =
      rows === ""
        ? ""
        : `<table class="table" data-dense aria-label="${escapeHtml(title)} steps"><thead><tr><th scope="col">Step</th><th scope="col">Does</th></tr></thead><tbody>${rows}</tbody></table>`;
    const more = j.stepsTotal > j.steps.length ? `<p class="muted small">${(j.stepsTotal - j.steps.length).toLocaleString()} more steps not shown</p>` : "";
    out += `<section><h3>${escapeHtml(title)}</h3>${list}${table}${more}</section>`;
  }
  if (doc.jobsTotal > doc.jobs.length) out += `<p class="muted small">${(doc.jobsTotal - doc.jobs.length).toLocaleString()} more jobs not shown</p>`;
  return {
    content: html`<div class="workflow-view"><p>${raw(on)}</p>${raw(out)}</div>`,
    lines: 0,
    summary: `${doc.jobsTotal} ${doc.jobsTotal === 1 ? "job" : "jobs"} · ${fileSize(input.size)}`,
  };
}

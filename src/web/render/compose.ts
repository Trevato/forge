/**
 * A `compose.yaml` / `docker-compose.yml` as its services: one row per
 * service with its image or build context, ports, volumes, `depends_on` and
 * the NAMES of its environment variables, never their values. A file that is
 * not YAML or has no `services` map is not drawn: the source shows with the
 * reason, no error banner. Every string is escaped and cut to `TEXT_CAP`; at
 * most `SERVICE_CAP` services are drawn and `LIST_CAP` entries per column.
 */

import { escapeHtml, html, raw } from "../html.ts";
import { fileSize } from "../ui.ts";
import type { Rendered, RenderInput } from "./renderers.ts";
import { parseAllDocuments } from "./vendor/yaml.mjs";

export const SERVICE_CAP = 100;
export const LIST_CAP = 50;
const TEXT_CAP = 300;

export interface Service {
  readonly name: string;
  /** `image: x`, else `build: context`, else empty. */
  readonly source: string;
  readonly built: boolean;
  readonly ports: string[];
  readonly volumes: string[];
  readonly dependsOn: string[];
  /** Variable names only. */
  readonly env: string[];
}
export type Compose = { readonly services: Service[]; readonly total: number } | { readonly error: string };

const cut = (s: string): string => s.slice(0, TEXT_CAP);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const scalar = (v: unknown): string => (typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? cut(String(v)) : "");

/** A short or long form entry (`"80:80"` or `{target, published}`) as one string. */
function entry(v: unknown): string {
  if (!isObj(v)) return scalar(v);
  const a = scalar(v["published"] ?? v["source"]);
  const b = scalar(v["target"]);
  return cut(a !== "" && b !== "" ? `${a}:${b}` : a + b);
}
const list = (v: unknown): string[] => (Array.isArray(v) ? v : []).map(entry).filter((s) => s !== "").slice(0, LIST_CAP);

/** `environment` is a map or a list of `NAME=value` / `NAME`; only the name is kept. */
function envNames(v: unknown): string[] {
  const names = isObj(v)
    ? Object.keys(v)
    : Array.isArray(v)
      ? v.map((x) => (typeof x === "string" ? x.split("=")[0]!.trim() : ""))
      : [];
  return names.filter((n) => n !== "").map(cut).slice(0, LIST_CAP);
}

/** `depends_on` is a list or a map keyed by service. */
const dependsOn = (v: unknown): string[] => (isObj(v) ? Object.keys(v).map(cut).slice(0, LIST_CAP) : list(v));

function buildOf(v: unknown): string {
  if (typeof v === "string") return cut(v);
  return isObj(v) ? scalar(v["context"]) || "." : "";
}

export function parseCompose(source: string): Compose {
  const docs = parseAllDocuments(source, { maxAliasCount: 100 });
  const doc = docs[0];
  if (doc === undefined || docs.length > 1) return { error: "it is not one YAML document" };
  if (doc.errors.length > 0) return { error: "it is not valid YAML" };
  let top: unknown;
  try {
    top = doc.toJS({ maxAliasCount: 100 });
  } catch {
    return { error: "it is not valid YAML" };
  }
  if (!isObj(top) || !isObj(top["services"])) return { error: "no services" };
  const names = Object.keys(top["services"]);
  const services: Service[] = [];
  for (const name of names.slice(0, SERVICE_CAP)) {
    const s = isObj(top["services"][name]) ? (top["services"][name] as Record<string, unknown>) : {};
    const image = scalar(s["image"]);
    const build = image === "" ? buildOf(s["build"]) : "";
    services.push({
      name: cut(name),
      source: image || build,
      built: image === "" && build !== "",
      ports: list(s["ports"]),
      volumes: list(s["volumes"]),
      dependsOn: dependsOn(s["depends_on"]),
      env: envNames(s["environment"]),
    });
  }
  return { services, total: names.length };
}

const cell = (items: string[]): string => items.map((s) => `<code>${escapeHtml(s)}</code>`).join(" ");

export function compose(input: RenderInput): Rendered {
  const doc = parseCompose(new TextDecoder().decode(input.body));
  if ("error" in doc) return { content: html``, lines: 0, fallback: doc.error === "no services" ? "This file has no services, so it is shown as YAML." : `This file is shown as YAML because ${doc.error}.` };
  let rows = "";
  for (const s of doc.services) {
    const src = s.source === "" ? "" : `${s.built ? "build " : ""}<code>${escapeHtml(s.source)}</code>`;
    rows += `<tr><th scope="row">${escapeHtml(s.name)}</th><td>${src}</td><td>${cell(s.ports)}</td><td>${cell(s.volumes)}</td><td>${cell(s.dependsOn)}</td><td>${cell(s.env)}</td></tr>`;
  }
  const more = doc.total > doc.services.length ? `<p class="muted small">${(doc.total - doc.services.length).toLocaleString()} more services not shown</p>` : "";
  const table = `<table class="table" data-dense aria-label="Services"><thead><tr><th scope="col">Service</th><th scope="col">Image or build</th><th scope="col">Ports</th><th scope="col">Volumes</th><th scope="col">Depends on</th><th scope="col">Environment names</th></tr></thead><tbody>${rows}</tbody></table>`;
  return {
    content: html`<div class="table-scroll" role="region" tabindex="0" aria-label="Services">${raw(table)}</div>${raw(more)}`,
    lines: 0,
    summary: `${doc.total} ${doc.total === 1 ? "service" : "services"} · ${fileSize(input.size)}`,
  };
}

/**
 * A forge pack: a plain, versioned definition of a forge to start from — the
 * apps it brings (by public source), the crew it starts with, and a
 * description. Anyone can publish one as a `pack.json` in a repository. Pure:
 * `parsePack` reads text and returns a pack or the one sentence that says what
 * is wrong. A pack carries no data, secret or variable: any key that looks
 * like one is refused, never ignored, so a published pack cannot ask for them.
 */

import { isIP } from "node:net";
import { isRefusedAddress } from "../kernel/outbound.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { CREW_ROLES, type CrewRole } from "../core/agents.ts";

export const PACK_FORMAT = 1;
const NAME = /^[a-z][a-z0-9-]{0,39}$/;
const APP_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
const USERNAME = /^[a-z][a-z0-9-]{0,31}$/;
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;
const REPO_PART = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const MAX_APPS = 20;
const MAX_CREW = 10;
const MAX_TEXT = 2_000;
/** Keys a pack may never carry, at any depth: what a pack brings is code and crew only. */
const FORBIDDEN = /secret|password|token|credential|env|variable|data|key/i;

export interface PackApp {
  readonly name: string;
  readonly description: string;
  /** An https address of a public git repository, no credentials in it, or `owner/name` of a repository on this forge. */
  readonly source: string;
  readonly branch?: string;
  /** Deploy absorbs the app as a feature, as the deploying admin's act (an event). Only a yes is carried; it sets no setting. */
  readonly absorb?: boolean;
}

export interface PackCrew {
  readonly username: string;
  readonly roles: readonly CrewRole[];
  readonly brief: string;
  readonly model?: string;
  readonly budgetUsd?: number;
}

export interface Pack {
  readonly format: typeof PACK_FORMAT;
  readonly name: string;
  readonly title: string;
  readonly version: string;
  readonly description: string;
  readonly apps: readonly PackApp[];
  readonly crew: readonly PackCrew[];
}

const text = (v: unknown, max = MAX_TEXT): string | undefined =>
  typeof v === "string" && v.trim() !== "" && v.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v)
    ? v.trim()
    : undefined;

const FORGE_SOURCE = /^([A-Za-z0-9][A-Za-z0-9._-]{0,99})\/([A-Za-z0-9][A-Za-z0-9._-]{0,99})$/;

/** True when a source names a repository on this forge (`owner/name`) rather than an https address. */
export const isForgeSource = (source: string): boolean => FORGE_SOURCE.test(source);

/** The source's address if it names a public https repository or a forge repo (`owner/name`), else undefined. */
export function sourceOf(v: unknown): string | undefined {
  const raw = text(v, 300);
  if (raw !== undefined && FORGE_SOURCE.test(raw)) return raw;
  const url = raw === undefined ? null : URL.parse(raw);
  if (url === null || url.protocol !== "https:" || url.username !== "" || url.password !== "") return undefined;
  if (url.search !== "" || url.hash !== "") return undefined;
  // An internal address literal is refused at once; a name and a port are judged when it is
  // cloned (`source_guard.ts`), which alone knows the forge's own address.
  const literal = url.hostname.replace(/^\[|\]$/g, "");
  if ((isIP(literal) !== 0 && isRefusedAddress(literal))) return undefined;
  const parts = url.pathname.split("/").filter((s) => s !== "");
  if (parts.length !== 2) return undefined;
  const repo = parts[1]!.replace(/\.git$/, "");
  if (!REPO_PART.test(parts[0]!) || !REPO_PART.test(repo)) return undefined;
  return `https://${url.host.toLowerCase()}/${parts[0]}/${repo}`;
}

/** The first forbidden key anywhere in `v`, as a path, or undefined. */
function forbiddenKey(v: unknown, path = ""): string | undefined {
  if (Array.isArray(v)) {
    for (const [i, item] of v.entries()) {
      const hit = forbiddenKey(item, `${path}[${i}]`);
      if (hit !== undefined) return hit;
    }
  } else if (v !== null && typeof v === "object") {
    for (const [k, item] of Object.entries(v)) {
      if (FORBIDDEN.test(k)) return path === "" ? k : `${path}.${k}`;
      const hit = forbiddenKey(item, path === "" ? k : `${path}.${k}`);
      if (hit !== undefined) return hit;
    }
  }
  return undefined;
}

const bad = (m: string): Result<Pack, string> => err(`pack: ${m}`);

/** Read a pack's text. Every field is checked; nothing unknown rides along. */
export function parsePack(raw: string): Result<Pack, string> {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return bad("not JSON");
  }
  if (v === null || typeof v !== "object" || Array.isArray(v)) return bad("expected an object");
  const o = v as Record<string, unknown>;
  const hit = forbiddenKey(o);
  if (hit !== undefined)
    return bad(`"${hit}" is not allowed: a pack brings no data, secrets or variables`);
  if (o.pack !== PACK_FORMAT) return bad(`"pack" must be ${PACK_FORMAT}`);
  const name = typeof o.name === "string" && NAME.test(o.name) ? o.name : undefined;
  if (name === undefined) return bad(`"name" must be lowercase letters, digits and dashes`);
  const title = text(o.title, 80);
  if (title === undefined) return bad(`"title" is missing`);
  const version = typeof o.version === "string" && VERSION.test(o.version) ? o.version : undefined;
  if (version === undefined) return bad(`"version" must look like 1.0.0`);
  const description = text(o.description);
  if (description === undefined) return bad(`"description" is missing`);

  if (!Array.isArray(o.apps) || o.apps.length === 0 || o.apps.length > MAX_APPS)
    return bad(`"apps" must list 1 to ${MAX_APPS} apps`);
  const apps: PackApp[] = [];
  for (const a of o.apps as unknown[]) {
    const r = (a ?? {}) as Record<string, unknown>;
    const appName = typeof r.name === "string" && APP_NAME.test(r.name) ? r.name : undefined;
    const source = sourceOf(r.source);
    const about = text(r.description, 300);
    if (appName === undefined || source === undefined || about === undefined)
      return bad(`each app needs a name, a description and an https "source" naming a public repository`);
    if (apps.some((x) => x.name === appName)) return bad(`two apps are named "${appName}"`);
    const branch = r.branch === undefined ? undefined : text(r.branch, 100);
    if (r.branch !== undefined && (branch === undefined || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch)))
      return bad(`app "${appName}" has an unusable "branch"`);
    if (r.absorb !== undefined && typeof r.absorb !== "boolean") return bad(`app "${appName}" has an unusable "absorb": it is true or false`);
    apps.push({ name: appName, description: about, source, ...(branch === undefined ? {} : { branch }), ...(r.absorb === true ? { absorb: true } : {}) });
  }

  const crew: PackCrew[] = [];
  const asked = o.crew === undefined ? [] : o.crew;
  if (!Array.isArray(asked) || asked.length > MAX_CREW) return bad(`"crew" must list at most ${MAX_CREW} agents`);
  for (const c of asked as unknown[]) {
    const r = (c ?? {}) as Record<string, unknown>;
    const username = typeof r.username === "string" && USERNAME.test(r.username) ? r.username : undefined;
    const brief = text(r.brief, 4_000);
    const roles = Array.isArray(r.roles) && r.roles.length > 0 ? r.roles : undefined;
    if (username === undefined || brief === undefined || roles === undefined)
      return bad(`each crew member needs a username, roles and a brief`);
    if (!roles.every((x): x is CrewRole => CREW_ROLES.includes(x as CrewRole)))
      return bad(`crew roles are ${CREW_ROLES.join(", ")}`);
    if (crew.some((x) => x.username === username)) return bad(`two crew members are named "${username}"`);
    const model = r.model === undefined ? undefined : text(r.model, 80);
    if (r.model !== undefined && model === undefined) return bad(`crew "${username}" has an unusable "model"`);
    const budget = r.budgetUsd;
    if (budget !== undefined && (typeof budget !== "number" || !(budget >= 0 && budget <= 100)))
      return bad(`crew "${username}" has an unusable "budgetUsd"`);
    crew.push({
      username,
      roles: [...new Set(roles)],
      brief,
      ...(model === undefined ? {} : { model }),
      ...(budget === undefined ? {} : { budgetUsd: budget }),
    });
  }
  return ok({ format: PACK_FORMAT, name, title, version, description, apps, crew });
}

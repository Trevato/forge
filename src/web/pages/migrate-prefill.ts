/**
 * Migrate's link form: `/migrate?from=<host>/<owner>/<name>&crew=<agent>`.
 * Pure — the query and what the page already loaded in, the choice out.
 *
 * `from` is matched on the origin's full host (`URL(webUrl).host`: host and
 * any port, lower-cased) then `/<owner>/<name>`; never on the display label.
 */

export interface PrefillOrigin {
  readonly id: string;
  /** `URL(origin.webUrl).host` — lower-case, port kept. */
  readonly host: string;
  readonly repos: readonly { readonly fullName: string }[];
}

export interface Prefill {
  readonly repo?: { readonly originId: string; readonly fullName: string };
  readonly agent?: string;
  /** Values that matched nothing, as given (capped) — the page escapes them. */
  readonly unmatched: string[];
}

const FROM_MAX = 200;
const CREW_MAX = 64;
const FROM_SAFE = /^[A-Za-z0-9._:/\-[\]]+$/;
const CREW_SAFE = /^[A-Za-z0-9._-]+$/;

/** An origin's host as the link spells it. */
export function originHost(webUrl: string): string {
  return URL.parse(webUrl)?.host.toLowerCase() ?? "";
}

const shown = (v: string): string => (v.length > 80 ? `${v.slice(0, 80)}…` : v);

export function prefill(
  query: { from?: string | null; crew?: string | null },
  origins: readonly PrefillOrigin[],
  agents: readonly string[],
): Prefill {
  const unmatched: string[] = [];
  let repo: Prefill["repo"];
  let agent: string | undefined;

  const from = (query.from ?? "").trim();
  if (from !== "") {
    const slash = from.indexOf("/");
    if (from.length <= FROM_MAX && FROM_SAFE.test(from) && slash > 0) {
      const host = from.slice(0, slash).toLowerCase();
      const path = from.slice(slash + 1).toLowerCase();
      for (const origin of origins) {
        if (origin.host !== host) continue;
        const hit = origin.repos.find((r) => r.fullName.toLowerCase() === path);
        if (hit) {
          repo = { originId: origin.id, fullName: hit.fullName };
          break;
        }
      }
    }
    if (repo === undefined) unmatched.push(`from=${shown(from)}`);
  }

  const crew = (query.crew ?? "").trim();
  if (crew !== "") {
    if (crew.length <= CREW_MAX && CREW_SAFE.test(crew) && agents.includes(crew))
      agent = crew;
    else unmatched.push(`crew=${shown(crew)}`);
  }

  return {
    ...(repo ? { repo } : {}),
    ...(agent ? { agent } : {}),
    unmatched,
  };
}

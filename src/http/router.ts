/**
 * The router: pattern strings compiled to segment matchers. Three segment
 * kinds — literal, `:param` (one segment, optional literal suffix like
 * `:name.git`), and `*rest` (everything remaining, final position only).
 * Small enough to read whole; no regexes to squint at in route tables.
 */

import { defect } from "../kernel/error.ts";

export type Params = Record<string, string>;

type Segment =
  | { kind: "literal"; value: string }
  | { kind: "param"; name: string; suffix: string }
  | { kind: "rest"; name: string };

export interface Match<H> {
  handler: H;
  params: Params;
  /** The pattern string given to `add`, so callers can name the route. */
  pattern: string;
}

interface CompiledRoute<H> {
  method: string;
  pattern: string;
  segments: Segment[];
  handler: H;
}

function compile(pattern: string): Segment[] {
  if (!pattern.startsWith("/"))
    defect("router.bad_pattern", `pattern must start with /: ${pattern}`);
  const parts = pattern === "/" ? [""] : pattern.slice(1).split("/");
  const segments: Segment[] = [];
  for (const [i, part] of parts.entries()) {
    if (part.startsWith("*")) {
      if (i !== parts.length - 1)
        defect("router.bad_pattern", `*rest must be last: ${pattern}`);
      segments.push({ kind: "rest", name: part.slice(1) });
    } else if (part.startsWith(":")) {
      const dot = part.indexOf(".");
      if (dot === -1)
        segments.push({ kind: "param", name: part.slice(1), suffix: "" });
      else
        segments.push({
          kind: "param",
          name: part.slice(1, dot),
          suffix: part.slice(dot),
        });
    } else {
      segments.push({ kind: "literal", value: part });
    }
  }
  return segments;
}

export class Router<H> {
  private routes_: CompiledRoute<H>[] = [];

  /** The literal first segment of every route: the names a page owns. */
  literalHeads(): string[] {
    const heads = new Set<string>();
    for (const route of this.routes_) {
      const first = route.segments[0];
      if (first?.kind === "literal" && first.value !== "") heads.add(first.value);
    }
    return [...heads].sort();
  }

  /** Every pattern given to `add`, once each, in the order added. */
  patterns(): string[] {
    return [...new Set(this.routes_.map((r) => r.pattern))];
  }

  /** Every registered route, method and pattern, in the order added — for tests that walk the table. */
  routes(): { method: string; pattern: string }[] {
    return this.routes_.map(({ method, pattern }) => ({ method, pattern }));
  }

  add(method: string, pattern: string, handler: H): this {
    this.routes_.push({ method, pattern, segments: compile(pattern), handler });
    return this;
  }

  match(method: string, pathname: string): Match<H> | undefined {
    const parts = pathname === "/" ? [""] : pathname.slice(1).split("/");
    for (const route of this.routes_) {
      if (route.method !== method) continue;
      const params = matchSegments(route, parts);
      if (params) return { handler: route.handler, params, pattern: route.pattern };
    }
    return undefined;
  }

  /**
   * The methods whose routes match the path, method ignored, sorted, with HEAD
   * wherever GET is. Asked only after `match` has failed, to tell a wrong
   * method from a wrong path.
   */
  allowed(pathname: string): string[] {
    const parts = pathname === "/" ? [""] : pathname.slice(1).split("/");
    const methods = new Set<string>();
    for (const route of this.routes_) {
      if (methods.has(route.method)) continue;
      if (matchSegments(route, parts)) methods.add(route.method);
    }
    if (methods.has("GET")) methods.add("HEAD");
    return [...methods].sort();
  }
}

/** The params a route's segments take from the path, or undefined when they do not fit. */
function matchSegments<H>(route: CompiledRoute<H>, parts: string[]): Params | undefined {
  const params: Params = {};
  for (const [i, segment] of route.segments.entries()) {
    if (segment.kind === "rest") {
      const decoded = parts.slice(i).map(decodeSegment);
      if (decoded.some((d) => d === undefined)) return undefined;
      params[segment.name] = decoded.join("/");
      return params;
    }
    const part = parts[i];
    if (part === undefined) return undefined;
    if (segment.kind === "literal") {
      if (part !== segment.value) return undefined;
    } else {
      if (segment.suffix !== "" && !part.endsWith(segment.suffix)) return undefined;
      const raw =
        segment.suffix === "" ? part : part.slice(0, -segment.suffix.length);
      const decoded = decodeSegment(raw);
      if (decoded === undefined || decoded === "") return undefined;
      params[segment.name] = decoded;
    }
  }
  return parts.length === route.segments.length ? params : undefined;
}

function decodeSegment(raw: string): string | undefined {
  try {
    return decodeURIComponent(raw);
  } catch {
    return undefined;
  }
}

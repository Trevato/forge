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
}

interface CompiledRoute<H> {
  method: string;
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
  private routes: CompiledRoute<H>[] = [];

  /** The literal first segment of every route: the names a page owns. */
  literalHeads(): string[] {
    const heads = new Set<string>();
    for (const route of this.routes) {
      const first = route.segments[0];
      if (first?.kind === "literal" && first.value !== "") heads.add(first.value);
    }
    return [...heads].sort();
  }

  add(method: string, pattern: string, handler: H): this {
    this.routes.push({ method, segments: compile(pattern), handler });
    return this;
  }

  match(method: string, pathname: string): Match<H> | undefined {
    const parts = pathname === "/" ? [""] : pathname.slice(1).split("/");
    outer: for (const route of this.routes) {
      if (route.method !== method) continue;
      const params: Params = {};
      for (const [i, segment] of route.segments.entries()) {
        if (segment.kind === "rest") {
          const decoded = parts.slice(i).map(decodeSegment);
          if (decoded.some((d) => d === undefined)) continue outer;
          params[segment.name] = decoded.join("/");
          return { handler: route.handler, params };
        }
        const part = parts[i];
        if (part === undefined) continue outer;
        if (segment.kind === "literal") {
          if (part !== segment.value) continue outer;
        } else {
          if (segment.suffix !== "" && !part.endsWith(segment.suffix))
            continue outer;
          const raw =
            segment.suffix === ""
              ? part
              : part.slice(0, -segment.suffix.length);
          const decoded = decodeSegment(raw);
          if (decoded === undefined || decoded === "") continue outer;
          params[segment.name] = decoded;
        }
      }
      if (parts.length !== route.segments.length) continue;
      return { handler: route.handler, params };
    }
    return undefined;
  }
}

function decodeSegment(raw: string): string | undefined {
  try {
    return decodeURIComponent(raw);
  } catch {
    return undefined;
  }
}

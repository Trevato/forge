/**
 * The API reference, the terminal's /api: the forge's OpenAPI operations as
 * rows (method, path, summary), `/` to narrow them, Enter to run a GET that
 * needs no path parameter as the person at this terminal and read the status,
 * time, Server-Timing and body. The request goes through the forge's own
 * router, in this process, with a session made for the call and ended after.
 */

import { narrow, reference, runnable, type Area, type Operation } from "../../contract/reference.ts";
import { openapiText, roleOf } from "../../contract/served.ts";
import { createSession, destroySession } from "../../core/sessions.ts";
import { running } from "../../kernel/version.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Session } from "../session.ts";
import { fill, len, split } from "../ui/layout.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import { emptyState } from "../ui/widgets.ts";
import { Filter, ListState, Scroll, drawLines, drawList, metaOf, type ListRow } from "./common.ts";

const MAX_SHOWN = 400;

/** Every operation of the forge's document, flat, in area order. */
export function apiOperations(areas: readonly Area[]): Operation[] {
  return areas.flatMap((a) => a.operations);
}

export function apiRows(ops: readonly Operation[]): ListRow[] {
  return ops.map((o) => ({
    title: `${o.method.toUpperCase().padEnd(6)}${o.path}`,
    meta: metaOf(o.summary, runnable(o) ? "Enter runs it" : ""),
  }));
}

export interface Answer {
  readonly status: number;
  readonly ms: number;
  readonly timing: string;
  readonly body: string;
}

/** GET `path` through the forge's router as this session's person (a guest: anonymously). */
export async function runGet(f: Session, path: string): Promise<Answer> {
  const { forgeHttp } = await import("../../http/server.ts");
  const http = forgeHttp(f.app);
  const made = f.user === undefined ? undefined : createSession(f.app.db, f.user.id);
  const began = performance.now();
  try {
    const headers = made === undefined ? {} : { cookie: `forge_session=${made.token}` };
    const base = f.app.config.url ?? "http://localhost";
    let target = path;
    let res = await http.handle(new Request(new URL(target, base).href, { headers }));
    // A same-site redirect (the OpenAPI alias) is followed, twice at most.
    for (let hops = 0; hops < 2 && res.status >= 300 && res.status < 400; hops++) {
      const next = res.headers.get("location") ?? "";
      if (!next.startsWith("/") || next.startsWith("//")) break;
      target = next;
      res = await http.handle(new Request(new URL(target, base).href, { headers }));
    }
    const text = await res.text();
    let body = text;
    try {
      body = JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      // not JSON: shown as it came
    }
    return { status: res.status, ms: Math.round(performance.now() - began), timing: res.headers.get("server-timing") ?? "", body };
  } finally {
    if (made !== undefined) destroySession(f.app.db, made.token);
    http.close();
  }
}

function answerScreen(ctx: Ctx, op: Operation, answer: Answer): Screen {
  const scroll = new Scroll();
  const head = `${answer.status} · ${answer.ms} ms${answer.timing === "" ? "" : ` · ${answer.timing}`}`;
  const lines = [head, "", ...answer.body.slice(0, 40_000).split("\n")];
  return {
    title: `GET ${op.path}`,
    keys: [binding(["j", "k"], "scroll"), binding(["esc", "q"], "back")],
    render(area, s) {
      const c = ctx.theme.c;
      drawLines(s, area, c, scroll, lines.map((text, i) => [{ text, style: style(i === 0 ? c.fg : c.mutedFg, c.bg) }]));
    },
    key(e) {
      if (e.key === "esc" || e.key === "q") ctx.pop();
      else scroll.key(e, lines.length);
      return true;
    },
  };
}

export function apiScreen(f: Session, ctx: Ctx): Screen {
  const state = new ListState();
  const filter = new Filter();
  // The rows this person may call, as the page cuts them: a guest reads the anonymous ones (#11286).
  const doc = openapiText(f.app.config.url ?? "http://localhost", running().version, roleOf(f));
  const all = apiOperations(reference(JSON.parse(doc.text)));
  const shown = (): Operation[] => apiOperations(narrow([{ name: "", operations: all }], filter.query)).slice(0, MAX_SHOWN);
  let note = "";
  return {
    title: "API",
    keys: [binding(["j", "k"], "move"), binding(["/"], "find"), binding(["enter"], "run a GET"), binding(["esc", "q"], "close")],
    render(area, s) {
      const c = ctx.theme.c;
      const list = shown();
      const [head, box, body] = split(area, "v", [len(1), len(filter.on ? 1 : 0), fill(1)]);
      const count = filter.query === "" ? `${all.length} operations` : `${list.length} of ${all.length} operations match`;
      s.text(head!.x, head!.y, truncate(note === "" ? count : `${count} · ${note}`, head!.w), style(c.mutedFg, c.bg), head!.x + head!.w);
      ctx.setCursor(filter.on ? filter.render(s, box!, c, "find a path, method or word") : null);
      if (list.length === 0) {
        emptyState(s, body!, c, { title: "No operation matches", body: "Esc clears the word." });
        return;
      }
      drawList(s, body!, c, state, apiRows(list));
    },
    key(e) {
      if (filter.key(e)) {
        state.clamp(shown().length);
        return true;
      }
      if (e.key === "esc" && filter.query !== "") {
        filter.query = "";
        state.clamp(shown().length);
      } else if (e.key === "esc" || e.key === "q") ctx.pop();
      else if (e.key === "enter") {
        const op = shown()[state.index];
        if (op === undefined) return true;
        if (!runnable(op)) note = "only a GET with no path parameter runs here";
        else {
          note = "";
          void runGet(f, op.path).then((answer) => {
            ctx.push(answerScreen(ctx, op, answer));
          });
        }
      } else state.key(e, shown().length);
      return true;
    },
  };
}

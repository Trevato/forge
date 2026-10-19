/**
 * The app page's log tail rides the page's one `/events` connection: it opens
 * no EventSource of its own and appends the `run.log` frames for its run.
 */
import { describe, expect, test } from "bun:test";
import { appTailJs, liveRegionsJs } from "../src/web/client.ts";

type Handler = (event: { data: string; lastEventId?: string }) => void;

function node(tag: string) {
  const el = {
    tag,
    className: "",
    textContent: "",
    children: [] as unknown[],
    appendChild(c: unknown) {
      el.children.push(c);
      return c;
    },
  };
  return el;
}

function boot(stream: string) {
  const opened: string[] = [];
  const docHandlers = new Map<string, (e: { detail: unknown }) => void>();
  const lines: ReturnType<typeof node>[] = [];
  const tail = {
    ...node("div"),
    scrollTop: 0,
    scrollHeight: 0,
    getAttribute: (n: string) =>
      (({ "data-stream": stream, "data-who": "crew", "data-cap": "0" }) as Record<
        string,
        string
      >)[n] ?? null,
    appendChild(c: unknown) {
      lines.push(c as ReturnType<typeof node>);
      return c;
    },
    querySelectorAll: () => lines,
  };
  const doc = {
    getElementById: (id: string) => (id === "app-run-tail" ? tail : null),
    createElement: (t: string) => node(t),
    createTextNode: (t: string) => ({ textContent: t }),
    addEventListener: (n: string, h: (e: { detail: unknown }) => void) =>
      void docHandlers.set(n, h),
    dispatchEvent: (e: { type: string; detail: unknown }) => {
      docHandlers.get(e.type)?.(e);
      return true;
    },
    hidden: false,
    activeElement: null,
    querySelectorAll: (sel: string) =>
      sel === "[data-live]"
        ? [{ id: "now", getAttribute: () => "run.*", hasAttribute: () => false }]
        : [],
    getElementsByTagName: () => [],
  };
  const sources: Record<string, Map<string, Handler>> = {};
  class ES {
    constructor(url: string) {
      opened.push(url);
      sources[url] = this.on;
    }
    on = new Map<string, Handler>();
    readyState = 1;
    addEventListener(n: string, h: Handler) {
      this.on.set(n, h);
    }
    close() {}
  }
  class CE {
    type: string;
    detail: unknown;
    constructor(type: string, init: { detail: unknown }) {
      this.type = type;
      this.detail = init.detail;
    }
  }
  const fake = {
    document: doc,
    window: { addEventListener() {}, setInterval: () => 0, clearInterval() {} },
    location: { href: "http://x/app" },
    EventSource: ES,
    CustomEvent: CE,
    DOMParser: class {},
    setTimeout: () => 0,
    clearTimeout() {},
    fetch: async () => ({}),
  };
  for (const js of [liveRegionsJs, appTailJs])
    new Function(...Object.keys(fake), js)(...Object.values(fake));
  return { opened, sources, lines };
}

const STREAM = "/api/v1/repos/a/b/runs/run1/log?follow=1";

describe("app page log tail", () => {
  test("opens no EventSource besides /events", () => {
    const { opened } = boot(STREAM);
    expect(opened).toEqual(["/events"]);
  });

  test("a run.log frame for its run appends its lines once; other runs are ignored", () => {
    const { sources, lines } = boot(STREAM);
    const handler = sources["/events"]?.get("run.log");
    expect(handler).toBeDefined();
    handler?.({ data: JSON.stringify({ run: "run1", lines: ["hello", "world"], truncated: false }) });
    expect(lines.length).toBe(2);
    handler?.({ data: JSON.stringify({ run: "other", lines: ["nope"], truncated: false }) });
    handler?.({ data: "not json" });
    expect(lines.length).toBe(2);
  });
});

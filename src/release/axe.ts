/**
 * The website specification's accessibility checks (#2915 check 8), report
 * only. `axe()` opens each path in headless Chromium once per colour scheme,
 * runs axe-core in the page and returns its violations as `Finding`s;
 * also loads each path with script execution disabled in the same session and
 * reports an empty <main> or a missing main heading in the rendered DOM.
 * `noScript()` is the fallback where there is no browser: it reads the served
 * HTML with regexes, which is only a proxy for the render (it cannot see what
 * CSS hides). Neither throws or fails a run.
 *
 * axe-core is a devDependency of the check runner and is read here as a file
 * to inject into the page; nothing the server loads imports this module.
 * There is no zero-dependency equivalent: axe's rules (contrast, names,
 * roles) need a rendered page and a computed accessibility tree.
 */

import { findChromium } from "../looks/capture.ts";
import { withPage } from "./devtools.ts";
import { s, type Finding } from "./webspec.ts";

const SCHEMES = ["light", "dark"] as const;

export interface AxeViolation {
  id: string;
  impact?: string | null;
  help: string;
  nodes: { target: unknown[] }[];
}

/** One axe violation as a finding; the scheme it appeared in is in the message. */
export function axeFinding(path: string, scheme: string, v: AxeViolation): Finding {
  const first = String(v.nodes[0]?.target?.[0] ?? "");
  return {
    path,
    check: `axe:${v.id}`,
    message: `${v.help} (${v.impact ?? "unrated"}, ${scheme} scheme): ${v.nodes.length} element(s)${first ? `, first ${first.slice(0, 120)}` : ""}`,
    section: s("accessibility"),
  };
}

/** What a visitor without JavaScript is served: <main> must hold content and a main heading. */
export function noScriptProblems(html: string): string[] {
  const body = html.replace(/<!--[\s\S]*?-->/g, "").replace(/<(script|style|template)\b[\s\S]*?<\/\1>/gi, "");
  const main = /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(body);
  const out: string[] = [];
  if (!main) out.push("the page has no <main>");
  else if (main[1]!.replace(/<[^>]*>/g, "").trim() === "" && !/<(img|svg|input|video|canvas|iframe)\b/i.test(main[1]!))
    out.push("<main> is empty without JavaScript");
  if (!/<h1\b[^>]*>[\s\S]*?\S[\s\S]*?<\/h1>/i.test(main ? main[1]! : body)) out.push("no main heading (<h1>) without JavaScript");
  return out;
}

/** Fetches each path as a script-less client would see it and reports empty pages. */
export async function noScript(base: string, paths: string[], fetcher: typeof fetch = fetch): Promise<Finding[]> {
  const findings: Finding[] = [];
  for (const path of paths) {
    try {
      const res = await fetcher(new URL(path, base).href, { headers: { accept: "text/html" }, redirect: "manual", signal: AbortSignal.timeout(10000) });
      if (!res.ok) continue; // webspec() already reports the status
      for (const message of noScriptProblems(await res.text()))
        findings.push({ path, check: "no-js", message, section: s("progressive-enhancement") });
    } catch {
      // unreachable pages are webspec()'s finding
    }
  }
  return findings;
}

/** Runs axe-core over each path in each colour scheme, once each, and reports its violations. */
export async function axe(base: string, paths: string[]): Promise<Finding[]> {
  const binary = findChromium();
  if (binary === undefined) return [{ path: "/", check: "axe", message: "no chromium here: axe-core did not run", section: s("accessibility") }];
  const source = await Bun.file(require.resolve("axe-core/axe.min.js")).text();
  const findings: Finding[] = [];
  try {
    await withPage(binary, async (send, once) => {
      await send("Page.enable");
      const load = async (path: string) => {
        const loaded = once("Page.loadEventFired");
        loaded.catch(() => {});
        await send("Page.navigate", { url: new URL(path, base).href });
        await loaded;
      };
      for (const path of paths) {
        try {
          await send("Emulation.setScriptExecutionDisabled", { value: true });
          await load(path);
          const dom = await send("Runtime.evaluate", { expression: "document.documentElement.outerHTML", returnByValue: true });
          for (const message of noScriptProblems(`<!doctype html>${dom.result.value}`))
            findings.push({ path, check: "no-js", message, section: s("progressive-enhancement") });
        } catch (e) {
          findings.push({ path, check: "axe", message: `the no-JavaScript render did not run: ${e instanceof Error ? e.message : String(e)}`, section: s("progressive-enhancement") });
        } finally {
          await send("Emulation.setScriptExecutionDisabled", { value: false }).catch(() => {});
        }
        for (const scheme of SCHEMES) {
          try {
            await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
            await load(path);
            const res = await send("Runtime.evaluate", {
              expression: `${source};axe.run(document,{resultTypes:["violations"]}).then(r=>JSON.stringify(r.violations))`,
              awaitPromise: true,
              returnByValue: true,
            });
            if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description ?? "axe failed");
            for (const v of JSON.parse(res.result.value) as AxeViolation[]) findings.push(axeFinding(path, scheme, v));
          } catch (e) {
            findings.push({ path, check: "axe", message: `axe-core did not run (${scheme}): ${e instanceof Error ? e.message : String(e)}`, section: s("accessibility") });
          }
        }
      }
    });
  } catch (e) {
    findings.push({ path: "/", check: "axe", message: `axe-core did not run: ${e instanceof Error ? e.message : String(e)}`, section: s("accessibility") });
  }
  return findings;
}

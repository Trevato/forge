/**
 * The new issue and new pull forms fit a 390 px phone in one column (#9719).
 *
 * There is no layout engine in the test run, so the fit is held on the real CSS the
 * page ships: every rule that can reach an element of the form (by one of its classes
 * or tags) is read, and none may fix a width or min-width over 390 px, nor lay the
 * fields side by side. The controls fill their field (`.input { width: 100% }`) and a
 * field is a block, so the form is as wide as the screen and no wider. A rule that
 * gave any of them a fixed width past 390 px would scroll the form sideways, and fails.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { utilities as base } from "../src/web/style/base.ts";
import { components } from "../src/web/style/components.ts";
import { content } from "../src/web/style/content.ts";

let dir: string;
let app: App;
let servers: Servers;
let cookie: string;

const must = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-compose-fit-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const u = must(await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "a@f.dev", password: "a-good-passphrase", adminIfFirst: true }));
  const repo = must(await createRepo(app, u, { name: "fit", visibility: "public" }));
  must(await commitToBranch(app, u, repo, { message: "init", files: [{ path: "README.md", content: "x" }] }));
  must(await commitToBranch(app, u, repo, { branch: "topic", message: "c", files: [{ path: "t.txt", content: "x" }] }));
  cookie = `forge_session=${createSession(app.db, u.id).token}; forge_mode=dev`;
}, 60_000);
afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

/** The compose form's markup and the page's own <style> blocks. */
async function compose(kind: "issues" | "pulls"): Promise<{ form: string; styles: string[] }> {
  const page = await (await fetch(`${servers.url}/alice/fit/${kind}/new`, { headers: { cookie } })).text();
  const at = page.indexOf(`<form method="post" action="/alice/fit/${kind}/new"`);
  expect(at).toBeGreaterThan(-1);
  return {
    form: page.slice(at, page.indexOf("</form>", at) + 7),
    styles: page.match(/<style[^>]*>[\s\S]*?<\/style>/g) ?? [],
  };
}

/** Each CSS rule as selector and body; an @media prelude stays on its first rule's selector. */
function rules(css: string): { selector: string; body: string }[] {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1]!.trim(), body: m[2]! }));
}

/** Rules whose selector names a class or tag that appears in the form. */
function reaching(form: string, css: string[]): { selector: string; body: string }[] {
  const classes = new Set([...form.matchAll(/class="([^"]*)"/g)].flatMap((m) => m[1]!.split(/\s+/)));
  const tags = new Set([...form.matchAll(/<([a-z][a-z0-9]*)\b/g)].map((m) => m[1]!));
  return css.flatMap(rules).filter(({ selector }) => {
    const sel = selector.replace(/@media[^{]*$/, "");
    for (const m of sel.matchAll(/\.([\w-]+)/g)) if (classes.has(m[1]!)) return true;
    for (const m of sel.matchAll(/(?:^|[\s,>+~])([a-z][a-z0-9]*)(?=[\s,.:[>+~]|$)/g)) if (tags.has(m[1]!)) return true;
    return false;
  });
}

const PX: Record<string, number> = { px: 1, rem: 16, em: 16, ch: 8 };

for (const kind of ["issues", "pulls"] as const) {
  describe(`the new ${kind === "issues" ? "issue" : "pull"} form at 390 px`, () => {
    test("no CSS rule that reaches the form fixes a width over 390 px", async () => {
      const { form, styles } = await compose(kind);
      expect(form).not.toMatch(/\sstyle="[^"]*width/i);
      const hit = reaching(form, [base, components, content, ...styles]);
      expect(hit.some((r) => /(^|[\s,])\.input\b/.test(r.selector))).toBe(true);
      const over: string[] = [];
      for (const { selector, body } of hit) {
        for (const m of body.matchAll(/(?<![-\w])(?:min-)?width\s*:\s*(-?[\d.]+)(px|rem|em|ch)\b/g)) {
          if (Number(m[1]) * PX[m[2]!]! > 390) over.push(`${selector} { ${m[0]} }`);
        }
      }
      expect(over).toEqual([]);
    });

    test("the controls fill their field and the fields stack in one column", async () => {
      const { form } = await compose(kind);
      expect(components).toMatch(/(?:^|\n)\.input \{[^}]*\bwidth: 100%/);
      expect(components).toMatch(/(?:^|\n)\.field \{[^}]*display: block/);
      expect(form).not.toContain("field-row");
      for (const m of form.matchAll(/<(select|textarea)\b[^>]*>/g)) expect(m[0]).toContain('class="input');
      for (const m of form.matchAll(/<input\b[^>]*>/g)) {
        if (!/type="(hidden|checkbox)"/.test(m[0])) expect(m[0]).toContain('class="input');
      }
    });

    test("one button, and Cancel is the link variant", async () => {
      const { form } = await compose(kind);
      expect(form.match(/<button/g)?.length).toBe(1);
      expect(form).toMatch(/<a\b[^>]*data-variant="link"[^>]*>\s*Cancel/);
    });
  });
}

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import {
  shellAsset,
  stylesheetAsset,
  stylesheetRedirect,
} from "../src/web/asset.ts";
import { shellJs } from "../src/web/client.ts";
import { escapeHtml, html, raw, when } from "../src/web/html.ts";
import {
  icon,
  pointAtSprite,
  spriteSvg,
  inlineIcons,
  type IconName,
} from "../src/web/icons.ts";
import { renderMarkdown } from "../src/web/markdown.ts";
import { highlightAsset, spriteAsset } from "../src/web/asset.ts";
import { securityFloor } from "../src/http/respond.ts";
import { THEME_NAMES } from "../src/design/themes.ts";
import { sha256 } from "../src/kernel/hash.ts";
import { css } from "../src/web/style.ts";

describe("stylesheet asset", () => {
  test("its path is a hash over the css, so changing the css moves it", () => {
    const expected = `/assets/forge-${sha256(css).slice(0, 16)}.css`;
    expect(stylesheetAsset().path).toBe(expected);
    expect(stylesheetAsset().path).not.toBe(
      `/assets/forge-${sha256(css + " ").slice(0, 16)}.css`,
    );
  });

  test("the old unhashed path redirects to the current sheet", async () => {
    const res = stylesheetRedirect();
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(stylesheetAsset().path);
    expect(res.headers.get("cache-control")).toBe("no-cache");
  });
});
import { gitClientEnv } from "./helpers/git-client.ts";
import { adminCookie } from "./helpers/admin.ts";
import { quietLogs } from "./helpers/globals.ts";
import { pageScriptOf } from "./helpers/page-script.ts";

describe("html template", () => {
  test("escapes interpolations by default", () => {
    const out = html`<p>${"<script>alert(1)</script>"}</p>`.text;
    expect(out).toBe("<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>");
  });

  test("raw is the only door, arrays and nulls compose", () => {
    const items = html`${[1, 2].map((n) => html`<li>${n}</li>`)}`.text;
    expect(items).toBe("<li>1</li><li>2</li>");
    expect(html`${null}${undefined}${false}`.text).toBe("");
    expect(html`${raw("<b>ok</b>")}`.text).toBe("<b>ok</b>");
  });

  test("when renders on truth only", () => {
    expect(when(undefined, () => html`x`).text).toBe("");
    expect(when("v", (v) => html`${v}`).text).toBe("v");
  });

  test("escapeHtml covers the five", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
  });
});

describe("markdown", () => {
  test("structure: headings, lists, quotes, paragraphs", () => {
    const out = renderMarkdown(
      "# Title\n\ntext *em* **strong** `code`\n\n- a\n- b\n\n> quoted",
    ).text;
    expect(out).toContain("<h1>Title</h1>");
    expect(out).toContain("<em>em</em>");
    expect(out).toContain("<strong>strong</strong>");
    expect(out).toContain("<code>code</code>");
    expect(out).toContain("<ul>\n<li>a</li>\n<li>b</li>\n</ul>");
    expect(out).toContain("<blockquote>");
  });

  test("hostile input stays inert", () => {
    const out = renderMarkdown(
      "<script>alert(1)</script>\n\n[x](javascript:alert(1))\n\n```\n<img onerror=x>\n```",
    ).text;
    expect(out).not.toContain("<script>");
    expect(out).not.toContain('href="javascript:');
    expect(out).toContain("&lt;script&gt;");
    expect(out).toContain("&lt;img onerror=x&gt;");
  });

  test("links allow safe schemes only", () => {
    expect(renderMarkdown("[ok](https://a.b)").text).toContain(
      'href="https://a.b"',
    );
    expect(renderMarkdown("[ok](/local)").text).toContain('href="/local"');
    expect(renderMarkdown("[no](data:text/html,x)").text).not.toContain(
      "href=",
    );
    // A relative path is how a README actually links to a sibling file, and
    // it cannot leave this origin — unlike `//host`, which can.
    expect(renderMarkdown("[doc](docs/keeping.md)").text).toContain(
      'href="docs/keeping.md"',
    );
    expect(renderMarkdown("[no](//evil.test/x)").text).not.toContain("href=");
    expect(renderMarkdown("[no](vbscript:x)").text).not.toContain("href=");
  });

  test("a fenced block is highlighted in the language it names", () => {
    const out = renderMarkdown('```ts\nconst x = "<b>";\n```').text;
    expect(out).toContain('<code class="language-ts">');
    expect(out).toContain('<span class="tok-keyword">const</span>');
    // Still escaped: a fence produces spans and nothing else.
    expect(out).toContain("&lt;b&gt;");
    expect(out).not.toContain("<b>");
    // A fence with no language is left as plain text.
    expect(renderMarkdown("```\nplain\n```").text).toContain(
      "<pre><code>plain</code></pre>",
    );
  });

  test("tables need a delimiter row, and honour its alignment", () => {
    const out = renderMarkdown(
      "| a | b | c |\n| --- | :-: | --: |\n| 1 | 2 | 3 |\n\nafter",
    ).text;
    expect(out).toContain("<table><thead><tr><th>a</th>");
    expect(out).toContain('<th class="ta-c">b</th>');
    expect(out).toContain('<th class="ta-r">c</th>');
    expect(out).toContain("<tbody>\n<tr><td>1</td>");
    expect(out).toContain("</tbody></table>");
    expect(out).toContain("<p>after</p>");
    // A lone pipe line is a sentence, not a table.
    expect(renderMarkdown("| just text |").text).toContain("<p>| just text |");
    expect(renderMarkdown("a | b").text).toContain("<p>a | b</p>");
  });
});

describe("icons", () => {
  test("the slot is a reference; the drawing is defined once, on the symbol", () => {
    expect(icon("issue").text).toBe(
      `<svg class="ico ico-issue" width="16" height="16" aria-hidden="true" ` +
        `focusable="false"><use href="#i-issue"/></svg>`,
    );
    // The spinner's class is what the CSS animation reaches for, and both
    // sizes `icon()` offers still stamp the slot they sit in.
    expect(icon("loader").text).toContain('class="ico ico-loader"');
    expect(icon("issue", 20).text).toContain('width="20" height="20"');

    const sprite = spriteSvg();
    expect(sprite.match(/<symbol /g)!.length).toBeGreaterThan(20);
    expect(sprite).toContain(
      `<symbol id="i-issue" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"`,
    );
    expect(sprite).toContain('<circle cx="12" cy="12" r="1"/>');
    // A page aims every reference at the one hashed file.
    expect(pointAtSprite(icon("issue").text, "/assets/i-x.svg")).toContain('<use href="/assets/i-x.svg#i-issue"/>');
  });

  test("a fragment carries its drawings inline, referencing no sprite", () => {
    const inlined = inlineIcons(icon("issue").text);
    expect(inlined).not.toContain("<use");
    expect(inlined).not.toContain("symbol");
    // A nested <svg> with the drawing's viewBox is what <use> instantiates.
    expect(inlined).toContain(
      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"`,
    );
    expect(inlined).toContain('<circle cx="12" cy="12" r="1"/>');
    expect(inlined).toContain('class="ico ico-issue"');
  });

  test("a hundred uses of twenty drawings weigh twenty drawings", () => {
    // The census the front door showed: 98 uses, 20 distinct.
    const census: [IconName, number][] = [
      ["issue", 18],
      ["check", 17],
      ["fork", 17],
      ["pull", 15],
      ["rocket", 7],
      ["repo", 5],
      ["user", 2],
      ["comment", 2],
      ["clock", 2],
      ["branch", 2],
      ["commit", 2],
      ["search", 1],
      ["plus", 1],
      ["help", 1],
      ["signOut", 1],
      ["users", 1],
      ["map", 1],
      ["settings", 1],
      ["key", 1],
      ["lock", 1],
    ];
    const markup = census
      .map(([name, count]) => icon(name).text.repeat(count))
      .join("");
    const shipped = pointAtSprite(markup, "/assets/i-0123456789abcdef.svg").length;
    // What the same page would weigh with a drawing per use.
    const perUse = inlineIcons(markup).length;
    expect(perUse - shipped).toBeGreaterThan(15_000);
  });
});

describe("a page ships each drawing once", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let cookie = "";

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-icons-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    cookie = await adminCookie(app, {
      username: "ada",
      email: "ada@forge.local",
      password: "analytical-engine",
    });
    const mode = await fetch(`${base}/mode`, {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ mode: "studio", back: "/" }),
      redirect: "manual",
    });
    cookie = `${cookie}; ${(mode.headers.get("set-cookie") ?? "").split(";")[0]}`;
    await fetch(`${base}/new`, {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ name: "engine", visibility: "public" }),
      redirect: "manual",
    });
    for (let n = 0; n < 12; n++) {
      await fetch(`${base}/ada/engine/issues/new`, {
        method: "POST",
        headers: { cookie, origin: base },
        body: new URLSearchParams({ title: `bug ${n}`, body: "a body" }),
        redirect: "manual",
      });
      await fetch(`${base}/ada/engine/issues/1/comments`, {
        method: "POST",
        headers: { cookie, origin: base },
        body: new URLSearchParams({ body: `comment ${n}` }),
        redirect: "manual",
      });
    }
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a timeline of a dozen comments sends the comment's drawing once, not a dozen times", async () => {
    const text = await (
      await fetch(`${base}/ada/engine/issues/1`, { headers: { cookie } })
    ).text();
    expect(text.match(/<use href="[^"#]+#i-comment"\/>/g)!.length).toBeGreaterThan(
      11,
    );
    // The drawing is not in the page at all: it is the one hashed sprite file.
    expect(text).not.toContain("<symbol");
    expect(text).toContain(`<use href="${spriteAsset().path}#i-comment"/>`);
  });

  test("every icon a page uses is defined by the sprite file it points at", async () => {
    for (const path of ["/", "/ada/engine/issues", "/settings"]) {
      const text = await (
        await fetch(`${base}${path}`, { headers: { cookie } })
      ).text();
      const used = new Set(
        [...text.matchAll(/<use href="([^"#]+)#i-([A-Za-z]+)"\/>/g)].map((m) => {
          expect(m[1]).toBe(spriteAsset().path);
          return m[2];
        }),
      );
      expect(used.size).toBeGreaterThan(0);
      expect(text).not.toContain("<symbol");
      const file = await (await fetch(base + spriteAsset().path)).text();
      for (const name of used) expect(file).toContain(`<symbol id="i-${name}"`);
    }
  });

  test("the thread fragment inlines its own drawings", async () => {
    await fetch(`${base}/ada/engine/issues/1/comments`, {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ intent: "comment", body: "I can repro." }),
      redirect: "manual",
    });
    const fragment = await (
      await fetch(`${base}/ada/engine/issues/1/thread?after=`, {
        headers: { cookie },
      })
    ).text();
    expect(fragment).toContain("I can repro.");
    expect(fragment).toContain('class="ico ico-comment"');
    expect(fragment).not.toContain("<use href=");
  });
});

describe("web pages end to end", () => {
  let dataDir: string;
  let work: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let cookie = "";
  let token = "";

  const clientEnv = gitClientEnv({
    GIT_AUTHOR_NAME: "Ada",
    GIT_AUTHOR_EMAIL: "ada@forge.local",
    GIT_COMMITTER_NAME: "Ada",
    GIT_COMMITTER_EMAIL: "ada@forge.local",
  });

  async function shOk(args: string[], cwd: string): Promise<string> {
    const proc = Bun.spawn(args, {
      cwd,
      env: clientEnv,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, errText, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0) throw new Error(`${args.join(" ")} failed: ${errText}`);
    return out.trim();
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-web-"));
    work = await mkdtemp(join(tmpdir(), "forge-webwork-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    // The site admin, who makes things below; no sign-up makes one.
    cookie = await adminCookie(app, { username: "ada", email: "ada@forge.local", password: "analytical-engine" });
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  });

  test("signup form creates the account and signs in", async () => {
    const response = await fetch(`${base}/signup`, {
      method: "POST",
      body: new URLSearchParams({
        username: "babbage",
        email: "babbage@forge.local",
        password: "difference-engine",
      }),
      redirect: "manual",
    });
    expect(response.status).toBe(303);
    const signedUp = (response.headers.get("set-cookie") ?? "").split(";")[0]!;
    expect(signedUp).toStartWith("forge_session=");

    const homePage = await fetch(base, { headers: { cookie: signedUp } });
    const text = await homePage.text();
    expect(text).toContain("Sign out");
    expect(text).toContain(`href="/babbage"`); // the account link in the topbar
    expect(text).toContain("New repository");
  });

  test("the shell is a cached file, linked before the page's own inline script", async () => {
    const shell = shellAsset();
    const home = await (await fetch(base, { headers: { cookie } })).text();
    expect(home).toContain(`<script src="${shell.path}" defer></script>`);
    // Its source is no longer in the HTML, and the page is a good deal lighter.
    expect(home).not.toContain(shellJs.slice(0, 400));
    expect(home).not.toContain(shellJs.slice(-400));

    // A page with its own script: the shell is deferred and the inline one waits
    // for DOMContentLoaded, so the shell has run by then.
    const apps = await (
      await fetch(`${base}/apps/new`, { headers: { cookie } })
    ).text();
    const at = apps.indexOf(`src="${shell.path}" defer>`);
    const inline = apps.indexOf('<script src="/assets/page-', at);
    expect(at).toBeGreaterThan(-1);
    expect(inline).toBeGreaterThan(at);
    expect(await pageScriptOf(base, apps)).toContain('document.addEventListener("DOMContentLoaded"');
    expect(apps).not.toContain(shellJs.slice(0, 400));

    const file = await fetch(base + shell.path);
    expect(file.status).toBe(200);
    expect(file.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(await file.text()).toBe(shellJs);
    expect(
      (await fetch(`${base}/assets/shell-0000000000000000.js`)).status,
    ).toBe(404);

    const policy = (await fetch(base, { headers: { cookie } })).headers.get(
      "content-security-policy",
    );
    expect(policy).not.toContain("unsafe-inline");
  });

  test("the command palette is a proper dialog: modal, a combobox over a listbox, its index as data", async () => {
    const text = await (await fetch(base, { headers: { cookie } })).text();
    expect(text).toMatch(
      /<dialog[^>]*class="dialog palette"[^>]*id="palette"[^>]*role="dialog"[^>]*aria-modal="true"/,
    );
    expect(text).toMatch(
      /<input[^>]*class="input palette-input"[^>]*type="text"[^>]*role="combobox"[^>]*aria-controls="palette-list"/,
    );
    expect(text).toMatch(/id="palette-list"\s+role="listbox"/);
    expect(text).toContain(
      '<script type="application/json" id="palette-index">',
    );
    // The shell file carries the scorer and consumes Escape itself.
    const file = await (await fetch(base + shellAsset().path)).text();
    expect(file).toContain("function fuzzyScore(");
    expect(file).toContain("function openModal(");
  });

  test("stylesheet is content-addressed and immutable, at the path the page names", async () => {
    const homeText = await (await fetch(base, { headers: { cookie } })).text();
    const match = homeText.match(/href="(\/assets\/forge-[0-9a-f]+\.css)"/);
    expect(match).not.toBeNull();
    const path = match![1]!;
    expect(
      (await fetch(base, { headers: { cookie } })).headers.get("cache-control"),
    ).toBe("private, no-cache");

    const response = await fetch(`${base}${path}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/css");
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );

    // A stale hash — an old tab's cached URL after a deploy — is a 404, not
    // a redirect, the same rule the highlighter bundle already follows.
    const stale = await fetch(`${base}/assets/forge-0000000000000000.css`);
    expect(stale.status).toBe(404);
  });

  test("the home carries no error-note for a setting that is not the default", async () => {
    const { changeCapacity } = await import("../src/actions/capacity.ts");
    const { getUserByName } = await import("../src/core/users.ts");
    const ada = getUserByName(app.db, "ada")!;
    expect(changeCapacity(app, ada, "cells.egress", "report", "a test says why").ok).toBe(true);
    try {
      const text = await (await fetch(base, { headers: { cookie } })).text();
      expect(text).not.toMatch(/class="[^"]*\berror-note/);
      expect(text).not.toContain("Egress is reported");
    } finally {
      changeCapacity(app, ada, "cells.egress", "enforce");
    }
  });

  test("new repo via the form, empty state renders", async () => {
    const response = await fetch(`${base}/new`, {
      method: "POST",
      headers: { cookie },
      body: new URLSearchParams({
        name: "engine",
        visibility: "public",
        description: "difference engine",
      }),
      redirect: "manual",
    });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/ada/engine");

    const repoPage = await fetch(`${base}/ada/engine`, { headers: { cookie } });
    const text = await repoPage.text();
    expect(text).toContain("empty repository");
    expect(text).toContain("git remote add origin");
  });

  test("after a push: tree, readme, blob, commits all render", async () => {
    const minted = await fetch(`${base}/api/v1/tokens`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ adminConfirm: true,
        username: "ada",
        password: "analytical-engine",
        name: "cli",
        scope: "rw",
      }),
    });
    token = ((await minted.json()) as { token: string }).token;

    const remote = `${base.replace("http://", `http://ada:${token}@`)}/ada/engine.git`;
    await shOk(["git", "clone", remote, "engine"], work);
    const dir = join(work, "engine");
    await Bun.write(
      join(dir, "README.md"),
      "# Engine\n\nA *difference* engine. <script>alert(1)</script>\n\n```\ngears\n```\n",
    );
    await Bun.write(
      join(dir, "src/gears.ts"),
      "export const teeth = 42;\nexport const wheels = 7;\n",
    );
    await shOk(["git", "add", "."], dir);
    await shOk(["git", "commit", "-m", "assemble the engine"], dir);
    await shOk(["git", "push", "origin", "main"], dir);

    const repoPage = await (await fetch(`${base}/ada/engine`)).text();
    expect(repoPage).toContain("<h1>Engine</h1>"); // README rendered
    expect(repoPage).not.toContain("<script>alert"); // and defanged
    expect(repoPage).toContain("src"); // tree listing
    expect(repoPage).toContain("/ada/engine.git"); // clone url
    // the address is a read-only input (selectable with no JS) beside a copy button
    expect(repoPage).toMatch(
      /<input[^>]*class="input[^"]*"[^>]*id="clone-https"[^>]*readonly[^>]*value="[^"]*\/ada\/engine\.git"/,
    );
    expect(repoPage).toContain('data-copy="clone-https"');
    expect(repoPage).not.toContain('class="clone');

    const treePage = await (
      await fetch(`${base}/ada/engine/tree/main/src`)
    ).text();
    expect(treePage).toContain("gears.ts");

    const blobPage = await (
      await fetch(`${base}/ada/engine/blob/main/src/gears.ts`)
    ).text();
    // Content is present but now syntax-highlighted (broken across spans).
    expect(blobPage).toContain("teeth");
    expect(blobPage).toContain("42");
    expect(blobPage).toContain('class="tok-keyword">export'); // highlighting applied
    expect(blobPage).toContain('id="L2"');

    const commitsPage = await (
      await fetch(`${base}/ada/engine/commits`)
    ).text();
    expect(commitsPage).toContain("assemble the engine");
    expect(commitsPage).toContain("Ada");
  });

  test("private repos are invisible pages for strangers", async () => {
    await fetch(`${base}/new`, {
      method: "POST",
      headers: { cookie },
      body: new URLSearchParams({ name: "secret", visibility: "private" }),
      redirect: "manual",
    });
    const anon = await fetch(`${base}/ada/secret`);
    expect(anon.status).toBe(404); // 404 status, not a soft 200…
    expect(await anon.text()).toContain("404"); // …with a real page body
    const owner = await (
      await fetch(`${base}/ada/secret`, { headers: { cookie } })
    ).text();
    expect(owner).toContain("empty repository");
  });

  test("path traversal and hostile refs bounce off the pages", async () => {
    for (const path of [
      "/ada/engine/blob/main/../../../../etc/passwd",
      "/ada/engine/blob/--upload-pack=x/f",
      "/ada/engine/tree/main~1",
    ]) {
      const response = await fetch(`${base}${path}`);
      const text = await response.text();
      expect(text).toContain("404");
    }
  });

  test("a path under no route at all gets the forge's page unless the caller asks for JSON", async () => {
    const browser = await fetch(`${base}/ada/engine/frobnicate`, {
      headers: {
        accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });
    expect(browser.status).toBe(404);
    expect(browser.headers.get("content-type")).toContain("text/html");
    expect(browser.headers.get("content-security-policy")).toContain(
      "default-src 'none'",
    );
    expect(browser.headers.get("x-content-type-options")).toBe("nosniff");
    expect(browser.headers.get("referrer-policy")).toBeTruthy();
    const html = await browser.text();
    expect(html).toContain("404");
    expect(html).toContain("Go home");

    // No Accept header at all — curl, a crawler, a link unfurler — gets the page
    // too (#6733); a caller that asks for JSON keeps the contract.
    const plain = await fetch(`${base}/ada/engine/frobnicate`);
    expect(plain.status).toBe(404);
    expect(plain.headers.get("content-type")).toContain("text/html");
    const asked = await fetch(`${base}/ada/engine/frobnicate`, { headers: { accept: "application/json" } });
    expect(asked.status).toBe(404);
    expect(asked.headers.get("content-type")).toContain("application/json");
    const body = (await asked.json()) as { error: string; message: string };
    expect(body.error).toBe("no_route");
    expect(body.message).toContain("/ada/engine/frobnicate");

    // An API path is unchanged even for a browser's own Accept header.
    const api = await fetch(`${base}/api/v1/nonsense`, {
      headers: { accept: "text/html,*/*;q=0.8" },
    });
    expect(api.headers.get("content-type")).toContain("application/json");
    const apiBody = (await api.json()) as { error: string };
    expect(apiBody.error).toBe("no_route");
  });

  test("a page's 404 is JSON for a caller whose Accept prefers JSON, HTML otherwise", async () => {
    const agent = await fetch(`${base}/nope`, {
      headers: { accept: "application/json" },
    });
    expect(agent.status).toBe(404);
    expect(agent.headers.get("content-type")).toContain("application/json");
    expect(agent.headers.get("x-content-type-options")).toBe("nosniff");
    expect(agent.headers.get("referrer-policy")).toBeTruthy();
    expect(agent.headers.get("content-security-policy")).toBeTruthy();
    const body = (await agent.json()) as { error: string; message: string; docs: string };
    expect(body.error).toBe("not_found");
    expect(body.message.length).toBeGreaterThan(0);
    expect(body.docs).toBe(`${base}/llms.txt`);

    for (const accept of ["text/html,application/xhtml+xml,*/*;q=0.8", "*/*", undefined]) {
      const other = await fetch(`${base}/nope`, accept ? { headers: { accept } } : {});
      expect(other.status).toBe(404);
      expect(other.headers.get("content-type")).toContain("text/html");
    }
  });
});

describe("themes", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-theme-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("stylesheet carries every premade theme", async () => {
    const css = await (
      await fetch(`${base}${stylesheetAsset().path}`)
    ).text();
    for (const name of THEME_NAMES) {
      expect(css).toContain(`:root[data-theme="${name}"]`);
      expect(css).toContain(`.swatch[data-t="${name}"]`);
    }
    // System pair: light in :root, dark behind the media query.
    expect(css).toContain("prefers-color-scheme: dark");
    // Root canvas colour (view-transition / Chromium nav frames use html).
    expect(css).toMatch(/html\s*\{[^}]*background:\s*var\(--bg\)/);
    // Syntax colors are tokens, so every theme restyles code for free.
    expect(css).toContain("--tok-keyword");
    expect(css).toContain("color: var(--tok-keyword)");
  });

  // The front door is a visitor's own page with its own bar (home: a visitor's front page);
  // the switcher lives in the shared bar every other page carries.
  test("no cookie means system: no data-theme, switcher present", async () => {
    const text = await (await fetch(`${base}/explore`)).text();
    expect(text).not.toMatch(/<html[^>]*\sdata-theme=/);
    expect(text).toContain('action="/theme"');
    for (const name of THEME_NAMES) {
      expect(text).toContain(`value="${name}"`);
    }
    // §5: each choice is a labelled radio, the button a plain btn; no bespoke classes.
    const form = text.slice(text.indexOf('action="/theme"'));
    const end = form.indexOf("</form>");
    const panel = form.slice(0, end);
    expect(panel.match(/<label class="check">/g)?.length).toBe(THEME_NAMES.length + 1);
    expect(panel.match(/type="radio"/g)?.length).toBe(THEME_NAMES.length + 1);
    expect(panel).toMatch(/<button\s+type="submit"[\s\S]*class="btn"[\s\S]*Apply/);
    expect(text).not.toContain("theme-option");
    expect(text).not.toContain("theme-apply");
    // Critical paint before the stylesheet: system pair (light default + dark
    // media), then a rule per theme so a toggle repaints without a reload.
    const boot = text.match(/<style>([^<]*)<\/style>/)?.[1];
    expect(boot).toStartWith(
      "html,body{background-color:#fafafa;color-scheme:light}@media (prefers-color-scheme: dark){html,body{background-color:#09090b;color-scheme:dark}}",
    );
    expect(boot).toContain(
      'html[data-theme="dark"],html[data-theme="dark"] body{background-color:#09090b;color-scheme:dark}',
    );
    expect(boot).toContain(
      'html[data-theme="light"],html[data-theme="light"] body{background-color:#fafafa;color-scheme:light}',
    );
    for (const name of THEME_NAMES) {
      expect(boot).toContain(`html[data-theme="${name}"] body{`);
    }
  });

  test("choosing a theme sets the cookie and stamps the page", async () => {
    const post = await fetch(`${base}/theme`, {
      method: "POST",
      headers: { referer: `${base}/signin` },
      body: new URLSearchParams({ theme: "midnight" }),
      redirect: "manual",
    });
    expect(post.status).toBe(303);
    expect(post.headers.get("location")).toBe("/signin");
    const setCookie = post.headers.get("set-cookie") ?? "";
    expect(setCookie).toStartWith("forge_theme=midnight");

    const cookie = setCookie.split(";")[0]!;
    const text = await (await fetch(`${base}/explore`, { headers: { cookie } })).text();
    expect(text).toContain('data-theme="midnight"');
    // The switcher shows the active choice.
    expect(text).toMatch(/value="midnight"\s+checked/);
    // Boot paint follows the attribute: midnight's ground for this page, and
    // the same rules as a system page, so switching away repaints at once.
    const boot = text.match(/<style>([^<]*)<\/style>/)?.[1];
    expect(boot).toContain(
      'html[data-theme="midnight"],html[data-theme="midnight"] body{background-color:#16161e;color-scheme:dark}',
    );
    const system = (await (await fetch(base)).text()).match(
      /<style>([^<]*)<\/style>/,
    )?.[1];
    expect(boot).toBe(system!);
  });

  test("system clears the cookie; junk never sticks", async () => {
    const system = await fetch(`${base}/theme`, {
      method: "POST",
      body: new URLSearchParams({ theme: "system" }),
      redirect: "manual",
    });
    expect(system.headers.get("set-cookie")).toContain("Max-Age=0");

    const junk = await fetch(`${base}/theme`, {
      method: "POST",
      body: new URLSearchParams({ theme: '"><script>x</script>' }),
      redirect: "manual",
    });
    expect(junk.headers.get("set-cookie")).toContain("forge_theme=;");

    // A hostile cookie value arriving from outside is ignored at render time.
    const text = await (
      await fetch(base, { headers: { cookie: "forge_theme=evil" } })
    ).text();
    expect(text).not.toMatch(/<html[^>]*\sdata-theme=/);
  });

  test("theme POST refuses cross-origin and foreign referers", async () => {
    const cross = await fetch(`${base}/theme`, {
      method: "POST",
      headers: { origin: "https://evil.example" },
      body: new URLSearchParams({ theme: "dark" }),
      redirect: "manual",
    });
    expect(cross.status).toBe(403);

    const foreign = await fetch(`${base}/theme`, {
      method: "POST",
      headers: { referer: "https://evil.example/phish" },
      body: new URLSearchParams({ theme: "dark" }),
      redirect: "manual",
    });
    expect(foreign.status).toBe(303);
    expect(foreign.headers.get("location")).toBe("/");
  });
});

describe("HEAD mirrors the GET it stands in for", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-head-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("HEAD / is 200, empty, with the same content-type and security floor as GET /", async () => {
    const get = await fetch(`${base}/`);
    const getBody = await get.text();
    expect(getBody.length).toBeGreaterThan(0);

    const head = await fetch(`${base}/`, { method: "HEAD" });
    expect(head.status).toBe(get.status);
    expect(await head.text()).toBe("");
    expect(head.headers.get("content-type")).toBe(get.headers.get("content-type"));
    expect(head.headers.get("x-content-type-options")).toBe("nosniff");
    expect(head.headers.get("referrer-policy")).toBeTruthy();
    expect(head.headers.get("content-security-policy")).toContain("script-src 'self'");
  });

  test("HEAD /healthz is 200 with an empty body", async () => {
    const head = await fetch(`${base}/healthz`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  test("HEAD of a path with no route at all is 404", async () => {
    const head = await fetch(`${base}/no/such/route`, { method: "HEAD" });
    expect(head.status).toBe(404);
    expect(await head.text()).toBe("");
  });

  test("HEAD of a path that only has a POST route is 404, and never runs the handler", async () => {
    const head = await fetch(`${base}/theme`, { method: "HEAD" });
    expect(head.status).toBe(404);
    expect(await head.text()).toBe("");
    // The POST handler would have set a cookie; a HEAD must never reach it.
    expect(head.headers.get("set-cookie")).toBeNull();
  });
});

const FLOOR_POLICY =
  "default-src 'none'; frame-ancestors 'none'; base-uri 'none'";

/**
 * The floor, on one response: never sniffed, never a referrer off-site, no
 * powers a page does not use, https once https, and
 * — unless the body is a document with a policy of its own — inert.
 */
function expectFloor(what: string, response: Response): void {
  const label = `${what}: `;
  expect(label + response.headers.get("x-content-type-options")).toBe(
    label + "nosniff",
  );
  expect(label + response.headers.get("referrer-policy")).toBe(
    label + "same-origin",
  );
  // No powers a page does not use, and https once https (#2917).
  const powers = response.headers.get("permissions-policy") ?? "";
  for (const power of ["camera", "microphone", "geolocation", "payment", "usb"])
    expect(label + powers).toContain(`${power}=()`);
  expect(label + response.headers.get("strict-transport-security")).toBe(
    label + "max-age=31536000",
  );
  expect(label + response.headers.get("cross-origin-opener-policy")).toBe(
    label + "same-origin",
  );
  const policy = response.headers.get("content-security-policy") ?? "";
  expect(label + (policy === "" ? "(none)" : "(a policy)")).toBe(
    label + "(a policy)",
  );
  const html = (response.headers.get("content-type") ?? "").startsWith(
    "text/html",
  );
  if (!html) expect(label + policy).toBe(label + FLOOR_POLICY);
}

describe("the security floor is on every response", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-floor-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("one of each kind the forge serves carries it", async () => {
    const asset = await highlightAsset();
    expect(asset).not.toBeNull();

    const page = await fetch(`${base}/`);
    expect(page.status).toBe(200);
    expectFloor("html page", page);
    // An HTML body keeps the policy it writes for itself: the floor
    // adds the other two headers and does not touch a policy already there.
    expect(page.headers.get("content-security-policy")).toContain("script-src 'self'");

    const list = await fetch(`${base}/api/v1/repos`);
    expect(list.status).toBe(200);
    expectFloor("json", list);

    const missing = await fetch(`${base}/api/v1/repos/nobody/nothing`);
    expect(missing.status).toBe(404);
    expectFloor("error json", missing);

    const typo = await fetch(`${base}/no/such/route`, {
      headers: { accept: "application/json" },
    });
    expect(typo.status).toBe(404);
    expect(((await typo.json()) as { error: string }).error).toBe("no_route");
    expectFloor("no_route json", typo);

    const stylesheet = await fetch(`${base}${stylesheetAsset().path}`);
    expect(stylesheet.status).toBe(200);
    expect(stylesheet.headers.get("cache-control")).toContain("immutable");
    expectFloor("stylesheet", stylesheet);

    const built = await fetch(`${base}${asset!.path}`);
    expect(built.status).toBe(200);
    expectFloor("built asset", built);

    const redirect = await fetch(`${base}/theme`, {
      method: "POST",
      body: new URLSearchParams({ theme: "dark" }),
      redirect: "manual",
    });
    expect(redirect.status).toBe(303);
    expectFloor("redirect", redirect);

    const health = await fetch(`${base}/healthz`);
    expect(health.status).toBe(200);
    expectFloor("healthz", health);
  });

  test("a responder that set one of these keeps its own value", () => {
    const own = securityFloor(
      new Response("<p>fragment</p>", {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "content-security-policy": "default-src 'none'; sandbox",
          "referrer-policy": "no-referrer",
          "cross-origin-opener-policy": "same-origin-allow-popups",
        },
      }),
    );
    expect(own.headers.get("cross-origin-opener-policy")).toBe(
      "same-origin-allow-popups",
    );
    expect(own.headers.get("content-security-policy")).toBe(
      "default-src 'none'; sandbox",
    );
    expect(own.headers.get("referrer-policy")).toBe("no-referrer");
    expect(own.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

describe("a refused cross-origin mutation says why in the log", () => {
  quietLogs("warn");
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-crossorigin-"));
    app = createApp({ dataDir, port: 0, url: "https://forge.example" });
    servers = await serve(app);
    base = servers.url;
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  async function post(
    username: string,
    origin: string | undefined,
  ): Promise<{ status: number; logs: string }> {
    const logs: string[] = [];
    const wrote = (...args: unknown[]): void => {
      logs.push(args.map(String).join(" "));
    };
    const real = { log: console.log, warn: console.warn, error: console.error };
    console.log = wrote;
    console.warn = wrote;
    console.error = wrote;
    let response: Response;
    try {
      response = await fetch(`${base}/signup`, {
        method: "POST",
        ...(origin === undefined ? {} : { headers: { origin } }),
        body: new URLSearchParams({
          username,
          email: `${username}@forge.example`,
          password: "not-from-here-either",
        }),
        redirect: "manual",
      });
    } finally {
      console.log = real.log;
      console.warn = real.warn;
      console.error = real.error;
    }
    return { status: response.status, logs: logs.join("\n") };
  }

  test("a mismatched origin is refused and logged with both origins", async () => {
    const { status, logs } = await post("mallory", base);
    expect(status).toBe(403);
    expect(logs).toContain("refused cross-origin mutation");
    expect(logs).toContain(`origin=${base}`);
    expect(logs).toContain("expected=https://forge.example");
  });

  test("the matching origin passes, and logs nothing about it", async () => {
    const { status, logs } = await post("ada", "https://forge.example");
    expect(status).toBe(303);
    expect(logs).not.toContain("refused cross-origin mutation");
  });

  test("no Origin header at all also passes, and logs nothing about it", async () => {
    const { status, logs } = await post("bob", undefined);
    expect(status).toBe(303);
    expect(logs).not.toContain("refused cross-origin mutation");
  });
});

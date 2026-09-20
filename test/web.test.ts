import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { health } from "../src/http/health.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { escapeHtml, html, raw, when } from "../src/web/html.ts";
import {
  icon,
  iconSprite,
  inlineIcons,
  type IconName,
} from "../src/web/icons.ts";
import { renderMarkdown } from "../src/web/markdown.ts";
import { THEME_NAMES } from "../src/design/themes.ts";

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

    const sprite = iconSprite(icon("issue").text.repeat(4)).text;
    expect(sprite.match(/<symbol /g)).toHaveLength(1);
    expect(sprite).toContain(
      `<symbol id="i-issue" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"`,
    );
    expect(sprite).toContain('<circle cx="12" cy="12" r="1"/>');
    // Markup with no icons defines none at all.
    expect(iconSprite("<p>a page of words</p>").text).toBe("");
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
    const shipped = markup.length + iconSprite(markup).text.length;
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
    const signup = await fetch(`${base}/signup`, {
      method: "POST",
      body: new URLSearchParams({
        username: "ada",
        email: "ada@forge.local",
        password: "analytical-engine",
      }),
      redirect: "manual",
    });
    cookie = (signup.headers.get("set-cookie") ?? "").split(";")[0]!;
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
    }
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a list of a dozen rows sends the row's drawing once, not a dozen times", async () => {
    const text = await (
      await fetch(`${base}/ada/engine/issues`, { headers: { cookie } })
    ).text();
    expect(text.match(/<use href="#i-issue"\/>/g)!.length).toBeGreaterThan(11);
    // The drawing itself — the issue glyph's inner dot — exactly once.
    expect(text.match(/<circle cx="12" cy="12" r="1"\/>/g)).toHaveLength(1);
    expect(text.match(/<symbol id="i-issue"/g)).toHaveLength(1);
  });

  test("what a page defines is exactly what it used — no more, no less", async () => {
    for (const path of ["/", "/ada/engine/issues", "/settings"]) {
      const text = await (
        await fetch(`${base}${path}`, { headers: { cookie } })
      ).text();
      const used = new Set(
        [...text.matchAll(/<use href="#i-([A-Za-z]+)"\/>/g)].map((m) => m[1]),
      );
      const defined = [...text.matchAll(/<symbol id="i-([A-Za-z]+)"/g)].map(
        (m) => m[1],
      );
      expect(defined.length).toBe(used.size); // each defined once
      expect(new Set(defined)).toEqual(used); // and nothing else shipped
      expect(used.size).toBeGreaterThan(0);
    }
    // The front door is not the settings page's icons: a page with three
    // drawings does not ship twenty.
    const home = await (await fetch(base, { headers: { cookie } })).text();
    expect(home).not.toContain('id="i-webhook"');
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

  const clientEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: "Ada",
    GIT_AUTHOR_EMAIL: "ada@forge.local",
    GIT_COMMITTER_NAME: "Ada",
    GIT_COMMITTER_EMAIL: "ada@forge.local",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
  };

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
        username: "ada",
        email: "ada@forge.local",
        password: "analytical-engine",
      }),
      redirect: "manual",
    });
    expect(response.status).toBe(303);
    cookie = (response.headers.get("set-cookie") ?? "").split(";")[0]!;
    expect(cookie).toStartWith("forge_session=");

    const homePage = await fetch(base, { headers: { cookie } });
    const text = await homePage.text();
    expect(text).toContain("Sign out");
    expect(text).toContain(`href="/ada"`); // the account link in the topbar
    expect(text).toContain("New repository");
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
    // The script carries the scorer and consumes Escape itself.
    expect(text).toContain("function fuzzyScore(");
    expect(text).toContain("function openModal(");
  });

  test("stylesheet is served with an etag", async () => {
    const first = await fetch(`${base}/assets/forge.css`);
    expect(first.headers.get("content-type")).toContain("text/css");
    const etag = first.headers.get("etag")!;
    const second = await fetch(`${base}/assets/forge.css`, {
      headers: { "if-none-match": etag },
    });
    expect(second.status).toBe(304);
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
      body: JSON.stringify({
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

  test("a path under no route at all gets the forge's page for a browser, and no_route for anyone else", async () => {
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

    // No Accept header at all — a plain script or `curl` — keeps the JSON
    // contract, same as before this page existed.
    const plain = await fetch(`${base}/ada/engine/frobnicate`);
    expect(plain.status).toBe(404);
    expect(plain.headers.get("content-type")).toContain("application/json");
    const body = (await plain.json()) as { error: string; message: string };
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
    const css = await (await fetch(`${base}/assets/forge.css`)).text();
    for (const name of THEME_NAMES) {
      expect(css).toContain(`:root[data-theme="${name}"]`);
      expect(css).toContain(`.swatch[data-t="${name}"]`);
    }
    // System pair: light in :root, dark behind the media query.
    expect(css).toContain("prefers-color-scheme: dark");
    // Syntax colors are tokens, so every theme restyles code for free.
    expect(css).toContain("--tok-keyword");
    expect(css).toContain("color: var(--tok-keyword)");
  });

  test("no cookie means system: no data-theme, switcher present", async () => {
    const text = await (await fetch(base)).text();
    expect(text).not.toContain("data-theme=");
    expect(text).toContain('action="/theme"');
    for (const name of THEME_NAMES) {
      expect(text).toContain(`value="${name}"`);
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
    const text = await (await fetch(base, { headers: { cookie } })).text();
    expect(text).toContain('data-theme="midnight"');
    // The switcher shows the active choice.
    expect(text).toMatch(/value="midnight"\s+checked/);
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
    expect(text).not.toContain("data-theme=");
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

describe("readiness", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-health-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
  });

  afterAll(async () => {
    health.draining = false;
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("/healthz says ok, and 503 once the forge is draining; the landing page stays up either way", async () => {
    expect((await fetch(`${servers.url}/healthz`)).status).toBe(200);
    health.draining = true;
    const draining = await fetch(`${servers.url}/healthz`);
    expect(draining.status).toBe(503);
    expect(await draining.text()).toBe("draining");
    expect((await fetch(`${servers.url}/`)).status).toBe(200);
  });
});

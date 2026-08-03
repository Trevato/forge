import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { escapeHtml, html, raw, when } from "../src/web/html.ts";
import { renderMarkdown } from "../src/web/markdown.ts";

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
    expect(text).toContain("Sign out ada");
    expect(text).toContain("New repository");
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
});

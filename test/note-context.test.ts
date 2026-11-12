/**
 * A note from the forge pill carries where it came from (#10827): path, build
 * and up to five console errors, checked, cut short and folded at the foot of
 * the issue, never in its title.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { newApp } from "../src/actions/apps.ts";
import { sendNote } from "../src/actions/app_notes.ts";
import { contextFold, parseNoteContext } from "../src/actions/note_context.ts";
import { getAppBySlug } from "../src/core/apps.ts";
import { getIssue } from "../src/core/issues.ts";
import { getRepo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { toolbarJs } from "../src/apps/toolbar.ts";
import { renderMarkdown } from "../src/web/markdown.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const BUILD = "a1b2c3d4e5f6";

describe("note context, parsed", () => {
  test("keeps the server's build and says nothing of the page", () => {
    const c = parseNoteContext([], BUILD);
    expect(c).toEqual({ build: BUILD, errors: [] });
  });

  test("keeps five errors, each cut to 200 characters, without secrets or queries", () => {
    const errs = [
      "x".repeat(500),
      "GET https://api.test/v1?api_key=abc123 failed",
      "Authorization: Bearer abcdefghijklmnop",
      "token=supersecret",
      "four",
      "six is dropped",
      42,
    ];
    const c = parseNoteContext(errs, BUILD);
    expect(c.errors.length).toBe(5);
    expect(c.errors[0]!.length).toBe(200);
    expect(c.errors[1]).toBe("GET https://api.test/v1 failed");
    expect(c.errors.join(" ")).not.toMatch(/abcdefghijklmnop|supersecret|abc123/);
    expect(c.errors).not.toContain("six is dropped");
  });

  test("hostile fields are dropped, not trusted", () => {
    const c = parseNoteContext("not a list", "../../etc");
    expect(c).toEqual({ build: "", errors: [] });
    expect(contextFold(c)).toBe("");
  });
});

describe("a note's issue", () => {
  let dataDir = "";
  let app: App;
  let owner: User;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-note-context-"));
    app = createApp({ dataDir, port: 0, host: "forge.test" });
    const made = await createUser(app.db, {
      username: "alice", email: "alice@forge.test", password: "a-good-passphrase",
      origin: "seed", trusted: true, adminIfFirst: true,
    });
    if (!made.ok) throw new Error(String(made.error));
    owner = made.value;
    const a = await newApp(app, owner, { name: "shop", description: "Words", visibility: "public" });
    if (!a.ok) throw new Error(String(a.error));
  });
  afterAll(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });

  test("stores the context under a fold, escaped, and not in the title", async () => {
    const repo = getRepo(app.db, "alice", "shop")!;
    const record = getAppBySlug(app.db, "shop")!;
    const context = parseNoteContext(["<img src=x onerror=alert(1)> `tick` \n</details>", "y".repeat(900)], BUILD);
    const sent = await sendNote(
      app, record, repo, "production", undefined,
      { key: `u:${owner.id}`, name: "alice", person: true },
      { text: "too small", page: "http://shop.test/cart", viewport: "390x844", context },
      "10.9.0.1",
    );
    if (!sent.ok) throw new Error(sent.error.message);
    const issue = getIssue(app.db, repo.id, sent.value.number)!;
    expect(issue.title).toBe("From the app: too small");
    expect(issue.body).toContain("<details><summary>Where this came from</summary>");
    expect(issue.body).toContain(`- Build: \`${BUILD}\``);
    expect(issue.body).not.toContain("- Path:");
    expect(issue.body.match(/\/cart/g)!.length).toBe(1); // the `- Page:` line says it once
    const errors = issue.body.split("\n").filter((l) => l.startsWith("- Console error:"));
    expect(errors.length).toBe(2);
    expect(errors[1]!.length).toBeLessThanOrEqual(200 + 20);
    const html = String(renderMarkdown(issue.body));
    expect(html).toContain("<details><summary>Where this came from</summary>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
    expect(html.match(/<\/details>/g)!.length).toBe(1);
  });
});

test("the pill sends the last console errors with a note", () => {
  expect(toolbarJs).toContain("errors: errs.slice(-5)");
  expect(toolbarJs).toContain('"unhandledrejection"');
});

describe("the fold in user text", () => {
  const html = (md: string) => String(renderMarkdown(md));
  const opens = (h: string) => (h.match(/<details>/g) ?? []).length;
  const closes = (h: string) => (h.match(/<\/details>/g) ?? []).length;

  test("an unclosed fold is closed by the renderer", () => {
    const h = html("<details><summary>More</summary>\n- one");
    expect(opens(h)).toBe(1);
    expect(closes(h)).toBe(1);
  });

  test("a nested fold is not a second fold: the flat rule holds", () => {
    const h = html("<details><summary>A</summary>\n<details><summary>B</summary>\nx\n</details>\n</details>");
    expect(opens(h)).toBe(1);
    expect(closes(h)).toBe(1);
    expect(h).toContain("&lt;details&gt;&lt;summary&gt;B");
  });

  test("a stray close is text, not a tag", () => {
    const h = html("hello\n</details>");
    expect(closes(h)).toBe(0);
  });

  test("a title with disallowed characters is text", () => {
    for (const title of ['x"onclick="1', "a<b", "a&amp;b", "it's", "`t`", "", "z".repeat(81)]) {
      const h = html(`<details><summary>${title}</summary>\nbody\n</details>`);
      expect(opens(h)).toBe(0);
      expect(h).not.toContain("<summary>");
    }
    expect(html("<details><summary>Fine title</summary>\nbody\n</details>")).toContain("<summary>Fine title</summary>");
  });
});

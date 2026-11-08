/** The door follows the reader's colour scheme, and its CSP hash is derived from its style (#6653). */

import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { doorPage } from "../src/apps/door.ts";

test("the door's style-src hash matches its one <style> block, and a dark rule is present", async () => {
  const res = doorPage(
    { where: { app: "lab", env: "production" }, forgeUrl: "https://forge.test", ssh: "ssh -p 2222 lab@localhost" },
    false,
  );
  const html = await res.text();
  const blocks = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)];
  expect(blocks.length).toBe(1);
  const css = blocks[0]![1]!;
  const hash = createHash("sha256").update(css).digest("base64");
  expect(res.headers.get("content-security-policy")).toContain(`style-src 'sha256-${hash}'`);
  expect(css).toContain("color-scheme:light dark");
  expect(css).toMatch(/@media \(prefers-color-scheme: dark\)\{[^]*body\{[^}]*background[^}]*\}[^]*a\{[^}]*\}[^]*pre\{[^}]*\}/);
  expect(html).not.toContain("<script");
});

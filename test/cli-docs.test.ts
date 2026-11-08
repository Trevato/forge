/**
 * docs/CLI.md keeps up with the CLI (#7372): every command `forge help`
 * prints has a `## forge <command>` heading there. The help is rendered
 * in-process: spawning a process made the verdict depend on the machine's load.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { printUsage } from "../src/cli/help.ts";
import { createOut } from "../src/cli/out.ts";

const root = new URL("..", import.meta.url).pathname;
const DOC = "docs/CLI.md";

async function help(): Promise<string> {
  const lines: string[] = [];
  printUsage({ ...createOut(), line: (t = "") => void lines.push(t) });
  return lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
}

/** `  forge sync   [--watch]` → "sync"; the bare `  forge      the local…` → "": a command is one space after `forge`, a description many. */
function helpCommands(text: string): string[] {
  const names: string[] = [];
  for (const line of text.split("\n")) {
    const m = /^\s+forge(?: ([a-z][a-z-]*))?(?:\s|$)/.exec(line);
    if (m !== null) names.push(m[1] ?? "");
  }
  return names;
}

/** `## forge`, `## forge sync` → "", "sync". */
function docHeadings(markdown: string): Set<string> {
  const found = new Set<string>();
  for (const line of markdown.split("\n")) {
    const m = /^## forge(?: ([a-z][a-z-]*))?\s*$/.exec(line);
    if (m !== null) found.add(m[1] ?? "");
  }
  return found;
}

test("helpCommands reads each command off its usage line", () => {
  const sample = [
    "forge 0.0.1 — your workbench, on this machine",
    "",
    "  forge                        the local terminal UI",
    "  forge login <url>            [--token T]",
    "  forge logout",
    "  config /x/config.json   root /x/src",
  ].join("\n");
  expect(helpCommands(sample)).toEqual(["", "login", "logout"]);
});

test("every command `forge help` lists has a heading in docs/CLI.md", async () => {
  const commands = helpCommands(await help());
  // The help has never had fewer than these; an empty parse is a broken test.
  expect(commands).toContain("login");
  expect(commands).toContain("sync");
  const headings = docHeadings(readFileSync(`${root}${DOC}`, "utf8"));
  const missing = commands
    .filter((c) => !headings.has(c))
    .map((c) => (c === "" ? "## forge" : `## forge ${c}`));
  if (missing.length > 0)
    throw new Error(
      `${DOC} has no section for ${missing.length} command(s) \`forge help\` lists. ` +
        `Add each heading, with what it does, its flags and one example:\n` +
        missing.map((h) => `  ${h}`).join("\n"),
    );
});

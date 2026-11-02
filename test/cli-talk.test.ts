/** `forge talk` against a fake conversation API, run as a shell runs it (#8821). */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT } from "../src/cli/main.ts";

const CLI = new URL("../src/cli/main.ts", import.meta.url).pathname;

let server: ReturnType<typeof Bun.serve>;
let dir = "";
let said = false;

/** What the API answers once the words are said: a thought, a call, and the reply with its work. */
const ANSWER = [
  { id: "t2", role: "tool", text: JSON.stringify({ thinking: "First \x1b[31mlook\x1b[0m\nat the issue." }) },
  { id: "t3", role: "tool", text: 'mcp__forge__issue {"repo":"alice/x","number":12}' },
  {
    id: "t4",
    role: "agent",
    text: "Twelve is open.",
    work: { steps: "opened #12\x07", links: [{ href: "/alice/x/issues/12", label: "alice/x #12" }, { href: "/alice/x/blob/main/a\x1b[2J.ts", label: "a" }] },
  },
];

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-cli-talk-"));
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/api/v1/conversation/messages" && req.method === "POST") {
        said = true;
        return Response.json({ how: "started" }, { status: 202 });
      }
      if (url.pathname === "/api/v1/conversation/turns")
        return Response.json({ running: false, turns: [{ id: "t1", role: "agent", text: "Earlier.", work: null }, ...(said ? ANSWER : [])] });
      return Response.json({ error: "not_found", message: "no" }, { status: 404 });
    },
  });
});

afterAll(async () => {
  server.stop(true);
  await rm(dir, { recursive: true, force: true });
});

test("prints the thought on one line, the reply, its steps line and its link paths, all inert", async () => {
  const proc = Bun.spawn(["bun", CLI, "talk", "what", "is", "open"], {
    cwd: dir,
    env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "", FORGE_URL: `http://127.0.0.1:${server.port}`, FORGE_TOKEN: "tok", FORGE_CONFIG_DIR: dir, FORGE_KEYCHAIN: "0", NO_COLOR: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  expect(code).toBe(EXIT.ok);
  const lines = out.trimEnd().split("\n");
  expect(lines).toEqual([
    "thinking: First �[31mlook�[0m at the issue.",
    "Twelve is open.",
    "opened #12�",
    "/alice/x/issues/12",
    "/alice/x/blob/main/a�[2J.ts",
  ]);
  // Nothing the API said reaches the terminal as a control character.
  expect(out.replaceAll("\n", "")).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
  // A turn seen before the words were said is not printed again.
  expect(out).not.toContain("Earlier.");
}, 15_000);

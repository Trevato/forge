import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT, main } from "../src/cli/main.ts";
import { readdirSync } from "node:fs";
import { commands } from "../src/cli/commands/index.ts";
import { printUsage } from "../src/cli/help.ts";
import { createOut } from "../src/cli/out.ts";

const DIR = new URL("../src/cli/commands/", import.meta.url).pathname;
const files = readdirSync(DIR)
  .filter((f) => f.endsWith(".ts") && f !== "index.ts" && f !== "types.ts")
  .map((f) => f.slice(0, -3));

test("every module in commands/ is in the table, named for its file", async () => {
  for (const file of files) {
    const mod = (await import(`${DIR}${file}.ts`)) as { command?: unknown };
    expect(commands).toContain(mod.command as never);
    expect(commands.map((c) => c.name)).toContain(file);
  }
  expect(commands.length).toBe(files.length);
  expect(new Set(commands.map((c) => c.name)).size).toBe(commands.length);
});

test("forge help lists every command", () => {
  const lines: string[] = [];
  const out = { ...createOut(), line: (t = "") => void lines.push(t) };
  printUsage(out);
  const text = lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
  for (const c of commands) expect(text).toContain(`  ${c.usage.synopsis}`);
});

// ── dispatch, driven through main() as the shell does ────────────────────

describe("main() dispatch", () => {
  const ENV = [
    "FORGE_CONFIG_DIR",
    "FORGE_KEYCHAIN",
    "FORGE_URL",
    "FORGE_TOKEN",
  ];
  const saved = new Map<string, string | undefined>();
  let dir = "";
  const realErr = process.stderr.write.bind(process.stderr);
  const realOut = process.stdout.write.bind(process.stdout);

  beforeEach(async () => {
    for (const key of ENV) saved.set(key, process.env[key]);
    dir = await mkdtemp(join(tmpdir(), "forge-dispatch-"));
    process.env["FORGE_CONFIG_DIR"] = dir;
    process.env["FORGE_KEYCHAIN"] = "0";
    delete process.env["FORGE_URL"];
    delete process.env["FORGE_TOKEN"];
    process.stderr.write = (() => true) as typeof process.stderr.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;
  });

  afterEach(async () => {
    process.stderr.write = realErr;
    process.stdout.write = realOut;
    for (const key of ENV) {
      const was = saved.get(key);
      if (was === undefined) delete process.env[key];
      else process.env[key] = was;
    }
    await rm(dir, { recursive: true, force: true });
  });

  test("an unknown command is a usage error", async () => {
    expect(await main(["nope"])).toBe(EXIT.usage);
  });

  test("help, --help and -h succeed", async () => {
    expect(await main(["help"])).toBe(EXIT.ok);
    expect(await main(["--help"])).toBe(EXIT.ok);
    expect(await main(["sync", "-h"])).toBe(EXIT.ok);
  });

  test("a known command reaches its run", async () => {
    expect(await main(["whoami"])).toBe(EXIT.notConfigured);
    expect(await main(["pin", "nonsense"])).toBe(EXIT.usage);
  });
});

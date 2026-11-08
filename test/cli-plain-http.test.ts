/**
 * `forge login` and every later command refuse plain http to another
 * machine (#7377): the token rides on every request, and over http it
 * crosses the network in clear. Loopback http and https pass; `--insecure`
 * passes and is remembered with that workbench only.
 *
 * Driven through `main()`, the function the shell calls, with `fetch`
 * stubbed so no request leaves the test — and counted, so "refused before
 * any request" is a number, not a hope.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  configPath,
  loadConfig,
  normalizeUrl,
  PLAIN_HTTP_REFUSAL,
  plainHttpRemote,
} from "../src/cli/config.ts";
import { main } from "../src/cli/main.ts";

const ENV = ["FORGE_CONFIG_DIR", "FORGE_KEYCHAIN", "FORGE_URL", "FORGE_TOKEN"];
const saved = new Map<string, string | undefined>();
let dir = "";
let requests: string[] = [];
let stderr = "";
const realFetch = globalThis.fetch;
const realErr = process.stderr.write.bind(process.stderr);
const realOut = process.stdout.write.bind(process.stdout);

beforeEach(async () => {
  for (const key of ENV) saved.set(key, process.env[key]);
  dir = await mkdtemp(join(tmpdir(), "forge-plain-http-"));
  process.env["FORGE_CONFIG_DIR"] = dir;
  process.env["FORGE_KEYCHAIN"] = "0";
  delete process.env["FORGE_URL"];
  delete process.env["FORGE_TOKEN"];
  requests = [];
  stderr = "";
  globalThis.fetch = (async (input: string | URL | Request) => {
    requests.push(String(input));
    return Response.json({ username: "ada", displayName: "Ada" });
  }) as typeof fetch;
  process.stderr.write = ((text: string) => {
    stderr += text;
    return true;
  }) as typeof process.stderr.write;
  process.stdout.write = (() => true) as typeof process.stdout.write;
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  process.stderr.write = realErr;
  process.stdout.write = realOut;
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(dir, { recursive: true, force: true });
});

async function stored(): Promise<Record<string, unknown> | null> {
  const file = Bun.file(configPath());
  return (await file.exists()) ? ((await file.json()) as never) : null;
}

test("only http to a host other than this machine is plain-http remote", () => {
  expect(plainHttpRemote("http://forge.example.com")).toBe(true);
  expect(plainHttpRemote("http://10.0.0.5:3000")).toBe(true);
  expect(plainHttpRemote("http://localhost.evil.example")).toBe(true);
  expect(plainHttpRemote("http://localhost:3000")).toBe(false);
  expect(plainHttpRemote("http://LOCALHOST")).toBe(false);
  expect(plainHttpRemote("http://127.0.0.1:8080")).toBe(false);
  expect(plainHttpRemote("http://[::1]:8080")).toBe(false);
  expect(plainHttpRemote("https://forge.example.com")).toBe(false);
});

test("bare hosts still become https, loopback still http", () => {
  expect(normalizeUrl("forge.example.com/")).toBe("https://forge.example.com");
  expect(normalizeUrl("localhost:3000")).toBe("http://localhost:3000");
  expect(normalizeUrl("127.0.0.1")).toBe("http://127.0.0.1");
  expect(normalizeUrl("[::1]:3000")).toBe("http://[::1]:3000");
});

test("login to a remote http address is refused, exits 2, writes nothing, sends nothing", async () => {
  const code = await main(["login", "http://forge.example.com", "--token", "t"]);
  expect(code).toBe(2);
  expect(stderr).toBe(`forge login: ${PLAIN_HTTP_REFUSAL}\n`);
  expect(requests).toEqual([]);
  expect(await stored()).toBeNull();
});

test("login over loopback http and over https passes", async () => {
  expect(await main(["login", "http://127.0.0.1:3000", "--token", "t"])).toBe(0);
  expect(await stored()).toEqual({ url: "http://127.0.0.1:3000", token: "t" });
  expect(await main(["login", "forge.example.com", "--token", "t"])).toBe(0);
  expect(await stored()).toEqual({ url: "https://forge.example.com", token: "t" });
  expect(requests).toEqual([
    "http://127.0.0.1:3000/api/v1/user",
    "https://forge.example.com/api/v1/user",
  ]);
});

test("--insecure passes, is kept with the workbench, and later commands work", async () => {
  const code = await main([
    "login",
    "http://forge.lan:3000",
    "--insecure",
    "--token",
    "t",
  ]);
  expect(code).toBe(0);
  expect(await stored()).toEqual({
    url: "http://forge.lan:3000",
    token: "t",
    insecure: true,
  });
  expect(await main(["whoami"])).toBe(0);
  expect(requests).toEqual([
    "http://forge.lan:3000/api/v1/user",
    "http://forge.lan:3000/api/v1/user",
  ]);
});

test("--insecure is not stored where it means nothing", async () => {
  await main(["login", "forge.example.com", "--insecure", "--token", "t"]);
  expect(await stored()).toEqual({ url: "https://forge.example.com", token: "t" });
});

test("FORGE_URL to a remote http address is refused before any request", async () => {
  process.env["FORGE_URL"] = "http://forge.example.com";
  process.env["FORGE_TOKEN"] = "t";
  expect(await loadConfig()).toBe("plain_http");
  expect(await main(["whoami"])).toBe(2);
  expect(stderr).toBe(`forge: ${PLAIN_HTTP_REFUSAL}\n`);
  expect(requests).toEqual([]);
});

test("a stored --insecure covers its own workbench, not another FORGE_URL", async () => {
  await main(["login", "http://forge.lan", "--insecure", "--token", "t"]);
  process.env["FORGE_URL"] = "http://forge.lan/";
  expect(await loadConfig()).not.toBeString();
  process.env["FORGE_URL"] = "http://other.lan";
  expect(await loadConfig()).toBe("plain_http");
});

test("an existing remote http login gets the refusal's words on its next command", async () => {
  await Bun.write(
    configPath(),
    JSON.stringify({ url: "http://forge.example.com", token: "t" }),
  );
  expect(await main(["sync"])).toBe(2);
  expect(stderr).toBe(`forge: ${PLAIN_HTTP_REFUSAL}\n`);
  expect(requests).toEqual([]);
});

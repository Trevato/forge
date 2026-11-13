import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fetchMirror,
  fetchRefFrom,
  MIRROR_REFUSED,
  MIRROR_UNRESOLVED,
  provideMirrorOutboundForTest,
} from "../src/origins/git-mirror.ts";
import { remoteGitEnv, pinFor } from "../src/git/remote-env.ts";
import { mirrorOutbound } from "./helpers/globals.ts";

let dir: string;
mirrorOutbound({});
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "mirror-outbound-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("a remote that resolves to 127.0.0.1 is refused before git starts", async () => {
  // `dir` is not a repository: had git started, the message would be git's.
  provideMirrorOutboundForTest({ resolve: async () => ["127.0.0.1"] });
  const refused = await fetchMirror(dir, "https://example.test/a/b.git", {});
  expect(refused.ok).toBe(false);
  if (!refused.ok) expect(refused.error.message).toBe(MIRROR_REFUSED);
  const literal = await fetchMirror(dir, "http://127.0.0.1:9/a/b.git", {});
  expect(literal.ok).toBe(false);
  if (!literal.ok) expect(literal.error.message).toBe(MIRROR_REFUSED);
});

test("git's environment carries the pin, no redirects and the protocol list", () => {
  const env = remoteGitEnv(
    { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "a.b", GIT_CONFIG_VALUE_0: "c" },
    pinFor("https://git.example.test/a/b.git", { via: "pin", addresses: ["93.184.216.34"] }),
  );
  expect(env["GIT_ALLOW_PROTOCOL"]).toBe("https:http");
  const pairs = Array.from({ length: Number(env["GIT_CONFIG_COUNT"]) }, (_, i) => [
    env[`GIT_CONFIG_KEY_${i}`],
    env[`GIT_CONFIG_VALUE_${i}`],
  ]);
  expect(pairs).toEqual([
    ["a.b", "c"],
    ["http.followRedirects", "false"],
    ["http.curloptResolve", "git.example.test:443:93.184.216.34"],
  ]);
});

test("fetchRefFrom refuses a private host and reports an unresolvable one before git starts", async () => {
  provideMirrorOutboundForTest({ resolve: async () => ["127.0.0.1"] });
  const refused = await fetchRefFrom(dir, "https://example.test/a/b.git", "refs/heads/main", {});
  expect(refused.ok).toBe(false);
  if (!refused.ok) expect(refused.error.message).toBe(MIRROR_REFUSED);

  provideMirrorOutboundForTest({ resolve: async () => [] });
  const gone = await fetchRefFrom(dir, "https://example.test/a/b.git", "refs/heads/main", {});
  expect(gone.ok).toBe(false);
  if (!gone.ok) expect(gone.error.message).toBe(MIRROR_UNRESOLVED);
  const goneMirror = await fetchMirror(dir, "https://example.test/a/b.git", {});
  expect(goneMirror.ok).toBe(false);
  if (!goneMirror.ok) expect(goneMirror.error.message).toBe(MIRROR_UNRESOLVED);
});

test("pinFor brackets an IPv6 address and honours an explicit port", () => {
  const pin = (url: string, ip: string) =>
    remoteGitEnv({}, pinFor(url, { via: "pin", addresses: [ip] }))["GIT_CONFIG_VALUE_1"];
  expect(pin("https://git.example.test/a.git", "2001:db8::1")).toBe(
    "git.example.test:443:[2001:db8::1]",
  );
  expect(pin("http://git.example.test:8080/a.git", "93.184.216.34")).toBe(
    "git.example.test:8080:93.184.216.34",
  );
  expect(pin("http://git.example.test/a.git", "93.184.216.34")).toBe(
    "git.example.test:80:93.184.216.34",
  );
  expect(pin("https://[2001:db8::2]:444/a.git", "2001:db8::2")).toBe(
    "2001:db8::2:444:[2001:db8::2]",
  );
});

import { expect, test } from "bun:test";
import { REMOTE_PROTOCOLS, remoteGitEnv } from "../src/git/remote-env.ts";
import { fetchEnv } from "../src/actions/migrate.ts";

test("remote fetches speak https and http only, never git", () => {
  expect(REMOTE_PROTOCOLS.split(":")).toEqual(["https", "http"]);
  expect(remoteGitEnv({})["GIT_ALLOW_PROTOCOL"]).toBe(REMOTE_PROTOCOLS);
  expect(fetchEnv({}, {})["GIT_ALLOW_PROTOCOL"]).toBe(REMOTE_PROTOCOLS);
});

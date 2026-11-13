/**
 * A hosted forge's own outbound code, run in a process that has nothing but
 * the proxy variables its cell would give it (`test/spawn-gate-e2e.test.ts`):
 * it vets a name, fetches it, and runs `ls-remote` and `fetch` against it,
 * then prints what happened as one JSON line.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGit } from "../../src/git/env.ts";
import { pinFor, remoteGitEnv } from "../../src/git/remote-env.ts";
import { GateRefusedError, outboundFetch, vetHost } from "../../src/kernel/outbound.ts";

const base = process.env["TARGET"]!;
const caFile = process.env["CA_FILE"]!;
const ca = await Bun.file(caFile).text();
const url = new URL(base);

const route = await vetHost(url.hostname);
const answer = await outboundFetch(`${base}/hello`, {}, { ca });
const gitUrl = `${base}/r.git`;
const env = { ...remoteGitEnv({}, route.ok ? pinFor(gitUrl, route.value) : undefined), GIT_SSL_CAINFO: caFile };
const listed = await runGit(["ls-remote", gitUrl], { env });
const into = mkdtempSync(join(tmpdir(), "gate-child-"));
await runGit(["init", "--bare", into], { env });
const fetched = await runGit(["fetch", gitUrl, "+refs/heads/*:refs/heads/*"], { cwd: into, env });
const main = await runGit(["rev-parse", "main"], { cwd: into });
const literal = await vetHost("127.0.0.1");
const refused = await outboundFetch(`https://${url.hostname}:${Number(url.port) + 1}/hello`, {}, { ca }).catch((e: unknown) => e);

console.log(
  JSON.stringify({
    via: route.ok ? route.value.via : route.error,
    body: await answer.text(),
    listed: listed.ok ? listed.value : listed.error.stderr,
    fetched: fetched.ok,
    main: main.ok ? main.value : "",
    literal: literal.ok ? "reached" : literal.error,
    refused: refused instanceof GateRefusedError ? refused.message : String(refused),
  }),
);

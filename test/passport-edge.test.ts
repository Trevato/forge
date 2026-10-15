import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { issue } from "../src/kernel/passport.ts";
import { passportEnv } from "../src/crew/passport_env.ts";

let dataDir = "";
let servers: Servers;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-passport-edge-"));
  servers = await serve(createApp({ dataDir, port: 0 }));
});
afterAll(() => servers.stop?.());

const ask = (token?: string) =>
  fetch(`${servers.url}/api/v1/passport/health`, {
    headers: token === undefined ? {} : { authorization: `Passport ${token}` },
  });
const mint = (o: { aud?: string; scopes?: string[]; ttlMs?: number; now?: number } = {}) => {
  const r = issue(dataDir, {
    iss: "runner",
    aud: o.aud ?? "forge",
    scopes: o.scopes ?? ["health:read"],
    ttlMs: o.ttlMs ?? 60_000,
    now: o.now ?? Date.now(),
  });
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

/** Change the signature's first character: always a different MAC. */
const tamperSig = (t: string) =>
  t.replace(/\.([^.])([^.]*)$/, (_, c, rest) => `.${c === "A" ? "B" : "A"}${rest}`);

test("a good passport reads the health", async () => {
  const r = await ask(mint());
  expect(r.status).toBe(200);
  expect(((await r.json()) as { ok: boolean }).ok).toBeDefined();
});

test("the runner's own passport is accepted", async () => {
  const r = await ask(passportEnv(dataDir)["FORGE_PASSPORT"]);
  expect(r.status).toBe(200);
});

test("missing, expired, wrong-audience, wrong-scope and forged passports are refused", async () => {
  const bad = [
    undefined,
    "garbage",
    mint({ now: Date.now() - 120_000 }),
    mint({ aud: "app" }),
    mint({ scopes: ["run:read"] }),
    tamperSig(mint()),
    `${mint()}=`,
    mint().replace(/.$/, "!$&"),
  ];
  for (const t of bad) expect((await ask(t)).status).toBe(401);
});

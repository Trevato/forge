/**
 * `bun scripts/pack-compat.ts` — does every shipped pack deploy on a clean
 * forge? For each pack it boots a new forge on an empty data directory, makes
 * an account and a token, deploys the pack as `scripts/pack.ts` does (so the
 * apps' real sources are cloned over the network) and checks every step
 * succeeded and each app's page answers. Exit 1 and the failing steps
 * otherwise. Run nightly (`src/nightly/jobs.ts`, job `pack-compat`).
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve } from "../src/http/server.ts";
import { catalog } from "../src/packs/catalog.ts";
import { deployPack } from "../src/packs/deploy.ts";
import { realHands } from "./pack.ts";

const { packs, problems } = catalog();
let failed = problems.length;
for (const p of problems) console.error(`✗ ${p}`);

for (const pack of packs) {
  const dataDir = await mkdtemp(join(tmpdir(), `pack-compat-${pack.name}-`));
  const app = createApp({ dataDir, port: 0 });
  const servers = await serve(app);
  try {
    const made = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      allowReserved: true,
      username: "owner",
      email: "owner@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!made.ok) throw new Error(made.error);
    const token = createToken(app.db, made.value.id, "pack-compat", "rw").token;
    const steps = await deployPack(pack, realHands(servers.url, token));
    for (const s of steps) {
      const ok = s.state === "done";
      if (!ok) failed++;
      console.log(`${ok ? "✓" : "✗"} ${pack.name}: ${s.what}${s.note ? ` — ${s.note}` : ""}`);
    }
    for (const a of pack.apps) {
      const res = await fetch(`${servers.url}/owner/${a.name}`);
      await res.arrayBuffer();
      if (res.status !== 200) {
        failed++;
        console.log(`✗ ${pack.name}: /owner/${a.name} answered ${res.status}`);
      }
    }
  } finally {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}
process.exit(failed === 0 ? 0 : 1);

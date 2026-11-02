/**
 * `bun scripts/backup-probe.ts --forge <url> [--dir <path>] [--max-age-hours 36]`
 * — the dead-man probe, run from cron or another host, not by the forge.
 * Reads the bucket (`S3_*` from the environment, or `--dir`) and the forge's
 * `/healthz`; prints one line each and exits 1 when either is silent. See
 * `docs/features/backup-truth.md`.
 */

import { parseProbeArgs, probe } from "../src/snapshot/probe.ts";
import { dirStore, s3FromEnv, s3Store, withRetries, type Store } from "../src/snapshot/store.ts";

const parsed = parseProbeArgs(process.argv.slice(2), process.env);
if ("error" in parsed) {
  console.error(parsed.error);
  process.exit(2);
}

const s3 = s3FromEnv();
const store: Store | undefined =
  parsed.dir !== undefined ? dirStore(parsed.dir) : s3 ? withRetries(s3Store(s3), { attempts: 2 }) : undefined;

const result = await probe({ store, forgeUrl: parsed.forgeUrl, maxAgeMs: parsed.maxAgeMs });
for (const f of result.findings) console.log(`${f.ok ? "ok " : "RED"} ${f.what}: ${f.detail}`);
process.exit(result.ok ? 0 : 1);

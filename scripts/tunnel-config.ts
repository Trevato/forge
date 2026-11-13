/**
 * `bun scripts/tunnel-config.ts [--db <forge.db>] [--write]` — renders the host
 * tunnel's ingress from the apps' verified domains. Prints it, or with `--write`
 * replaces infra/forge-box/cloudflared-forge.yml. Reads the database only.
 * The database is `--db`, else `$FORGE_DATA/forge.db`; neither is exit 2.
 */
import { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { appDomainHosts, renderTunnelConfig } from "../src/system/tunnel_config.ts";

const usage = "usage: bun scripts/tunnel-config.ts [--db <forge.db>] [--write]  (default db: $FORGE_DATA/forge.db)";
const args = process.argv.slice(2);
const i = args.indexOf("--db");
let dbPath: string | undefined;
if (i >= 0) dbPath = args[i + 1];
else if (process.env.FORGE_DATA) dbPath = join(process.env.FORGE_DATA, "forge.db");
if (!dbPath || dbPath.startsWith("--")) {
  console.error(usage);
  process.exit(2);
}
const text = renderTunnelConfig(appDomainHosts(new Database(dbPath, { readonly: true })));
const out = process.env.FORGE_TUNNEL_CONFIG_OUT ?? join(import.meta.dir, "../infra/forge-box/cloudflared-forge.yml");
if (args.includes("--write")) writeFileSync(out, text);
else process.stdout.write(text);

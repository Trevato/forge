/**
 * celld, pinned: fetch the one release this repository has been tried against,
 * check its SHA-256, unpack it into a cache under the temp dir, return its path.
 * A new celld is a deliberate pull: change VERSION and every digest together.
 */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const VERSION = "v0.6.1";
const BASE = `https://github.com/denoland/celld/releases/download/${VERSION}/`;

/** Asset name and SHA-256 of the compressed download, by `${platform}-${arch}`. */
const ASSETS: Record<string, { file: string; sha256: string }> = {
  "linux-x64": {
    file: "celld-x86_64-unknown-linux-gnu.gz",
    sha256: "79a8253cff5d4e8a4a9f7a2611e393390f7fe9025f00e88467875b007c44866b",
  },
  "linux-arm64": {
    file: "celld-aarch64-unknown-linux-gnu.gz",
    sha256: "ab99053bcced225bb5b54f428792260c905b782b8a61947362a12ce3a9c22def",
  },
  "darwin-arm64": {
    file: "celld-aarch64-apple-darwin.gz",
    sha256: "3033cc4f428433f4239ac616a04092cd4b6c7db19f2f5ba9926c86ec56c34c95",
  },
};

/** The path of the pinned celld binary, fetched on first use. Throws when it cannot be had. */
export async function celld(
  platform: string = process.platform,
  arch: string = process.arch,
): Promise<string> {
  const asset = ASSETS[`${platform}-${arch}`];
  if (!asset)
    throw new Error(
      `celld ${VERSION} has no build for ${platform}-${arch}; it has ${Object.keys(ASSETS).join(", ")}`,
    );
  const dir = join(tmpdir(), `forge-celld-${VERSION}-${asset.sha256.slice(0, 12)}`);
  const bin = join(dir, "celld");
  if (existsSync(bin)) return bin;

  const res = await fetch(BASE + asset.file, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`celld download: ${res.status} for ${asset.file}`);
  const gz = new Uint8Array(await res.arrayBuffer());
  const sum = createHash("sha256").update(gz).digest("hex");
  if (sum !== asset.sha256)
    throw new Error(`celld download: SHA-256 ${sum} is not the pinned ${asset.sha256}`);

  mkdirSync(dir, { recursive: true });
  const tmp = `${bin}.${process.pid}.part`;
  writeFileSync(tmp, Bun.gunzipSync(gz));
  chmodSync(tmp, 0o755);
  renameSync(tmp, bin);
  return bin;
}

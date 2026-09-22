/**
 * Where snapshots go. Two places, one shape: a bucket over S3 (the platform
 * gives every app one, mirrored off the machine by lanes the forge never
 * sees) or a directory (a forge on a desk, a test). Keys are paths; the
 * store keeps no other idea of structure, so a snapshot is exactly the
 * files it lists and a restore is exactly reading them back.
 */

import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";

export interface Store {
  /** What this store is, for a page and a log; never a secret. */
  readonly where: string;
  put(key: string, body: Uint8Array | string): Promise<void>;
  get(key: string): Promise<Uint8Array | undefined>;
  /** Every key under `prefix`, in no particular order. */
  list(prefix: string): Promise<string[]>;
  delete(key: string): Promise<void>;
}

/** The S3 credentials as the platform hands them to an app. */
export interface S3Target {
  readonly endpoint: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly region?: string | undefined;
}

/** Read the platform's `S3_*` variables; undefined when the app has no bucket. */
export function s3FromEnv(
  env: Record<string, string | undefined> = process.env,
): S3Target | undefined {
  const endpoint = env["S3_ENDPOINT"]?.trim();
  const bucket = env["S3_BUCKET"]?.trim();
  const accessKeyId = env["S3_ACCESS_KEY"]?.trim();
  const secretAccessKey = env["S3_SECRET_KEY"]?.trim();
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey)
    return undefined;
  return {
    endpoint,
    bucket,
    accessKeyId,
    secretAccessKey,
    region: env["S3_REGION"]?.trim() || undefined,
  };
}

export function s3Store(target: S3Target): Store {
  const client = new Bun.S3Client({
    endpoint: target.endpoint,
    bucket: target.bucket,
    accessKeyId: target.accessKeyId,
    secretAccessKey: target.secretAccessKey,
    ...(target.region === undefined ? {} : { region: target.region }),
  });
  return {
    where: `${target.endpoint.replace(/^https?:\/\//, "")}/${target.bucket}`,
    async put(key, body) {
      await client.write(key, body);
    },
    async get(key) {
      const file = client.file(key);
      if (!(await file.exists())) return undefined;
      return new Uint8Array(await file.arrayBuffer());
    },
    async list(prefix) {
      const keys: string[] = [];
      let token: string | undefined;
      do {
        const page = await client.list({
          prefix,
          maxKeys: 1000,
          ...(token === undefined ? {} : { continuationToken: token }),
        });
        for (const item of page.contents ?? []) keys.push(item.key);
        token = page.isTruncated ? page.nextContinuationToken : undefined;
      } while (token !== undefined);
      return keys;
    },
    async delete(key) {
      await client.delete(key);
    },
  };
}

/** A directory as a store: `key` is a path under it, nothing else. */
export function dirStore(root: string): Store {
  const at = (key: string): string => {
    if (key.startsWith("/") || key.split("/").includes(".."))
      throw new Error(`refusing key ${key}`);
    return join(root, key);
  };
  const walk = (dir: string, out: string[]): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path, out);
      else out.push(relative(root, path));
    }
  };
  return {
    where: root,
    async put(key, body) {
      const path = at(key);
      mkdirSync(dirname(path), { recursive: true });
      await Bun.write(path, body);
    },
    async get(key) {
      const file = Bun.file(at(key));
      if (!(await file.exists())) return undefined;
      return new Uint8Array(await file.arrayBuffer());
    },
    async list(prefix) {
      const all: string[] = [];
      walk(root, all);
      return all.filter((k) => k.startsWith(prefix));
    },
    async delete(key) {
      rmSync(at(key), { force: true });
    },
  };
}

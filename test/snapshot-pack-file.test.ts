import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packFile, unpack } from "../src/snapshot/parts.ts";

const dir = mkdtempSync(join(tmpdir(), "pack-file-"));

test("a file packed as a stream unpacks to the bytes that went in, in parts of the size asked", async () => {
  const body = new Uint8Array(3_000_000);
  for (let i = 0; i < body.length; i++) body[i] = (i * 31 + (i >> 7)) & 0xff;
  const file = join(dir, "big.bin");
  writeFileSync(file, body);
  const parts: Uint8Array[] = [];
  const packed = await packFile("big.bin", file, async (n, part) => {
    expect(n).toBe(parts.length);
    parts.push(part);
  }, 64 * 1024);
  expect(packed.bytes).toBe(body.length);
  expect(packed.parts).toBe(parts.length);
  expect(parts.slice(0, -1).every((p) => p.byteLength === 64 * 1024)).toBe(true);
  expect(parts.reduce((n, p) => n + p.byteLength, 0)).toBe(packed.packedBytes);
  expect(Buffer.from(await unpack(packed, parts)).equals(Buffer.from(body))).toBe(true);
});

test("an empty file is one empty part", async () => {
  const file = join(dir, "empty.bin");
  writeFileSync(file, new Uint8Array(0));
  const parts: Uint8Array[] = [];
  const packed = await packFile("empty.bin", file, async (_n, part) => void parts.push(part));
  expect(packed.parts).toBe(1);
  expect(packed.bytes).toBe(0);
  expect((await unpack(packed, parts)).byteLength).toBe(0);
});

test("a path that climbs out is refused before the file is read", async () => {
  expect(packFile("../x", join(dir, "nope"), async () => undefined)).rejects.toThrow("refusing to pack");
});

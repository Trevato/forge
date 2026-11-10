import { afterEach, describe, expect, test } from "bun:test";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseManifest } from "../src/apps/manifest.ts";
import { startProcess } from "../src/apps/process.ts";
import { toolchainUse } from "../src/apps/toolchain.ts";

const dirs: string[] = [];
const tmp = async (): Promise<string> => {
  const d = await mkdtemp(join(tmpdir(), "forge-rust-"));
  dirs.push(d);
  return d;
};
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

const start = (dir: string, json: string, lines: string[]) => {
  const m = parseManifest(json, undefined);
  if (!m.ok) throw new Error(JSON.stringify(m.error));
  return startProcess({
    dir,
    dataDir: dir,
    manifest: m.value,
    env: "production",
    url: "http://app.test",
    commitOid: "0".repeat(40),
    forgeUrl: "http://forge.test",
    identityKey: "key",
    log: (l) => void lines.push(l),
    signal: new AbortController().signal,
  });
};

/** A toolchain root whose `cargo` is a script that says where it was told to live. */
async function fakeRoot(): Promise<string> {
  const root = await tmp();
  const bin = join(root, "rust", "1.82", "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(
    join(bin, "cargo"),
    '#!/bin/sh\necho "cargo CARGO_HOME=$CARGO_HOME RUSTUP_HOME=$RUSTUP_HOME"\n',
  );
  await chmod(join(bin, "cargo"), 0o755);
  return root;
}

describe("a pinned rust toolchain", () => {
  test("is put on PATH with CARGO_HOME and RUSTUP_HOME, read-only dir revealed", async () => {
    const root = await fakeRoot();
    const r = toolchainUse({ rust: "1.82" }, "/scratch", root);
    expect(r.ok && r.value?.env["PATH"]).toStartWith(join(root, "rust", "1.82", "bin") + ":");
    expect(r.ok && r.value?.env["CARGO_HOME"]).toBe("/scratch/.cargo");
    expect(r.ok && r.value?.env["RUSTUP_HOME"]).toBe(join(root, "rust", "1.82", "rustup"));
    expect(r.ok && r.value?.reveal).toEqual([join(root, "rust", "1.82")]);
  });

  test("no pin adds nothing; a pin the host lacks is one plain line", async () => {
    expect(toolchainUse(undefined, "/s", "/nowhere")).toEqual({ ok: true, value: undefined });
    const r = toolchainUse({ rust: "1.82" }, "/s", "/nowhere");
    expect(!r.ok && r.error).toBe("rust 1.82 is pinned but not installed on this host");
  });

  test("install and run see cargo only when the app names rust", async () => {
    const root = await fakeRoot();
    const old = process.env["FORGE_TOOLCHAINS"];
    process.env["FORGE_TOOLCHAINS"] = root;
    const realFetch = globalThis.fetch;
    let fetched = 0;
    // Only the loopback readiness probe may use fetch; anything else is a download.
    globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      if (String(input).startsWith("http://127.0.0.1:")) return realFetch(input, init);
      fetched++;
      throw new Error("no network");
    }) as unknown as typeof fetch;
    try {
      const server = "Bun.serve({port:Number(process.env.PORT),hostname:'127.0.0.1',fetch:()=>new Response('ok')})";
      for (let i = 0; i < 2; i++) {
        const dir = await tmp();
        await writeFile(join(dir, "server.ts"), server);
        const lines: string[] = [];
        const s = await start(
          dir,
          JSON.stringify({
            toolchain: { rust: "1.82" },
            app: { install: "cargo > out.txt", run: "bun server.ts", health: "/", ready: 8 },
          }),
          lines,
        );
        expect(s.ok ? "" : s.error.message + lines.join("\n")).toBe("");
        if (!s.ok) return;
        await s.value.handle.stop();
        expect(await readFile(join(dir, "out.txt"), "utf8")).toContain("RUSTUP_HOME=");
      }
      expect(fetched).toBe(0);

      // An app that does not name rust sees no cargo.
      const dir = await tmp();
      await writeFile(join(dir, "server.ts"), server);
      const s = await start(
        dir,
        JSON.stringify({ app: { install: "echo $PATH:$CARGO_HOME > out.txt", run: "bun server.ts", health: "/", ready: 8 } }),
        [],
      );
      expect(s.ok).toBe(true);
      if (!s.ok) return;
      await s.value.handle.stop();
      expect(await readFile(join(dir, "out.txt"), "utf8")).not.toContain(root);
    } finally {
      globalThis.fetch = realFetch;
      if (old === undefined) delete process.env["FORGE_TOOLCHAINS"];
      else process.env["FORGE_TOOLCHAINS"] = old;
    }
  }, 60_000);

  test("an unavailable pin fails the install stage in one line", async () => {
    const old = process.env["FORGE_TOOLCHAINS"];
    delete process.env["FORGE_TOOLCHAINS"];
    try {
      const dir = await tmp();
      const s = await start(dir, JSON.stringify({ toolchain: { rust: "1.82" }, app: { run: "true" } }), []);
      expect(!s.ok && s.error.stage).toBe("install");
      expect(!s.ok && s.error.message).toContain("not installed on this host");
    } finally {
      if (old !== undefined) process.env["FORGE_TOOLCHAINS"] = old;
    }
  });
});

// The hello-world needs a real cargo; where the check host has none, this is
// reported as skipped by name, never passed.
const sysroot = (() => {
  if (Bun.which("cargo") === null || Bun.which("rustc") === null) return undefined;
  const p = Bun.spawnSync(["rustc", "--print", "sysroot"]);
  return p.exitCode === 0 ? p.stdout.toString().trim() : undefined;
})();

describe("rust hello-world fixture", () => {
  (sysroot === undefined ? test.skip : test)(
    "deploys with cargo build in install and answers /",
    async () => {
      const root = await tmp();
      const version = join(root, "rust", "1.82");
      await mkdir(version, { recursive: true });
      await symlink(join(sysroot ?? "", "bin"), join(version, "bin"));
      const old = process.env["FORGE_TOOLCHAINS"];
      process.env["FORGE_TOOLCHAINS"] = root;
      try {
        const dir = await tmp();
        await cp(join(import.meta.dir, "fixtures", "rust-hello"), dir, { recursive: true });
        const lines: string[] = [];
        const json = JSON.parse(await readFile(join(dir, "forge.json"), "utf8"));
        const s = await start(dir, JSON.stringify(json), lines);
        if (!s.ok) throw new Error(`${s.error.message}\n${lines.join("\n")}`);
        const res = await fetch(`http://127.0.0.1:${s.value.handle.port}/`);
        expect(await res.text()).toBe("hello from rust\n");
        await s.value.handle.stop();
      } finally {
        if (old === undefined) delete process.env["FORGE_TOOLCHAINS"];
        else process.env["FORGE_TOOLCHAINS"] = old;
      }
    },
    120_000,
  );
});

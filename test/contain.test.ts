/**
 * Repository code runs in a cell (`apps/contain.ts`): an app, its preview
 * and a check, on a fresh account's repository, each try to read the forge's
 * data, the forge's environment and another tenant's app, and to reach a
 * host nobody declared — and each is refused, while the forge itself still
 * answers. Over a memory, CPU or disk limit a step is stopped, and the
 * reason is the step's error.
 *
 * The cell needs bubblewrap and user namespaces; where the host has none
 * (macOS), the end-to-end half skips and says so.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { enableApp } from "../src/actions/apps.ts";
import { openPull, submitReview } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo, forkRepo } from "../src/actions/repos.ts";
import {
  cellCounters,
  cellMounts,
  cellsAvailable,
  hiddenMounts,
  mountMode,
  secretMounts,
  WATCH,
  type CellSpec,
} from "../src/apps/contain.ts";
import { envDir } from "../src/apps/data.ts";
import {
  hostAllowed,
  isPublicAddress,
  startEgress,
} from "../src/apps/egress.ts";
import { noteReached, reachedHosts } from "../src/apps/egress_report.ts";
import { egressNote } from "../src/web/studio/egress.ts";
import { parseCheck, parseManifest } from "../src/apps/manifest.ts";
import { childEnv, runStep, stepCell } from "../src/apps/process.ts";
import { AppsRuntime } from "../src/apps/runtime.ts";
import { runAppTty } from "../src/apps/tty.ts";
import { startChecks, type ChecksHandle } from "../src/checks/service.ts";
import { listRuns, type Run } from "../src/core/runs.ts";
import { setMember } from "../src/core/roles.ts";
import { createUser, type User } from "../src/core/users.ts";
import type { AppRecord } from "../src/core/apps.ts";
import type { Repo } from "../src/core/repos.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { readRunLog } from "../src/runs/log.ts";
import { expectContained, probeSource } from "./helpers/cell-probe.ts";
import { missing } from "./helpers/tools.ts";
import { portInsteadOfSocket } from "../src/git/hook-address.ts";

// Cells and their egress proxy bind unix sockets, which a sandbox refuses
// (FORGE_TEST_SOCKET=port); these run in the forge's check instead.
const bySocket = portInsteadOfSocket() ? describe.skip : describe;

describe("egress: what a cell may reach", () => {
  test("a declared name matches exactly, or below a *. wildcard, on 80 and 443", () => {
    expect(hostAllowed(["api.example.com"], "api.example.com", 443)).toBe(true);
    expect(hostAllowed(["api.example.com"], "API.example.com.", 80)).toBe(true);
    expect(hostAllowed(["api.example.com"], "example.com", 443)).toBe(false);
    expect(hostAllowed(["api.example.com"], "evilapi.example.com", 443)).toBe(
      false,
    );
    expect(hostAllowed(["*.example.com"], "a.b.example.com", 443)).toBe(true);
    expect(hostAllowed(["*.example.com"], "example.com", 443)).toBe(false);
    expect(hostAllowed(["*.example.com"], "badexample.com", 443)).toBe(false);
    expect(hostAllowed([], "registry.npmjs.org", 443)).toBe(false);
  });

  test("a declared name is not a declared port: ssh and mail are refused unless named", () => {
    expect(hostAllowed(["api.example.com"], "api.example.com", 22)).toBe(false);
    expect(hostAllowed(["api.example.com"], "api.example.com", 25)).toBe(false);
    expect(hostAllowed(["*.example.com"], "a.example.com", 22)).toBe(false);
    expect(hostAllowed(["db.example.com:5432"], "db.example.com", 5432)).toBe(
      true,
    );
    expect(hostAllowed(["db.example.com:5432"], "db.example.com", 443)).toBe(
      false,
    );
  });

  test("private, loopback, link-local and cluster addresses are never public", () => {
    for (const ip of [
      "127.0.0.1",
      "10.42.0.13",
      "10.43.0.1",
      "169.254.169.254",
      "172.16.0.1",
      "192.168.1.1",
      "100.100.161.11",
      "0.0.0.0",
      "::1",
      "fd00::1",
      "fe80::1",
      "::ffff:127.0.0.1",
      "::ffff:169.254.169.254",
    ])
      expect(isPublicAddress(ip)).toBe(false);
    for (const ip of ["104.16.1.1", "8.8.8.8", "2606:4700::1111"])
      expect(isPublicAddress(ip)).toBe(true);
  });

  test("forge.json declares egress once, for the app and the check, and limits per section", () => {
    const json = JSON.stringify({
      egress: ["api.example.com", "*.cdn.example.com"],
      app: { run: "bun server.ts", limits: { memory: 768, cpus: 1.5 } },
      check: { run: "bun test", limits: { disk: 2048 } },
    });
    const app = parseManifest(json, undefined);
    const check = parseCheck(json, undefined);
    expect(app.ok && app.value.egress).toEqual([
      "api.example.com",
      "*.cdn.example.com",
    ]);
    expect(app.ok && app.value.limits).toEqual({ memoryMiB: 768, cpus: 1.5 });
    expect(check.ok && check.value?.egress).toEqual([
      "api.example.com",
      "*.cdn.example.com",
    ]);
    expect(check.ok && check.value?.limits).toEqual({ diskMiB: 2048 });
  });

  test("a wrong egress or limit is a manifest error, never a guess", () => {
    for (const bad of [
      { egress: "api.example.com" },
      { egress: ["http://api.example.com"] },
      { egress: ["api.example.com/path"] },
      { egress: ["api example.com"] },
      { egress: Array.from({ length: 33 }, (_, i) => `h${i}.example.com`) },
    ]) {
      const result = parseManifest(
        JSON.stringify({ ...bad, app: { run: "x" } }),
        undefined,
      );
      expect(result.ok).toBe(false);
    }
    for (const limits of [
      { memory: 1 },
      { cpus: 0 },
      { disk: "1G" },
      { swap: 1 },
      [],
    ]) {
      const result = parseCheck(
        JSON.stringify({ check: { run: "x", limits } }),
        undefined,
      );
      expect(result.ok).toBe(false);
    }
  });
});

bySocket("egress: the proxy forwards what is allowed, byte for byte, and refuses the rest", () => {
  let dir: string;
  let upstream: ReturnType<typeof Bun.serve>;
  let socket: string;
  let egress: { close(): void };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-egress-"));
    upstream = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (req) =>
        new Response(
          `${req.method} ${new URL(req.url).pathname} ${await req.text()}`,
        ),
    });
    socket = join(dir, "out.sock");
    egress = startEgress(socket, {
      // Declared on its web ports and on the upstream's: still refused, private.
      hosts: ["localhost", `localhost:${upstream.port ?? 0}`],
      origins: [{ host: "127.0.0.1", port: upstream.port ?? 0 }],
    });
  });

  afterAll(async () => {
    egress.close();
    upstream.stop(true);
    await rm(dir, { recursive: true, force: true });
  });

  /** Send `bytes` to the proxy, then `after` once it answers; everything that comes back. */
  async function exchange(bytes: string, after = ""): Promise<string> {
    let got = "";
    let answered = false;
    const decoder = new TextDecoder();
    const done = Promise.withResolvers<void>();
    const conn = await Bun.connect({
      unix: socket,
      socket: {
        data(sock, chunk) {
          got += decoder.decode(chunk);
          if (!answered && after !== "") {
            answered = true;
            sock.write(after);
          }
        },
        close: () => done.resolve(),
        error: () => done.resolve(),
      },
    });
    conn.write(bytes);
    await Promise.race([done.promise, Bun.sleep(3_000)]);
    conn.end();
    return got;
  }

  test("an allowed origin, as an absolute-form request: forwarded with its body", async () => {
    const port = upstream.port ?? 0;
    const reply = await exchange(
      `POST http://127.0.0.1:${port}/echo HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Length: 5\r\nProxy-Authorization: x\r\n\r\nhello`,
    );
    expect(reply).toStartWith("HTTP/1.1 200");
    expect(reply).toContain("POST /echo hello");
  });

  test("an allowed origin, through CONNECT: a tunnel that carries the request after it opens", async () => {
    const port = upstream.port ?? 0;
    const reply = await exchange(
      `CONNECT 127.0.0.1:${port} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`,
      `GET /tunnel HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`,
    );
    expect(reply).toStartWith("HTTP/1.1 200 Connection Established");
    expect(reply).toContain("GET /tunnel ");
  });

  test("a host nobody declared, a declared name on a private address, and the origin at another port: refused, named", async () => {
    const port = upstream.port ?? 0;
    const undeclared = await exchange(
      `CONNECT example.com:443 HTTP/1.1\r\n\r\n`,
    );
    expect(undeclared).toStartWith("HTTP/1.1 403");
    expect(undeclared).toContain(
      'example.com:443 is not in this repository\'s egress (forge.json "egress")',
    );
    const privateName = await exchange(
      `GET http://localhost:${port}/ HTTP/1.1\r\nHost: localhost\r\n\r\n`,
    );
    expect(privateName).toStartWith("HTTP/1.1 403");
    expect(privateName).toContain("localhost resolves to a private address");
    const otherPort = await exchange(
      `CONNECT 127.0.0.1:${port + 1} HTTP/1.1\r\n\r\n`,
    );
    expect(otherPort).toStartWith("HTTP/1.1 403");
  });

  test("a declared host on a port it did not declare (ssh, mail): refused", async () => {
    for (const port of [22, 25]) {
      const reply = await exchange(
        `CONNECT localhost:${port} HTTP/1.1\r\n\r\n`,
      );
      expect(reply).toStartWith("HTTP/1.1 403");
      expect(reply).toContain(
        `localhost:${port} is not in this repository's egress`,
      );
    }
  });
});

bySocket("egress, reported: an undeclared public host goes through and is counted; a private one never does", () => {
  let dir: string;
  let socket: string;
  let egress: { close(): void };
  const seen: string[] = [];

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-egress-report-"));
    socket = join(dir, "out.sock");
    egress = startEgress(socket, {
      hosts: [],
      origins: [],
      report: (host, port) => seen.push(`${host}:${port}`),
    });
  });

  afterAll(async () => {
    egress.close();
    await rm(dir, { recursive: true, force: true });
  });

  async function head(bytes: string): Promise<string> {
    let got = "";
    const done = Promise.withResolvers<void>();
    const conn = await Bun.connect({
      unix: socket,
      socket: {
        data(_s, chunk) {
          got += new TextDecoder().decode(chunk);
          done.resolve();
        },
        close: () => done.resolve(),
        error: () => done.resolve(),
      },
    });
    conn.write(bytes);
    await Promise.race([done.promise, Bun.sleep(10_000)]);
    conn.end();
    return got;
  }

  test("a private address is refused in report mode too, and not counted", async () => {
    const reply = await head(`CONNECT localhost:443 HTTP/1.1\r\n\r\n`);
    expect(reply).toStartWith("HTTP/1.1 403");
    expect(reply).toContain("private address");
    expect(seen).toEqual([]);
  });

  test("an undeclared host on any port but 80 and 443 is refused in report mode too, and not counted", async () => {
    for (const port of [25, 22, 6443]) {
      const reply = await head(`CONNECT example.com:${port} HTTP/1.1\r\n\r\n`);
      expect(reply).toStartWith("HTTP/1.1 403");
      expect(reply).toContain(
        `example.com:${port} is not in this repository's egress`,
      );
    }
    expect(seen).toEqual([]);
  });

  test("an undeclared public host is let through and counted", async () => {
    const reply = await head(`CONNECT example.com:443 HTTP/1.1\r\n\r\n`);
    // Through: a tunnel, or the host not answering — never the refusal.
    if (reply.includes("does not resolve")) {
      console.log(
        "SKIPPING: no DNS on this machine, so a public host cannot be resolved",
      );
      return;
    }
    expect(reply).not.toStartWith("HTTP/1.1 403");
    expect(seen).toEqual(["example.com:443"]);
  }, 20_000);
});

describe("egress, reported: what an app reached is kept per repository and shown to its writers", () => {
  let dataDir: string;
  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-egress-kept-"));
  });
  afterAll(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  test("counted per host and port, most recent first; a host declared since is not repeated", () => {
    noteReached(dataDir, "01repo", "api.stripe.com", 443);
    noteReached(dataDir, "01repo", "api.stripe.com", 443);
    noteReached(dataDir, "01repo", "db.example.com", 5432);
    const reached = reachedHosts(dataDir, "01repo");
    expect(reached.map((r) => [r.host, r.port, r.count])).toEqual([
      ["db.example.com", 5432, 1],
      ["api.stripe.com", 443, 2],
    ]);
    expect(reachedHosts(dataDir, "01other")).toEqual([]);
    const note = String(egressNote(dataDir, "01repo", [], "report"));
    expect(note).toContain("api.stripe.com:443");
    expect(note).toContain("&quot;api.stripe.com&quot;");
    expect(note).toContain("db.example.com:5432");
    const after = String(egressNote(dataDir, "01repo", ["api.stripe.com"], "report"));
    expect(after).not.toContain("api.stripe.com");
    expect(
      egressNote(dataDir, "01repo", ["api.stripe.com", "db.example.com:5432"], "report"),
    ).toBeNull();
  });
});

describe("cells in a pod see an allow-list of mounts, not the pod's mounts minus a deny-list (#801)", () => {
  const mountinfo = [
    "22 1 0:21 / / rw - overlay overlay rw",
    "23 22 0:22 / /proc rw - proc proc rw",
    "24 22 0:23 / /dev rw - tmpfs tmpfs rw",
    "25 22 0:24 / /sys ro - sysfs sysfs ro",
    "26 22 8:1 /pods/x/etc-hosts /etc/hosts rw - ext4 /dev/vda1 rw",
    "27 22 8:1 /pods/x/resolv /etc/resolv.conf rw - ext4 /dev/vda1 rw",
    "28 22 8:1 /pods/x/hostname /etc/hostname rw - ext4 /dev/vda1 rw",
    "29 22 8:1 /storage/pvc-1 /data rw - ext4 /dev/vda1 rw",
    "30 22 8:1 /pods/x/volumes/configmap /etc/app-config ro - ext4 /dev/vda1 ro",
    "31 22 8:1 /srv/shared /mnt/host rw - ext4 /dev/vda1 rw",
    "32 22 0:30 / /mnt/csi rw - nfs4 server:/export rw",
    "33 22 0:31 / /nix/store ro - ext4 /dev/vda2 ro",
    "34 22 0:32 / /etc/plat-ca ro - tmpfs tmpfs ro",
  ].join("\n");

  test("every mount but the root, /dev, /proc, /sys and the resolver's files is hidden", () => {
    const hidden = hiddenMounts(mountinfo, "allow-list", ["/usr/local/bin"]);
    for (const path of [
      "/data",
      "/etc/app-config",
      "/mnt/host",
      "/mnt/csi",
      "/nix/store",
      "/etc/plat-ca",
    ])
      expect(hidden).toContain(path);
    for (const path of [
      "/",
      "/proc",
      "/dev",
      "/sys",
      "/etc/hosts",
      "/etc/resolv.conf",
      "/etc/hostname",
    ])
      expect(hidden).not.toContain(path);
  });

  test("a mount the runtime or a tool lives on stays, or no cell could start", () => {
    const hidden = hiddenMounts(mountinfo, "allow-list", [
      "/nix/store/abc-bun/bin",
    ]);
    expect(hidden).not.toContain("/nix/store");
    expect(hidden).toContain("/mnt/host");
  });

  test("outside a pod the deny-list holds: a developer's system mounts stay, secrets go", () => {
    const hidden = hiddenMounts(mountinfo, "deny-list", []);
    expect(hidden).toContain("/etc/plat-ca");
    expect(hidden).not.toContain("/nix/store");
    expect(hidden).not.toContain("/mnt/host");
  });

  test("inside Kubernetes the allow-list is the default; FORGE_CELL_MOUNTS chooses either", () => {
    const saved = {
      k: process.env["KUBERNETES_SERVICE_HOST"],
      m: process.env["FORGE_CELL_MOUNTS"],
    };
    try {
      delete process.env["FORGE_CELL_MOUNTS"];
      process.env["KUBERNETES_SERVICE_HOST"] = "10.43.0.1";
      expect(mountMode()).toBe("allow-list");
      delete process.env["KUBERNETES_SERVICE_HOST"];
      expect(mountMode()).toBe("deny-list");
      process.env["FORGE_CELL_MOUNTS"] = "allow-list";
      expect(mountMode()).toBe("allow-list");
      process.env["KUBERNETES_SERVICE_HOST"] = "10.43.0.1";
      process.env["FORGE_CELL_MOUNTS"] = "deny-list";
      expect(mountMode()).toBe("deny-list");
    } finally {
      if (saved.k === undefined) delete process.env["KUBERNETES_SERVICE_HOST"];
      else process.env["KUBERNETES_SERVICE_HOST"] = saved.k;
      if (saved.m === undefined) delete process.env["FORGE_CELL_MOUNTS"];
      else process.env["FORGE_CELL_MOUNTS"] = saved.m;
    }
  });
});

describe("cells hide every mount that may carry a secret", () => {
  test("tmpfs mounts and anything under /run or /var/run, but not the cell's own /dev, /proc, /sys", () => {
    const mountinfo = [
      "22 1 0:21 / / rw - overlay overlay rw",
      "23 22 0:22 / /proc rw - proc proc rw",
      "24 22 0:23 / /dev rw - tmpfs tmpfs rw",
      "25 24 0:24 / /dev/shm rw - tmpfs shm rw",
      "26 22 0:25 / /var/run/secrets/kubernetes.io/serviceaccount ro - tmpfs tmpfs ro",
      "27 22 0:26 / /etc/plat-ca ro - tmpfs tmpfs ro",
      "28 22 8:1 /data /data rw - ext4 /dev/vda1 rw",
      "29 22 0:27 / /run/creds\\040x ro - ramfs ramfs ro",
      "30 22 8:1 /etc/hosts /etc/hosts rw - ext4 /dev/vda1 rw",
    ].join("\n");
    const hidden = secretMounts(mountinfo);
    expect(hidden).toContain("/var/run/secrets/kubernetes.io/serviceaccount");
    expect(hidden).toContain("/etc/plat-ca");
    expect(hidden).toContain("/run/creds x");
    expect(hidden).toContain("/run/secrets");
    expect(hidden).toContain("/var/run/secrets");
    for (const kept of [
      "/",
      "/proc",
      "/dev",
      "/dev/shm",
      "/data",
      "/etc/hosts",
    ])
      expect(hidden).not.toContain(kept);
  });

  // A forge that runs in a cell (a preview) has its own sockets at
  // /run/forge; a child forge's cell inside it remounted them read-only and
  // never had a socket to listen on (#6023).
  test("nothing under the cell's own /tmp and /run is hidden again, so a cell inside a cell keeps its sockets", () => {
    const dirs = new Set(["/data", "/run/forge", "/run/secrets", "/tmp/fc-1", "/etc/plat-ca", "/data/code"]);
    const kind = (path: string) => (dirs.has(path) ? "dir" : path === "/etc/token" ? "file" : undefined);
    const mounts = cellMounts(
      { hide: ["/data"], reveal: ["/data/code"] },
      ["/run/forge", "/run/secrets", "/tmp", "/tmp/fc-1", "/run", "/etc/plat-ca", "/etc/token", "/var/run/gone"],
      kind,
    );
    expect(mounts.hide).toEqual(["/data", "/etc/plat-ca"]);
    expect(mounts.blank).toEqual(["/etc/token"]);
    expect(mounts.reveal).toContain("/data/code");
  });
});

describe("cells are labelled for the machine sampler (boards/sampler.ts)", () => {
  test("a deploy's install and test steps carry the environment's label", () => {
    const manifest = parseManifest(JSON.stringify({ app: { run: "bun server.ts" } }), undefined);
    if (!manifest.ok) throw new Error(JSON.stringify(manifest.error));
    const input = {
      dir: "/x", dataDir: "/d", manifest: manifest.value, env: "production" as const,
      url: "http://x", commitOid: "0".repeat(40), forgeUrl: "http://forge",
      identityKey: "k", log: () => {}, signal: new AbortController().signal,
    };
    expect(stepCell(input)).toBeUndefined();
    const spec = stepCell({ ...input, cell: { hide: [], home: "/h", label: "app:notes/production" } });
    expect(spec?.label).toBe("app:notes/production");
  });
});

// A host told not to hold cells (`FORGE_CELLS=off`: a check cell, where a
// cell inside a cell is not a cell) is a host without cells for these.
const noCells =
  process.env["FORGE_CELLS"] === "off" ||
  missing("bwrap", "socat") ||
  process.platform !== "linux" ||
  portInsteadOfSocket();

describe.skipIf(noCells)(
  "cells: repository code cannot take over the forge",
  () => {
    const DOMAIN = "cells.test";
    const CANARY = `forge-canary-${crypto.randomUUID()}`;
    let dataDir: string;
    let app: App;
    let servers: Servers;
    let runtime: AppsRuntime;
    let checks: ChecksHandle;
    let alice: User;
    let mallory: User;
    let listener: ReturnType<typeof Bun.serve>;
    let other: AppRecord;
    let repo: Repo;
    let record: AppRecord;

    async function settled(
      kind: "deploy" | "check",
      where: (run: Run) => boolean,
      timeoutMs = 90_000,
    ): Promise<Run> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const run = listRuns(app.db, repo.id, { kind, limit: 50 }).find(where);
        if (
          run &&
          (run.state === "ok" ||
            run.state === "failed" ||
            run.state === "cancelled")
        )
          return run;
        await Bun.sleep(100);
      }
      throw new Error(`${kind} did not settle in time`);
    }

    // Every label the machine sampler could have read while these cells ran.
    const labels = new Set<string>();
    let recorder: ReturnType<typeof setInterval> | undefined;
    const savedTick = WATCH.tickMs;

    const viaHost = async (url: string, path: string): Promise<Response> =>
      fetch(`${servers.url}${path}`, { headers: { host: new URL(url).host } });

    beforeAll(async () => {
      // The forge's own environment carries this; no cell may ever see it.
      process.env["FORGE_TEST_CANARY"] = CANARY;
      dataDir = await mkdtemp(join(tmpdir(), "forge-cells-"));
      WATCH.tickMs = 200;
      recorder = setInterval(() => {
        for (const c of cellCounters()) labels.add(c.label);
      }, 50);
      app = createApp({ dataDir, port: 0 });
      servers = await serve(app);
      runtime = new AppsRuntime(app, {
        domain: DOMAIN,
        scheme: "http",
        publicPort: servers.port,
        forgeUrl: servers.url,
        concurrency: 2,
      });
      await runtime.start();
      checks = startChecks(app, { forgeUrl: servers.url, concurrency: 1 });
      // A stand-in for the cluster API or another pod: reachable from the forge.
      listener = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch: () => new Response("inside"),
      });

      const a = await createUser(app.db, {
        origin: "seed",
        trusted: true,
        username: "alice",
        email: "alice@forge.local",
        password: "a-good-passphrase",
        adminIfFirst: true,
      });
      if (!a.ok) throw new Error(a.error);
      alice = a.value;
      const m = await createUser(app.db, {
        origin: "seed",
        trusted: true,
        username: "mallory",
        email: "mallory@forge.local",
        password: "a-good-passphrase",
      });
      if (!m.ok) throw new Error(m.error);
      mallory = m.value;
      // A guest cannot own a repository (docs/ROLES.md): the probe needs one.
      setMember(app.db, mallory.id, true, alice.id, new Date());

      // Another tenant's app, running, with data of its own.
      const theirs = await createRepo(app, alice, {
        name: "ledger",
        visibility: "private",
      });
      if (!theirs.ok) throw new Error(String(theirs.error));
      const seeded = await commitToBranch(app, alice, theirs.value, {
        message: "Start",
        files: [
          {
            path: "package.json",
            content:
              '{"name":"ledger","scripts":{"start":"bun run server.ts"}}\n',
          },
          {
            path: "server.ts",
            content:
              "await Bun.write(process.env.FORGE_APP_DATA + '/books.txt', 'private');\nBun.serve({ port: Number(process.env.PORT), hostname: '127.0.0.1', fetch: () => new Response('ok') });\n",
          },
        ],
      });
      if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
      const enabled = enableApp(app, alice, theirs.value, { slug: "ledger" });
      if (!enabled.ok) throw new Error(String(enabled.error));
      other = enabled.value;
    }, 60_000);

    afterAll(async () => {
      delete process.env["FORGE_TEST_CANARY"];
      clearInterval(recorder);
      WATCH.tickMs = savedTick;
      await checks?.stop();
      await runtime?.stop();
      listener?.stop(true);
      servers?.stop();
      app?.close();
      await rm(dataDir, { recursive: true, force: true });
    });

    test("this host can hold a cell", async () => {
      expect(await cellsAvailable()).toEqual({ ok: true });
    });

    test("an app, its terminal, its preview and its check, on a fresh account, are each refused everything but the forge", async () => {
      const made = await createRepo(app, mallory, {
        name: "probe",
        visibility: "public",
      });
      if (!made.ok) throw new Error(String(made.error));
      repo = made.value;
      const source = probeSource({
        dataDir,
        otherAppDir: envDir(dataDir, other.id, "production"),
        canary: CANARY,
        listenerPort: listener.port ?? 0,
        forgePid: process.pid,
      });
      const forgeJson = JSON.stringify({
        // Declared, but it is this machine: still refused.
        egress: ["localhost"],
        app: {
          run: "bun probe.ts serve",
          health: "/",
          tty: "bun probe.ts check",
        },
        check: { run: "bun probe.ts check", timeout: 120 },
      });
      const committed = await commitToBranch(app, mallory, repo, {
        message: "A probe",
        files: [
          { path: "forge.json", content: forgeJson },
          { path: "probe.ts", content: source },
        ],
      });
      if (!committed.ok) throw new Error(JSON.stringify(committed.error));
      const enabled = enableApp(app, mallory, repo, { slug: "probe" });
      if (!enabled.ok) throw new Error(String(enabled.error));
      record = enabled.value;

      // The other tenant is up and has written its data: there is something to steal.
      await Bun.sleep(100);
      const deadline = Date.now() + 60_000;
      while (
        !existsSync(
          join(envDir(dataDir, other.id, "production"), "data", "books.txt"),
        ) &&
        Date.now() < deadline
      )
        await Bun.sleep(100);
      expect(existsSync(join(dataDir, "forge.db"))).toBe(true);
      expect(existsSync(join(dataDir, "secret.key"))).toBe(true);

      const production = await settled(
        "deploy",
        (r) =>
          r.env === "production" && r.commitOid === committed.value.commitOid,
      );
      expect(production.state).toBe("ok");
      expect(production.sandboxEnforced).toBe(true);
      const fromApp = await viaHost(
        runtime.urlFor(record, "production"),
        "/probe",
      );
      expectContained((await fromApp.json()) as Record<string, string>);

      // The app's terminal (`ssh probe@forge`) is the app: the same cell.
      let screen = "";
      const decoder = new TextDecoder();
      const terminal = await runAppTty(
        app,
        {
          cols: 200,
          rows: 50,
          term: "xterm",
          write: (bytes) => {
            screen += decoder.decode(bytes);
          },
          onData: () => {},
          onResize: () => {},
        },
        mallory,
        { app: record, env: "production" },
      );
      expect(terminal.ok).toBe(true);
      const shown = screen.split(/\r?\n/).find((l) => l.startsWith("PROBE "));
      expect(shown).toBeDefined();
      expectContained(JSON.parse(shown!.slice(6)) as Record<string, string>);
      expect(
        screen.split(/\r?\n/).find((l) => l.startsWith("OWNAPP ")),
      ).toStartWith("OWNAPP reached");

      const check = await settled(
        "check",
        (r) => r.commitOid === committed.value.commitOid,
      );
      expect(check.state).toBe("ok");
      expect(check.sandboxEnforced).toBe(true);
      const line = readRunLog(dataDir, check.id).lines.find((l) =>
        l.startsWith("PROBE "),
      );
      expect(line).toBeDefined();
      expectContained(JSON.parse(line!.slice(6)) as Record<string, string>);

      const branched = await commitToBranch(app, mallory, repo, {
        branch: "change",
        message: "A change",
        files: [{ path: "NOTES.md", content: "a change\n" }],
      });
      if (!branched.ok) throw new Error(JSON.stringify(branched.error));
      const opened = await openPull(app, mallory, repo, {
        title: "Change",
        baseBranch: "main",
        headBranch: "change",
      });
      if (!opened.ok) throw new Error(String(opened.error));
      const env = `pull-${opened.value.number}` as const;
      const preview = await settled("deploy", (r) => r.env === env);
      expect(preview.state).toBe("ok");
      const fromPreview = await viaHost(runtime.urlFor(record, env), "/probe");
      expectContained((await fromPreview.json()) as Record<string, string>);
    }, 240_000);

    test("each cell is sampled by whose it is: app:<slug>/<env> and check:<run id>", () => {
      expect(labels).toContain("app:ledger/production");
      expect(labels).toContain("app:probe/production");
      const checksRun = listRuns(app.db, repo.id, { kind: "check", limit: 50 });
      expect(checksRun.length).toBeGreaterThan(0);
      expect(checksRun.some((r) => labels.has(`check:${r.id}`))).toBe(true);
      for (const l of labels) expect(l).toMatch(/^(app:[a-z0-9-]+\/[a-z0-9-]+|check:\S+)$/);
    });
  },
);

describe.skipIf(noCells)("cells: limits stop a step, and say which", () => {
  let dir: string;
  let hidden: string;
  const saved = { ...WATCH };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-cell-limits-"));
    hidden = await mkdtemp(join(tmpdir(), "forge-cell-hidden-"));
    WATCH.tickMs = 200;
    WATCH.cpuWindowMs = 3_000;
    WATCH.diskEveryTicks = 1;
  });

  afterAll(async () => {
    Object.assign(WATCH, saved);
    await rm(dir, { recursive: true, force: true });
    await rm(hidden, { recursive: true, force: true });
  });

  const cell = (limits: Partial<CellSpec["limits"]>): CellSpec => ({
    dir,
    writable: [],
    home: join(dir, ".home"),
    hide: [hidden],
    egress: [],
    reach: [],
    limits: { memoryMiB: 2048, cpus: 4, diskMiB: 4096, ...limits },
  });

  const step = (command: string, spec: CellSpec) =>
    runStep("check", command, {
      cwd: dir,
      env: childEnv({}),
      log: () => {},
      signal: new AbortController().signal,
      timeoutMs: 60_000,
      cell: spec,
    });

  test("over its memory limit", async () => {
    const result = await step(
      `bun -e "const a = []; for (;;) { a.push(new Uint8Array(16 << 20).fill(1)); await Bun.sleep(10); }"`,
      cell({ memoryMiB: 128 }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error).toMatch(
        // The watch's tick, or — where the forge holds a delegated cgroup — the kernel's cap first.
        /^check stopped: it (used \d+ MiB of memory, over its 128 MiB limit \(the default\)|reached its 128 MiB memory cap, and the kernel killed it)$/,
      );
  }, 30_000);

  test("over its CPU limit", async () => {
    // A small share, so a busy machine still gives the loop more than it.
    const result = await step(`bun -e "for (;;) {}"`, cell({ cpus: 0.02 }));
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error).toMatch(
        /^check stopped: it used [\d.]+ cores for \d+s, over its limit of 0\.02$/,
      );
  }, 30_000);

  test("over its disk limit", async () => {
    const result = await step(
      "head -c 200000000 /dev/zero > big; sleep 30",
      cell({ diskMiB: 64 }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error).toMatch(
        /^check stopped: it wrote \d+ MiB to disk, over its 64 MiB limit$/,
      );
  }, 30_000);

  test("a labelled cell is counted while it runs and gone once it ends; an unlabelled one never is", async () => {
    const seen: { label: string; cpuUsec: number; memoryBytes: number }[] = [];
    const poll = setInterval(() => seen.push(...cellCounters()), 50);
    try {
      // Holds 64 MiB for a few watch ticks (200 ms each here), then ends.
      const hold = `bun -e "const a = new Uint8Array(64 << 20).fill(1); await Bun.sleep(1500); console.log(a[0])"`;
      const [labelled, plain] = await Promise.all([
        step(hold, { ...cell({}), label: "check:t1" }),
        step(hold, cell({})),
      ]);
      expect(labelled.ok).toBe(true);
      expect(plain.ok).toBe(true);
    } finally {
      clearInterval(poll);
    }
    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen.map((c) => c.label))).toEqual(new Set(["check:t1"]));
    const last = seen.at(-1)!;
    expect(last.memoryBytes).toBeGreaterThan(64 * 2 ** 20);
    expect(last.cpuUsec).toBeGreaterThanOrEqual(0);
    expect(cellCounters()).toEqual([]);
  }, 30_000);

  test("within its limits, a step runs, writes only where it may, and sees no mounted secret", async () => {
    await Bun.write(join(hidden, "secret"), "forge data");
    const result = await step(
      `echo ok > here.txt && test ! -e ${hidden}/secret && ! touch ${hidden}/x 2>/dev/null && ! touch /etc/forge-x 2>/dev/null` +
        // The places a pod's secrets are mounted hold no file inside (the
        // directories a nested mount needs may stand, empty).
        ` && test -z "$(find /var/run/secrets /run/secrets -type f 2>/dev/null)"`,
      cell({}),
    );
    expect(result).toEqual({ ok: true, value: undefined });
    expect(existsSync(join(dir, "here.txt"))).toBe(true);
    expect(existsSync(join(hidden, "x"))).toBe(false);
  }, 30_000);
});

describe.skipIf(noCells)(
  "cells, egress reported: a step reaches an undeclared public host and it is counted",
  () => {
    let dir: string;
    let listener: ReturnType<typeof Bun.serve>;
    beforeAll(async () => {
      dir = await mkdtemp(join(tmpdir(), "forge-cell-report-"));
      listener = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch: () => new Response("inside"),
      });
    });
    afterAll(async () => {
      listener.stop(true);
      await rm(dir, { recursive: true, force: true });
    });

    test("the public host is let through and named; the private one is still refused", async () => {
      const seen: string[] = [];
      const lines: string[] = [];
      const result = await runStep(
        "check",
        `bun -e "
        const a = await fetch('https://example.com/', { signal: AbortSignal.timeout(10000) }).then((r) => r.status, () => 'refused');
        const b = await fetch('http://localhost:${listener.port}/', { proxy: process.env.HTTP_PROXY, signal: AbortSignal.timeout(5000) }).then((r) => r.status, () => 'refused');
        console.log('PUBLIC', a, 'PRIVATE', b);
      "`,
        {
          cwd: dir,
          env: childEnv({}),
          log: (line) => lines.push(line),
          signal: new AbortController().signal,
          timeoutMs: 60_000,
          cell: {
            dir,
            writable: [],
            home: join(dir, ".home"),
            hide: [],
            egress: [],
            reach: [],
            limits: { memoryMiB: 1024, cpus: 2, diskMiB: 1024 },
            egressMode: "report",
            onUndeclared: (host, port) => seen.push(`${host}:${port}`),
          },
        },
      );
      expect(result.ok).toBe(true);
      const said = lines.find((l) => l.startsWith("PUBLIC "));
      expect(said).toMatch(/^PUBLIC 200 PRIVATE (403|refused)$/);
      expect(seen).toEqual(["example.com:443"]);
    }, 60_000);
  },
);

describe.skipIf(noCells)(
  "cells: an outside pull's check cannot reach the forge's data (#2080)",
  () => {
    const CANARY = `forge-canary-${crypto.randomUUID()}`;
    let dataDir: string;
    let app: App;
    let servers: Servers;
    let checks: ChecksHandle;
    let listener: ReturnType<typeof Bun.serve>;

    beforeAll(async () => {
      process.env["FORGE_TEST_CANARY"] = CANARY;
      dataDir = await mkdtemp(join(tmpdir(), "forge-cells-outside-"));
      app = createApp({ dataDir, port: 0 });
      servers = await serve(app);
      checks = startChecks(app, { forgeUrl: servers.url, concurrency: 1 });
      listener = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch: () => new Response("inside"),
      });
    }, 60_000);

    afterAll(async () => {
      delete process.env["FORGE_TEST_CANARY"];
      await checks?.stop();
      listener?.stop(true);
      servers?.stop();
      app?.close();
      await rm(dataDir, { recursive: true, force: true });
    });

    test("a fork's code, run by the base's check once approved, is refused everything but the forge", async () => {
      const user = async (username: string, first = false): Promise<User> => {
        const made = await createUser(app.db, {
          origin: "seed",
          trusted: true,
          username,
          email: `${username}@forge.local`,
          password: "a-good-passphrase",
          adminIfFirst: first,
        });
        if (!made.ok) throw new Error(made.error);
        return made.value;
      };
      const alice = await user("alice", true);
      const mallory = await user("mallory");
      // A guest cannot fork (docs/ROLES.md): the outsider is a member elsewhere.
      setMember(app.db, mallory.id, true, alice.id, new Date());
      const made = await createRepo(app, alice, {
        name: "lib",
        visibility: "public",
      });
      if (!made.ok) throw new Error(String(made.error));
      const repo = made.value;

      // Something of another tenant's to steal, where an app's data lives.
      const stolen = envDir(dataDir, "someoneelsesapp", "production");
      mkdirSync(join(stolen, "data"), { recursive: true });
      writeFileSync(join(stolen, "data", "books.txt"), "private");

      const source = probeSource({
        dataDir,
        otherAppDir: stolen,
        canary: CANARY,
        listenerPort: listener.port ?? 0,
        forgePid: process.pid,
      });
      // The base declares a harmless check; the fork's tree supplies the code.
      const gate = await commitToBranch(app, alice, repo, {
        message: "The base's check",
        files: [
          {
            path: "forge.json",
            content: JSON.stringify({
              egress: ["localhost"],
              check: { run: "bun probe.ts check", timeout: 120 },
            }),
          },
          { path: "probe.ts", content: "console.log('base');\n" },
        ],
      });
      if (!gate.ok) throw new Error(JSON.stringify(gate.error));

      const forked = await forkRepo(app, mallory, repo);
      if (!forked.ok) throw new Error(String(forked.error));
      const committed = await commitToBranch(app, mallory, forked.value, {
        branch: "from-fork",
        message: "From the fork",
        files: [{ path: "probe.ts", content: source }],
      });
      if (!committed.ok) throw new Error(JSON.stringify(committed.error));
      const opened = await openPull(app, mallory, repo, {
        title: "From the fork",
        baseBranch: "main",
        headBranch: "from-fork",
        headRepo: forked.value,
      });
      if (!opened.ok) throw new Error(String(opened.error));
      expect(opened.value.crossRepo).toBe(true);
      const approved = await submitReview(app, alice, repo, opened.value, {
        state: "approved",
      });
      if (!approved.ok) throw new Error(String(approved.error));

      const deadline = Date.now() + 90_000;
      let run: Run | undefined;
      while (Date.now() < deadline) {
        run = listRuns(app.db, repo.id, { kind: "check", limit: 50 }).find(
          (r) =>
            r.issueId === opened.value.id &&
            r.commitOid === committed.value.commitOid,
        );
        if (run && (run.state === "ok" || run.state === "failed")) break;
        await Bun.sleep(100);
      }
      if (!run) throw new Error("the fork's check did not run");
      expect(run.state).toBe("ok");
      expect(run.sandboxEnforced).toBe(true);
      const line = readRunLog(dataDir, run.id).lines.find((l) =>
        l.startsWith("PROBE "),
      );
      expect(line).toBeDefined();
      expectContained(JSON.parse(line!.slice(6)) as Record<string, string>);
    }, 240_000);
  },
);

describe.skipIf(noCells)("cells: the shared install cache is read-only (#7543)", () => {
  test("a revealed cache under a hidden data dir is readable and a write into it fails", async () => {
    const data = await mkdtemp(join(tmpdir(), "forge-cell-cache-"));
    const cache = join(data, "check-install", "r", "bun");
    mkdirSync(cache, { recursive: true });
    writeFileSync(join(cache, "pkg"), "x");
    const dir = join(data, "..", `co-${Date.now()}`);
    mkdirSync(dir);
    const lines: string[] = [];
    const result = await runStep(
      "check",
      `cat ${cache}/pkg && (echo y > ${cache}/new && echo WROTE || echo REFUSED)`,
      {
        cwd: dir,
        env: childEnv({}),
        log: (line) => lines.push(line),
        signal: new AbortController().signal,
        timeoutMs: 60_000,
        cell: {
          dir,
          writable: [],
          home: join(dir, ".home"),
          hide: [data],
          reveal: [cache],
          egress: [],
          reach: [],
          limits: { memoryMiB: 1024, cpus: 2, diskMiB: 1024 },
        },
      },
    );
    expect(result.ok).toBe(true);
    expect(lines).toContain("x");
    expect(lines).toContain("REFUSED");
    expect(lines).not.toContain("WROTE");
    await rm(data, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }, 60_000);
});

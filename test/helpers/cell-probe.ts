import { expect } from "bun:test";

/** What the probe tries, from inside a deploy or a check. */
export function probeSource(targets: {
  dataDir: string;
  otherAppDir: string;
  canary: string;
  listenerPort: number;
  /** The forge's own pid: its environment holds every secret it was started with. */
  forgePid: number;
}): string {
  return `
import { readdirSync, readFileSync } from "node:fs";
const T = ${JSON.stringify(targets)};
const reached = (detail) => "reached: " + String(detail).slice(0, 80);
async function attempt(fn) {
  try {
    const found = await fn();
    return found === false ? "refused" : reached(found);
  } catch {
    return "refused";
  }
}
const answered = async (url, init) => {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(5000) });
  await res.body?.cancel();
  return res.ok ? res.status : false;
};
async function probe() {
  return {
    forgeDb: await attempt(() => readFileSync(T.dataDir + "/forge.db").length),
    secretKey: await attempt(() => readFileSync(T.dataDir + "/secret.key").length),
    forgeData: await attempt(() => {
      const names = readdirSync(T.dataDir);
      return names.some((n) => n === "forge.db" || n === "secret.key" || n === "repos") && names.join(",");
    }),
    otherApp: await attempt(() => readdirSync(T.otherAppDir).join(",")),
    environment: await attempt(() => {
      if (Object.values(process.env).some((v) => v?.includes(T.canary))) return "own env";
      // The pid is the forge's only outside a pid namespace of its own; inside
      // one the same number may be a process of the cell's.
      const cmdline = readFileSync("/proc/" + T.forgePid + "/cmdline", "latin1");
      const forge = readFileSync("/proc/" + T.forgePid + "/environ", "latin1");
      if (cmdline.includes("test") && forge.length > 0) return "the forge's environment, " + forge.length + " bytes";
      for (const pid of readdirSync("/proc")) {
        if (!/^\\d+$/.test(pid)) continue;
        try {
          if (readFileSync("/proc/" + pid + "/environ", "latin1").includes(T.canary)) return "pid " + pid;
        } catch {}
      }
      return false;
    }),
    undeclaredHost: await attempt(() => answered("http://example.com/")),
    cluster: await attempt(() => answered("http://127.0.0.1:" + T.listenerPort + "/")),
    declaredButPrivate: await attempt(() =>
      answered("http://localhost:" + T.listenerPort + "/", { proxy: process.env.HTTP_PROXY ?? undefined }),
    ),
    forge: await attempt(() => answered(process.env.FORGE_URL + "/healthz")),
  };
}
if (process.argv[2] === "check") {
  console.log("PROBE " + JSON.stringify(await probe()));
  // A terminal is the app's own client: its app answers it on its port.
  if (process.env.FORGE_APP_TTY === "1")
    console.log("OWNAPP " + (await attempt(() => answered("http://127.0.0.1:" + process.env.PORT + "/"))));
  // The sampler sees a cell only at a tick (200 ms here); a check that ends
  // sooner is never seen. Stay up for several ticks.
  if (process.env.FORGE_CHECK) await Bun.sleep(1000);
} else {
  Bun.serve({
    port: Number(process.env.PORT),
    hostname: "127.0.0.1",
    fetch: async (req) =>
      new URL(req.url).pathname === "/probe" ? Response.json(await probe()) : new Response("ok"),
  });
}
`;
}

/** Everything refused, and the forge — the one declared way out — answering. */
export function expectContained(results: Record<string, string>): void {
  const { forge, ...rest } = results;
  for (const [name, outcome] of Object.entries(rest))
    expect(`${name}: ${outcome}`).toBe(`${name}: refused`);
  expect(forge).toStartWith("reached");
}

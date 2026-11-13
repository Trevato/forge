/**
 * A stand-in for the forge in test/cell-stopped-dies-with-forge.test.ts: it
 * opens a real cell, runs `argv[3]` in it, and waits to be killed. Arguments:
 * a scratch directory, a loopback port, the command.
 */
import { join } from "node:path";
import { openCell } from "../../src/apps/contain.ts";

const [dir, port, command] = process.argv.slice(2) as [string, string, string];
const cell = openCell({
  dir: dir!,
  writable: [],
  home: join(dir!, "home"),
  hide: [],
  egress: [],
  reach: [],
  limits: { memoryMiB: 256, cpus: 1, diskMiB: 64 },
  listen: Number(port),
});
Bun.spawn(cell.argv(command!), {
  cwd: dir!,
  env: cell.env({ PATH: process.env["PATH"] ?? "/usr/bin:/bin" }),
  stdin: "ignore",
  stdout: "ignore",
  stderr: "ignore",
});
console.log("opened");
setInterval(() => {}, 1000);

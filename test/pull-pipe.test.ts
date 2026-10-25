import { expect, test } from "bun:test";
import { pullPipe } from "../src/git/pull-pipe.ts";

const MB = 1024 * 1024;

test("a child writing 200 MB stays blocked while nobody reads, and memory stays bounded", async () => {
  const before = process.memoryUsage.rss();
  const pipe = await pullPipe();
  const proc = Bun.spawn(["head", "-c", String(200 * MB), "/dev/zero"], {
    stdin: "ignore",
    stdout: pipe.writeFd,
    stderr: "ignore",
  });
  pipe.sealed();
  await Bun.sleep(1500);
  expect(proc.exitCode).toBeNull();
  expect(process.memoryUsage.rss() - before).toBeLessThan(32 * MB);

  let total = 0;
  for await (const chunk of pipe.stream) total += chunk.length;
  expect(total).toBe(200 * MB);
  expect(await proc.exited).toBe(0);
  expect(process.memoryUsage.rss() - before).toBeLessThan(64 * MB);
}, 30_000);

test("a reader that takes one chunk and stalls holds git blocked, memory bounded", async () => {
  const before = process.memoryUsage.rss();
  const pipe = await pullPipe();
  const proc = Bun.spawn(["head", "-c", String(200 * MB), "/dev/zero"], {
    stdin: "ignore",
    stdout: pipe.writeFd,
    stderr: "ignore",
  });
  pipe.sealed();
  const reader = pipe.stream.getReader();
  expect((await reader.read()).done).toBe(false);
  await Bun.sleep(1500);
  expect(proc.exitCode).toBeNull();
  expect(process.memoryUsage.rss() - before).toBeLessThan(32 * MB);
  await reader.cancel();
  proc.kill("SIGKILL");
  await proc.exited;
});

test("cancelling the stream tells the caller to stop the writer and closes the pipe", async () => {
  let cancelled = 0;
  const pipe = await pullPipe(() => {
    cancelled++;
    proc.kill("SIGKILL");
  });
  const proc = Bun.spawn(["head", "-c", String(200 * MB), "/dev/zero"], {
    stdin: "ignore",
    stdout: pipe.writeFd,
    stderr: "ignore",
  });
  pipe.sealed();
  const reader = pipe.stream.getReader();
  await reader.read();
  await reader.cancel();
  await proc.exited;
  expect(cancelled).toBe(1);
  expect(proc.signalCode).toBe("SIGKILL");
});

test("a quiet writer costs almost no wakeups while the reader waits", async () => {
  // Process CPU time also counts every other thing a loaded machine runs, so
  // count what the pipe itself does: each poll of a quiet writer is one
  // Bun.sleep. Backing off to 100 ms makes that ~25 over 2 s; a busy poll
  // would make hundreds.
  const realSleep = Bun.sleep;
  let sleeps = 0;
  Bun.sleep = ((ms: Parameters<typeof Bun.sleep>[0]) => {
    sleeps++;
    return realSleep(ms);
  }) as typeof Bun.sleep;
  try {
    const pipe = await pullPipe();
    const proc = Bun.spawn(["sleep", "2"], {
      stdin: "ignore",
      stdout: pipe.writeFd,
      stderr: "ignore",
    });
    pipe.sealed();
    for await (const _ of pipe.stream) void _;
    expect(await proc.exited).toBe(0);
  } finally {
    Bun.sleep = realSleep;
  }
  expect(sleeps).toBeGreaterThan(0);
  expect(sleeps).toBeLessThan(40);
});

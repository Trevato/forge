/**
 * Borrowing a process global for one test file, and giving it back. The
 * suite runs every file in one process, so a floor lowered or a variable
 * cleared and never restored is inherited by whichever file runs next — and
 * that file goes red for a reason that belongs to this one (#302). Each
 * helper registers its own `beforeAll`/`afterAll` in the scope it is called
 * from: called at a file's top level, it holds for that file and no longer.
 */

import { afterAll, beforeAll } from "bun:test";
import { logLevel, setLogLevel, type LogLevel } from "../../src/kernel/log.ts";
import { firstFetchRetry } from "../../src/origins/mirror.ts";
import type { OutboundOptions } from "../../src/kernel/outbound.ts";
import {
  mirrorOutboundForTest,
  provideMirrorOutboundForTest,
} from "../../src/origins/git-mirror.ts";

/** Raise the log floor (by default to errors only) while this scope runs. */
export function quietLogs(level: LogLevel = "error"): void {
  let found: LogLevel;
  beforeAll(() => {
    found = logLevel();
    setLogLevel(level);
  });
  afterAll(() => setLogLevel(found));
}

/** Shorten a new mirror's first-fetch retries while this scope runs. */
export function fastFirstFetch(ms: readonly number[] = [50]): void {
  let found: readonly number[];
  beforeAll(() => {
    found = firstFetchRetry.ms;
    firstFetchRetry.ms = ms;
  });
  afterAll(() => {
    firstFetchRetry.ms = found;
  });
}

/**
 * Tell a mirror's outbound vet `options` while this scope runs. The preload
 * lets every file mirror from loopback; a file that tightens that and leaves
 * it tightened refuses the next file's fake origin in the same shard.
 */
export function mirrorOutbound(options: OutboundOptions): void {
  let found: OutboundOptions;
  beforeAll(() => {
    found = mirrorOutboundForTest();
    provideMirrorOutboundForTest(options);
  });
  afterAll(() => provideMirrorOutboundForTest(found));
}

/**
 * Unset environment variables the machine may carry while this scope runs.
 * A crew machine sets `FORGE_URL` to its own forge; a test that registers an
 * OAuth callback must not inherit it. Whatever the scope itself sets under
 * these names is cleared again on the way out, and the machine's values put
 * back.
 */
export function withoutEnv(...names: string[]): void {
  const found = new Map<string, string | undefined>();
  beforeAll(() => {
    for (const name of names) {
      found.set(name, process.env[name]);
      delete process.env[name];
    }
  });
  afterAll(() => {
    for (const [name, value] of found) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}

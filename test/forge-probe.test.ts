/**
 * The probe (`kernel/probe.ts`, #2917): what the release machinery sends to
 * be told what a forge runs. A caller reads the key and never writes it, and
 * the launcher's copy of the derivation is the forge's own.
 */

import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeHeaders as launcherProbe } from "../src/release/launch.ts";
import { isProbe, PROBE_HEADER, probeFor, probeHeaders } from "../src/kernel/probe.ts";

const root = mkdtempSync(join(tmpdir(), "forge-probe-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

test("a caller with no key yet sends nothing, and leaves no key behind", () => {
  const data = join(root, "fresh");
  expect(probeHeaders(data)).toEqual({});
  expect(launcherProbe(data)).toEqual({});
  expect(existsSync(join(data, "secret.key"))).toBe(false);
});

test("the caller's probe, the launcher's and the forge's are one value", () => {
  const data = join(root, "keyed");
  const forge = probeFor(data);
  expect(probeHeaders(data)).toEqual({ [PROBE_HEADER]: forge });
  expect(launcherProbe(data)).toEqual({ [PROBE_HEADER]: forge });
  const asked = (value?: string) =>
    new Request("http://forge/healthz", value === undefined ? {} : { headers: { [PROBE_HEADER]: value } });
  expect(isProbe(asked(forge), data)).toBe(true);
  for (const wrong of [undefined, "", forge.slice(1), `${forge}x`, probeFor(join(root, "other"))])
    expect(isProbe(asked(wrong), data)).toBe(false);
});

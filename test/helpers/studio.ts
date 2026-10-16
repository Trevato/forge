/**
 * What the studio test files share (#2038 split one file into several):
 * a picture to drop where a look would sit, and an app runtime that
 * answers "running" without starting anything.
 */

import { spyOn } from "bun:test";
import type { App } from "../../src/app.ts";
import { AppsRuntime, type EnvState, type EnvStatus } from "../../src/apps/runtime.ts";
import type { AppRecord } from "../../src/core/apps.ts";
import { looksForEnv } from "../../src/core/looks.ts";
import type { Servers } from "../../src/http/server.ts";

/** One transparent pixel, dropped where a look would sit. */
export const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

/**
 * A runtime registered for `app`, never started, answering every app's
 * production with `stateOf` (running unless told) — the door shows only
 * what is up or wakes. The returned function takes it away again.
 */
export async function serving(
  app: App,
  servers: Servers,
  stateOf: (record: AppRecord) => EnvState = () => "running",
): Promise<() => Promise<void>> {
  const runtime = new AppsRuntime(app, {
    domain: "studio-door.test",
    scheme: "http",
    publicPort: servers.port,
    forgeUrl: servers.url,
  });
  const status = spyOn(AppsRuntime.prototype, "status").mockImplementation(
    (record: AppRecord): EnvStatus[] => [
      {
        env: "production",
        state: stateOf(record),
        // Serving the commit its newest picture is of.
        commitOid: looksForEnv(app.db, record.id, "production")[0]?.commitOid ?? "",
      } as EnvStatus,
    ],
  );
  return async () => {
    status.mockRestore();
    await runtime.stop();
  };
}

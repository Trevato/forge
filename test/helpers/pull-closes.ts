/** Waits for a pull's issue to close: parking reads git history, so it lands just after the announcement. */
import { expect } from "bun:test";
import type { App } from "../../src/app.ts";
import { getIssueById } from "../../src/core/issues.ts";

export async function pullCloses(app: App, pull: { id: string }): Promise<void> {
  const open = () => getIssueById(app.db, pull.id)?.state === "open";
  for (let i = 0; i < 1000 && open(); i++) await Bun.sleep(2);
  expect(open()).toBe(false);
}

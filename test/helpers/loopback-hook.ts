/**
 * Test receivers listen on loopback over plain http, which the forge refuses
 * to save and refuses to send to. These two get a test around that without
 * any switch production could carry: a row inserted past `createWebhook`, and
 * an allow-list passed to `deliverDue` as an argument.
 */
import type { App } from "../../src/app.ts";
import { id } from "../../src/kernel/id.ts";

export const LOOPBACK = { allow: ["127.0.0.1", "::1"], plain: true } as const;

export function plainHook(app: App, repoId: string, url: string, kinds = "*"): void {
  app.db
    .query("INSERT INTO webhook (id, repo_id, url, secret, kinds) VALUES (?1, ?2, ?3, 'test-secret', ?4)")
    .run(id(), repoId, url, kinds);
}

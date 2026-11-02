/**
 * What crawlers cost the forge, as one plain object (#8129): their share of
 * the last quarter hour's answering time and who was refused. The admin API
 * and the terminal's Crawlers screen both read it.
 */

import type { App } from "../app.ts";
import { crawlRefusalScopes, crawlRefusals } from "../http/crawl.ts";
import { perfRecord } from "./live.ts";
import { WINDOW_MS, crawlerShare } from "./record.ts";

export function crawlReport(app: App, now = Date.now()) {
  const share = crawlerShare(perfRecord, now - WINDOW_MS);
  return {
    window_minutes: WINDOW_MS / 60_000,
    requests: share.requests,
    crawler_requests: share.crawlerRequests,
    ms: Math.round(share.ms),
    crawler_ms: Math.round(share.crawlerMs),
    deep_stranger_requests: share.strangerRequests,
    deep_stranger_ms: Math.round(share.strangerMs),
    share: Math.round(share.share * 1000) / 1000,
    refused: crawlRefusals(app).slice(0, 50),
    refused_by_budget: crawlRefusalScopes(app),
  };
}

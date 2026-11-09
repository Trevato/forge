/** llms.txt names how to find things, and says so when nothing is public. */
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { serve } from "../src/http/server.ts";

test("llms.txt names explore and search, and an empty forge says None yet.", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "forge-llms-find-"));
  const app = createApp({ dataDir, port: 0 });
  const servers = await serve(app);
  try {
    const body = await fetch(`${servers.url}/llms.txt`).then((r) => r.text());
    expect(body).toContain("## Find things (no account)");
    expect(body).toContain("/api/v1/explore?q=kind:app+sort:forks+garden");
    expect(body).toContain("/api/v1/search?q=");
    expect(body).toContain('MCP "explore": with an account');
    expect(body).toContain('MCP "search": with an account');
    expect(body).toMatch(/## Public repositories\n\nNone yet\.\n/);
  } finally {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

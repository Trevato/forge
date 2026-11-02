/** A PDF on the blob page: the browser's viewer in an <object>, with a fallback inside it. */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const SMALL = new TextEncoder().encode("%PDF-1.7\n1 0 obj<<>>endobj\n%%EOF\n");
const BIG = new Uint8Array(1_500_000);
BIG.set(SMALL);

let dataDir = "";
let app: App;
let servers: Servers;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-pdf-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const a = await seedAdmin(app, { username: "alice", email: "a@f.dev", password: "a-long-pdf-passphrase" });
  if (!a.ok) throw new Error("signup failed");
  const repo = await createRepo(app, a.value, { name: "docs", visibility: "public" });
  if (!repo.ok) throw new Error("repo failed");
  const made = await commitToBranch(app, a.value, repo.value, {
    message: "pdfs",
    files: [
      { path: "a.pdf", content: SMALL },
      { path: "big.pdf", content: BIG },
    ],
  });
  if (!made.ok) throw new Error("commit failed");
});

afterAll(async () => {
  await servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

const page = async (path: string, query = ""): Promise<string> =>
  (await (await fetch(`${servers.url}/alice/docs/blob/main/${path}${query}`)).text()).replace(/\s+/g, " ");

describe("PDF blob pages", () => {
  for (const file of ["a.pdf", "big.pdf"]) {
    test(`${file} is an <object> on the media URL with both fallback links`, async () => {
      const html = await page(file);
      const media = `/alice/docs/media/main/${file}`;
      expect(html).toContain(`<object class="pdf-frame" data="${media}" type="application/pdf">`);
      expect(html).toContain(`<a href="${media}">Open the PDF</a>`);
      expect(html).toContain(`href="${media}?download=1"`);
      expect(html).toContain("Download</a>");
      expect(html).toContain("PDF</span>");
    });
  }

  test("the source view has no object", async () => {
    const html = await page("a.pdf", "?view=source");
    expect(html).not.toContain("<object");
    expect(html).not.toContain("application/pdf");
  });
});

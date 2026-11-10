/** The crew, prompts, egress, webhook, decision, event and flow routes are in the served document. */
import { expect, test } from "bun:test";
import { openapi } from "../src/contract/openapi.ts";

const R = "/api/v1/repos/{owner}/{name}";
const WANT: Record<string, string[]> = {
  [`${R}/crew`]: ["get"],
  [`${R}/crew/{username}`]: ["delete"],
  [`${R}/prompts`]: ["get", "post"],
  [`${R}/prompts/{id}`]: ["delete"],
  [`${R}/egress-grants`]: ["get", "post", "delete"],
  [`${R}/hooks`]: ["get", "post"],
  [`${R}/hooks/{id}`]: ["delete"],
  [`${R}/decisions`]: ["get"],
  [`${R}/events`]: ["get"],
  [`${R}/flow`]: ["get"],
};

test("each crew-area path and method is served", () => {
  const doc = openapi("https://f.test", "1") as any;
  for (const [path, methods] of Object.entries(WANT))
    for (const m of methods) expect(doc.paths[path]?.[m], `${m} ${path}`).toBeDefined();
  expect(doc.paths[`${R}/hooks`].post.security).toBeDefined();
  expect(doc.paths[`${R}/decisions`].get.security).toEqual([]);
});

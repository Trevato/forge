import { expect, test } from "bun:test";
import { raw } from "../src/web/html.ts";
import { stat } from "../src/web/ui.ts";
import { components } from "../src/web/style/components.ts";

test("stat renders a div tile without href", () => {
  const h = String(stat({ label: "Pulls", value: 1234, title: "1,234 pulls" }));
  expect(h).toContain('<div class="stat">');
  expect(h).toContain('title="1,234 pulls"');
  expect(h).toContain("stat-value num");
  expect(h).not.toContain("stat-note");
  expect(h).not.toContain("<a ");
});

test("stat is a link with href, and shows note and spark", () => {
  const h = String(
    stat({ label: "L", value: "7", note: "n", href: "/x", spark: raw("<svg></svg>") }),
  );
  expect(h).toContain('<a class="stat" href="/x">');
  expect(h).toContain('<span class="stat-note">n</span>');
  expect(h).toContain("<svg></svg>");
});

test("stat escapes label, value, note and href", () => {
  const h = String(stat({ label: "<b>", value: "<i>", note: "<script>", href: '/"x' }));
  expect(h).not.toContain("<b>");
  expect(h).not.toContain("<i>");
  expect(h).not.toContain("<script>");
  expect(h).toContain("&lt;b&gt;");
  expect(h).toContain("&lt;script&gt;");
  expect(h).not.toContain('"x');
});

test("the stats grid is defined", () => {
  expect(components).toContain("minmax(160px, 1fr)");
});

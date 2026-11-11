/** A compose file as its services: depends_on, build, env names only, escaping, fallback, the registry. */
import { describe, expect, test } from "bun:test";
import { compose, LIST_CAP, parseCompose, SERVICE_CAP } from "../src/web/render/compose.ts";
import { fileKind, kindByName } from "../src/web/render/kinds.ts";
import { RENDERERS } from "../src/web/render/renderers.ts";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const draw = (text: string) => compose({ path: "compose.yaml", size: text.length, body: enc(text), media: "/m", download: "/d" });
const out = (r: ReturnType<typeof draw>): string => String(r.content);

const FILE = `services:
  web:
    image: nginx:1
    ports: ["8080:80", { target: 443, published: 8443 }]
    volumes: [./site:/usr/share/nginx/html]
    depends_on: [api, db]
    environment:
      SECRET_TOKEN: hunter2
  api:
    build: ./api
    depends_on:
      db:
        condition: service_healthy
    environment:
      - DB_PASSWORD=s3cret
      - PLAIN
  db:
    build:
      context: ./db
    environment:
      X: "<script>alert(1)</script>"
`;

describe("compose", () => {
  test("two services with depends_on, a build service, names only", () => {
    const c = parseCompose(FILE);
    if ("error" in c) throw new Error(c.error);
    expect(c.services.map((s) => s.name)).toEqual(["web", "api", "db"]);
    expect(c.services[0]!.dependsOn).toEqual(["api", "db"]);
    expect(c.services[0]!.ports).toEqual(["8080:80", "8443:443"]);
    expect(c.services[1]!.dependsOn).toEqual(["db"]);
    expect(c.services[1]!.built).toBe(true);
    expect(c.services[1]!.source).toBe("./api");
    expect(c.services[2]!.source).toBe("./db");
    expect(c.services[1]!.env).toEqual(["DB_PASSWORD", "PLAIN"]);
    const html = out(draw(FILE));
    expect(html).toContain("SECRET_TOKEN");
    for (const v of ["hunter2", "s3cret", "alert(1)"]) expect(html).not.toContain(v);
  });
  test("escapes every value", () => {
    const html = out(draw(`services:\n  "<script>x</script>":\n    image: "<script>y</script>"\n    ports: ["<script>z</script>"]\n    environment: ["<script>e</script>=1"]\n`));
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
  test("not compose falls back to source, no banner of error", () => {
    for (const bad of ["a: [", "just: text", "- a\n- b", "---\na: 1\n---\nb: 2"]) {
      const r = draw(bad);
      expect(r.fallback).toContain("shown as YAML");
    }
  });
  test("registered by name and drawn", () => {
    for (const n of ["compose.yaml", "compose.yml", "docker-compose.yaml", "a/Docker-Compose.yml"]) {
      expect(fileKind(n, enc("services: {}"))).toBe("compose");
      expect(kindByName(n)).toBe("compose");
    }
    expect(fileKind("my-compose.yaml", enc("a: 1"))).not.toBe("compose");
    expect(RENDERERS.compose).toBe(compose);
  });
});

describe("compose caps", () => {
  test("SERVICE_CAP and the more-services line", () => {
    const n = SERVICE_CAP + 3;
    const text = "services:\n" + Array.from({ length: n }, (_, i) => `  s${i}:\n    image: x\n`).join("");
    const c = parseCompose(text);
    if ("error" in c) throw new Error(c.error);
    expect(c.services.length).toBe(SERVICE_CAP);
    expect(c.total).toBe(n);
    const html = out(draw(text));
    expect(html).toContain("3 more services not shown");
    expect(html).not.toContain(`s${SERVICE_CAP}<`);
  });
  test("LIST_CAP per column", () => {
    const n = LIST_CAP + 5;
    const ports = Array.from({ length: n }, (_, i) => `"${1000 + i}:80"`).join(", ");
    const c = parseCompose(`services:\n  a:\n    image: x\n    ports: [${ports}]\n`);
    if ("error" in c) throw new Error(c.error);
    expect(c.services[0]!.ports.length).toBe(LIST_CAP);
  });
  test("the table scrolls on a phone and says why it fell back", () => {
    expect(out(draw(FILE))).toContain('class="table-scroll"');
    expect(draw("a: 1").fallback).toBe("This file has no services, so it is shown as YAML.");
  });
});

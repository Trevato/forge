/**
 * The app a new app starts as is a repository (#10305): the forge copies
 * the template repository's tip when it has one, and the copy in the image
 * otherwise; `template.json` says which literals are the app's name and
 * description; the template's own evaluator is the forge's.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { newApp } from "../src/actions/apps.ts";
import { bakedFiles, bakedTemplate, fillTemplate, parseTemplateSpec, scaffoldFiles } from "../src/apps/template.ts";
import { createUser, type User } from "../src/core/users.ts";
import { readerFor } from "../src/git/read.ts";
import { repoDir } from "../src/git/repos.ts";
import { commitFiles } from "../src/git/write.ts";

setDefaultTimeout(30_000);

const text = (c: string | Uint8Array | null | undefined): string =>
  typeof c === "string" ? c : new TextDecoder().decode(c ?? new Uint8Array());

describe("the copy in the image", () => {
  const copy = bakedTemplate();
  const spec = parseTemplateSpec(text(copy.files.find((f) => f.path === "template.json")?.content));

  test("declares its literals and the files that carry them", () => {
    expect(spec?.name).toBe("app-template");
    expect(spec?.files).toEqual(["package.json", "README.md", "contract/openapi.json"]);
    for (const path of spec?.files ?? []) expect(copy.files.some((f) => f.path === path)).toBe(true);
  });

  test("filling replaces the literals in the named files and touches nothing else", () => {
    const out = bakedFiles({ name: "hello-there", description: 'A "quoted" place' });
    expect(out.some((f) => f.path === "template.json")).toBe(false);
    const get = (path: string) => text(out.find((f) => f.path === path)?.content);
    expect(JSON.parse(get("package.json"))).toMatchObject({ name: "hello-there", description: 'A "quoted" place' });
    expect(get("README.md").startsWith('# hello-there\n\nA "quoted" place\n')).toBe(true);
    expect(JSON.parse(get("contract/openapi.json")).info).toMatchObject({ title: "hello-there", description: 'A "quoted" place' });
    const carriers = new Set(spec?.files);
    for (const f of copy.files) {
      if (f.path === "template.json" || carriers.has(f.path)) continue;
      expect(get(f.path)).toBe(text(f.content));
    }
  });

  test("an empty description keeps the template's own line", () => {
    const out = bakedFiles({ name: "x", description: "  " });
    expect(text(out.find((f) => f.path === "README.md")?.content)).toContain("A new app on the forge.");
  });

  test("filling with its own literals gives back the template's files", () => {
    const out = fillTemplate(copy, { name: "app-template", description: "A new app on the forge." }) ?? [];
    for (const f of out) expect(text(f.content)).toBe(text(copy.files.find((c) => c.path === f.path)?.content));
  });

  test("its contract evaluator and beacon are the forge's own", async () => {
    const mine = (p: string) => Bun.file(join(import.meta.dir, "..", p)).text();
    const can = copy.files.find((f) => f.path === "src/can.ts")?.content;
    expect(text(can)).toBe(await mine("src/contract/can.ts"));
  });

  test("a template.json that names odd paths or too many files is not read", () => {
    expect(parseTemplateSpec("nope")).toBeUndefined();
    for (const bad of ["../x", "/abs", ".git/config", "a/../b", "a//b", "a\\b", "x/.GIT/y"])
      expect(parseTemplateSpec(JSON.stringify({ name: "a", description: "b", files: [bad] }))).toBeUndefined();
    const many = Array.from({ length: 51 }, (_, i) => `f${i}`);
    expect(parseTemplateSpec(JSON.stringify({ name: "a", description: "b", files: many }))).toBeUndefined();
  });
});

describe("New app copies the template repository when the forge has it", () => {
  let dataDir: string;
  let app: App;
  let owner: User;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-template-"));
    app = createApp({ dataDir, port: 0 });
    const made = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "trevato",
      email: "trevato@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!made.ok) throw new Error(made.error);
    owner = made.value;
  });
  afterAll(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const readme = async (name: string): Promise<string> => {
    const got = await readerFor(repoDir(app.reposRoot, "trevato", name)).object("refs/heads/main:README.md");
    return got.ok ? text(got.value.body) : "";
  };

  test("without the repository the image's copy makes the app", async () => {
    const files = await scaffoldFiles(app, { name: "fallback", description: "" });
    expect(files.map((f) => f.path).sort()).toEqual(bakedFiles({ name: "fallback", description: "" }).map((f) => f.path).sort());
    const made = await newApp(app, owner, { name: "from-baked", description: "Baked" });
    expect(made.ok).toBe(true);
    expect(await readme("from-baked")).toStartWith("# from-baked\n\nBaked\n");
  });

  test("with it, the tip of its default branch is the app, in one commit", async () => {
    // trevato/app-template: made as an app, then given a README the image does not have.
    expect((await newApp(app, owner, { name: "app-template" })).ok).toBe(true);
    const edited = text(bakedTemplate().files.find((f) => f.path === "README.md")?.content).replace(
      "# app-template",
      "# app-template\n\nTIP-MARKER",
    );
    const template = bakedTemplate().files.map((f) => (f.path === "README.md" ? { ...f, content: edited } : f));
    await commitFiles(repoDir(app.reposRoot, "trevato", "app-template"), {
      branch: "main",
      message: "Change the template",
      files: template,
      author: { name: "trevato", email: "trevato@forge.local" },
    });
    const child = await newApp(app, owner, { name: "child-one", description: "Kid" });
    expect(child.ok).toBe(true);
    const body = await readme("child-one");
    expect(body).toContain("TIP-MARKER");
    expect(body).toStartWith("# child-one\n\nTIP-MARKER");
    const count = Bun.spawnSync(["git", "-C", repoDir(app.reposRoot, "trevato", "child-one"), "rev-list", "--count", "main"]);
    expect(count.stdout.toString().trim()).toBe("1");
    const tracked = Bun.spawnSync(["git", "-C", repoDir(app.reposRoot, "trevato", "child-one"), "ls-tree", "-r", "--name-only", "main"]);
    expect(tracked.stdout.toString()).not.toContain("template.json");
  });

  test("a template repository without a readable template.json falls back to the image's copy", async () => {
    await commitFiles(repoDir(app.reposRoot, "trevato", "app-template"), {
      branch: "main",
      message: "Break template.json",
      files: [{ path: "template.json", content: "nope" }],
      author: { name: "trevato", email: "trevato@forge.local" },
    });
    expect((await newApp(app, owner, { name: "child-two" })).ok).toBe(true);
    expect(await readme("child-two")).not.toContain("TIP-MARKER");
  });
});

describe("the copy in the image is pinned or says it is not", () => {
  const raw = JSON.parse(readFileSync(new URL("../templates/app-template.json", import.meta.url), "utf8")) as {
    commit: string;
    pinned?: boolean;
    note?: string;
  };

  test("a pinned bundle names a full commit id; an unpinned one says so in a note", () => {
    if (raw.pinned === true) expect(raw.commit).toMatch(/^[0-9a-f]{40}$/);
    else expect(raw.note ?? "").toContain("Not yet taken from the repository");
  });
});

describe("the two template.json forms", () => {
  test("the root form is not read as a folder's and the folder's is not read as the root's", () => {
    const root = { name: "app-template", description: "A new app.", files: ["README.md"] };
    const folder = { files: ["README.md"], literals: ["{{name}}", "{{description}}"] };
    expect(parseTemplateSpec(JSON.stringify(root))).toBeDefined();
    expect(parseTemplateSpec(JSON.stringify(folder))).toBeUndefined();
    expect(Object.keys(folder).sort()).toEqual(["files", "literals"]);
  });
});

describe("a template copy over the caps is not used", () => {
  let dataDir: string;
  let app: App;
  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-template-caps-"));
    app = createApp({ dataDir, port: 0 });
    const made = await createUser(app.db, {
      origin: "seed", trusted: true, username: "trevato", email: "t@forge.local",
      password: "a-good-passphrase", adminIfFirst: true,
    });
    if (!made.ok) throw new Error(made.error);
    expect((await newApp(app, made.value, { name: "app-template" })).ok).toBe(true);
  });
  afterAll(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a file over the per-file cap sends New app to the image's copy", async () => {
    await commitFiles(repoDir(app.reposRoot, "trevato", "app-template"), {
      branch: "main",
      message: "Too big",
      files: [{ path: "big.bin", content: new Uint8Array(512 * 1024 + 1) }],
      author: { name: "trevato", email: "t@forge.local" },
    });
    const got = await scaffoldFiles(app, { name: "capped", description: "" });
    expect(got.some((f) => f.path === "big.bin")).toBe(false);
  });
});

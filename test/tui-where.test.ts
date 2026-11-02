/**
 * The terminal's where-strip: every repository screen says, in plain words,
 * whether it reads live from an origin, from the workbench or from this
 * machine — and what an origin's URL carries never reaches the terminal as
 * a command.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { createOrigin, linkRepoToOrigin } from "../src/core/origins.ts";
import { pin } from "../src/core/pins.ts";
import { getRepo, type Repo } from "../src/core/repos.ts";
import type { User } from "../src/core/users.ts";
import type { Origin } from "../src/origins/types.ts";
import { originTarget } from "../src/tui/screens/contribute.ts";
import { Session } from "../src/tui/session.ts";
import {
  hostLabel,
  hostOf,
  local,
  originKind,
  otherSide,
  otherSideLabel,
  whereRows,
  whereSpans,
  whereStrip,
} from "../src/tui/screens/where.ts";
import { Screen as Surface } from "../src/tui/term/screen.ts";
import { theme } from "../src/tui/ui/theme.ts";
import type { RepoSource } from "../src/view/source.ts";
import { sourceFor } from "../src/view/source.ts";
import { quietLogs } from "./helpers/globals.ts";
import { seedAdmin } from "./helpers/admin.ts";

quietLogs();

const c = theme("dark").c;

let dir: string;
let app: App;
let alice: User;
let native: Repo;
let mirror: Repo;
let origin: Origin;
let remote: RepoSource;

const session = (user: User | undefined): Session =>
  new Session(app, { sshUsername: "t", remoteAddress: "127.0.0.1", user });

/** A live browse of `fullName` at the origin, with a mirror if given. */
const live = (o: Origin, mirrored?: Repo): RepoSource =>
  ({
    ...remote,
    where: {
      kind: "origin",
      origin: o,
      fullName: "octo/widgets",
      htmlUrl: `${o.webUrl}/octo/widgets`,
      ...(mirrored === undefined ? {} : { mirroredAs: mirrored }),
    },
  }) as RepoSource;

/** The two rows a screen gives the strip, as the terminal would show them. */
const strip = (f: Session, src: RepoSource, w = 120): string[] => {
  const s = new Surface(w, 2);
  whereStrip(s, { x: 0, y: 0, w, h: whereRows(src) }, c, f, src);
  return s.toText().split("\n");
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-tui-where-"));
  app = createApp({ dataDir: dir, port: 0 });
  const a = await seedAdmin(app, {
    username: "alice",
    email: "alice@forge.test",
    password: "a-long-passphrase",
  });
  if (!a.ok) throw new Error("signup failed");
  alice = a.value;
  const n = await createRepo(app, alice, { name: "plain", visibility: "public" });
  const m = await createRepo(app, alice, { name: "widgets", visibility: "public" });
  if (!n.ok || !m.ok) throw new Error("repo creation failed");
  const o = createOrigin(app.db, dir, {
    userId: alice.id,
    kind: "forgejo",
    apiUrl: "https://codeberg.org/api/v1",
    webUrl: "https://codeberg.org",
    login: "alice",
    token: "t0ken",
  });
  if (!o.ok) throw new Error("origin failed");
  origin = o.value;
  linkRepoToOrigin(app.db, m.value.id, {
    originId: origin.id,
    fullName: "octo/widgets",
    remoteId: "1",
    htmlUrl: "https://codeberg.org/octo/widgets",
  });
  native = getRepo(app.db, "alice", "plain")!;
  mirror = getRepo(app.db, "alice", "widgets")!;
  remote = local(session(alice), native);
});

afterAll(async () => {
  app.db.close();
  await rm(dir, { recursive: true, force: true });
});

describe("the strip names the one place being read", () => {
  test("a live origin reads from the origin and says read-only", () => {
    const f = session(alice);
    const src = live(origin);
    const [first, second] = strip(f, src);
    expect(whereRows(src)).toBe(2);
    expect(first).toContain("● codeberg.org");
    expect(first).toContain("○ workbench");
    expect(first).toContain("○ this machine");
    expect(first!.split("●").length).toBe(2);
    expect(second).toContain("reading live from codeberg.org");
    expect(second).toContain("read-only");
  });

  test("a mirror in the workbench is the current place; its origin is only present", () => {
    const f = session(alice);
    const src = local(f, mirror);
    const rows = strip(f, src);
    expect(whereRows(src)).toBe(1);
    expect(rows[0]).toContain("codeberg.org");
    expect(rows[0]).toContain("● workbench (never synced)");
    expect(rows[0]!.split("● workbench").length).toBe(2);
    expect(rows[1]!.trim()).toBe("");
    const spans = whereSpans(f, src, c);
    const dots = spans.filter((s) => s.text === "●" || s.text === "○");
    expect(dots.map((s) => s.text)).toEqual(["●", "●", "○"]);
    // accent marks the place being read; the origin dot is success-coloured
    expect(dots[1]!.style.fg).not.toEqual(dots[0]!.style.fg);
  });

  test("a native repository has two places and no origin or banner", () => {
    const f = session(alice);
    const src = local(f, native);
    const rows = strip(f, src);
    expect(rows[0]).toContain("● workbench");
    expect(rows[0]).toContain("○ this machine");
    expect(rows[0]).not.toContain("codeberg");
    expect(rows[1]!.trim()).toBe("");
  });

  test("this machine is marked, and diamonded, once pinned", () => {
    const f = session(alice);
    const src = local(f, native);
    expect(strip(f, src)[0]).toContain("○ this machine");
    pin(app.db, alice.id, native.id);
    expect(strip(f, src)[0]).toContain("◆ this machine");
  });

  test("a live browse with a mirror names it on the banner", () => {
    const f = session(alice);
    const rows = strip(f, live(origin, mirror));
    expect(rows[0]).toContain("workbench (alice/widgets)");
    expect(rows[1]).toContain("the workbench copy is alice/widgets");
  });
});

describe("the other side", () => {
  test("a mirror can switch to its live origin, and says where", () => {
    const f = session(alice);
    const src = local(f, mirror);
    const other = otherSide(f, src);
    expect(other?.where.kind).toBe("origin");
    expect(otherSideLabel(f, src)).toBe("live on codeberg.org");
  });

  test("a live browse with a mirror switches to the workbench copy", () => {
    const f = session(alice);
    const src = live(origin, mirror);
    const other = otherSide(f, src);
    expect(other?.where.kind).toBe("local");
    expect(otherSideLabel(f, src)).toBe("the workbench copy");
  });

  test("nothing when there is no other side", () => {
    const f = session(alice);
    const native1 = local(f, native);
    expect(otherSide(f, native1)).toBeUndefined();
    expect(otherSideLabel(f, native1)).toBeUndefined();
    const bare = live(origin);
    expect(otherSide(f, bare)).toBeUndefined();
    expect(otherSideLabel(f, bare)).toBeUndefined();
  });

  test("a guest is offered no live side of a mirror", () => {
    const guest = session(undefined);
    const src = local(guest, mirror);
    expect(otherSide(guest, src)).toBeUndefined();
    expect(otherSideLabel(guest, src)).toBeUndefined();
    expect(sourceFor(app, undefined, { originId: origin.id, fullName: "octo/widgets" }).ok).toBe(false);
  });
});

describe("what an origin's URL carries prints inert", () => {
  test("originKind says which forge software, or nothing for a native repo", () => {
    const f = session(alice);
    expect(originKind(live(origin))).toBe("forgejo");
    expect(originKind(local(f, mirror))).toBe("forgejo");
    expect(originKind(local(f, native))).toBeUndefined();
  });

  test("hostOf gives the host and nothing of the path", () => {
    expect(hostOf("https://codeberg.org/octo/widgets")).toBe("codeberg.org");
    expect(hostOf("https://git.example:8443/a/b")).toBe("git.example:8443");
  });

  test("a control character in the path never reaches the host", () => {
    expect(hostOf("https://codeberg.org/a\x1b[31mb\x07/c")).toBe("codeberg.org");
  });

  test("a host that is not a URL gives an empty string", () => {
    expect(hostOf("not a url")).toBe("");
    expect(hostOf("")).toBe("");
    expect(hostOf("\x1b]0;pwned\x07")).toBe("");
    expect(hostOf("https://ev\x1b[2Jil.example/")).toBe("");
  });

  test("an origin whose web address is hostile paints no control byte", () => {
    const f = session(alice);
    for (const webUrl of [
      "https://evil.example/\x1b]0;pwned\x07",
      "https://ev\x1b[2Jil.example/",
      "\x1b[31mnot-a-url\x07",
    ]) {
      const hostile = { ...origin, webUrl } as Origin;
      const src = live(hostile);
      const s = new Surface(120, 2);
      whereStrip(s, { x: 0, y: 0, w: 120, h: 2 }, c, f, src);
      // only the renderer's own SGR sequences may carry an escape byte
      const bare = s
        .toStyledText()
        // eslint-disable-next-line no-control-regex
        .replace(/\x1b\[[0-9;:]*m/g, "");
      // eslint-disable-next-line no-control-regex
      expect(bare).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/);
      expect(s.toText()).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f]/);
      expect(JSON.stringify(whereSpans(f, src, c))).not.toContain("\\u001b");
    }
  });

  test("a full name from the remote, with no usable page address, prints inert", () => {
    const f = session(alice);
    for (const fullName of ["octo/\x1b[2Jwidgets", "octo/\x1b]0;x\x07widgets"]) {
      const repo = {
        ...mirror,
        origin: { ...mirror.origin!, htmlUrl: "", fullName },
      } as Repo;
      const src = local(f, repo);
      const s = new Surface(120, 2);
      whereStrip(s, { x: 0, y: 0, w: 120, h: 2 }, c, f, src);
      // eslint-disable-next-line no-control-regex
      const ctl = /[\x00-\x1f\x7f-\x9f]/;
      expect(s.toText().split("\n")[0]).toContain("octo/");
      expect(JSON.stringify(whereSpans(f, src, c))).not.toContain("\\u001b");
      expect(otherSideLabel(f, src)).not.toMatch(ctl);
      expect(originTarget(src)!.host).not.toMatch(ctl);
      expect(hostLabel("", fullName)).not.toMatch(ctl);
    }
  });
});

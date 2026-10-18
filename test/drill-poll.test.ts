import { expect, test } from "bun:test";
import { forgePoll } from "../scripts/drills/run.ts";

const answers = (health: Response | Error, board: Response | Error): typeof fetch =>
  (async (url: string) => {
    const r = String(url).endsWith("/api/v1/health") ? health : board;
    if (r instanceof Error) throw r;
    return r.clone();
  }) as unknown as typeof fetch;

const html = (status: number, body: string) => new Response(body, { status, headers: { "content-type": "text/html" } });
const ok = () => Response.json({ ok: true });

test("healthy only when health reports ok and the board answers", async () => {
  expect((await forgePoll("http://f", "t", answers(ok(), html(200, "<p>hi</p>")))()).healthy).toBe(true);
  expect((await forgePoll("http://f", "t", answers(ok(), html(503, "<p>stuck</p>")))()).healthy).toBe(false);
  expect((await forgePoll("http://f", "t", answers(Response.json({ ok: false }), html(200, "hi")))()).healthy).toBe(false);
  expect((await forgePoll("http://f", "t", answers(new Response("ok", { status: 200 }), html(200, "hi")))()).healthy).toBe(false);
});

test("what each page said is kept under its own source", async () => {
  const look = await forgePoll("http://f", "t", answers(
    Response.json({ ok: false, note: "Disk is nearly full" }, { status: 503 }),
    html(503, "<p>The runner is stuck</p>"),
  ))();
  expect(look.said).toEqual({ health: ["Disk is nearly full"], board: ["The runner is stuck"] });
});

test("a page that cannot be reached says 'unreachable'", async () => {
  const look = await forgePoll("http://f", "t", answers(new Error("refused"), html(200, "hi")))();
  expect(look).toEqual({ healthy: false, said: { health: ["unreachable"], board: ["hi"] } });
});

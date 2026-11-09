/**
 * A response's Server-Timing without the loop's `lag` token (#10288): the
 * phases the request itself named, for a test that lists them in order.
 * `lag` is the worst event-loop lag of the last 10 s, not this request's.
 */
export function requestTiming(res: { headers: Headers }): string {
  return (res.headers.get("server-timing") ?? "")
    .split(", ")
    .filter((p) => !p.startsWith("lag;"))
    .join(", ");
}

/**
 * The line a heavy test's helper printed as its result: the last line of its
 * stdout that is a JSON object. The helper prints its result before it stops
 * its cell children, and their shutdown lines ("forge draining", "forge
 * shutting down") reach stdout after it, so the last line is not the result
 * (#10541).
 */
export function resultLine(out: string): string {
  const lines = out.trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = (lines[i] ?? "").trim();
    if (!line.startsWith("{")) continue;
    try {
      const v: unknown = JSON.parse(line);
      if (v !== null && typeof v === "object" && !Array.isArray(v)) return line;
    } catch {
      // a log line that happens to open with a brace
    }
  }
  return "";
}

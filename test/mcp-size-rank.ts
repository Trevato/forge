/** Ranks `tools/list` entries by what the whole entry costs on the wire. */
export function costliestTools(tools: { name: string }[], n = 5): string {
  return tools
    .map((t) => ({ name: t.name, bytes: Buffer.byteLength(JSON.stringify(t)) }))
    .sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name))
    .slice(0, n)
    .map((t) => `${t.name} (${t.bytes} bytes)`)
    .join(", ");
}

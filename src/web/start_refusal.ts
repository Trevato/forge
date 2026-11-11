/**
 * Why the door refused "Start my forge" on the home page (#11238), in one
 * plain sentence each. The door's own message speaks to the API (codes,
 * counts, timestamps); the home page shows only these fixed sentences, so a
 * refusal never leaks a raw value and nothing the visitor typed is echoed
 * except the name, escaped, back in its field.
 */

export type StartRefusal = "rate" | "taken" | "name" | "full" | "other";

export const START_REFUSALS: Readonly<Record<StartRefusal, string>> = {
  rate: "Too many forges have been started from your connection lately. Wait a few minutes, or try again tomorrow, and press Start my forge again.",
  taken: "That name is already taken. Change it a little, for example add your own name or a number, and press Start my forge again.",
  name: "That name can't be used. Use 1 to 39 lowercase letters, digits or dashes, not starting or ending with a dash, and press Start my forge again.",
  full: "This forge has no room for another forge right now. Try again later, or come back tomorrow.",
  other: "We couldn't start your forge this time. Press Start my forge to try again, or come back in a few minutes.",
};

/** The refusal kind a door answer names, by its status and error code. */
export function startRefusalOf(door: { readonly status: number; readonly body: Record<string, unknown> }): StartRefusal {
  const error = door.body["error"];
  const message = String(door.body["message"] ?? "");
  if (door.status === 429 || error === "rate_limited") return "rate";
  if (error === "exists" || (error === "refused" && /already exists|being made/.test(message))) return "taken";
  if (error === "invalid" && /^name: /.test(message)) return "name";
  if (error === "refused" && /forges sent|room|quota|deep|capacity|limit/i.test(message)) return "full";
  return "other";
}

/** `?start=<kind>` back to a kind, or undefined for anything else. */
export function startRefusalIn(value: string | null): StartRefusal | undefined {
  return value !== null && Object.hasOwn(START_REFUSALS, value) ? (value as StartRefusal) : undefined;
}

/** Where the home page is told of a refusal: the kind and the name, kept. */
export function startRefusalHref(kind: StartRefusal, name: string): string {
  return `/?start=${kind}&name=${encodeURIComponent(name.slice(0, 39))}#start-forge`;
}

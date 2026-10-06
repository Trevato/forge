/**
 * Is the crew held off here. A preview is a throwaway copy of production's
 * data; an agent run there is real spend and a real push to a copy nobody
 * watches. The platform says which environment this is in `FORGE_APP_ENV`
 * (never the hostname); only the word `preview` holds the crew off, and
 * `FORGE_CREW_IN_PREVIEW=1` turns it back on for a preview of a crew change.
 */

export const CREW_OFF_IN_PREVIEW = "the crew is off in a preview";

export function crewOffInPreview(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return (
    (env.FORGE_APP_ENV ?? "").trim().toLowerCase() === "preview" &&
    (env.FORGE_CREW_IN_PREVIEW ?? "").trim() !== "1"
  );
}

/** The one sentence for what the forge is: manifest, meta and og:description, front page. */
export const SITE_LINE = "Your software and the crew that builds it, in one place.";

/** The one button a person presses to get a forge; every page that offers one uses this name. */
export const START_BUTTON = "Start my forge";

/** The one path from a link to an app, in one line; no other path is described anywhere. */
export const SITE_PATH = (origin: string): string =>
  `Open ${origin}. Type a name and press ${START_BUTTON}. Pick a username and create your passkey. Type what you want built. Your app is live a minute later.`;

/** What this is, in one sentence, with the full name. */
export const SITE_WHAT = "Open Platform Forge gives you a forge of your own where an AI crew builds your apps.";

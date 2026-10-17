import type { App } from "../../src/app.ts";
import { SignupSlot } from "../../src/actions/signup-window.ts";

let fixtures = 0;

/**
 * A place in `app`'s sign-up window for a fixture's `signUp`, as a door
 * takes one. Each comes from a source of its own, so a suite's set-up does
 * not spend the count a test about the window is reading.
 */
export function fixtureSlot(app: App): SignupSlot {
  const slot = SignupSlot.take(app, `fixture-${++fixtures}`);
  if (typeof slot === "number") throw new Error(`the sign-up window is spent for ${slot}s`);
  return slot;
}

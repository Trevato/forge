/**
 * What a sign-in flow says when its return cannot be finished: the state
 * did not come back to the browser that began, or the login it names is
 * gone (spent, or past its time). The parent sign-in (`http/rp.ts`) and the
 * sign-in an app's scaffold writes (`templates/app-template.json`) say the same thing,
 * so it is said here once.
 */
export const SIGNIN_NOT_THIS_BROWSER = "This sign-in did not start in this browser.";
export const SIGNIN_EXPIRED = "This sign-in took too long or was already used.";

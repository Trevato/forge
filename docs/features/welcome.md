# The account screen of a forge you just started

Where a person who started a forge from the home arrives, and how their first ask is sent (#11510).

## `/welcome`

The page that made the forge ([forge-made](forge-made.md)) sends the person to `/welcome` on their new forge, with the one-time code in the address fragment, which a server never sees. The screen says "Make your account": a username and one button, **Create your passkey**. A passkey is the device's fingerprint, face or PIN, with nothing to remember; the browser offers this device or, by its own QR code, a phone (no `authenticatorAttachment` is asked for, a resident key is preferred, user verification is required). The person is the admin of that forge and signed in. The words say nothing of a sender, a founder or a claim; the screen is `welcomePage` and `welcomeSubmit` in `src/web/pages/claim.ts`, sharing the form, the code check and the one-link-once rules with `/claim`, which stays for a link someone else sent.

There is one way in, never a choice between two. A browser that cannot make a passkey, or runs no script, is shown a password field instead ("This browser cannot create a passkey, so choose a password."). A passkey that could not be made on this device (cancelled, or no authenticator) brings the password out under the button. The page never says whether passkeys are on or off.

No email is asked for on a forge that sends no mail (`mailConfigured`, `src/actions/verify.ts`), and an address posted anyway is not read. On a forge that does send mail the field is there and optional. Either way the link is the proof: the account is made verified, so nothing later waits on a verification mail. Recovery without mail is a second passkey: while the owner signs in with exactly one passkey and no password, the first screens say so in one line with the way to add another (`secondPasskeyLine`, `src/web/pages/next-steps.ts`). The everyday account's form drops its email field on such a forge too.

The "Link code" field is filled and hidden by a few lines of script when the address carries the code; without JavaScript it stays visible, with a hint, so the screen still works.

An unknown, used or already-owned link says so in the same plain words as `/claim` and points back to the home.

## The first ask

On a new forge's first screen the box under "What do you want built?" sends on Enter; Shift+Enter makes a newline, and so does Enter while composing text or with a modifier held (`firstAskJs`, `src/web/pages/next-steps.ts`). Without JavaScript Enter makes a newline and the **Tell the crew** button sends. No hint is printed about the key, since it would be false without the script. The line under the box says what pays for the crew and names no second next step: the box is the one thing to do.

## The terminal

The terminal does not reach `/welcome`: it is the screen where the first account is made, and the terminal needs an account to sign in. Once there is one, the first ask is the terminal's own first screen (`crewFirstText`).

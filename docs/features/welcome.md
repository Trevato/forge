# The account screen of a forge you just started

Where a person who started a forge from the home arrives, and how their first ask is sent (#11510).

## `/welcome`

The waiting page (`/forges/<name>/waiting`) sends the person to `/welcome` on their new forge, with the one-time code in the address fragment, which a server never sees. The screen says "Make your account": a username and a password, then **Done**. The person is the admin of that forge and signed in. The words say nothing of a sender, a founder or a claim; the screen is `welcomePage` and `welcomeSubmit` in `src/web/pages/claim.ts`, sharing the code check and the one-link-once rules with `/claim`, which stays for a link someone else sent.

The "Link code" field is filled and hidden by a few lines of script when the address carries the code; without JavaScript it stays visible, with a hint, so the screen still works.

Password only is deliberate: the person is minutes into a forge and has been asked for nothing else; a passkey is offered afterwards, on the first-login next steps (the everyday step). `/claim` keeps its "Use a passkey instead" button because there the new owner may be taking over from the sender.

An unknown, used or already-owned link says so in the same plain words as `/claim` and points back to the home.

## The first ask

On a new forge's first screen the box under "What do you want built?" sends on Enter; Shift+Enter makes a newline, and so does Enter while composing text or with a modifier held (`firstAskJs`, `src/web/pages/next-steps.ts`). Without JavaScript Enter makes a newline and the **Tell the crew** button sends. No hint is printed about the key, since it would be false without the script.

## The terminal

The terminal does not reach `/welcome`: it is the screen where the first account is made, and the terminal needs an account to sign in. Once there is one, the first ask is the terminal's own first screen (`crewFirstText`).

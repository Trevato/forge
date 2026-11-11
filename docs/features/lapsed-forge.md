# A forge whose billing is none

When a forge's subscription ends and the grace days pass, its billing reads `none` (see [billing](billing.md)). The forge then sleeps: its apps stop answering and are not woken, whoever asks, until it is paid.

## What a visitor sees

Its address answers 402 with one page: a sentence on what happened, a **Pay again** button, and a line that says until when the data is kept and how to ask for an export. A client that does not ask for HTML gets the same sentences as plain text. The button posts to `/pay-again` on that address, same origin only; it makes a checkout for the last paid plan and sends the payer to it. Each address may press it five times a minute, and sixty together; past that the answer is 429 with `Retry-After`.

These sentences are public: anyone who opens the address reads that the subscription ended and the keep-until date.

## Paying

The provider's webhook records the payment as for any subscription; the next request to the address wakes the forge as it was. Nothing on this page marks a forge paid.

## In the terminal

Palette entry **Lapsed forges** (forge admins who are people): each sleeping forge with the same sentences; `p` starts the checkout and prints the address to hand to the payer. `j`/`k` move, `esc` goes back.

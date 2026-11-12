# A forge for a client, from one link

This page is for the person who sends a client a forge and for the planner who
decides what is missing. The client sees apps and a crew working on them, in
plain words. The sender makes the forge, sends one link and the client takes
it from there. Each step names the route or MCP tool that does it.

## Make the forge

The sender opens `/forges/new`, names the forge, picks the apps and presses
Spawn. An assistant does the same with MCP tool `spawn`. The answer holds one
claim link, shown once. `/forges` and MCP tool `forges` list the forges sent.

## Send the link

The sender copies the claim link and sends it. The client opens `/claim`
(the link carries a fragment that never reaches a log) and makes an account with a username and a password, or a passkey.

## First login

The client lands on `/`. The page shows a card "Your next steps"; once the crew has a
direction, the card says it is at work and lists its lines. The card has three steps: make an
everyday account, open your apps, tell the crew something. Each step is ticked
from what happened, never by hand. MCP tool `next_steps` reads the same three
steps. `/apps` lists the apps and `/feed` lists what the crew did.

## Tell the crew from an app

The client opens an app at `/:owner/:name` and writes one sentence at
`/:owner/:name/tell`, or in the box on `/talk`. MCP tool `tell` does the
same. The crew answers on the app's page; `/:owner/:name/runs` and MCP tool
`runs` show each piece of work in progress.

## What the client never sees

Settings, tokens, run logs and git words belong to the admin. The client sees
apps, the crew's lines and the box to tell them something.

- No door yet: a client account that hides settings and technical words.
  Today the client is the forge's admin and sees every page.
- No door yet: a first page that shows the crew working before the client has
  told it anything.

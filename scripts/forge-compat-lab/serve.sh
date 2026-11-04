#!/bin/sh
# The server of one lab forge, restartable: `kill` its pid and it is down.
cd /app
echo $$ > /tmp/pid
exec bun src/main.ts >>/tmp/forge.log 2>&1

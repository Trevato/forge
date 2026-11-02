### 6f. Realtime

Dashboard, issue and pull lists, the repo home, and the issue and pull screens
all subscribe to the outbox for as long as they are on the stack, through one
helper (`live()` in `screens/common.ts`). Popping the screen unsubscribes it —
there is no lifecycle to get wrong. A burst is coalesced into one refresh.

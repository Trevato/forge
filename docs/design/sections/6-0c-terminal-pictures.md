### 6·0c. Pictures in the terminal

A tab whose path looks like an image and whose bytes git returned as binary is
a **picture tab**. Where the terminal can show pixels it does
(§`term/graphics.ts`: kitty for Ghostty/kitty/WezTerm, sixel where detected,
iTerm2 by setting); where it cannot, a placeholder card names the format, the
geometry and the size, and says plainly what would show it.

The loop owns the lifecycle. A screen calls `ctx.placeImage(placement)` during
render and the bytes go out **after** the frame, raw; not calling it removes
whatever the last frame placed. That one rule makes a tab switch, a close, a
`pop`, a resize and a theme change all clean up by themselves, with no screen
having to remember to. A placement is re-sent only when it is genuinely new —
a different image, a different rectangle, or a repaint that invalidated
everything — because `drawImage` reserves its cells with the theme ground and
an ordinary frame emits nothing over them. Re-sending a megabyte of base64 on
every keystroke is the one thing that would make pictures unusable over SSH.

Aspect ratio comes from the client's own `pty-req` / `window-change` pixel
fields when it sends them (most send zeros), and from the 1:2 guess otherwise.

`v` toggles a picture between the pixels and the facts about the file.

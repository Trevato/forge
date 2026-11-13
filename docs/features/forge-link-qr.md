# A forge's claim link as a QR in the terminal

After you make a forge in the terminal (Start my forge, New forge, or Forge it), the claim link is shown once in a dialog. When the terminal has room, a QR code of exactly that link is drawn between the link and the help text, so a phone can take it from the screen with no typing.

- The QR is dark on light whatever the theme, with a two-module quiet zone.
- It needs the whole code to fit. A narrow or short terminal shows the link alone, as before.
- The code is built from the link on screen, held in memory only, and never logged or written to disk. A resize redraws it; the link is not printed again.
- Other links the terminal shows (opening a page on the web) have no QR.

/**
 * The house cover, drawn in the browser: the page's picture inset in a
 * black frame, the cart's name in orange top left, its number big top
 * right, and the handle and green cube taken from the template cover
 * (`cover-template.png`). The same drawing as browser-arcade's
 * `scripts/cover.ts`, so a cart nobody gave a cover still looks like one.
 *
 * A string of browser code, spliced into the panel's and the Arcade's
 * scripts. `drawCover(canvas, art, template, name, version)` draws on a
 * 512×512 canvas; `coverTitle` splits a name and version into its lines.
 */
export const COVER_JS = `
  function coverTitle(name, version) {
    var parts = String(name).split('-');
    var lines = parts.length < 2 ? [String(name)] : [parts.slice(0, -1).join('-'), parts[parts.length - 1]];
    var v = String(version || '');
    var tail = /(\\d+(?:\\.\\d+)?)$/.exec(v);
    var number = v.length <= 4 ? v : tail ? tail[1] : '';
    return { lines: lines, number: number };
  }
  function drawCover(c, art, tpl, name, version) {
    c.width = c.height = 512;
    var x = c.getContext('2d');
    x.fillStyle = '#000'; x.fillRect(0, 0, 512, 512);
    if (art) {
      var s = Math.min(art.naturalWidth, art.naturalHeight);
      x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high';
      x.drawImage(art, (art.naturalWidth - s) / 2, (art.naturalHeight - s) / 2, s, s, 60, 60, 396, 396);
    }
    var t = coverTitle(name, version);
    var font = '"Ubuntu", "Arial Black", "Helvetica Neue", sans-serif';
    x.font = '700 44px ' + font; x.textBaseline = 'alphabetic'; x.lineJoin = 'round';
    t.lines.forEach(function (line, k) {
      var y = 104 + k * 46;
      x.lineWidth = 6; x.strokeStyle = 'rgba(0,0,0,.65)'; x.strokeText(line, 66, y);
      x.fillStyle = '#ffa300'; x.fillText(line, 66, y);
    });
    if (t.number) {
      x.font = '700 76px ' + font; x.textAlign = 'right';
      x.lineWidth = 8; x.strokeStyle = 'rgba(0,0,0,.65)'; x.strokeText(t.number, 446, 128);
      x.fillStyle = '#ffa300'; x.fillText(t.number, 446, 128);
      x.textAlign = 'left';
    }
    if (!tpl) return;
    x.drawImage(tpl, 200, 466, 220, 34, 200, 466, 220, 34);
    var L = document.createElement('canvas'); L.width = L.height = 112;
    var lx = L.getContext('2d');
    lx.drawImage(tpl, 400, 400, 112, 112, 0, 0, 112, 112);
    var d = lx.getImageData(0, 0, 112, 112);
    for (var i = 0; i < d.data.length; i += 4) {
      var r = d.data[i], g = d.data[i + 1], b = d.data[i + 2];
      if (!(g > 40 && g > r * 1.15 && g > b * 1.2)) d.data[i + 3] = 0;
    }
    lx.putImageData(d, 0, 0);
    x.save();
    x.filter = 'drop-shadow(2px 0 0 #000) drop-shadow(-2px 0 0 #000) drop-shadow(0 2px 0 #000) drop-shadow(0 -2px 0 #000)';
    x.drawImage(L, 400, 400); x.restore();
  }
  function loadImage(src) {
    return new Promise(function (done) {
      if (!src) return done(null);
      var i = new Image();
      i.onload = function () { done(i); };
      i.onerror = function () { done(null); };
      i.src = src;
    });
  }
`;

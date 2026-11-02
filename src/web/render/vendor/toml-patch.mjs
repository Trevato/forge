// @decimalturn/toml-patch 3.3.2 (MIT), bundled from its dist; licence in TOML-PATCH-LICENSE
// node_modules/@decimalturn/toml-patch/dist/toml-patch.js
//! @decimalturn/toml-patch v3.3.2 - https://github.com/DecimalTurn/toml-patch - @license: MIT
function e(e2) {
  return e2.type === `Document`;
}
function t(e2) {
  return e2.type === `Table`;
}
function n(e2) {
  return e2.type === `TableKey`;
}
function r(e2) {
  return e2.type === `TableArray`;
}
function i(e2) {
  return e2.type === `TableArrayKey`;
}
function a(e2) {
  return e2.type === `KeyValue`;
}
function o(e2) {
  return e2.type === `String`;
}
function s(e2) {
  return e2.type === `Integer`;
}
function c(e2) {
  return e2.type === `Float`;
}
function l(e2) {
  return e2.type === `DateTime`;
}
function u(e2) {
  return e2.type === `InlineArray`;
}
function d(e2) {
  return e2.type === `InlineItem`;
}
function f(e2) {
  return e2.type === `InlineTable`;
}
function p(e2) {
  return e2.type === `Comment`;
}
function m(n2) {
  return e(n2) || t(n2) || r(n2) || f(n2) || u(n2);
}
function h(e2) {
  return n(e2) || i(e2) || d(e2);
}
function g(e2) {
  return a(e2) || t(e2) || r(e2) || p(e2);
}
var _;
var v;
function y(e2) {
  if (_ === e2 && v !== undefined)
    return v;
  let t2 = w(e2);
  return _ = e2, v = t2, t2;
}
function b() {
  _ = undefined, v = undefined;
}
function x(e2) {
  return { lines: e2.end.line - e2.start.line + 1, columns: e2.end.column - e2.start.column };
}
function S(e2, t2) {
  let n2 = Array.isArray(e2) ? e2 : w(e2);
  if (n2.length === 0)
    return { line: 1, column: t2 };
  let r2 = 0, i2 = n2.length - 1;
  for (;r2 < i2; ) {
    let e3 = r2 + i2 >>> 1;
    n2[e3] < t2 ? r2 = e3 + 1 : i2 = e3;
  }
  n2[r2] < t2 && r2++;
  let a2 = r2 + 1;
  return { line: a2, column: t2 - (n2[a2 - 2] + 1 || 0) };
}
function C(e2, t2) {
  let n2 = y(e2), r2 = n2[t2.line - 2] === undefined ? 0 : n2[t2.line - 2] + 1, i2 = n2[t2.line - 1] || e2.length;
  return e2.substring(r2, i2);
}
function w(e2) {
  let t2 = [];
  for (let n2 = 0;n2 < e2.length; n2++) {
    let r2 = e2.charCodeAt(n2);
    r2 === 10 ? t2.push(n2) : r2 === 13 && (e2.charCodeAt(n2 + 1) === 10 ? (t2.push(n2 + 1), n2++) : t2.push(n2));
  }
  return t2.push(e2.length), t2;
}
function T(e2) {
  return { line: e2.line, column: e2.column };
}
function E(e2) {
  return { start: T(e2.start), end: T(e2.end) };
}
function D() {
  return { line: 1, column: 0 };
}
var O = class extends Error {
  line;
  column;
  constructor(e2, t2, n2) {
    let r2 = `Error parsing TOML (${t2.line}, ${t2.column + 1}):
`;
    if (e2) {
      let n3 = C(e2, t2), i2 = `${k(t2.column)}^`;
      n3 && (r2 += `${n3}
${i2}
`);
    }
    r2 += n2, super(r2), this.line = t2.line, this.column = t2.column;
  }
};
function k(e2, t2 = ` `) {
  return t2.repeat(e2);
}
var A = /^[\w-]+$/;
var j = /[\w,\d,",',+,\-,_]/;
function ee() {
  return { reference: null, mixed: false };
}
function* te(e2, t2) {
  let n2 = e2.length, r2 = 0, i2 = t2 ?? ee(), a2 = [], o2 = (e3, t3) => ({ start: S(a2, e3), end: S(a2, t3) });
  for (;r2 < n2; ) {
    let t3 = e2.charCodeAt(r2);
    if ((t3 <= 31 || t3 === 127) && t3 !== 9 && t3 !== 13 && t3 !== 10)
      throw new O(e2, S(a2, r2), `Control char 0x${t3.toString(16).toUpperCase().padStart(2, `0`)} not allowed`);
    if (t3 === 13 && (r2 + 1 >= n2 || e2.charCodeAt(r2 + 1) !== 10))
      throw new O(e2, S(a2, r2), `Standalone CR; must be CRLF or LF`);
    if (t3 !== 32 && t3 !== 9 && t3 !== 13) {
      if (t3 === 10)
        s2(r2);
      else if (t3 === 91 || t3 === 93)
        yield { type: `Bracket`, raw: e2[r2], loc: o2(r2, r2 + 1) };
      else if (t3 === 123 || t3 === 125)
        yield { type: `Curly`, raw: e2[r2], loc: o2(r2, r2 + 1) };
      else if (t3 === 61)
        yield { type: `Equal`, raw: `=`, loc: o2(r2, r2 + 1) };
      else if (t3 === 44)
        yield { type: `Comma`, raw: `,`, loc: o2(r2, r2 + 1) };
      else if (t3 === 46)
        yield { type: `Dot`, raw: `.`, loc: o2(r2, r2 + 1) };
      else if (t3 === 35)
        yield c2();
      else {
        let t4 = ne(e2, r2, `'`) || ne(e2, r2, `"`);
        t4 ? yield l2(t4) : yield u2();
      }
    }
    r2++;
  }
  function s2(t3) {
    a2.push(t3);
    let n3 = t3 > 0 && e2.charCodeAt(t3 - 1) === 13 ? `\r
` : `
`;
    i2.reference === null ? i2.reference = n3 : i2.reference !== n3 && (i2.mixed = true);
  }
  function c2() {
    let t3 = r2;
    for (;r2 + 1 < n2; ) {
      let t4 = e2.charCodeAt(r2 + 1);
      if (t4 === 10 || t4 === 13)
        break;
      r2++;
      let n3 = e2.charCodeAt(r2);
      if ((n3 <= 31 || n3 === 127) && n3 !== 9)
        throw new O(e2, S(a2, r2), `Control char 0x${n3.toString(16).toUpperCase().padStart(2, `0`)} not allowed`);
    }
    return { type: `Comment`, raw: e2.slice(t3, r2 + 1), loc: o2(t3, r2 + 1) };
  }
  function l2(t3) {
    let i3 = r2, c3 = t3 + t3 + t3;
    for (r2 += 3;r2 < n2; ) {
      if (ne(e2, r2, t3)) {
        let n3 = 3;
        for (;e2[r2 + n3] === t3; )
          n3++;
        if (n3 >= 6)
          throw new O(e2, S(a2, r2), `Invalid multiline string: ${n3} consecutive ${t3} characters`);
        if (n3 === 3) {
          r2 += 2;
          break;
        }
        r2 += n3 - 3, r2 += 2;
        break;
      }
      let i4 = e2.charCodeAt(r2);
      if (i4 === 13 && (r2 + 1 >= n2 || e2.charCodeAt(r2 + 1) !== 10))
        throw new O(e2, S(a2, r2), `Standalone CR in multiline string; must be CRLF or LF`);
      if ((i4 <= 31 || i4 === 127) && i4 !== 9 && i4 !== 10 && i4 !== 13) {
        let n3 = t3 === `"` ? `multiline basic strings` : `multiline literal strings`, o3 = `0x${i4.toString(16).toUpperCase().padStart(2, `0`)}`, s3 = ``;
        i4 === 0 ? s3 = `Null` : i4 === 127 && (s3 = `DEL`);
        let c4 = s3 ? `${s3} (${o3}) not allowed in ${n3}` : `Control char ${o3} not allowed in ${n3}`;
        throw new O(e2, S(a2, r2), c4);
      }
      i4 === 10 && s2(r2), r2++;
    }
    if (r2 >= n2) {
      if (t3 === `"`) {
        let t4 = 0, i4 = n2 - 1;
        for (;i4 >= 0 && e2[i4] === `\\`; )
          t4++, i4--;
        if (t4 > 0 && t4 % 2 != 0)
          throw new O(e2, S(a2, r2), `Unterminated multiline ${c3} (possible escape issue)`);
      }
      throw new O(e2, S(a2, r2), `Unterminated multiline ${c3}`);
    }
    return { type: `Literal`, raw: e2.slice(i3, r2 + 1), loc: o2(i3, r2 + 1) };
  }
  function u2() {
    let t3 = e2[r2];
    if (!j.test(t3))
      throw new O(e2, S(a2, r2), `Unexpected char "${t3}"`);
    let i3 = r2, s3 = t3 === `"`, c3 = t3 === `'`;
    for (;r2 < n2 && !(r2 + 1 >= n2); ) {
      let t4 = e2.charCodeAt(r2 + 1);
      if (!(s3 || c3) && (t4 === 32 || t4 === 9 || t4 === 10 || t4 === 13 || t4 === 44 || t4 === 46 || t4 === 93 || t4 === 125 || t4 === 61 || t4 === 35))
        break;
      if (r2++, !(s3 || c3)) {
        let t5 = e2.charCodeAt(r2);
        if (t5 <= 31 || t5 === 127)
          throw new O(e2, S(a2, r2), `Control char 0x${t5.toString(16).toUpperCase().padStart(2, `0`)} not allowed in unquoted value`);
      }
      if (s3 || c3) {
        let t5 = e2.charCodeAt(r2);
        if ((t5 <= 31 || t5 === 127) && t5 !== 9) {
          let n3 = s3 ? `basic strings` : `literal strings`, i5 = `0x${t5.toString(16).toUpperCase().padStart(2, `0`)}`, o3 = ``;
          t5 === 10 ? o3 = `Newline` : t5 === 13 ? o3 = `Carriage return` : t5 === 0 ? o3 = `Null` : t5 === 127 && (o3 = `DEL`);
          let c4 = o3 ? `${o3} (${i5}) not allowed in ${n3}` : `Control char ${i5} not allowed in ${n3}`;
          throw new O(e2, S(a2, r2), c4);
        }
      }
      let i4 = e2[r2];
      if (i4 === `"` && !c3 && (s3 = !s3), i4 === `'` && !s3 && (c3 = !c3), r2 + 1 >= n2)
        break;
      if (s3 && i4 === `\\`) {
        let t5 = e2[r2 + 1];
        (t5 === `"` || t5 === `\\`) && r2++;
      }
    }
    if (s3 || c3)
      throw new O(e2, S(a2, i3), `Expected close of string with ${s3 ? `"` : `'`}`);
    return { type: `Literal`, raw: e2.slice(i3, r2 + 1), loc: o2(i3, r2 + 1) };
  }
}
function ne(e2, t2, n2) {
  if (!n2 || e2[t2] !== n2 || e2[t2 + 1] !== n2 || e2[t2 + 2] !== n2)
    return false;
  if (n2 === `'`)
    return n2;
  let r2 = 0, i2 = t2 - 1;
  for (;i2 >= 0 && e2[i2] === `\\`; )
    r2++, i2--;
  return (r2 === 0 || r2 % 2 == 0) && n2;
}
var M = /* @__PURE__ */ new Int8Array(128);
M.fill(-1);
for (let e2 = 0;e2 < 10; e2++)
  M[48 + e2] = e2;
for (let e2 = 0;e2 < 6; e2++)
  M[65 + e2] = 10 + e2, M[97 + e2] = 10 + e2;
function re(e2) {
  let t2 = e2.charCodeAt(0);
  return t2 < 128 && M[t2] !== -1;
}
function ie(e2, t2) {
  return M[e2.charCodeAt(t2)] << 12 | M[e2.charCodeAt(t2 + 1)] << 8 | M[e2.charCodeAt(t2 + 2)] << 4 | M[e2.charCodeAt(t2 + 3)];
}
function ae(e2) {
  return e2.startsWith(`'''`) ? se(e2.slice(3, e2.length - 3)) : e2.startsWith(`'`) ? e2.slice(1, e2.length - 1) : e2.startsWith(`"""`) ? oe(se(e2.slice(3, e2.length - 3)), true) : e2.startsWith(`"`) ? oe(e2.slice(1, e2.length - 1), false) : e2;
}
function oe(e2, t2) {
  let n2 = e2.length;
  if (!t2 && e2.indexOf(`\\`) === -1)
    return e2;
  let r2 = [], i2 = 0;
  for (let a2 = 0;a2 < n2; a2++) {
    if (e2[a2] !== `\\`)
      continue;
    if (a2 > i2 && r2.push(e2.slice(i2, a2)), a2++, a2 >= n2)
      throw Error(`Trailing backslash`);
    let o2 = e2[a2];
    switch (o2) {
      case `b`:
        r2.push(`\b`);
        break;
      case `t`:
        r2.push(`	`);
        break;
      case `n`:
        r2.push(`
`);
        break;
      case `f`:
        r2.push(`\f`);
        break;
      case `r`:
        r2.push(`\r`);
        break;
      case `"`:
        r2.push(`"`);
        break;
      case `\\`:
        r2.push(`\\`);
        break;
      case `e`:
        r2.push(`\x1B`);
        break;
      case `u`: {
        if (a2 + 4 > n2 || !re(e2[a2 + 1]) || !re(e2[a2 + 2]) || !re(e2[a2 + 3]) || !re(e2[a2 + 4]))
          throw Error(`Invalid Unicode escape: \\u${e2.slice(a2 + 1, a2 + 5)}`);
        let t3 = ie(e2, a2 + 1);
        if (t3 >= 55296 && t3 <= 57343)
          throw Error(`Invalid \\u${e2.slice(a2 + 1, a2 + 5)}: surrogates not allowed`);
        r2.push(String.fromCharCode(t3)), a2 += 4;
        break;
      }
      case `U`: {
        if (a2 + 8 > n2)
          throw Error(`Invalid Unicode escape: \\U${e2.slice(a2 + 1, a2 + 9)}`);
        for (let t4 = 1;t4 <= 8; t4++)
          if (!re(e2[a2 + t4]))
            throw Error(`Invalid Unicode escape: \\U${e2.slice(a2 + 1, a2 + 9)}`);
        let t3 = parseInt(e2.slice(a2 + 1, a2 + 9), 16);
        if (t3 >= 55296 && t3 <= 57343)
          throw Error(`Invalid \\U${e2.slice(a2 + 1, a2 + 9)}: surrogates not allowed`);
        r2.push(String.fromCodePoint(t3)), a2 += 8;
        break;
      }
      case `x`: {
        if (a2 + 2 > n2 || !re(e2[a2 + 1]) || !re(e2[a2 + 2]))
          throw Error(`Invalid hex escape: \\x${e2.slice(a2 + 1, a2 + 3)}`);
        let t3 = M[e2.charCodeAt(a2 + 1)] << 4 | M[e2.charCodeAt(a2 + 2)];
        r2.push(String.fromCharCode(t3)), a2 += 2;
        break;
      }
      default:
        if (t2 && (o2 === `
` || o2 === `\r` || o2 === ` ` || o2 === `	`)) {
          let t3 = o2 === `
` || o2 === `\r`, r3 = a2;
          for (;r3 < n2 && (e2[r3] === ` ` || e2[r3] === `	` || e2[r3] === `
` || e2[r3] === `\r`); )
            (e2[r3] === `
` || e2[r3] === `\r`) && (t3 = true), r3++;
          if (!t3)
            throw Error(`Invalid escape sequence: \\${o2}`);
          a2 = r3 - 1;
          break;
        }
        throw Error(`Invalid escape sequence: \\${o2}`);
    }
    i2 = a2 + 1;
  }
  return i2 === 0 ? e2 : (i2 < n2 && r2.push(e2.slice(i2)), r2.join(``));
}
function se(e2) {
  return e2.charCodeAt(0) === 10 ? e2.slice(1) : e2.charCodeAt(0) === 13 && e2.charCodeAt(1) === 10 ? e2.slice(2) : e2;
}
var ce = class {
  iterator;
  index;
  value;
  done;
  peeked;
  constructor(e2) {
    this.iterator = e2, this.index = -1, this.value = undefined, this.done = false, this.peeked = null;
  }
  next() {
    if (this.done)
      return ue();
    let e2 = this.peeked || this.iterator.next();
    return this.index += 1, this.value = e2.value, this.done = e2.done ?? false, this.peeked = null, e2;
  }
  peek() {
    return this.done ? ue() : (this.peeked ||= this.iterator.next(), this.peeked);
  }
  [Symbol.iterator]() {
    return this;
  }
};
var le = Object.freeze({ value: undefined, done: true });
function ue() {
  return le;
}
var de = /* @__PURE__ */ new WeakMap;
function fe(e2, t2) {
  de.set(e2, t2);
}
function pe(e2) {
  return de.get(e2);
}
function me(e2) {
  return { year: String(e2.getUTCFullYear()).padStart(4, `0`), month: String(e2.getUTCMonth() + 1).padStart(2, `0`), day: String(e2.getUTCDate()).padStart(2, `0`), hours: String(e2.getUTCHours()).padStart(2, `0`), minutes: String(e2.getUTCMinutes()).padStart(2, `0`), seconds: String(e2.getUTCSeconds()).padStart(2, `0`), ms: e2.getUTCMilliseconds() };
}
function he(e2) {
  return e2 === 0 ? `` : String(e2).padStart(3, `0`).replace(/0+$/, ``);
}
var ge = /\.(\d+)\s*$/;
var _e = /\.(\d+)(?:[Zz]|[+-]\d{2}:\d{2})\s*$/;
function ve(e2, t2) {
  var n2;
  return ((n2 = e2.match(t2)) == null ? undefined : n2[1]) ?? ``;
}
function ye(e2, t2, n2) {
  let r2 = ve(t2, n2), i2 = r2.length > r2.replace(/0+$/, ``).length ? Math.max(r2.length, e2.length) : e2.length;
  return i2 === 0 ? `` : `.` + e2.padEnd(i2, `0`);
}
function be(e2) {
  let t2 = e2.toISOString().match(/\.(\d+)/);
  return t2 ? t2[1] : ``;
}
function xe(e2, t2, n2, r2 = ge) {
  let i2 = be(e2).replace(/0+$/, ``);
  return i2.length > he(t2).length ? ye(i2, n2, r2) : Se(t2, n2, r2);
}
function Se(e2, t2, n2 = ge) {
  let r2 = he(e2);
  if (t2 && t2.includes(`.`)) {
    let i2 = t2.match(n2);
    return i2 && i2[1].startsWith(String(e2).padStart(3, `0`)) ? `.` + i2[1] : ye(r2, t2, n2);
  }
  return r2 ? `.` + r2 : ``;
}
function Ce(e2) {
  if (e2 === `Z`)
    return 0;
  let t2 = e2[0] === `+` ? 1 : -1, [n2, r2] = e2.slice(1).split(`:`);
  return t2 * (parseInt(n2) * 60 + parseInt(r2));
}
function we(e2, t2) {
  return t2 <= 0 ? e2 : e2.replace(/(\d{2}:\d{2})(?::(\d{2}))?(?:\.(\d+))?/, (e3, n2, r2, i2) => {
    let a2 = i2 ?? ``;
    return a2.length >= t2 ? e3 : `${n2}:${r2 ?? `00`}.${a2.padEnd(t2, `0`)}`;
  });
}
var Te = class e2 {
  static IS_DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
  static IS_TIME_ONLY = /^\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?$/;
  static IS_LOCAL_DATETIME_T = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?$/;
  static IS_LOCAL_DATETIME_SPACE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?(?:\.\d+)?$/;
  static IS_OFFSET_DATETIME_T = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$/;
  static IS_OFFSET_DATETIME_SPACE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$/;
  static IS_FULL_DATE = /(\d{4})-(\d+)-(\d+)/;
  static IS_FULL_TIME = /(\d+):(\d+)(?::(\d+))?/;
  static createDateWithOriginalFormat(t2, n2) {
    if (e2.IS_DATE_ONLY.test(n2)) {
      if (t2.getUTCHours() !== 0 || t2.getUTCMinutes() !== 0 || t2.getUTCSeconds() !== 0 || t2.getUTCMilliseconds() !== 0) {
        if (t2 instanceof ke)
          return t2;
        let e4 = t2.toISOString().replace(`Z`, ``);
        return e4 = e4.replace(/\.000$/, ``), new Oe(e4, false);
      }
      let e3 = t2.toISOString().split(`T`)[0];
      return new Ee(e3);
    }
    if (e2.IS_TIME_ONLY.test(n2)) {
      let e3 = me(t2), r2 = xe(t2, e3.ms, n2);
      return new De(`${e3.hours}:${e3.minutes}:${e3.seconds}${r2}`);
    }
    if (e2.IS_LOCAL_DATETIME_T.test(n2)) {
      let e3 = me(t2), r2 = xe(t2, e3.ms, n2), i2 = `${e3.year}-${e3.month}-${e3.day}T${e3.hours}:${e3.minutes}:${e3.seconds}${r2}`;
      return new Oe(i2, false, i2);
    }
    if (e2.IS_LOCAL_DATETIME_SPACE.test(n2)) {
      let e3 = me(t2), r2 = xe(t2, e3.ms, n2), i2 = `${e3.year}-${e3.month}-${e3.day} ${e3.hours}:${e3.minutes}:${e3.seconds}${r2}`;
      return new Oe(i2, true, i2);
    }
    if (e2.IS_OFFSET_DATETIME_T.test(n2) || e2.IS_OFFSET_DATETIME_SPACE.test(n2)) {
      let r2 = n2.match(/([+-]\d{2}:\d{2}|[Zz])$/), i2 = r2 ? r2[1] === `z` ? `Z` : r2[1] : `Z`, a2 = e2.IS_OFFSET_DATETIME_SPACE.test(n2), o2 = me(new Date(t2.getTime() + Ce(i2) * 60000)), s2 = a2 ? ` ` : `T`, c2 = xe(t2, o2.ms, n2, _e);
      return new ke(`${o2.year}-${o2.month}-${o2.day}${s2}${o2.hours}:${o2.minutes}:${o2.seconds}${c2}${i2}`, a2);
    }
    return t2;
  }
};
var Ee = class extends Date {
  constructor(e3) {
    super(e3);
  }
  toISOString() {
    let e3 = me(this);
    return `${e3.year}-${e3.month}-${e3.day}`;
  }
};
var De = class extends Date {
  originalFormat;
  constructor(e3, t2 = e3) {
    let n2 = e3;
    /:\d{2}:\d{2}/.test(e3) || (n2 = e3 + `:00`), super(`0000-01-01T${n2}Z`), this.originalFormat = t2;
  }
  toISOString() {
    let e3 = me(this);
    return `${e3.hours}:${e3.minutes}:${e3.seconds}${Se(e3.ms, this.originalFormat)}`;
  }
};
var Oe = class extends Date {
  useSpaceSeparator = false;
  originalFormat;
  constructor(e3, t2 = false, n2) {
    let r2 = e3;
    /\d{2}:\d{2}:\d{2}/.test(e3) || (r2 = e3.replace(/(\d{2}:\d{2})([\s\-+TZ]|$)/, `$1:00$2`)), super(r2.replace(` `, `T`) + `Z`), this.useSpaceSeparator = t2, this.originalFormat = n2 || e3;
  }
  toISOString() {
    let e3 = me(this), t2 = this.useSpaceSeparator ? ` ` : `T`;
    return `${e3.year}-${e3.month}-${e3.day}${t2}${e3.hours}:${e3.minutes}:${e3.seconds}${Se(e3.ms, this.originalFormat)}`;
  }
};
var ke = class extends Date {
  useSpaceSeparator = false;
  originalOffset;
  originalFormat;
  constructor(e3, t2 = false) {
    let n2 = e3;
    /\d{2}:\d{2}:\d{2}/.test(e3) || (n2 = e3.replace(/(\d{2}:\d{2})([\s\-+TZ]|$)/, `$1:00$2`)), super(n2.replace(` `, `T`)), this.useSpaceSeparator = t2, this.originalFormat = e3;
    let r2 = e3.match(/([+-]\d{2}:\d{2}|[Zz])$/);
    r2 && (this.originalOffset = r2[1] === `z` ? `Z` : r2[1]);
  }
  toISOString() {
    if (this.originalOffset) {
      let e4 = me(new Date(this.getTime() + Ce(this.originalOffset) * 60000)), t2 = this.useSpaceSeparator ? ` ` : `T`, n2 = Se(e4.ms, this.originalFormat, _e);
      return `${e4.year}-${e4.month}-${e4.day}${t2}${e4.hours}:${e4.minutes}:${e4.seconds}${n2}${this.originalOffset}`;
    }
    let e3 = super.toISOString();
    return this.useSpaceSeparator ? e3.replace(`T`, ` `) : e3;
  }
};
var Ae = Te;
var je = `true`;
var Me = /e/i;
var Ne = /_/g;
var Pe = /^[+-]?inf$/;
var Fe = /^[+-]?nan$/;
var Ie = /^[+-]?0x/i;
function Le(e3) {
  return e3 >= 65 && e3 <= 90 || e3 >= 97 && e3 <= 122 || e3 >= 48 && e3 <= 57 || e3 === 95 || e3 === 45;
}
var Re = /^[+-]?0o/i;
var ze = /^[+-]?0b/i;
function Be(e3, t2, n2) {
  for (let r2 = 0;r2 < e3.length; r2++)
    if (!Le(e3.charCodeAt(r2)))
      throw new O(t2, { line: n2.line, column: n2.column + r2 }, `Invalid bare key char '${e3[r2]}'`);
}
function Ve(e3, t2, n2) {
  if (e3.startsWith(`"""`) || e3.startsWith(`'''`))
    throw new O(t2, n2, `Multiline strings cannot be keys`);
}
function He(e3, t2, n2) {
  try {
    return ae(e3);
  } catch (e4) {
    throw new O(t2, n2, e4.message);
  }
}
function Ue(e3, t2, n2, r2 = true) {
  if (e3.endsWith(`_`) || (r2 ? /^[+-]?_/.test(e3) : e3.startsWith(`_`)))
    throw new O(t2, n2, `Underscore must be between digits`);
  if (/__/.test(e3))
    throw new O(t2, n2, `Consecutive underscores not allowed`);
}
function We(e3, t2, n2, r2) {
  let i2 = e3.replace(Ne, ``);
  if (/^[+-]?0\d/.test(i2) && !Ie.test(e3) && !Re.test(e3) && !ze.test(e3))
    throw new O(t2, n2, `Leading zeros are not allowed in ${r2}`);
}
function Ge(e3, t2, n2, r2) {
  if (/_[eE]/.test(e3))
    throw new O(n2, r2, `Underscore before exponent is not allowed`);
  if (/[eE][+-]?_/.test(e3))
    throw new O(n2, r2, `Underscore at start of exponent is not allowed`);
  if (/[eE][+-]?$/.test(e3))
    throw new O(n2, r2, `Invalid float "${t2}": incomplete exponent`);
  if (/[eE][+-]?.*\./.test(e3))
    throw new O(n2, r2, `Invalid float "${t2}": decimal point not allowed in exponent`);
}
function Ke(e3, t2, n2, r2, i2, a2) {
  if (e3.length !== 2)
    throw new O(i2, a2, `"${r2}": hour must be 2 digits`);
  if (t2.length !== 2)
    throw new O(i2, a2, `"${r2}": minute must be 2 digits`);
  if (n2 && n2.length !== 2)
    throw new O(i2, a2, `"${r2}": second must be 2 digits`);
}
function qe(e3, t2, n2, r2, i2, a2) {
  if (e3 !== undefined) {
    let t3 = parseInt(e3, 10);
    if (t3 < 0 || t3 > 23)
      throw new O(i2, a2, `"${r2}": hour must be 00-23`);
  }
  if (t2 !== undefined) {
    let e4 = parseInt(t2, 10);
    if (e4 < 0 || e4 > 59)
      throw new O(i2, a2, `"${r2}": minute must be 00-59`);
  }
  if (n2 !== undefined) {
    let e4 = parseInt(n2, 10);
    if (e4 < 0 || e4 > 60)
      throw new O(i2, a2, `"${r2}": second must be 00-60`);
  }
}
function Je(e3, t2, n2) {
  if (Ie.test(e3) || Re.test(e3) || ze.test(e3))
    return;
  let r2 = e3.replace(/^[+-]/, ``).replace(/_/g, ``);
  if (!/^[0-9]+$/.test(r2))
    throw new O(t2, n2, `Invalid integer "${e3}"`);
}
function Ye(e3, t2, n2, r2, i2, a2, o2) {
  let s2 = r2[0] + r2[1].toUpperCase();
  if (RegExp(`^[+\\-]?` + s2.replace(/([[\]])/g, `\\$1`)).test(e3))
    throw new O(t2, n2, `${a2} prefix must be lowercase "${r2}"`);
  if (RegExp(`^[+\\-]?` + r2 + `_`, `i`).test(e3))
    throw new O(t2, n2, `Underscore must be between digits`);
  let c2 = RegExp(`^[+\\-]?` + r2, `i`), l2 = e3.replace(c2, ``);
  if (!l2 || l2 === `_` || l2.startsWith(`_`))
    throw new O(t2, n2, `Incomplete ${a2.toLowerCase()} number`);
  let u2 = l2.replace(/_/g, ``);
  if (!i2.test(u2))
    throw new O(t2, n2, o2 ?? `Invalid ${a2.toLowerCase()} digits`);
  if (/^[+-]/.test(e3))
    throw new O(t2, n2, `${a2} numbers cannot have a sign prefix`);
}
function* N(e3, t2) {
  let n2 = new ce(te(e3, t2));
  try {
    for (;!n2.next().done; ) {
      let t3 = ct(n2, e3);
      for (let e4 of t3)
        yield e4;
    }
  } finally {
    b();
  }
}
function* Xe(e3, t2, n2) {
  for (let t3 of e3)
    yield t3;
  let r2 = new ce(te(t2));
  try {
    for (;!r2.next().done; ) {
      let e4 = ct(r2, t2);
      for (let t3 of e4)
        n2 && Qe(t3, n2), yield t3;
    }
  } finally {
    b();
  }
}
function Ze(e3, t2) {
  return { line: e3.line + t2.line - 1, column: e3.line === 1 ? e3.column + t2.column : e3.column };
}
function Qe(e3, t2) {
  let n2 = [e3];
  for (;n2.length > 0; ) {
    let e4 = n2.pop();
    if (e4.loc.start = Ze(e4.loc.start, t2), e4.loc.end = Ze(e4.loc.end, t2), e4.type === `KeyValue`) {
      let t3 = e4;
      n2.push(t3.value, t3.key);
    } else if (e4.type === `TableKey` || e4.type === `TableArrayKey` || e4.type === `InlineItem`)
      n2.push(e4.item);
    else if (e4.type === `Table` || e4.type === `TableArray`) {
      let t3 = e4;
      n2.push(t3.key);
      for (let e5 = t3.items.length - 1;e5 >= 0; e5--)
        n2.push(t3.items[e5]);
    } else if (e4.type === `InlineTable` || e4.type === `InlineArray`) {
      let t3 = e4.items;
      for (let e5 = t3.length - 1;e5 >= 0; e5--)
        n2.push(t3[e5]);
    }
  }
}
function $e(e3) {
  return { type: `Comment`, loc: e3.value.loc, raw: e3.value.raw };
}
function et(e3, t2) {
  let n2 = !e3.peek().done && e3.peek().value.type === `Bracket` ? `TableArray` : `Table`, r2 = n2 === `Table`;
  if (r2 && e3.value.raw !== `[`)
    throw new O(t2, e3.value.loc.start, `Expected table opening "[", found ${e3.value.raw}`);
  if (!r2) {
    let n3 = e3.peek();
    if (n3.done)
      throw new O(t2, e3.value.loc.start, `Expected "[[" for Array of Tables, found end of input`);
    if (e3.value.raw !== `[` || n3.value.raw !== `[`)
      throw new O(t2, e3.value.loc.start, `Expected "[[", found ${e3.value.raw + n3.value.raw}`);
    let r3 = e3.value, i3 = n3.value;
    if (r3.loc.end.line !== i3.loc.start.line || r3.loc.end.column !== i3.loc.start.column)
      throw new O(t2, r3.loc.start, `"[[" brackets must be adjacent (no whitespace)`);
  }
  let i2 = r2 ? { type: `TableKey`, loc: e3.value.loc } : { type: `TableArrayKey`, loc: e3.value.loc };
  if (e3.next(), n2 === `TableArray` && e3.next(), e3.done)
    throw new O(t2, i2.loc.start, `Expected table key, reached end of file`);
  if (e3.value.type === `Bracket` && e3.value.raw === `]`)
    throw new O(t2, e3.value.loc.start, n2 === `TableArray` ? `Array of Tables header [[]] requires a table name` : `Table header [] requires a table name`);
  let a2 = e3.value.raw;
  Ve(a2, t2, e3.value.loc.start), a2.startsWith(`"`) || a2.startsWith(`'`) || Be(a2, t2, e3.value.loc.start);
  let o2;
  for (o2 = [He(e3.value.raw, t2, e3.value.loc.start)], i2.item = { type: `Key`, loc: e3.value.loc, raw: e3.value.raw, value: o2 };!e3.peek().done && e3.peek().value.type === `Dot`; ) {
    e3.next();
    let n3 = e3.value;
    e3.next();
    let r3 = e3.value.raw;
    r3.startsWith(`"`) || r3.startsWith(`'`) || Be(r3, t2, e3.value.loc.start);
    let a3 = ` `.repeat(n3.loc.start.column - i2.item.loc.end.column), o3 = ` `.repeat(e3.value.loc.start.column - n3.loc.end.column);
    i2.item.loc.end = e3.value.loc.end, i2.item.raw += `${a3}.${o3}${e3.value.raw}`;
    try {
      i2.item.value.push(ae(e3.value.raw));
    } catch (n4) {
      let r4 = n4;
      throw new O(t2, e3.value.loc.start, r4.message);
    }
  }
  if (e3.next(), !e3.done) {
    let n3 = i2.loc.start.line;
    if (e3.value.loc.start.line !== n3)
      throw new O(t2, e3.value.loc.start, r2 ? `Table header must be single-line` : `Array of Tables header must be single-line`);
  }
  if (r2 && (e3.done || e3.value.raw !== `]`))
    throw new O(t2, e3.done ? i2.item.loc.end : e3.value.loc.start, `Expected table closing "]", found ${e3.done ? `end of file` : e3.value.raw}`);
  if (!r2 && (e3.done || e3.peek().done || e3.value.raw !== `]` || e3.peek().value.raw !== `]`))
    throw new O(t2, e3.done || e3.peek().done ? i2.item.loc.end : e3.value.loc.start, `Expected "]]" closing, found ${e3.done || e3.peek().done ? `end of file` : e3.value.raw + e3.peek().value.raw}`);
  if (!r2) {
    let n3 = e3.value, r3 = e3.peek().value;
    if (n3.loc.end.line !== r3.loc.start.line || n3.loc.end.column !== r3.loc.start.column)
      throw new O(t2, n3.loc.start, `"]]" brackets must be adjacent (no whitespace)`);
  }
  if (r2 || e3.next(), i2.loc.end = e3.value.loc.end, !e3.peek().done) {
    let n3 = e3.peek().value;
    if (n3.loc.start.line === i2.loc.end.line && n3.type !== `Comment`)
      throw new O(t2, n3.loc.start, `Extra content after ${r2 ? `table` : `Array of Tables`} header`);
  }
  let s2 = [];
  for (;!e3.peek().done && e3.peek().value.type !== `Bracket`; ) {
    e3.next();
    let n3 = ct(e3, t2);
    for (let e4 = 0;e4 < n3.length; e4++)
      s2.push(n3[e4]);
  }
  return { type: r2 ? `Table` : `TableArray`, loc: { start: T(i2.loc.start), end: s2.length ? T(s2[s2.length - 1].loc.end) : T(i2.loc.end) }, key: i2, items: s2 };
}
function tt(e3, t2) {
  let n2 = He(e3.value.raw, t2, e3.value.loc.start);
  return { type: `String`, loc: e3.value.loc, raw: e3.value.raw, value: n2 };
}
function nt(e3) {
  return { type: `Boolean`, loc: e3.value.loc, value: e3.value.raw === je };
}
function rt(e3, t2) {
  let n2 = e3.value.loc, r2 = e3.value.raw, i2;
  if (!e3.peek().done && e3.peek().value.type === `Literal` && Ae.IS_FULL_DATE.test(r2) && /^\d/.test(e3.peek().value.raw) && Ae.IS_FULL_TIME.test(e3.peek().value.raw)) {
    let t3 = n2.start;
    e3.next(), n2 = { start: t3, end: e3.value.loc.end }, r2 += ` ${e3.value.raw}`;
  }
  if (!e3.peek().done && e3.peek().value.type === `Dot`) {
    let i3 = n2.start;
    if (e3.next(), e3.peek().done || e3.peek().value.type !== `Literal`)
      throw new O(t2, e3.value.loc.end, `Expected fractional value for DateTime`);
    e3.next(), n2 = { start: i3, end: e3.value.loc.end }, r2 += `.${e3.value.raw}`;
  }
  if (at(r2, t2, n2.start), Ae.IS_FULL_DATE.test(r2))
    i2 = Ae.IS_DATE_ONLY.test(r2) ? new Ee(r2) : Ae.IS_LOCAL_DATETIME_T.test(r2) ? new Oe(r2, false) : Ae.IS_LOCAL_DATETIME_SPACE.test(r2) ? new Oe(r2, true) : Ae.IS_OFFSET_DATETIME_T.test(r2) ? new ke(r2, false) : Ae.IS_OFFSET_DATETIME_SPACE.test(r2) ? new ke(r2, true) : new Date(r2.replace(` `, `T`));
  else if (Ae.IS_TIME_ONLY.test(r2))
    i2 = new De(r2, r2);
  else {
    let [e4] = (/* @__PURE__ */ new Date()).toISOString().split(`T`);
    i2 = /* @__PURE__ */ new Date(`${e4}T${r2}`);
  }
  return { type: `DateTime`, loc: n2, raw: r2, value: i2 };
}
function it(e3, t2) {
  return t2 === 2 ? e3 % 4 == 0 && e3 % 100 != 0 || e3 % 400 == 0 ? 29 : 28 : [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][t2 - 1];
}
function at(e3, t2, n2) {
  if (/\.([Zz]|[+-])/.test(e3))
    throw new O(t2, n2, `"${e3}": fractional seconds needs digit after dot`);
  if (/[+-]$/.test(e3))
    throw new O(t2, n2, `"${e3}": offset needs HH:MM`);
  let r2 = /\d{2}:\d{2}/.test(e3) ? e3.match(/([+-])(\d+)(:?)(\d*)$/) : null;
  if (r2) {
    let e4 = r2[0], i3 = r2[2], a3 = r2[3], o3 = r2[4];
    if (a3 !== `:`)
      throw new O(t2, n2, `Offset "${e4}": missing colon separator`);
    if (i3.length !== 2)
      throw new O(t2, n2, `Offset "${e4}": hour must be 2 digits`);
    if (!o3 || o3.length === 0)
      throw new O(t2, n2, `Offset "${e4}": minute required`);
    if (o3.length !== 2)
      throw new O(t2, n2, `Offset "${e4}": minute must be 2 digits`);
    let s3 = parseInt(i3, 10);
    if (s3 < 0 || s3 > 23)
      throw new O(t2, n2, `Offset "${e4}": hour must be 00-23`);
    let c3 = parseInt(o3, 10);
    if (c3 < 0 || c3 > 59)
      throw new O(t2, n2, `Offset "${e4}": minute must be 00-59`);
  }
  if (!/^\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})?)?$/.test(e3) && !/^\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?$/.test(e3))
    throw /^\d{4}-\d{2}-\d{2}T$/.test(e3) ? new O(t2, n2, `"${e3}": 'T' requires time component`) : /^\d{4}-\d{2}-\d{2}[a-su-zA-SU-Z]/.test(e3) ? new O(t2, n2, `Invalid date "${e3}": unexpected character after date`) : /^\d{4}-\d{2}-\d{2}\d{2}:\d{2}/.test(e3) ? new O(t2, n2, `"${e3}": missing 'T' or space separator`) : new O(t2, n2, `Invalid datetime "${e3}"`);
  let i2 = e3.match(/^(\d+)-/);
  if (i2 && i2[1].length !== 4)
    throw new O(t2, n2, `"${e3}": year must be 4 digits`);
  let a2 = e3.match(/^(\d+)-(\d+)-(\d+)/);
  if (a2) {
    let [, , r3, i3] = a2;
    if (r3.length !== 2)
      throw new O(t2, n2, `"${e3}": month must be 2 digits`);
    if (i3.length !== 2)
      throw new O(t2, n2, `"${e3}": day must be 2 digits`);
  }
  let o2 = e3.match(/[T ](\d+):(\d+)(?::(\d+))?/);
  if (o2) {
    let [, r3, i3, a3] = o2;
    Ke(r3, i3, a3, e3, t2, n2);
  }
  let s2 = e3.match(/^(\d+):(\d+)(?::(\d+))?/);
  if (s2 && !a2) {
    let [, r3, i3, a3] = s2;
    Ke(r3, i3, a3, e3, t2, n2);
  }
  let c2 = e3.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/), l2 = e3.match(/^(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (c2) {
    let [, r3, i3, a3, o3, s3, l3] = c2, u2 = parseInt(i3, 10);
    if (u2 < 1 || u2 > 12)
      throw new O(t2, n2, `"${e3}": month must be 01-12`);
    let d2 = parseInt(a3, 10);
    if (d2 < 1 || d2 > 31)
      throw new O(t2, n2, `"${e3}": day must be 01-31`);
    if (d2 > it(parseInt(r3, 10), u2))
      throw new O(t2, n2, `"${e3}": day ${a3} invalid for ${r3}-${i3}`);
    qe(o3, s3, l3, e3, t2, n2);
  } else if (l2) {
    let [, r3, i3, a3] = l2;
    qe(r3, i3, a3, e3, t2, n2);
  }
}
function ot(e3, t2) {
  let n2 = e3.value.loc, r2 = e3.value.raw, i2;
  if (Pe.test(r2))
    i2 = r2.startsWith(`-`) ? -1 / 0 : 1 / 0;
  else if (Fe.test(r2)) {
    let e4 = /* @__PURE__ */ new Float64Array(1), t3 = new DataView(e4.buffer);
    r2.startsWith(`-`) ? (t3.setUint32(0, 0, true), t3.setUint32(4, 4294443008, true)) : (t3.setUint32(0, 0, true), t3.setUint32(4, 2146959360, true)), i2 = e4[0];
    let a2 = r2.startsWith(`+`) ? `+` : r2.startsWith(`-`) ? `-` : undefined;
    return { type: `Float`, loc: n2, raw: r2, value: i2, nanSign: a2 };
  } else if (!e3.peek().done && e3.peek().value.type === `Dot`) {
    let a2 = n2.start;
    {
      if (Me.test(r2) && !Ie.test(r2))
        throw new O(t2, n2.start, `Float "${r2}": dot after exponent`);
      let e4 = r2;
      We(e4, t2, n2.start, `the integer part of a float`);
      let i3 = e4.replace(/^[+-]/, ``);
      if (i3 === `` || i3 === `_`)
        throw new O(t2, n2.start, `Float: digit required before dot`);
      Ue(e4, t2, n2.start);
    }
    if (e3.next(), e3.peek().done || e3.peek().value.type !== `Literal`)
      throw new O(t2, e3.value.loc.end, `Expected fraction value for Float`);
    e3.next(), r2 += `.${e3.value.raw}`, n2 = { start: a2, end: e3.value.loc.end };
    {
      let n3 = e3.value.raw;
      if (!/^\d/.test(n3))
        throw new O(t2, e3.value.loc.start, `Float: fraction must start with digit, found "${n3}"`);
      Ue(n3, t2, e3.value.loc.start, false), Ge(n3, r2, t2, e3.value.loc.start);
    }
    i2 = Number(r2.replace(Ne, ``));
  } else {
    if (Ue(r2, t2, n2.start), Ge(r2, r2, t2, n2.start), !e3.peek().done && e3.peek().value.type === `Dot`)
      throw new O(t2, e3.peek().value.loc.start, `Float "${r2}.": dot after exponent`);
    We(r2, t2, n2.start, `the integer part of a float`), i2 = Number(r2.replace(Ne, ``));
  }
  if (Number.isNaN(i2) && !Fe.test(r2))
    throw new O(t2, n2.start, `Invalid float "${r2}"`);
  return { type: `Float`, loc: n2, raw: r2, value: i2 };
}
function st(e3, t2) {
  let n2 = e3.value.raw, r2 = e3.value.loc;
  if (/^\d{1,}-\d{1,}/.test(n2) || /^\d{1,}:\d{1,}/.test(n2) || /^\d{6}-\d{2}$/.test(n2))
    throw new O(t2, r2.start, `Invalid integer "${n2}"`);
  if (n2 === `-0` || n2 === `+0`)
    return { type: `Integer`, loc: r2, raw: n2, value: 0 };
  if (/^[+-]{2,}/.test(n2))
    throw new O(t2, r2.start, `Double sign is not allowed in integers`);
  We(n2, t2, r2.start, `decimal integers`), Ue(n2, t2, r2.start), Je(n2, t2, r2.start);
  let i2 = 10;
  Ie.test(n2) ? (i2 = 16, Ye(n2, t2, r2.start, `0x`, /^[0-9a-fA-F]+$/, `Hexadecimal`)) : Re.test(n2) ? (i2 = 8, Ye(n2, t2, r2.start, `0o`, /^[0-7]+$/, `Octal`, `Invalid octal digits (must be 0-7)`)) : ze.test(n2) && (i2 = 2, Ye(n2, t2, r2.start, `0b`, /^[01]+$/, `Binary`, `Invalid binary digits (must be 0 or 1)`));
  let a2 = parseInt(n2.replace(Ne, ``).replace(Re, ``).replace(ze, ``), i2);
  if (Number.isNaN(a2))
    throw new O(t2, r2.start, `Invalid integer "${n2}"`);
  return { type: `Integer`, loc: r2, raw: n2, value: a2 };
}
function ct(e3, t2) {
  if (e3.value.type === `Comment`)
    return [$e(e3)];
  if (e3.value.type === `Bracket`)
    return [et(e3, t2)];
  if (e3.value.type === `Literal`)
    return lt(e3, t2);
  throw e3.value.type === `Equal` ? new O(t2, e3.value.loc.start, `Missing key before '='`) : new O(t2, e3.value.loc.start, `Unexpected token "${e3.value.type}"`);
}
function lt(e3, t2) {
  let n2 = e3.value.raw;
  if (n2.endsWith(`:`))
    throw new O(t2, { line: e3.value.loc.start.line, column: e3.value.loc.start.column + [...n2].length - 1 }, `Use '=' to separate keys and values, not ':'`);
  Ve(n2, t2, e3.value.loc.start), n2.startsWith(`"`) || n2.startsWith(`'`) || Be(n2, t2, e3.value.loc.start);
  let r2;
  r2 = [He(e3.value.raw, t2, e3.value.loc.start)];
  let i2 = { type: `Key`, loc: e3.value.loc, raw: e3.value.raw, value: r2 };
  for (;!e3.peek().done && e3.peek().value.type === `Dot`; ) {
    e3.next();
    let n3 = e3.value;
    e3.next();
    let r3 = e3.value.raw;
    Ve(r3, t2, e3.value.loc.start), r3.startsWith(`"`) || r3.startsWith(`'`) || Be(r3, t2, e3.value.loc.start);
    let a3 = C(t2, i2.loc.end), o3 = C(t2, n3.loc.end), s3 = a3.slice(i2.loc.end.column, n3.loc.start.column), c3 = o3.slice(n3.loc.end.column, e3.value.loc.start.column);
    i2.loc.end = e3.value.loc.end, i2.raw += `${s3}.${c3}${e3.value.raw}`, i2.value.push(He(e3.value.raw, t2, e3.value.loc.start));
  }
  if (e3.next(), !e3.done && e3.value.loc.start.line !== i2.loc.end.line)
    throw new O(t2, e3.value.loc.start, `"=" must be on same line as key`);
  if (e3.done || e3.value.type !== `Equal`)
    throw !e3.done && e3.value.raw === `:` ? new O(t2, e3.value.loc.start, `Use '=' to separate keys and values, not ':'`) : new O(t2, e3.done ? i2.loc.end : e3.value.loc.start, `Expected "=" for key-value`);
  let a2 = e3.value.loc.start.column, o2 = e3.value.loc.start.line;
  if (e3.next(), e3.done)
    throw new O(t2, i2.loc.start, `Expected value, reached EOF`);
  if (e3.value.loc.start.line !== o2)
    throw new O(t2, e3.value.loc.start, `Value must be on same line as '='`);
  if (e3.done)
    throw new O(t2, i2.loc.start, `Expected value for key-value`);
  let s2 = ut(e3, t2), c2 = s2[0];
  if (!e3.peek().done) {
    let n3 = e3.peek().value;
    if (n3.type === `Dot` && n3.loc.start.line === c2.loc.end.line && (c2.type === `Float` || c2.type === `Integer`))
      throw new O(t2, n3.loc.start, `Invalid number: multiple decimal points not allowed`);
    if ((n3.type === `Literal` || n3.type === `Bracket`) && n3.loc.start.line === c2.loc.end.line)
      throw new O(t2, n3.loc.start, `Key/value pairs must be separated by a newline`);
  }
  return s2[0] = { type: `KeyValue`, key: i2, value: c2, loc: { start: T(i2.loc.start), end: T(c2.loc.end) }, equals: a2 }, s2;
}
function ut(e3, t2) {
  if (e3.value.type === `Literal`) {
    let n2 = e3.value.raw;
    return n2[0] === `"` || n2[0] === `'` ? [tt(e3, t2)] : n2 === je || n2 === `false` ? [nt(e3)] : /^\d/.test(n2) && (/^\d{1,}-\d{1,}/.test(n2) || /^\d{1,}:\d{1,}/.test(n2)) ? [rt(e3, t2)] : !e3.peek().done && e3.peek().value.type === `Dot` || Pe.test(n2) || Fe.test(n2) || Me.test(n2) && !Ie.test(n2) ? [ot(e3, t2)] : [st(e3, t2)];
  }
  if (e3.value.type === `Curly`) {
    let [n2, r2] = ft(e3, t2);
    return [n2, ...r2];
  }
  if (e3.value.type === `Bracket`) {
    let [n2, r2] = pt(e3, t2);
    return [n2, ...r2];
  }
  throw e3.value.type === `Dot` ? new O(t2, e3.value.loc.start, `Number cannot start with a dot`) : new O(t2, e3.value.loc.start, `Unrecognized token type`);
}
function dt(e3) {
  for (let t2 = 1;t2 < e3.length; t2++) {
    let n2 = e3[t2 - 1], r2 = e3[t2];
    if (n2.loc.end.line === r2.loc.start.line) {
      let e4 = r2.loc.start.column - n2.loc.end.column;
      if (e4 >= 1)
        return e4;
    }
  }
}
function ft(e3, t2) {
  if (e3.value.raw !== `{`)
    throw new O(t2, e3.value.loc.start, `Expected "{" for inline table`);
  let n2 = { type: `InlineTable`, loc: e3.value.loc, items: [] }, r2 = [];
  for (e3.next();!e3.done && (e3.value.type !== `Curly` || e3.value.raw !== `}`); ) {
    if (e3.value.type === `Comment`) {
      r2.push($e(e3)), e3.next();
      continue;
    }
    if (e3.value.type === `Comma`) {
      let r3 = n2.items[n2.items.length - 1];
      if (!r3)
        throw new O(t2, e3.value.loc.start, `Leading comma in inline table`);
      if (r3.comma)
        throw new O(t2, e3.value.loc.start, `Consecutive commas in inline table`);
      r3.comma = true, r3.loc.end = e3.value.loc.start, e3.next();
      continue;
    }
    let i2 = n2.items[n2.items.length - 1];
    if (i2 && !i2.comma)
      throw new O(t2, e3.value.loc.start, `Missing comma between inline table items`);
    let a2 = ct(e3, t2), o2 = a2[0];
    if (o2.type === `KeyValue`) {
      n2.items.push({ type: `InlineItem`, loc: E(o2.loc), item: o2, comma: false });
      for (let e4 = 1;e4 < a2.length; e4++)
        r2.push(a2[e4]);
    }
    e3.next();
  }
  if (e3.done || e3.value.type !== `Curly` || e3.value.raw !== `}`)
    throw new O(t2, e3.done ? n2.loc.start : e3.value.loc.start, `Expected "}"`);
  n2.loc.end = e3.value.loc.end;
  {
    let e4 = dt(n2.items);
    e4 !== undefined && fe(n2, e4);
  }
  return [n2, r2];
}
function pt(e3, t2) {
  if (e3.value.raw !== `[`)
    throw new O(t2, e3.value.loc.start, `Expected "[" for inline array`);
  let n2 = { type: `InlineArray`, loc: e3.value.loc, items: [] }, r2 = [];
  for (e3.next();!e3.done && (e3.value.type !== `Bracket` || e3.value.raw !== `]`); ) {
    if (e3.value.type === `Comma`) {
      let r3 = n2.items[n2.items.length - 1];
      if (!r3)
        throw new O(t2, e3.value.loc.start, `Leading comma in array`);
      if (r3.comma)
        throw new O(t2, e3.value.loc.start, `Consecutive commas in array`);
      r3.comma = true, r3.loc.end = e3.value.loc.start;
    } else if (e3.value.type === `Comment`)
      r2.push($e(e3));
    else {
      let i2 = n2.items[n2.items.length - 1];
      if (i2 && !i2.comma)
        throw new O(t2, e3.value.loc.start, `Missing comma between array elements`);
      let a2 = ut(e3, t2), o2 = a2[0];
      n2.items.push({ type: `InlineItem`, loc: E(o2.loc), item: o2, comma: false });
      for (let e4 = 1;e4 < a2.length; e4++)
        r2.push(a2[e4]);
    }
    e3.next();
  }
  if (e3.done || e3.value.type !== `Bracket` || e3.value.raw !== `]`)
    throw new O(t2, e3.done ? n2.loc.start : e3.value.loc.start, `Expected "]"`);
  n2.loc.end = e3.value.loc.end;
  {
    let e4 = dt(n2.items);
    e4 !== undefined && fe(n2, e4);
  }
  return [n2, r2];
}
function P(e3) {
  return e3[e3.length - 1];
}
function mt() {
  return Object.create(null);
}
function ht(e3, t2) {
  return e3 === t2 && (typeof e3 != `number` || Object.is(e3, t2));
}
var gt = /* @__PURE__ */ new DataView(/* @__PURE__ */ new ArrayBuffer(8));
function _t(e3) {
  return Number.isNaN(e3) ? (gt.setFloat64(0, e3, true), !!(gt.getUint32(4, true) & 2147483648)) : false;
}
function vt(e3) {
  return typeof e3 == `string`;
}
function yt(e3) {
  return typeof e3 == `number` && e3 % 1 == 0 && isFinite(e3) && !Object.is(e3, -0) && e3 >= -(2 ** 53 - 1) && e3 <= 2 ** 53 - 1;
}
function bt(e3) {
  return typeof e3 == `bigint`;
}
function xt(e3) {
  return typeof e3 == `number` && (!yt(e3) || !isFinite(e3) || Object.is(e3, -0));
}
function St(e3) {
  return typeof e3 == `boolean`;
}
function Ct(e3) {
  return Object.prototype.toString.call(e3) === `[object Date]`;
}
var wt = /* @__PURE__ */ new Set([`Temporal.PlainDate`, `Temporal.PlainTime`, `Temporal.PlainDateTime`, `Temporal.ZonedDateTime`, `PlainDate`, `PlainTime`, `PlainDateTime`, `ZonedDateTime`]);
function Tt(e3) {
  var t2;
  return typeof e3 == `object` && !!e3 && wt.has((t2 = e3.constructor) == null ? undefined : t2.name) && typeof e3.equals == `function`;
}
function Et(e3) {
  var t2;
  let n2 = ((t2 = e3.constructor) == null ? undefined : t2.name) ?? ``;
  if (n2 === `Temporal.ZonedDateTime` || n2 === `ZonedDateTime`) {
    let t3 = e3.toString(), n3 = t3.match(/\[(.+)\]$/);
    if (n3 && !/^[+-]\d{2}:\d{2}$/.test(n3[1]))
      throw Error(`ZonedDateTime with IANA timezone "${t3}" cannot be represented in TOML. TOML only supports offset-based timezones (+05:30, Z).`);
    return t3.replace(/\[.*\]$/, ``).replace(/(\+00:00)$/, `Z`);
  }
  let r2 = e3.toString();
  if (/\[.*\]/.test(r2))
    throw Error(`Temporal value contains unsupported annotation: "${r2}". TOML only supports ISO 8601 calendar.`);
  return r2;
}
function Dt(e3, t2 = /* @__PURE__ */ new WeakSet) {
  return typeof e3 != `object` || !e3 ? false : Tt(e3) ? true : !t2.has(e3) && (t2.add(e3), Object.values(e3).some((e4) => Dt(e4, t2)));
}
function F(e3) {
  return e3 && typeof e3 == `object` && !Ct(e3) && !Tt(e3) && !Array.isArray(e3);
}
function Ot(e3) {
  return e3 != null && typeof e3[Symbol.iterator] == `function`;
}
function kt(e3) {
  return e3.startsWith(`"`) && !e3.startsWith(`"""`);
}
function At(e3) {
  return e3.startsWith(`"""`);
}
function jt(e3) {
  return e3.startsWith(`'`) && !e3.startsWith(`'''`);
}
function Mt(e3) {
  return e3.startsWith(`'''`);
}
function I(e3, t2) {
  if (e3.length !== t2.length)
    return false;
  for (let n2 = 0;n2 < e3.length; n2++)
    if (e3[n2] !== t2[n2])
      return false;
  return true;
}
function Nt(e3) {
  return /^\d{4}-\d{2}-\d{2}$/.test(e3) ? `date` : /^\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(e3) ? `time` : /(?:[Zz]|[+-]\d{2}:\d{2})$/.test(e3) ? `offset` : `datetime`;
}
function Pt(e3) {
  let t2 = e3.match(/\.(\d+)/);
  return t2 ? t2[1].replace(/0+$/, ``) : ``;
}
function Ft(e3) {
  return e3 === 0 ? 0 : String(e3).padStart(3, `0`).replace(/0+$/, ``).length;
}
function It(e3, t2) {
  let n2 = Pt(t2);
  return n2.length > Ft(e3.getUTCMilliseconds()) ? n2 : undefined;
}
function Lt(e3, t2) {
  if (Tt(e3) && Tt(t2))
    return e3.toString() === t2.toString();
  if (Ct(e3) && Ct(t2)) {
    if (e3.getTime() !== t2.getTime())
      return false;
    let n2 = e3.toISOString(), r2 = t2.toISOString();
    if (Nt(n2) !== Nt(r2))
      return false;
    let i2 = It(e3, n2), a2 = It(t2, r2);
    return i2 === undefined || a2 === undefined || i2 === a2;
  }
  return false;
}
function Rt(e3) {
  let t2 = [], n2 = /* @__PURE__ */ new WeakSet, r2 = [{ value: e3 }];
  for (;r2.length > 0; ) {
    let e4 = r2.pop();
    if (`text` in e4) {
      t2.push(e4.text), `leave` in e4 && n2.delete(e4.leave);
      continue;
    }
    let i2 = e4.value;
    if (F(i2)) {
      if (n2.has(i2))
        throw TypeError(`Cannot stableStringify a circular structure`);
      n2.add(i2);
      let e5 = Object.keys(i2).sort();
      t2.push(`{`), r2.push({ leave: i2, text: `}` });
      for (let t3 = e5.length - 1;t3 >= 0; t3--) {
        let n3 = e5[t3];
        t3 < e5.length - 1 && r2.push({ text: `,` }), r2.push({ value: i2[n3] }), r2.push({ text: `:` }), r2.push({ text: JSON.stringify(n3) });
      }
    } else if (Array.isArray(i2)) {
      if (n2.has(i2))
        throw TypeError(`Cannot stableStringify a circular structure`);
      n2.add(i2), t2.push(`[`), r2.push({ leave: i2, text: `]` });
      for (let e5 = i2.length - 1;e5 >= 0; e5--)
        e5 < i2.length - 1 && r2.push({ text: `,` }), r2.push({ value: i2[e5] });
    } else if (Tt(i2))
      t2.push(JSON.stringify(i2.toString()));
    else if (Ct(i2))
      t2.push(JSON.stringify(i2.toISOString()));
    else if (typeof i2 == `bigint`)
      t2.push(i2.toString() + `n`);
    else if (typeof i2 == `number` && !Number.isFinite(i2)) {
      let e5 = Number.isNaN(i2) ? _t(i2) ? `-` : `+` : i2 < 0 ? `-` : `+`;
      t2.push(`${e5}${String(i2)}`);
    } else
      typeof i2 == `number` && Object.is(i2, -0) ? t2.push(`-0`) : t2.push(JSON.stringify(i2));
  }
  return t2.join(``);
}
function zt(e3, t2) {
  let n2 = e3.length, r2 = t2.length;
  e3.length = n2 + r2;
  for (let i2 = 0;i2 < r2; i2++)
    e3[n2 + i2] = t2[i2];
}
var Bt = typeof String.prototype.isWellFormed == `function` ? String.prototype.isWellFormed : undefined;
function Vt(e3) {
  for (let t2 = 0;t2 < e3.length; t2++) {
    let n2 = e3.charCodeAt(t2);
    if (!(n2 < 55296 || n2 > 57343)) {
      if (n2 <= 56319) {
        let n3 = e3.charCodeAt(t2 + 1);
        if (n3 >= 56320 && n3 <= 57343) {
          t2++;
          continue;
        }
      }
      return { index: t2, code: n2 };
    }
  }
}
function Ht(e3, t2) {
  if (Bt !== undefined && Bt.call(e3))
    return;
  let n2 = Vt(e3);
  if (!n2)
    return;
  let r2 = n2.code.toString(16).toUpperCase().padStart(4, `0`);
  throw Error(`${t2} contains a lone surrogate (U+${r2}) at index ${n2.index}. Unpaired surrogates are not Unicode scalar values and cannot be encoded as TOML.`);
}
function Ut(e3, t2) {
  Ot(e3) ? n2(e3, null) : r2(e3, null);
  function n2(e4, t3) {
    for (let n3 of e4)
      r2(n3, t3);
  }
  function r2(e4, i2) {
    let a2 = t2[e4.type];
    switch (a2 && typeof a2 == `function` && a2(e4, i2), a2 && a2.enter && a2.enter(e4, i2), e4.type) {
      case `Document`:
        n2(e4.items, e4);
        break;
      case `Table`:
        r2(e4.key, e4), n2(e4.items, e4);
        break;
      case `TableKey`:
        r2(e4.item, e4);
        break;
      case `TableArray`:
        r2(e4.key, e4), n2(e4.items, e4);
        break;
      case `TableArrayKey`:
        r2(e4.item, e4);
        break;
      case `KeyValue`:
        r2(e4.key, e4), r2(e4.value, e4);
        break;
      case `InlineArray`:
        n2(e4.items, e4);
        break;
      case `InlineItem`:
        r2(e4.item, e4);
        break;
      case `InlineTable`:
        n2(e4.items, e4);
        break;
      case `Key`:
      case `String`:
      case `Integer`:
      case `Float`:
      case `Boolean`:
      case `DateTime`:
      case `Comment`:
        break;
      default:
        throw Error(`Unrecognized node type "${e4.type}"`);
    }
    a2 && a2.exit && a2.exit(e4, i2);
  }
}
function Wt(e3) {
  return new TextDecoder(`utf-8`, { fatal: true, ignoreBOM: true }).decode(e3);
}
function Gt(e3) {
  return e3.charCodeAt(0) === 65279;
}
function Kt(e3) {
  return Gt(e3) ? e3.slice(1) : e3;
}
var qt = `auto`;
var Jt = `auto`;
function Yt(e3) {
  for (let t2 of e3) {
    let e4 = $t(t2);
    if (e4 !== null)
      return e4;
  }
  return false;
}
function Xt(e3, t2) {
  for (let n2 of t2) {
    let t3 = Zt(n2, e3);
    if (t3 !== null)
      return t3;
  }
  return true;
}
function Zt(e3, t2) {
  if (!e3 || typeof e3 != `object`)
    return null;
  if ((e3.type === `InlineArray` || e3.type === `InlineTable`) && e3.loc) {
    let n2 = Qt(e3.loc, t2);
    if (n2 !== null)
      return n2;
  }
  if (e3.items && Array.isArray(e3.items))
    for (let n2 of e3.items) {
      let e4 = Zt(n2, t2);
      if (e4 !== null)
        return e4;
      if (n2.item) {
        let e5 = Zt(n2.item, t2);
        if (e5 !== null)
          return e5;
      }
    }
  for (let n2 of [`value`, `key`, `item`])
    if (e3[n2]) {
      let r2 = Zt(e3[n2], t2);
      if (r2 !== null)
        return r2;
    }
  return null;
}
function Qt(e3, t2) {
  if (!e3 || !e3.start || !e3.end)
    return null;
  let n2 = t2.split(/\r?\n/), r2 = e3.start.line - 1, i2 = e3.end.line - 1, a2 = e3.start.column, o2 = e3.end.column, s2 = ``;
  if (r2 === i2) {
    var c2;
    s2 = ((c2 = n2[r2]) == null ? undefined : c2.substring(a2, o2 + 1)) || ``;
  } else {
    n2[r2] && (s2 += n2[r2].substring(a2));
    for (let e4 = r2 + 1;e4 < i2; e4++)
      s2 += `
` + (n2[e4] || ``);
    n2[i2] && (s2 += `
` + n2[i2].substring(0, o2 + 1));
  }
  let l2 = s2.match(/^\[(\s*)/), u2 = s2.match(/^\{(\s*)/);
  return l2 ? l2[1].length > 0 : u2 ? u2[1].length > 0 : null;
}
function $t(e3) {
  if (!e3 || typeof e3 != `object`)
    return null;
  if (e3.type === `InlineArray` && e3.items && Array.isArray(e3.items) || e3.type === `InlineTable` && e3.items && Array.isArray(e3.items))
    return en(e3.items);
  if (e3.type === `KeyValue` && e3.value)
    return $t(e3.value);
  if (e3.items && Array.isArray(e3.items))
    for (let t2 of e3.items) {
      let e4 = $t(t2);
      if (e4 !== null)
        return e4;
    }
  return null;
}
function en(e3) {
  if (e3.length === 0)
    return null;
  let t2 = e3[e3.length - 1];
  return t2 && typeof t2 == `object` && `comma` in t2 ? t2.comma === true : false;
}
function tn(e3) {
  let t2 = e3.indexOf(`
`);
  return t2 > 0 && e3[t2 - 1] === `\r` ? `\r
` : `
`;
}
function nn(e3) {
  let t2 = 0, n2 = e3.length;
  for (;n2 > 0 && e3[n2 - 1] === `
`; )
    t2++, n2--, n2 > 0 && e3[n2 - 1] === `\r` && n2--;
  return t2;
}
function rn(e3) {
  for (let t2 = 0;t2 < e3.length; t2++) {
    if (e3[t2] !== `\\`)
      continue;
    let n2 = e3[t2 + 1];
    if (!n2)
      return null;
    if (n2 === `\\`)
      t2++;
    else {
      if (n2 === `x` && /^[0-9A-Fa-f]{2}$/.test(e3.slice(t2 + 2, t2 + 4)))
        return /[A-F]/.test(e3.slice(t2 + 2, t2 + 4));
      if (n2 === `u` && /^[0-9A-Fa-f]{4}$/.test(e3.slice(t2 + 2, t2 + 6)))
        return /[A-F]/.test(e3.slice(t2 + 2, t2 + 6));
      if (n2 === `U` && /^[0-9A-Fa-f]{8}$/.test(e3.slice(t2 + 2, t2 + 10)))
        return /[A-F]/.test(e3.slice(t2 + 2, t2 + 10));
    }
  }
  return null;
}
function an(e3) {
  if (!e3 || typeof e3 != `object`)
    return null;
  if (e3.type === `String` && typeof e3.raw == `string`) {
    let t2 = rn(e3.raw);
    if (t2 !== null)
      return t2;
  }
  for (let t2 of [`key`, `item`, `value`])
    if (e3[t2] && typeof e3[t2] == `object`) {
      let n2 = an(e3[t2]);
      if (n2 !== null)
        return n2;
    }
  if (Array.isArray(e3.items))
    for (let t2 of e3.items) {
      let e4 = an(t2);
      if (e4 !== null)
        return e4;
    }
  return null;
}
function on(e3) {
  for (let t2 of e3) {
    let e4 = an(t2);
    if (e4 !== null)
      return e4;
  }
  return true;
}
function sn(e3) {
  let t2 = e3.split(/\r?\n/), n2 = 0, r2 = 0;
  for (let e4 of t2)
    if (e4.length !== 0 && (e4[0] === `	` ? n2++ : e4[0] === ` ` && r2++, n2 + r2 >= 5))
      break;
  return n2 > 0 && n2 >= r2;
}
function cn(e3) {
  let t2 = 0;
  for (;t2 < e3.length && e3[t2] === ` `; )
    t2++;
  return t2;
}
function ln(e3, t2) {
  let n2 = e3.split(/\r?\n/), r2 = [], i2 = /* @__PURE__ */ new Set([`Table`, `TableArray`, `InlineTable`, `InlineArray`]), a2 = /* @__PURE__ */ new Set([`Table`, `TableArray`, `InlineTable`, `InlineArray`, `KeyValue`, `InlineItem`, `Comment`]), o2 = (e4, t3) => {
    var s3, c3, l2;
    if (!e4 || typeof e4 != `object`)
      return;
    if (t3 !== undefined && a2.has(e4.type) && ((s3 = e4.loc) == null || (s3 = s3.start) == null ? undefined : s3.line) > t3) {
      let t4 = cn(n2[e4.loc.start.line - 1] ?? ``);
      t4 > 0 && r2.push(t4);
    }
    let u2 = i2.has(e4.type) && ((c3 = e4.loc) == null || (c3 = c3.end) == null ? undefined : c3.line) > ((l2 = e4.loc) == null || (l2 = l2.start) == null ? undefined : l2.line) ? e4.loc.start.line : t3;
    if (Array.isArray(e4.items))
      for (let t4 of e4.items)
        o2(t4, u2);
    e4.item && o2(e4.item, u2), e4.value && o2(e4.value, u2);
  }, s2 = Array.isArray(t2) ? t2 : Array.from(t2 ?? []);
  for (let e4 of s2)
    o2(e4);
  if (r2.length > 0)
    return Math.min(...r2);
  let c2 = n2.filter((e4) => e4.trim().length > 0 && !e4.trimStart().startsWith(`#`)).map(cn).filter((e4) => e4 > 0);
  return c2.length > 0 ? Math.min(...c2) : 2;
}
var un = /* @__PURE__ */ new Map([[`
`, `
`], [`\r
`, `\r
`], [`\\n`, `
`], [`\\r\\n`, `\r
`], [`LF`, `
`], [`CRLF`, `\r
`], [`UNIX`, `
`], [`DOS`, `\r
`]]);
function dn(e3) {
  let t2 = un.get(e3) ?? un.get(e3.toUpperCase());
  if (t2 === undefined)
    throw TypeError(`Invalid newLine value: expected LF or CRLF`);
  return t2;
}
function fn(e3) {
  if (!e3 || typeof e3 != `object`)
    return {};
  let t2 = (e4) => typeof e4 == `boolean` ? null : `expected boolean, got ${typeof e4}`, n2 = (e4) => e4 == null || typeof e4 == `boolean` || e4 === `auto` || e4 === `parent` || typeof e4 == `number` && Number.isInteger(e4) && e4 >= 0 ? null : `expected boolean, non-negative integer, "auto" or "parent", got ${typeof e4}`, r2 = { newLine: (e4) => typeof e4 == `string` ? null : `expected string, got ${typeof e4}`, trailingNewline: (e4) => typeof e4 == `boolean` || typeof e4 == `number` ? null : `expected boolean or number, got ${typeof e4}`, trailingComma: t2, bracketSpacing: t2, leadingBom: t2, inlineTableStart: (e4) => e4 == null || typeof e4 == `number` && Number.isInteger(e4) && e4 >= 0 ? null : `expected non-negative integer or undefined, got ${typeof e4}`, truncateZeroTimeInDates: t2, useTabsForIndentation: t2, indentWidth: (e4) => e4 == null || typeof e4 == `number` && Number.isInteger(e4) && e4 > 0 ? null : `expected positive integer or undefined, got ${typeof e4}`, minimumDecimals: (e4) => e4 == null || typeof e4 == `number` && Number.isInteger(e4) && e4 >= 0 ? null : `expected non-negative integer or undefined, got ${typeof e4}`, minimumTimeDecimals: (e4) => e4 == null || typeof e4 == `number` && Number.isInteger(e4) && e4 >= 0 ? null : `expected non-negative integer or undefined, got ${typeof e4}`, updateOrder: t2, multilineTable: n2, multilineArray: n2, escapeSequenceUpperCase: t2 }, i2 = {}, a2 = [], o2 = [];
  for (let t3 in e3) {
    let n3 = Object.prototype.hasOwnProperty.call(r2, t3) ? r2[t3] : undefined;
    if (n3) {
      let r3 = e3[t3], a3 = n3(r3);
      a3 ? o2.push(`${t3} (${a3})`) : i2[t3] = r3;
    } else
      Object.prototype.hasOwnProperty.call(e3, t3) && a2.push(t3);
  }
  if (a2.length > 0 && console.warn(`toml-patch: Ignoring unsupported format properties: ${a2.join(`, `)}. Supported properties are: ${Object.keys(r2).join(`, `)}`), o2.length > 0)
    throw TypeError(`Invalid types for format properties: ${o2.join(`, `)}`);
  return `newLine` in i2 && (i2.newLine = dn(i2.newLine)), i2;
}
function L(e3, t2) {
  if (e3) {
    if (e3 instanceof R)
      return e3;
    {
      let n2 = fn(e3);
      return new R(n2.newLine ?? t2.newLine, n2.trailingNewline ?? t2.trailingNewline, n2.trailingComma ?? t2.trailingComma, n2.bracketSpacing ?? t2.bracketSpacing, `inlineTableStart` in n2 ? n2.inlineTableStart : t2.inlineTableStart, n2.truncateZeroTimeInDates ?? t2.truncateZeroTimeInDates, n2.useTabsForIndentation ?? t2.useTabsForIndentation, n2.minimumDecimals ?? t2.minimumDecimals, n2.leadingBom ?? t2.leadingBom, n2.updateOrder ?? t2.updateOrder, n2.indentWidth ?? t2.indentWidth, n2.multilineTable ?? t2.multilineTable, n2.multilineArray ?? t2.multilineArray, n2.escapeSequenceUpperCase ?? t2.escapeSequenceUpperCase, n2.minimumTimeDecimals ?? t2.minimumTimeDecimals);
    }
  }
  return t2;
}
var R = class e3 {
  newLine;
  trailingNewline;
  trailingComma;
  bracketSpacing;
  leadingBom;
  inlineTableStart;
  truncateZeroTimeInDates;
  useTabsForIndentation;
  indentWidth;
  minimumDecimals;
  minimumTimeDecimals;
  updateOrder;
  multilineTable;
  multilineArray;
  escapeSequenceUpperCase;
  constructor(e4, t2, n2, r2, i2, a2, o2, s2, c2, l2, u2, d2, f2, p2, m2) {
    this.newLine = e4 == null ? `
` : dn(e4), this.trailingNewline = t2 ?? 1, this.trailingComma = n2 ?? false, this.bracketSpacing = r2 ?? true, this.inlineTableStart = i2 ?? 1, this.truncateZeroTimeInDates = a2 ?? false, this.useTabsForIndentation = o2 ?? false, this.indentWidth = this.useTabsForIndentation ? 1 : u2 ?? 2, this.minimumDecimals = s2 ?? 0, this.minimumTimeDecimals = m2 ?? 0, this.leadingBom = c2 ?? false, this.updateOrder = l2 ?? false, this.multilineTable = d2 ?? `auto`, this.multilineArray = f2 ?? `auto`, this.escapeSequenceUpperCase = p2 ?? true;
  }
  static default() {
    return new e3(`
`, 1, false, true, 1, false, false, 0, false, false, 2, qt, Jt, true, 0);
  }
  static autoDetectFormat(t2) {
    return e3.autoDetectFormatWithCst(t2);
  }
  static autoDetectFormatWithCst(t2, n2) {
    let r2 = e3.default();
    r2.leadingBom = Gt(t2);
    let i2 = Kt(t2), a2 = [];
    r2.newLine = tn(i2), r2.trailingNewline = nn(i2);
    try {
      a2 = Array.isArray(n2) ? n2 : Array.from(n2 ?? N(i2)), r2.trailingComma = Yt(a2), r2.bracketSpacing = Xt(i2, a2);
    } catch {
      r2.trailingComma = false, r2.bracketSpacing = true;
    }
    return r2.useTabsForIndentation = sn(i2), r2.indentWidth = r2.useTabsForIndentation ? 1 : ln(i2, a2), r2.inlineTableStart = 1, r2.truncateZeroTimeInDates = false, r2.minimumDecimals = 0, r2.minimumTimeDecimals = 0, r2.updateOrder = false, r2.multilineTable = qt, r2.multilineArray = Jt, r2.escapeSequenceUpperCase = on(a2), r2;
  }
  static autoDetectFormatWithAst(t2, n2) {
    return e3.autoDetectFormatWithCst(t2, n2);
  }
};
var pn = /* @__PURE__ */ new WeakMap;
var mn = /* @__PURE__ */ new WeakMap;
var hn = /* @__PURE__ */ new WeakSet;
var gn = /* @__PURE__ */ new WeakMap;
function _n(e4, t2) {
  return (e4[t2.line - 1] ?? e4[e4.length - 1]) + t2.column;
}
function vn(e4, t2) {
  let n2 = yn(t2);
  for (let t3 of e4)
    n2(t3);
}
function yn(e4) {
  let n2 = [0];
  for (let t2 = 0;t2 < e4.length; t2++)
    e4.charCodeAt(t2) === 10 && n2.push(t2 + 1);
  return (i2) => {
    let o2 = [i2];
    for (;o2.length > 0; ) {
      let i3 = o2.pop(), s2 = [_n(n2, i3.loc.start), _n(n2, i3.loc.end)];
      if (Object.defineProperty(i3, "range", { configurable: true, enumerable: false, value: s2 }), pn.set(i3, e4), gn.set(i3, xn(i3).slice()), a(i3))
        o2.push(i3.value), o2.push(i3.key);
      else if (d(i3))
        o2.push(i3.item);
      else if (t(i3) || r(i3)) {
        o2.push(i3.key);
        let e5 = i3.items;
        for (let t2 = e5.length - 1;t2 >= 0; t2--)
          o2.push(e5[t2]);
      } else if (m(i3)) {
        let e5 = i3.items;
        for (let t2 = e5.length - 1;t2 >= 0; t2--)
          o2.push(e5[t2]);
      }
    }
  };
}
function z(e4) {
  return pn.get(e4);
}
function bn(e4) {
  let t2 = gn.get(e4);
  if (!t2)
    return false;
  let n2 = xn(e4);
  return t2.length === n2.length && t2.every((e5, t3) => e5 === n2[t3]);
}
function xn(e4) {
  return a(e4) ? [e4.key, e4.value] : d(e4) ? [e4.item] : t(e4) || r(e4) ? [e4.key, ...e4.items] : m(e4) ? e4.items : [];
}
function Sn(e4) {
  if (hn.has(e4))
    return;
  let t2 = [e4];
  for (;t2.length > 0; ) {
    let e5 = t2.pop();
    for (let n2 of xn(e5))
      mn.set(n2, e5), t2.push(n2);
  }
  hn.add(e4);
}
function Cn(e4) {
  let t2 = [e4];
  for (;t2.length > 0; ) {
    let e5 = t2.pop();
    Tn(e5);
    for (let n2 of xn(e5))
      t2.push(n2);
  }
}
function wn(e4) {
  Cn(e4);
}
function Tn(e4) {
  Object.defineProperty(e4, "dirty", { configurable: true, enumerable: false, value: true, writable: true });
}
function En(e4, t2, n2) {
  Sn(e4), n2 && (mn.set(n2, t2), Cn(n2));
  let r2 = t2;
  for (;r2; )
    Tn(r2), r2 = mn.get(r2);
}
function Dn(e4) {
  let t2 = gn.get(e4);
  return !!(t2 != null && t2[0]) && t2[0].loc.start.line > e4.loc.start.line;
}
var On = /* @__PURE__ */ new WeakMap;
var kn = /* @__PURE__ */ new WeakSet;
var An = /* @__PURE__ */ new WeakSet;
var jn = /* @__PURE__ */ new WeakSet;
var Mn = /* @__PURE__ */ new WeakSet;
function Nn(e4, t2, n2, r2) {
  let i2 = e4 === `array` ? r2.multilineArray : r2.multilineTable;
  return typeof i2 == `boolean` ? i2 : typeof i2 == `number` ? t2 >= i2 : i2 === `parent` && n2;
}
function Pn(e4, t2) {
  On.set(e4, t2), t2 && e4.items.length === 0 && (e4.loc.end.line = e4.loc.start.line + 1, e4.loc.end.column = e4.loc.start.column + 1);
}
function Fn(e4) {
  return On.get(e4);
}
function In(e4) {
  kn.add(e4);
}
function Ln(e4) {
  return kn.has(e4);
}
function Rn(e4) {
  An.add(e4);
}
function zn(e4) {
  return An.has(e4);
}
function Bn(e4) {
  jn.add(e4);
}
function Vn(e4) {
  return jn.has(e4);
}
function Hn(e4) {
  Mn.add(e4);
}
function Un(e4) {
  return Mn.has(e4);
}
function Wn(e4) {
  return e4.items.length ? e4.items.some((t2, n2) => {
    let r2 = e4.items[n2 - 1];
    return t2.loc.start.line > ((r2 == null ? undefined : r2.loc.end.line) ?? e4.loc.start.line);
  }) : e4.loc.end.line > e4.loc.start.line;
}
function Gn(e4, t2) {
  let n2 = (e5, r2) => {
    if (e5 === t2)
      return r2;
    if (a(e5))
      return n2(e5.value, r2);
    if (d(e5))
      return n2(e5.item, r2);
    if (u(e5) || f(e5))
      for (let t3 of e5.items) {
        let e6 = n2(t3, r2 + 1);
        if (e6 !== undefined)
          return e6;
      }
    else if (m(e5))
      for (let t3 of e5.items) {
        let e6 = n2(t3, r2);
        if (e6 !== undefined)
          return e6;
      }
  };
  return n2(e4, 0);
}
function Kn(e4, t2) {
  let n2 = (e5, r2) => {
    if (e5 === t2)
      return r2;
    if (a(e5))
      return n2(e5.value, r2);
    if (d(e5))
      return n2(e5.item, r2);
    if (u(e5) || f(e5))
      for (let t3 of e5.items) {
        let r3 = n2(t3, e5);
        if (r3)
          return r3;
      }
    else if (m(e5))
      for (let t3 of e5.items) {
        let e6 = n2(t3, r2);
        if (e6)
          return e6;
      }
  };
  return n2(e4, undefined);
}
var qn = /* @__PURE__ */ new WeakSet;
var Jn = /* @__PURE__ */ new WeakSet;
var Yn = /* @__PURE__ */ new WeakMap;
var Xn = /* @__PURE__ */ new WeakMap;
function Zn(e4, t2) {
  Yn.set(e4, t2);
}
function Qn(e4, t2) {
  Xn.set(e4, t2);
}
function $n(e4) {
  Jn.add(e4);
}
var er = /* @__PURE__ */ new WeakMap;
var tr = /* @__PURE__ */ new WeakSet;
var nr = /* @__PURE__ */ new WeakSet;
function rr(e4) {
  return nr.has(e4);
}
function ir(e4) {
  nr.delete(e4);
}
function ar(e4, t2, n2) {
  xr(n2, B(e4), t2);
}
function or(e4) {
  wn(e4), qn.add(e4);
}
var sr = /* @__PURE__ */ new WeakMap;
var cr = (e4) => (sr.has(e4) || sr.set(e4, /* @__PURE__ */ new WeakMap), sr.get(e4));
function lr(e4) {
  return sr.has(e4) || sr.set(e4, /* @__PURE__ */ new WeakMap), sr.get(e4);
}
var ur = /* @__PURE__ */ new WeakMap;
function B(e4) {
  return ur.has(e4) || ur.set(e4, /* @__PURE__ */ new WeakMap), ur.get(e4);
}
function V(e4, t2, n2, r2) {
  if (m(t2)) {
    let e5 = t2.items.indexOf(n2);
    if (e5 < 0)
      throw Error(`Item not found in parent for replace`);
    t2.items.splice(e5, 1, r2);
  } else if (a(t2) && f(t2.value) && !f(n2)) {
    let e5 = t2.value.items.indexOf(n2);
    if (e5 < 0)
      throw Error(`Item not found in parent for replace`);
    t2.value.items.splice(e5, 1, r2);
  } else if (h(t2))
    t2.item = r2;
  else if (a(t2))
    t2.key === n2 ? t2.key = r2 : t2.value = r2;
  else
    throw Error(`Unsupported parent type "${t2.type}" for replace`);
  G(r2, { lines: n2.loc.start.line - r2.loc.start.line, columns: n2.loc.start.column - r2.loc.start.column });
  let i2 = x(n2.loc), o2 = x(r2.loc);
  xr({ lines: o2.lines - i2.lines, columns: o2.columns - i2.columns }, B(e4), r2, n2), Jn.has(e4) || En(e4, t2, r2), qn.add(e4);
}
function H(t2, n2, r2, i2, a2, o2, s2, c2 = false) {
  if (!m(n2))
    throw Error(`Unsupported parent type "${n2.type}" for insert`);
  i2 = i2 != null && typeof i2 == `number` ? i2 : n2.items.length;
  let l2, d2;
  u(n2) || f(n2) ? { shift: l2, offset: d2 } = hr(n2, r2, i2, Yn.get(t2) ?? 2) : a2 && e(n2) ? { shift: l2, offset: d2 } = gr(n2, r2, i2) : { shift: l2, offset: d2 } = fr(t2, n2, r2, i2, s2), G(r2, l2, { first_line_only: c2 });
  let h2 = n2.items[i2 - 1], g2 = h2 && B(t2).get(h2);
  if (g2 && (d2.lines += g2.lines, d2.columns += g2.columns, B(t2).delete(h2)), (f(n2) || u(n2)) && d2.lines !== 0 && (o2 || m(t2)) && t2 !== n2) {
    let e4 = r2.loc.start.line, i3 = o2 ?? t2.items, a3 = dr(n2, i3);
    for (let t3 = 0;t3 < i3.length; t3++) {
      let n3 = i3[t3];
      if (!p(n3))
        continue;
      let r3 = n3.loc.start.line;
      r3 < a3.loc.start.line || r3 > a3.loc.end.line || r3 < e4 && (n3.loc.start.line -= d2.lines, n3.loc.end.line -= d2.lines);
    }
  }
  B(t2).set(r2, d2), Jn.has(t2) || En(t2, n2, r2), qn.add(t2);
}
function dr(e4, t2) {
  for (let n2 of t2) {
    if (!a(n2))
      continue;
    let t3 = n2.value;
    if (!u(t3) && !f(t3))
      continue;
    let r2 = false, i2 = (t4) => {
      t4 === e4 && (r2 = true);
    };
    if (Ut(t3, { InlineArray: i2, InlineTable: i2 }), r2)
      return t3;
  }
  return e4;
}
function fr(n2, i2, a2, o2, s2) {
  if (!g(a2))
    throw Error(`Incompatible child type "${a2.type}"`);
  let c2 = i2.items[o2 - 1], l2 = e(i2) && !i2.items.length, u2 = e(i2) && !l2 && c2 === undefined;
  i2.items.splice(o2, 0, a2);
  let d2;
  if (c2 !== undefined) {
    if (Jn.has(n2))
      d2 = c2;
    else {
      let e4 = false;
      for (let t2 = 0;t2 < o2; t2++)
        if (p(i2.items[t2])) {
          e4 = true;
          break;
        }
      if (!e4)
        d2 = c2;
      else {
        let e5 = -1, t2 = -1;
        for (let n3 = 0;n3 < o2; n3++) {
          let r2 = i2.items[n3], a3 = r2.loc.end;
          (a3.line > e5 || a3.line === e5 && a3.column > t2) && (e5 = a3.line, t2 = a3.column, d2 = r2);
        }
      }
    }
  }
  let f2 = d2 ? { line: d2.loc.end.line, column: p(d2) ? i2.loc.start.column : d2.loc.start.column } : T(i2.loc.start), m2 = t(a2) || r(a2), h2 = 0;
  s2 === undefined ? l2 || u2 || (h2 = m2 ? 2 : 1) : h2 = s2, f2.line += h2;
  let _2 = { lines: f2.line - a2.loc.start.line, columns: f2.column - a2.loc.start.column }, v2 = x(a2.loc), y2 = !Jn.has(n2) && c2 === undefined && (t(i2) || r(i2) || e(i2)) && er.has(i2), b2 = y2 && !tr.has(i2);
  y2 && (er.delete(i2), tr.delete(i2));
  let S2 = y2 && !b2, C2 = 0;
  if (S2) {
    let e4 = t(i2) || r(i2) ? B(n2).get(i2.key) : cr(n2).get(i2);
    C2 = e4 ? -e4.lines : 1;
  }
  let w2 = b2 || S2 ? h2 - 2 : h2 - 1, E2 = { lines: u2 ? v2.lines + 1 : v2.lines + w2, columns: v2.columns };
  return { shift: { lines: _2.lines + C2, columns: _2.columns }, offset: E2 };
}
function pr(e4, t2, n2, r2 = {}) {
  let { useNewLine: i2 = false, skipCommaSpace: a2 = 2, skipBracketSpace: o2 = 1, hasCommaHandling: s2 = false, isLastElement: c2 = false, hasSeparatingCommaBefore: l2 = false, hasSeparatingCommaAfter: d2 = false, hasTrailingComma: m2 = false, indentWidth: h2 = 2 } = r2, g2 = n2 > 0 ? e4.items[n2 - 1] : undefined, _2 = g2 ? { line: g2.loc.end.line, column: i2 ? p(g2) ? e4.loc.start.column : g2.loc.start.column : g2.loc.end.column } : T(e4.loc.start);
  if (!g2 && i2) {
    let t3 = e4.items.find((e5, t4) => t4 > n2 && !p(e5));
    t3 ? _2.column = t3.loc.start.column : e4.loc.end.line > e4.loc.start.line && (_2.column = (u(e4) || f(e4) ? Xn.get(e4) : undefined) ?? e4.loc.end.column - 1 + h2);
  }
  let v2 = 0;
  if (i2)
    v2 = 1;
  else {
    let e5 = l2 || !s2 && !!g2;
    e5 && s2 ? _2.column += a2 : (e5 || s2 && !g2) && (_2.column += o2);
  }
  _2.line += v2;
  let y2 = { lines: _2.line - t2.loc.start.line, columns: _2.column - t2.loc.start.column }, b2 = x(t2.loc);
  if (!s2)
    return { shift: y2, offset: { lines: b2.lines + (v2 - 1), columns: b2.columns } };
  let S2 = l2 && m2 && !d2 && c2, C2 = 0;
  S2 && (C2 = -1);
  let w2 = b2.columns + (l2 || d2 ? a2 : 0) + (m2 ? 1 + C2 : 0);
  return i2 && c2 && g2 && e4.loc.end.line === g2.loc.end.line && (w2 = b2.columns - (g2.loc.end.column - g2.loc.start.column)), { shift: y2, offset: { lines: b2.lines + (v2 - 1), columns: w2 } };
}
function mr(e4) {
  return pe(e4) ?? 2;
}
function hr(e4, t2, n2, r2) {
  if (!d(t2))
    throw Error(`Incompatible child type "${t2.type}"`);
  let i2 = mr(e4), a2 = n2 == null ? P(e4.items) : e4.items[n2 - 1], o2 = n2 == null || n2 === e4.items.length, s2 = n2 == null ? undefined : e4.items[n2];
  e4.items.splice(n2, 0, t2);
  let c2 = !!a2, l2 = !o2;
  return c2 && (a2.comma = true), l2 && (t2.comma = true), pr(e4, t2, n2, { useNewLine: br(e4, t2) && !(a2 && s2 && s2.loc.start.line === a2.loc.end.line && s2.loc.start.column >= a2.loc.end.column) && !(Fn(e4) !== true && f(e4) && !s2 && a2 && a2.loc.end.line === e4.loc.end.line), skipCommaSpace: i2, hasCommaHandling: true, isLastElement: o2, hasSeparatingCommaBefore: c2, hasSeparatingCommaAfter: l2, hasTrailingComma: o2 && t2.comma === true, indentWidth: r2 });
}
function gr(e4, t2, n2) {
  let r2 = pr(e4, t2, n2, { useNewLine: false, hasCommaHandling: false });
  return e4.items.splice(n2, 0, t2), r2;
}
function U(n2, i2, a2, o2) {
  if (!m(i2))
    throw Error(`Unsupported parent type "${i2.type}" for remove`);
  Jn.has(n2) || En(n2, i2);
  let s2 = i2.items.indexOf(a2);
  if (s2 < 0) {
    if (s2 = i2.items.findIndex((e4) => h(e4) && e4.item === a2), s2 < 0)
      throw Error(`Node not found in parent for removal`);
    a2 = i2.items[s2];
  }
  let c2 = i2.items[s2 - 1], l2 = i2.items[s2 + 1];
  i2.items.splice(s2, 1);
  let g2 = x(a2.loc);
  l2 && p(l2) && l2.loc.start.line === a2.loc.end.line && (g2 = x({ start: a2.loc.start, end: l2.loc.end }), l2 = i2.items[s2 + 1], i2.items.splice(s2, 1));
  let _2 = c2 && d(c2) || l2 && d(l2), v2 = c2 ? B(n2).get(c2) : undefined, y2 = c2 && c2.loc.end.line === a2.loc.start.line + ((v2 == null ? undefined : v2.lines) ?? 0), b2 = l2 && l2.loc.start.line === a2.loc.end.line, S2 = _2 && (y2 || b2), C2 = { lines: -(g2.lines - +!!S2), columns: S2 ? -g2.columns : 0 };
  if ((e(i2) || t(i2) || r(i2)) && l2 && !S2 && l2.loc.start.line > a2.loc.end.line) {
    let e4 = t(a2) || r(a2), o3 = t(l2) || r(l2), u2 = -1;
    for (let e5 = 0;e5 < s2; e5++) {
      let t2 = i2.items[e5].loc.end.line;
      t2 > u2 && (u2 = t2);
    }
    let d2 = c2 ? B(n2).get(c2) : undefined, f2 = B(n2).get(a2), p2 = c2 ? e4 ? a2.loc.start.line + ((d2 == null ? undefined : d2.lines) ?? 0) - u2 - 1 : 0 : o3 ? l2.loc.start.line + ((f2 == null ? undefined : f2.lines) ?? 0) - a2.loc.end.line - 1 : 0;
    p2 > 0 && (C2.lines -= p2);
  }
  let w2 = (f(i2) || u(i2)) && i2.loc.end.line > i2.loc.start.line, T2 = w2 && a2.loc.start.line === i2.loc.start.line;
  w2 && !T2 && c2 === undefined && l2 === undefined && a2.loc.start.line > i2.loc.start.line && i2.loc.end.line > a2.loc.end.line && Hn(i2), c2 === undefined && l2 === undefined && (!w2 || T2) && (C2.lines = 0, C2.columns = 0, (f(i2) || u(i2)) && nr.add(i2), (t(i2) || r(i2) || e(i2)) && er.set(i2, true)), (c2 !== undefined || l2 !== undefined) && (t(i2) || r(i2) || e(i2)) && tr.add(i2);
  let E2 = u(i2) || f(i2) ? mr(i2) : 2;
  if (_2 && y2 && (C2.columns -= E2), _2 && !c2 && l2 && (br(i2) || (C2.columns -= E2)), _2 && c2 && !l2 && (c2.comma = !!a2.comma, y2)) {
    var D2;
    let e4 = c2 ? ((D2 = B(n2).get(c2)) == null ? undefined : D2.columns) ?? 0 : 0;
    C2.columns = c2.loc.end.column - a2.loc.end.column - e4;
  }
  let O2, k2;
  c2 ? (O2 = c2, k2 = B(n2)) : (t(i2) || r(i2)) && (`key` in i2) ? (O2 = i2.key, k2 = B(n2)) : (O2 = i2, k2 = cr(n2));
  let A2 = B(n2), j2 = k2.get(O2);
  j2 && (C2.lines += j2.lines, C2.columns += j2.columns);
  let ee2 = A2.get(a2);
  if (ee2 && (C2.lines += ee2.lines, S2 && (C2.columns += ee2.columns)), k2.set(O2, C2), qn.add(n2), w2 && (o2 || m(n2)) && n2 !== i2) {
    let e4 = a2.loc.start.line, t2 = o2 ?? n2.items, r2 = dr(i2, t2), s3 = [];
    for (let n3 = 0;n3 < t2.length; n3++) {
      let a3 = t2[n3];
      if (!p(a3))
        continue;
      let o3 = a3.loc.start.line;
      o3 < r2.loc.start.line || o3 > r2.loc.end.line || (o3 === e4 && (o3 < i2.loc.end.line || a3.loc.start.column < i2.loc.end.column) ? s3.push(n3) : C2.lines !== 0 && o3 < e4 && (a3.loc.start.line -= C2.lines, a3.loc.end.line -= C2.lines));
    }
    for (let e5 = s3.length - 1;e5 >= 0; e5--)
      t2.splice(s3[e5], 1);
  }
}
function _r(e4) {
  let t2 = e4.loc.start.line, n2 = e4.loc.start.column;
  if (`key` in e4) {
    let r2 = e4.key.loc.end;
    (r2.line > t2 || r2.line === t2 && r2.column > n2) && (t2 = r2.line, n2 = r2.column);
  }
  for (let r2 = 0;r2 < e4.items.length; r2++) {
    let i2 = e4.items[r2].loc.end;
    (i2.line > t2 || i2.line === t2 && i2.column > n2) && (t2 = i2.line, n2 = i2.column);
  }
  e4.loc.end = { line: t2, column: n2 };
}
function vr(e4, t2, n2 = true) {
  if (!n2 || !t2.items.length)
    return;
  xr({ lines: 0, columns: 1 }, cr(e4), t2);
  let r2 = P(t2.items);
  xr({ lines: 0, columns: 1 }, B(e4), r2), qn.add(e4);
}
function yr(e4, t2, n2 = false) {
  if (!n2 || !t2.items.length)
    return;
  let r2 = P(t2.items);
  r2.comma = true, xr({ lines: 0, columns: 1 }, B(e4), r2), qn.add(e4);
}
function W(e4) {
  if (!qn.has(e4))
    return;
  let t2 = cr(e4), n2 = B(e4), r2 = 0, i2 = {};
  function a2(e5) {
    switch (e5.type) {
      case `Document`: {
        let t3 = e5;
        o2(t3);
        for (let e6 = 0;e6 < t3.items.length; e6++)
          a2(t3.items[e6]);
        s2(t3), _r(t3);
        break;
      }
      case `Table`: {
        let t3 = e5;
        o2(t3), a2(t3.key);
        for (let e6 = 0;e6 < t3.items.length; e6++)
          a2(t3.items[e6]);
        s2(t3), _r(t3);
        break;
      }
      case `TableArray`: {
        let t3 = e5;
        o2(t3), a2(t3.key);
        for (let e6 = 0;e6 < t3.items.length; e6++)
          a2(t3.items[e6]);
        s2(t3), _r(t3);
        break;
      }
      case `TableKey`: {
        let t3 = e5;
        o2(t3), a2(t3.item), s2(t3);
        break;
      }
      case `TableArrayKey`: {
        let t3 = e5;
        o2(t3), a2(t3.item), s2(t3);
        break;
      }
      case `KeyValue`: {
        let t3 = e5, c3 = t3.loc.start.line + r2, l3 = n2.get(t3.key);
        t3.equals += (i2[c3] || 0) + (l3 ? l3.columns : 0), o2(t3), a2(t3.key), a2(t3.value), s2(t3);
        break;
      }
      case `InlineArray`: {
        let r3 = e5;
        if (!t2.get(r3) && !n2.get(r3)) {
          c2(r3);
          for (let e6 = 0;e6 < r3.items.length; e6++)
            a2(r3.items[e6]);
          l2(r3);
          break;
        }
        o2(r3);
        for (let e6 = 0;e6 < r3.items.length; e6++)
          a2(r3.items[e6]);
        s2(r3);
        break;
      }
      case `InlineTable`: {
        let r3 = e5;
        if (!t2.get(r3) && !n2.get(r3)) {
          c2(r3);
          for (let e6 = 0;e6 < r3.items.length; e6++)
            a2(r3.items[e6]);
          l2(r3);
          break;
        }
        o2(r3);
        for (let e6 = 0;e6 < r3.items.length; e6++)
          a2(r3.items[e6]);
        s2(r3);
        break;
      }
      case `InlineItem`: {
        let t3 = e5;
        o2(t3), a2(t3.item), s2(t3);
        break;
      }
      case `Key`:
      case `String`:
      case `Integer`:
      case `Float`:
      case `Boolean`:
      case `DateTime`:
      case `Comment`:
        o2(e5), s2(e5);
        break;
      default:
        throw Error(`Unrecognized node type "${e5.type}"`);
    }
  }
  function o2(e5) {
    e5.loc.start.line += r2;
    let n3 = i2[e5.loc.start.line] || 0;
    e5.loc.start.column += n3;
    let a3 = t2.get(e5);
    a3 && (r2 += a3.lines, i2[e5.loc.start.line] = (i2[e5.loc.start.line] || 0) + a3.columns);
  }
  function s2(e5) {
    e5.loc.end.line += r2;
    let t3 = i2[e5.loc.end.line] || 0;
    e5.loc.end.column += t3;
    let a3 = n2.get(e5);
    a3 && (r2 += a3.lines, i2[e5.loc.end.line] = (i2[e5.loc.end.line] || 0) + a3.columns);
  }
  function c2(e5) {
    e5.loc.start.line += r2, e5.loc.start.column += i2[e5.loc.start.line] || 0;
  }
  function l2(e5) {
    e5.loc.end.line += r2, e5.loc.end.column += i2[e5.loc.end.line] || 0;
  }
  a2(e4), qn.delete(e4), sr.delete(e4), ur.delete(e4);
}
function G(e4, t2, n2 = {}) {
  let { lines: r2, columns: i2 } = t2;
  if (r2 === 0 && i2 === 0)
    return e4;
  let { first_line_only: o2 = false, shift_generated_multiline_end: s2 = false } = n2, c2 = e4.loc.start.line, l2 = e4.type;
  if (l2 === `Key` || l2 === `String` || l2 === `Integer` || l2 === `Float` || l2 === `Boolean` || l2 === `DateTime` || l2 === `Comment`)
    return (!o2 || e4.loc.start.line === c2) && (e4.loc.start.column += i2, e4.loc.end.line === e4.loc.start.line && (e4.loc.end.column += i2)), e4.loc.start.line += r2, e4.loc.end.line += r2, e4;
  if (l2 === `KeyValue`) {
    let t3 = e4, n3 = t3.value.type;
    if (n3 === `String` || n3 === `Integer` || n3 === `Float` || n3 === `Boolean` || n3 === `DateTime`) {
      let n4 = !o2 || t3.loc.start.line === c2;
      n4 && (t3.loc.start.column += i2, t3.loc.end.line === t3.loc.start.line && (t3.loc.end.column += i2)), t3.loc.start.line += r2, t3.loc.end.line += r2, n4 && (t3.equals += i2);
      let a2 = t3.key;
      (!o2 || a2.loc.start.line === c2) && (a2.loc.start.column += i2, a2.loc.end.column += i2), a2.loc.start.line += r2, a2.loc.end.line += r2;
      let s3 = t3.value;
      return (!o2 || s3.loc.start.line === c2) && (s3.loc.start.column += i2, s3.loc.end.line === s3.loc.start.line && (s3.loc.end.column += i2)), s3.loc.start.line += r2, s3.loc.end.line += r2, e4;
    }
  }
  let p2 = (e5) => {
    if (!o2 || e5.loc.start.line === c2) {
      e5.loc.start.column += i2;
      let t3 = (!o2 || s2) && e5.loc.end.line !== e5.loc.start.line && ((u(e5) || f(e5)) && Fn(e5) !== undefined && !Ln(e5) || d(e5) && ((u(e5.item) || f(e5.item)) && Fn(e5.item) !== undefined && !Ln(e5.item) || a(e5.item) && (u(e5.item.value) || f(e5.item.value)) && Fn(e5.item.value) !== undefined && !Ln(e5.item.value)) || a(e5) && (u(e5.value) || f(e5.value)) && Fn(e5.value) !== undefined);
      (e5.loc.end.line === e5.loc.start.line || t3) && (e5.loc.end.column += i2);
    }
    e5.loc.start.line += r2, e5.loc.end.line += r2;
  };
  return Ut(e4, { Table: p2, TableKey: p2, TableArray: p2, TableArrayKey: p2, KeyValue(e5) {
    let t3 = !o2 || e5.loc.start.line === c2;
    p2(e5), t3 && (e5.equals += i2);
  }, Key: p2, String: p2, Integer: p2, Float: p2, Boolean: p2, DateTime: p2, InlineArray: p2, InlineItem: p2, InlineTable: p2, Comment: p2 }), e4;
}
function br(e4, t2) {
  let n2 = Fn(e4);
  if (n2 === true)
    return true;
  if (n2 !== undefined || !e4.items.length)
    return false;
  let r2 = t2 ? e4.items.filter((e5) => e5 !== t2) : e4.items;
  return r2.length ? e4.loc.end.line > e4.loc.start.line && r2.every((e5, t3) => t3 === 0 || e5.loc.start.line > r2[t3 - 1].loc.start.line) : e4.loc.end.line > e4.loc.start.line;
}
function xr(e4, t2, n2, r2) {
  let i2 = t2.get(r2 || n2);
  i2 && (e4.lines += i2.lines, e4.columns += i2.columns), t2.set(n2, e4);
}
function Sr(e4) {
  let t2 = e4.match(/\r\n|\n/);
  return (t2 == null ? undefined : t2[0]) === `\r
` ? `\r
` : `
`;
}
function Cr(e4, t2) {
  var n2;
  let r2 = Sr(e4);
  e4 = e4.replace(/\r\n/g, `
`).replace(/\n/g, r2);
  let i2, a2;
  e4.startsWith(`"""\\${r2}`) ? (i2 = 4 + r2.length, a2 = `"""\\${r2}`) : e4.startsWith(`"""${r2}`) ? (i2 = 3 + r2.length, a2 = `"""${r2}`) : (i2 = 3, a2 = `"""`);
  let o2 = e4.length - 3, s2 = e4.slice(i2, o2).split(r2), c2 = s2[s2.length - 1], l2 = s2.length > 1 && /^[\t ]*$/.test(c2), u2 = l2 ? c2 : ``, d2 = (l2 ? s2.slice(0, -1) : s2).map((e5) => {
    var t3;
    if (/^[\t ]*$/.test(e5))
      return { indent: e5, content: ``, trailingWs: ``, hasBackslash: false, isBlank: true };
    let n3 = e5, r3 = 0;
    for (let e6 = n3.length - 1;e6 >= 0 && n3[e6] === `\\`; e6--)
      r3++;
    let i3 = r3 % 2 == 1;
    i3 && (n3 = n3.slice(0, -1));
    let a3 = ((t3 = n3.match(/^[\t ]*/)) == null ? undefined : t3[0]) ?? ``, o3 = n3.slice(a3.length), s3 = o3.match(/([\t ]+)$/), c3 = s3 ? s3[1] : ``;
    return { indent: a3, content: o3.slice(0, o3.length - c3.length), trailingWs: c3, hasBackslash: i3, isBlank: false };
  }), f2 = d2.filter((e5) => !e5.isBlank), p2 = Math.max(...f2.map((e5) => e5.content.length + e5.trailingWs.length), 1), m2 = f2.filter((e5) => e5.hasBackslash), h2 = m2[m2.length - 1] ?? f2[f2.length - 1] ?? { indent: ``, trailingWs: ``, hasBackslash: false, content: ``, isBlank: false }, g2 = f2[f2.length - 1] ?? h2, _2 = [];
  {
    let e5 = [], t3 = 0;
    for (let n3 of d2)
      n3.isBlank ? e5.push(n3.indent) : (t3 > 0 && _2.push(e5), e5 = [], t3++);
  }
  let v2 = f2.some((e5, t3) => !e5.hasBackslash && t3 < f2.length - 1), y2 = a2 === `"""${r2}`, b2 = y2 && f2.length > 0 ? ((n2 = t2.match(/^[\t ]*/)) == null ? undefined : n2[0]) ?? `` : ``, x2 = (e5) => {
    let t3 = e5.match(/\S+| +/g) ?? [], n3 = [], r3 = 0;
    for (;r3 < t3.length; ) {
      let e6 = t3[r3++];
      for (;r3 < t3.length && t3[r3][0] === ` `; ) {
        let n4 = t3[r3], i3 = t3[r3 + 1];
        if (!i3) {
          r3++;
          break;
        }
        if (e6.length + n4.length + i3.length <= p2)
          e6 += n4 + i3, r3 += 2;
        else {
          e6 += n4, r3++;
          break;
        }
      }
      n3.push(e6);
    }
    return n3.length === 0 && n3.push(``), n3;
  }, S2 = [], C2 = [], w2 = /* @__PURE__ */ new Set, T2 = /* @__PURE__ */ new Set, E2 = /* @__PURE__ */ new Map, D2 = false;
  if (v2 && t2.includes(r2) && (r2 === `\r
` || !t2.includes(`\r
`))) {
    D2 = true;
    let e5 = t2.split(r2), n3 = e5[0].slice(b2.length);
    if (n3.length > 0 && n3[0] === ` `)
      return null;
    let i3 = e5[e5.length - 1];
    if (i3.length > 0 && i3.length - i3.trimEnd().length !== g2.trailingWs.length)
      return null;
    for (let t3 = 0;t3 < e5.length; t3++) {
      var O2;
      let n4 = e5[t3], r3 = t3 === 0 ? n4.slice(b2.length) : n4, i4 = ((O2 = r3.match(/^[\t ]*/)) == null ? undefined : O2[0]) ?? ``, a3 = x2(r3.slice(i4.length)), o3 = S2.length;
      T2.add(o3), t3 > 0 && E2.set(o3, i4);
      for (let e6 of a3)
        S2.push(e6);
      t3 < e5.length - 1 && w2.add(o3 + a3.length - 1);
    }
  } else {
    let e5 = t2.replace(/\r\n/g, `\\r\\n`).replace(/\n/g, `\\n`).slice(b2.length);
    if (e5.length > 0 && (e5[0] === ` ` || e5.length - e5.trimEnd().length !== g2.trailingWs.length))
      return null;
    if (!v2) {
      let t3 = 0, n4 = 0;
      for (let r3 = 0;r3 < f2.length - 1; r3++) {
        let i4 = f2[r3];
        if (!i4.hasBackslash)
          break;
        let a3 = i4.content + i4.trailingWs;
        if (e5.slice(n4, n4 + a3.length) === a3)
          t3++, n4 += a3.length;
        else
          break;
      }
      let i3 = 0, o3 = 0;
      for (let r3 = f2.length - 1;r3 >= t3; r3--) {
        let t4 = f2[r3], a3 = t4.content + t4.trailingWs;
        if (a3.length === 0)
          break;
        let s4 = e5.length - o3 - a3.length;
        if (s4 >= n4 && e5.slice(s4, s4 + a3.length) === a3)
          i3++, o3 += a3.length;
        else
          break;
      }
      if (i3 > 0) {
        let s4 = e5.slice(n4, e5.length - o3);
        if (s4.length === 0 || s4[0] !== ` `) {
          for (let e7 = 0;e7 < t3; e7++) {
            let n5 = f2[e7];
            if (C2.push(`${n5.indent}${n5.content}${n5.trailingWs}\\`), e7 < t3 - 1 && e7 < _2.length && _2[e7].length > 0)
              for (let t4 of _2[e7])
                C2.push(t4);
          }
          if (s4.length > 0) {
            let e7 = x2(s4), n5 = e7.join(``), r3 = /(?<!\\)\\n/.test(n5);
            if (t3 > 0 && !r3) {
              let e8 = t3 - 1;
              if (e8 < _2.length && _2[e8].length > 0)
                for (let t4 of _2[e8])
                  C2.push(t4);
            }
            for (let n6 = 0;n6 < e7.length; n6++) {
              let i4 = e7[n6], a4 = t3 + n6, o4 = a4 < f2.length ? f2[a4] : null, c3 = o4 ? y2 && a4 === 0 ? b2 : o4.indent : h2.indent, l3 = i4.length > 0 && /\s$/.test(i4) ? `` : s4.endsWith(` `) ? ` ` : ``;
              if (C2.push(`${c3}${i4}${l3}\\`), n6 < e7.length - 1 && !r3) {
                let e8 = t3 + n6;
                if (e8 < _2.length && _2[e8].length > 0)
                  for (let t4 of _2[e8])
                    C2.push(t4);
              }
            }
            let a3 = f2.length - i3 - 1;
            if (!r3 && a3 >= 0 && a3 < _2.length && _2[a3].length > 0)
              for (let e8 of _2[a3])
                C2.push(e8);
          } else if (t3 > 0) {
            let e7 = t3 - 1;
            if (e7 < _2.length && _2[e7].length > 0)
              for (let t4 of _2[e7])
                C2.push(t4);
          }
          let e6 = f2.length - i3;
          for (let t4 = e6;t4 < f2.length; t4++) {
            let n5 = f2[t4], r3 = t4 === f2.length - 1;
            if (t4 > e6) {
              let e7 = t4 - 1;
              if (e7 < _2.length && _2[e7].length > 0)
                for (let t5 of _2[e7])
                  C2.push(t5);
            }
            C2.push(r3 ? `${n5.indent}${n5.content}${n5.trailingWs}${n5.hasBackslash && n5.content !== `` ? `\\` : ``}` : `${n5.indent}${n5.content}${n5.trailingWs}\\`);
          }
          return l2 && !(g2.hasBackslash && g2.content === ``) ? `${a2}${C2.join(r2)}${r2}${u2}"""` : `${a2}${C2.join(r2)}"""`;
        }
      }
      let s3 = e5.slice(n4);
      if (t3 > 0 && (n4 === e5.length || s3.length > 0 && s3[0] !== ` `)) {
        for (let e6 = 0;e6 < t3; e6++) {
          let n5 = f2[e6];
          if (C2.push(`${n5.indent}${n5.content}${n5.trailingWs}\\`), e6 < t3 - 1 && e6 < _2.length && _2[e6].length > 0)
            for (let t4 of _2[e6])
              C2.push(t4);
        }
        if (n4 === e5.length) {
          let e6 = f2[t3 - 1], n5 = g2.hasBackslash && e6.content !== `` ? `\\` : ``;
          C2[C2.length - 1] = `${e6.indent}${e6.content}${g2.trailingWs}${n5}`;
        } else {
          let e6 = x2(s3), n5 = e6.join(``), r3 = /(?<!\\)\\n/.test(n5), i4 = t3 - 1;
          if (!r3 && i4 < _2.length && _2[i4].length > 0)
            for (let e7 of _2[i4])
              C2.push(e7);
          for (let n6 = 0;n6 < e6.length; n6++) {
            let i5 = n6 === e6.length - 1, a3 = e6[n6], o4 = t3 + n6, s4 = o4 < f2.length ? f2[o4] : null, c3 = s4 ? y2 && o4 === 0 ? b2 : s4.indent : i5 ? g2.indent : h2.indent, l3, u3;
            if (i5 ? (l3 = g2.trailingWs, u3 = g2.hasBackslash && g2.content !== `` ? `\\` : ``) : (l3 = a3.length > 0 && /\s$/.test(a3) ? `` : ` `, u3 = `\\`), C2.push(`${c3}${a3}${l3}${u3}`), !i5) {
              let e7 = t3 + n6;
              if (!r3 && e7 < _2.length && _2[e7].length > 0)
                for (let t4 of _2[e7])
                  C2.push(t4);
            }
          }
        }
        return l2 && !(g2.hasBackslash && g2.content === ``) ? `${a2}${C2.join(r2)}${r2}${u2}"""` : `${a2}${C2.join(r2)}"""`;
      }
    }
    let n3 = x2(e5);
    for (let e6 of n3)
      S2.push(e6);
  }
  for (let e5 = 0;e5 < S2.length; e5++) {
    let t3 = e5 === S2.length - 1, n3 = w2.has(e5), r3 = t3 || n3, i3 = e5 < f2.length ? f2[e5] : null, a3 = D2 && T2.has(e5) && e5 > 0 ? E2.get(e5) ?? `` : i3 ? y2 && e5 === 0 ? b2 : i3.indent : r3 ? g2.indent : h2.indent, o3 = S2[e5], s3, c3;
    if (r3 && t3 ? (s3 = g2.trailingWs, c3 = g2.hasBackslash && g2.content !== `` ? `\\` : ``) : r3 ? (s3 = g2.trailingWs, c3 = ``) : (s3 = o3.length > 0 && /\s$/.test(o3) ? `` : ` `, c3 = `\\`), C2.push(`${a3}${o3}${s3}${c3}`), !t3 && !n3 && !D2) {
      let t4 = S2.join(``);
      if (!/(?<!\\)\\n/.test(t4) && e5 < _2.length && _2[e5].length > 0)
        for (let t5 of _2[e5])
          C2.push(t5);
    }
  }
  return l2 && !(g2.hasBackslash && g2.content === ``) ? `${a2}${C2.join(r2)}${r2}${u2}"""` : `${a2}${C2.join(r2)}"""`;
}
function wr(e4) {
  if (e4.includes(`'`))
    return false;
  for (let t2 = 0;t2 < e4.length; t2++) {
    let n2 = e4.charCodeAt(t2);
    if (n2 < 32 && n2 !== 9 || n2 === 127)
      return false;
  }
  return true;
}
function Tr(e4) {
  if (e4.includes(`'''`))
    return false;
  for (let t2 = 0;t2 < e4.length; t2++) {
    let n2 = e4.charCodeAt(t2);
    if (n2 === 13) {
      if (e4.charCodeAt(t2 + 1) !== 10)
        return false;
    } else if (n2 < 32 && n2 !== 9 && n2 !== 10 || n2 === 127)
      return false;
  }
  return true;
}
function Er(e4) {
  switch (e4) {
    case `b`:
      return `\b`;
    case `t`:
      return `	`;
    case `n`:
      return `
`;
    case `f`:
      return `\f`;
    case `r`:
      return `\r`;
    case `"`:
      return `"`;
    case `\\`:
      return `\\`;
    default:
      return null;
  }
}
function Dr(e4, t2) {
  return t2 === `singleline-basic` ? e4 <= 31 || e4 === 127 : e4 >= 0 && e4 <= 7 || e4 === 11 || e4 >= 14 && e4 <= 31 || e4 === 127;
}
function Or(e4, t2, n2) {
  switch (e4) {
    case `\\`:
      return `\\\\`;
    case `\b`:
      return `\\b`;
    case `	`:
      return `\\t`;
    case `\f`:
      return `\\f`;
    case `"`:
      return t2 === `singleline-basic` ? `\\"` : `"`;
    case `
`:
      return t2 === `singleline-basic` ? `\\n` : `
`;
    case `\r`:
      return t2 === `singleline-basic` ? `\\r` : `\r`;
    default: {
      let r2 = e4.charCodeAt(0);
      if (Dr(r2, t2)) {
        let e5 = r2.toString(16).padStart(4, `0`);
        return `\\u${n2 ? e5.toUpperCase() : e5}`;
      }
      return e4;
    }
  }
}
function kr(e4) {
  return e4.replace(/(\\+)u([0-9a-f]{4})/g, (e5, t2, n2) => t2.length % 2 == 1 ? `${t2}u${n2.toUpperCase()}` : e5);
}
function Ar(e4) {
  let t2 = /* @__PURE__ */ new Map;
  for (let n2 = 0;n2 < e4.length; n2++) {
    if (e4[n2] !== `\\`)
      continue;
    let r2 = e4[n2 + 1];
    if (!r2)
      continue;
    let i2 = Er(r2);
    if (i2 !== null)
      i2 !== `
` && i2 !== `\r` && !t2.has(i2) && t2.set(i2, `\\` + r2), n2 += 1;
    else if (r2 === `x` && /^[0-9A-Fa-f]{2}$/.test(e4.slice(n2 + 2, n2 + 4))) {
      let r3 = e4.slice(n2, n2 + 4), i3 = Number.parseInt(e4.slice(n2 + 2, n2 + 4), 16), a2 = String.fromCharCode(i3);
      t2.has(a2) || t2.set(a2, r3), n2 += 3;
    } else if (r2 === `u` && /^[0-9A-Fa-f]{4}$/.test(e4.slice(n2 + 2, n2 + 6))) {
      let r3 = e4.slice(n2, n2 + 6), i3 = Number.parseInt(e4.slice(n2 + 2, n2 + 6), 16), a2 = String.fromCodePoint(i3);
      t2.has(a2) || t2.set(a2, r3), n2 += 5;
    } else if (r2 === `U` && /^[0-9A-Fa-f]{8}$/.test(e4.slice(n2 + 2, n2 + 10))) {
      let r3 = e4.slice(n2, n2 + 10), i3 = Number.parseInt(e4.slice(n2 + 2, n2 + 10), 16), a2 = String.fromCodePoint(i3);
      t2.has(a2) || t2.set(a2, r3), n2 += 9;
    }
  }
  return t2;
}
function jr(e4, t2, n2, r2) {
  let i2 = ``;
  for (let a2 of e4) {
    let e5 = t2.get(a2);
    i2 += e5 || Or(a2, n2, r2);
  }
  return i2;
}
function Mr(e4, t2, n2, r2 = true) {
  let i2 = Ar(t2);
  if (i2.size === 0 && n2 === `singleline-basic`) {
    let t3 = JSON.stringify(e4).slice(1, -1).replace(/\x7f/g, `\\u007f`);
    return r2 ? kr(t3) : t3;
  }
  let a2 = jr(e4, i2, n2, r2);
  return n2 === `multiline-basic` ? a2.replace(/\r(?!\n)/g, `\\r`).replace(/"""/g, `""\\"`) : a2;
}
function Nr() {
  return { type: `Document`, loc: { start: D(), end: D() }, items: [] };
}
function K(e4, t2 = true) {
  let n2 = Pr(e4, t2);
  return { type: `Table`, loc: E(n2.loc), key: n2, items: [] };
}
function Pr(e4, t2 = true) {
  let n2 = zr(e4, t2);
  return { type: `TableKey`, loc: { start: D(), end: { line: 1, column: n2.length + 2 } }, item: { type: `Key`, loc: { start: { line: 1, column: 1 }, end: { line: 1, column: n2.length + 1 } }, value: e4, raw: n2 } };
}
function Fr(e4, t2 = true) {
  let n2 = Ir(e4, t2);
  return { type: `TableArray`, loc: E(n2.loc), key: n2, items: [] };
}
function Ir(e4, t2 = true) {
  let n2 = zr(e4, t2);
  return { type: `TableArrayKey`, loc: { start: D(), end: { line: 1, column: n2.length + 4 } }, item: { type: `Key`, loc: { start: { line: 1, column: 2 }, end: { line: 1, column: n2.length + 2 } }, value: e4, raw: n2 } };
}
function Lr(e4, t2, n2 = false, r2 = true) {
  let i2 = Br(e4, r2), { column: a2 } = i2.loc.end, o2 = a2 + 1;
  return G(t2, { lines: 1 - t2.loc.start.line, columns: a2 + 3 - t2.loc.start.column }, { first_line_only: true, shift_generated_multiline_end: n2 }), { type: `KeyValue`, loc: { start: T(i2.loc.start), end: T(t2.loc.end) }, key: i2, equals: o2, value: t2 };
}
function Rr(e4, t2 = true) {
  let n2 = JSON.stringify(e4).replace(/\x7f/g, `\\u007f`);
  return t2 ? kr(n2) : n2;
}
function zr(e4, t2 = true) {
  return e4.map((e5) => (Ht(e5, `Key ${JSON.stringify(e5)}`), A.test(e5) ? e5 : Rr(e5, t2))).join(`.`);
}
function Br(e4, t2 = true) {
  let n2 = zr(e4, t2);
  return { type: `Key`, loc: { start: D(), end: { line: 1, column: n2.length } }, raw: n2, value: e4 };
}
function Vr(e4, t2, n2 = true) {
  return Ht(e4, `String value`), t2 ? Hr(e4, t2, n2) : Ur(e4, undefined, n2);
}
function Hr(e4, t2, n2) {
  if (kt(t2))
    return Ur(e4, t2, n2);
  if (jt(t2))
    return wr(e4) ? Wr(e4) : Tr(e4) ? qr(e4, `'''${t2.slice(1, -1)}'''`) : Ur(e4, undefined, n2);
  if (Mt(t2))
    return Tr(e4) ? qr(e4, t2) : Kr(e4, `"""${t2.slice(3, -3)}"""`, n2);
  if (At(t2))
    return Kr(e4, t2, n2);
  throw Error(`Existing raw string value is not valid: ${t2}`);
}
function Ur(e4, t2, n2 = true) {
  let r2 = ``;
  return r2 = t2 ? `"${Mr(e4, t2, `singleline-basic`, n2)}"` : Rr(e4, n2), { type: `String`, loc: { start: D(), end: { line: 1, column: r2.length } }, raw: r2, value: e4 };
}
function Wr(e4) {
  let t2 = `'${e4}'`, n2;
  if (t2.includes(`
`)) {
    let e5 = t2.split(/\r\n|\n/), r2 = e5[e5.length - 1];
    n2 = { line: e5.length, column: r2.length };
  } else
    n2 = { line: 1, column: t2.length };
  return { type: `String`, loc: { start: D(), end: n2 }, raw: t2, value: e4 };
}
function Gr(e4, t2, n2) {
  return e4.startsWith(t2 + `\r
`) ? `\r
` : e4.startsWith(t2 + `
`) ? `
` : n2.startsWith(`\r
`) ? `\r
` : n2.startsWith(`
`) ? `
` : ``;
}
function Kr(e4, t2, n2 = true) {
  let r2 = Mr(e4, t2, `multiline-basic`, n2), i2 = `"""` + Gr(t2, `"""`, r2) + r2 + `"""`, a2 = t2.slice(3, -3);
  if (/(^|[^\\])(\\\\)*\\$/m.test(a2)) {
    let e5 = Cr(t2, r2);
    e5 !== null && (i2 = e5);
  }
  let o2 = Jr(i2);
  return { type: `String`, loc: { start: D(), end: o2 }, raw: i2, value: e4 };
}
function qr(e4, t2) {
  let n2 = `'''` + Gr(t2, `'''`, e4) + e4 + `'''`, r2 = Jr(n2);
  return { type: `String`, loc: { start: D(), end: r2 }, raw: n2, value: e4 };
}
function Jr(e4) {
  if (e4.includes(`
`)) {
    let t2 = e4.split(/\r\n|\n/), n2 = t2[t2.length - 1];
    return { line: t2.length, column: n2.length };
  }
  return { line: 1, column: e4.length };
}
function Yr(e4) {
  let t2 = e4.toString();
  return { type: `Integer`, loc: { start: D(), end: { line: 1, column: t2.length } }, raw: t2, value: e4 };
}
function Xr(e4, t2 = 1) {
  let n2, r2;
  if (e4 === 1 / 0)
    n2 = `inf`;
  else if (e4 === -1 / 0)
    n2 = `-inf`;
  else if (Number.isNaN(e4)) {
    let t3 = _t(e4);
    r2 = t3 ? `-` : undefined, n2 = t3 ? `-nan` : `nan`;
  } else if (Object.is(e4, -0))
    n2 = `-0.` + `0`.repeat(Math.max(t2, 1));
  else {
    n2 = e4.toString();
    let r3 = n2.search(/[eE]/);
    if (r3 !== -1) {
      let e5 = n2.slice(0, r3), i2 = n2.slice(r3), a2 = e5.indexOf(`.`);
      if (a2 === -1)
        n2 = `${e5}.${`0`.repeat(Math.max(t2, 1))}${i2}`;
      else {
        let r4 = e5.length - a2 - 1;
        n2 = r4 < t2 ? `${e5}${`0`.repeat(t2 - r4)}${i2}` : `${e5}${i2}`;
      }
    } else {
      let e5 = n2.indexOf(`.`);
      if (e5 === -1)
        n2 += `.` + `0`.repeat(Math.max(t2, 1));
      else {
        let r4 = n2.length - e5 - 1;
        r4 < t2 && (n2 += `0`.repeat(t2 - r4));
      }
    }
  }
  return { type: `Float`, loc: { start: D(), end: { line: 1, column: n2.length } }, raw: n2, value: e4, ...r2 === undefined ? {} : { nanSign: r2 } };
}
function Zr(e4) {
  return { type: `Boolean`, loc: { start: D(), end: { line: 1, column: e4 ? 4 : 5 } }, value: e4 };
}
function Qr(e4, t2 = false, n2 = 0) {
  t2 && !(e4 instanceof De) && e4.getUTCHours() === 0 && e4.getUTCMinutes() === 0 && e4.getUTCSeconds() === 0 && e4.getUTCMilliseconds() === 0 && (e4 = new Ee(e4.toISOString().split(`T`)[0]));
  let r2 = we(e4.toISOString(), n2);
  return { type: `DateTime`, loc: { start: D(), end: { line: 1, column: r2.length } }, raw: r2, value: e4 };
}
function $r(e4, t2 = false, n2 = 0) {
  var r2;
  let i2 = ((r2 = e4.constructor) == null ? undefined : r2.name) ?? ``, a2 = i2 === `Temporal.PlainDate` || i2 === `PlainDate`, o2 = i2 === `Temporal.PlainTime` || i2 === `PlainTime`, s2 = i2 === `Temporal.PlainDateTime` || i2 === `PlainDateTime`, c2;
  if (a2)
    c2 = Et(e4);
  else if (o2)
    c2 = Et(e4);
  else if (s2) {
    if (t2) {
      let t3 = globalThis.Temporal;
      if (!t3)
        throw Error(`Temporal API is not available in this runtime. Set temporal: false or use a runtime with Temporal support.`);
      let r3 = t3.PlainDate.from(e4.toString().split(`T`)[0]);
      if (r3.toString() + `T00:00:00` === e4.toString().slice(0, 19))
        return c2 = we(Et(r3), n2), { type: `DateTime`, loc: { start: D(), end: { line: 1, column: c2.length } }, raw: c2, value: r3 };
    }
    c2 = Et(e4);
  } else
    c2 = Et(e4);
  return c2 = we(c2, n2), { type: `DateTime`, loc: { start: D(), end: { line: 1, column: c2.length } }, raw: c2, value: e4 };
}
function ei() {
  return { type: `InlineArray`, loc: { start: D(), end: { line: 1, column: 2 } }, items: [] };
}
function q(e4) {
  return { type: `InlineItem`, loc: E(e4.loc), item: e4, comma: false };
}
function ti() {
  return { type: `InlineTable`, loc: { start: D(), end: { line: 1, column: 2 } }, items: [] };
}
function ni(e4) {
  return e4.startsWith(`#`) || (e4 = `# ${e4}`), { type: `Comment`, loc: { start: D(), end: { line: 1, column: e4.length } }, raw: e4 };
}
function ri(e4) {
  return !u(e4) || e4.items.length === 0 ? false : e4.items[e4.items.length - 1].comma === true;
}
function ii(e4) {
  return !f(e4) || e4.items.length === 0 ? false : e4.items[e4.items.length - 1].comma === true;
}
function ai(e4, t2) {
  return t2.inlineTableStart === 0 || (e4.items.filter((e5) => {
    if (!a(e5))
      return false;
    let n2 = f(e5.value), r2 = u(e5.value) && e5.value.items.length > 0 && e5.value.items.every((e6) => f(e6.item));
    if (n2 || r2) {
      let n3 = mi(e5.key.value);
      return t2.inlineTableStart === undefined || n3 < t2.inlineTableStart;
    }
    return false;
  }).forEach((n2) => {
    U(e4, e4, n2), f(n2.value) ? n2.value.items.length === 0 ? H(e4, e4, K(n2.key.value)) : H(e4, e4, oi(n2, t2.bracketSpacing, t2.escapeSequenceUpperCase)) : si(n2, t2.bracketSpacing, t2.escapeSequenceUpperCase).forEach((t3) => {
      H(e4, e4, t3);
    });
  }), W(e4)), e4;
}
function oi(e4, t2, n2) {
  let r2 = K(e4.key.value, n2);
  $n(r2);
  for (let t3 of e4.value.items)
    H(r2, r2, t3.item, undefined, undefined, undefined, undefined, true);
  return W(r2), di(r2, 1, t2), r2;
}
function si(e4, n2, i2) {
  let a2 = Nr();
  $n(a2);
  for (let t2 of e4.value.items) {
    let n3 = Fr(e4.key.value, i2);
    H(a2, a2, n3);
    for (let e5 of t2.item.items)
      H(a2, n3, e5.item, undefined, undefined, undefined, undefined, true);
  }
  W(a2);
  for (let e5 of a2.items)
    (t(e5) || r(e5)) && di(e5, 1, n2);
  return a2.items;
}
function ci(e4) {
  let t2 = Fn(e4);
  return t2 === undefined ? Wn(e4) : t2;
}
function li(e4) {
  return Math.max(e4, 2);
}
function ui(e4, t2, n2, r2 = true) {
  let i2 = ci(e4), o2 = false;
  if (i2) {
    let i3 = t2 + n2;
    for (let t3 of e4.items)
      G(t3, { lines: 0, columns: i3 - t3.loc.start.column }), d(t3) && (u(t3.item) || f(t3.item) ? ui(t3.item, t3.item.loc.start.column, li(n2), r2) && (t3.loc.end = { ...t3.item.loc.end }, o2 = true) : a(t3.item) && (u(t3.item.value) || f(t3.item.value)) && ui(t3.item.value, t3.item.loc.start.column, n2, r2) && (t3.item.loc.end = { ...t3.item.value.loc.end }, t3.loc.end = { ...t3.item.loc.end }, o2 = true));
    e4.loc.end.column = t2 + 1, o2 = true;
  }
  for (let t3 of e4.items)
    if (d(t3)) {
      if (u(t3.item) || f(t3.item))
        ui(t3.item, t3.item.loc.start.column, li(n2), r2) && (t3.loc.end = { ...t3.item.loc.end }, o2 = true);
      else if (a(t3.item) && (u(t3.item.value) || f(t3.item.value))) {
        let e5 = t3.item.value, i3 = t3.item.loc.start.column, a2 = ci(e5);
        ui(e5, i3, n2, r2) && (a2 && (e5.loc.end.column = i3 + 1), t3.item.loc.end = { ...e5.loc.end }, t3.loc.end = { ...t3.item.loc.end }, o2 = true);
      }
    }
  let s2 = pe(e4) ?? 2;
  for (let t3 = 1;t3 < e4.items.length; t3++) {
    let n3 = e4.items[t3 - 1], r3 = e4.items[t3];
    n3.loc.end.line === r3.loc.start.line && G(r3, { lines: 0, columns: n3.loc.end.column + (n3.comma ? s2 : 1) - r3.loc.start.column });
  }
  if (o2 && !i2 && e4.items.length > 0) {
    let t3 = e4.items[e4.items.length - 1];
    e4.loc.end = { line: t3.loc.end.line, column: t3.loc.end.column + +!!t3.comma + (r2 ? 2 : 1) };
  }
  return o2;
}
function di(e4, t2, n2 = true) {
  let r2 = a(e4) ? [e4] : e4.items;
  for (let e5 of r2)
    a(e5) && (u(e5.value) || f(e5.value)) && ui(e5.value, e5.loc.start.column, t2, n2);
}
function fi(e4, t2) {
  let n2 = (e5, r2) => {
    if (r2 && (delete e5.range, Fn(e5) === true || Wn(e5))) {
      let n3 = e5.loc.start.column + t2;
      for (let t3 of e5.items)
        G(t3, { lines: 0, columns: n3 - t3.loc.start.column });
      e5.loc.end.column = e5.loc.start.column + 1;
    }
    for (let t3 of e5.items)
      d(t3) && (u(t3.item) || f(t3.item) ? n2(t3.item, u(e5) && f(t3.item)) : a(t3.item) && (u(t3.item.value) || f(t3.item.value)) && n2(t3.item.value, false));
  };
  n2(e4, false);
}
function pi(e4) {
  if (e4.items.length > 0) {
    let t2 = e4.items[e4.items.length - 1];
    e4.loc.end.line = t2.loc.end.line, e4.loc.end.column = t2.loc.end.column;
  } else
    e4.loc.end.line = e4.key.loc.end.line, e4.loc.end.column = e4.key.loc.end.column;
}
function mi(e4) {
  return Math.max(0, e4.length - 1);
}
function hi(e4, t2) {
  if (t2.inlineTableStart === undefined || t2.inlineTableStart === 0)
    return e4;
  let n2 = [];
  for (let i3 of e4.items)
    if (a(i3) && f(i3.value)) {
      if (mi(i3.key.value) < t2.inlineTableStart) {
        let r2 = oi(i3, t2.bracketSpacing, t2.escapeSequenceUpperCase);
        U(e4, e4, i3), H(e4, e4, r2), gi(r2, n2, t2);
      }
    } else
      (i3.type === `Table` || r(i3)) && gi(i3, n2, t2);
  let i2 = /* @__PURE__ */ new Map;
  for (let { table: t3, parent: r2 } of n2) {
    let n3 = e4.items.indexOf(r2), a2 = (i2.get(r2) ?? 0) + 1;
    i2.set(r2, a2), H(e4, e4, t3, n3 + a2);
  }
  return W(e4), e4;
}
function gi(e4, t2, n2) {
  let r2 = [];
  for (let t3 = 0;t3 < e4.items.length; t3++) {
    let i2 = e4.items[t3];
    if (a(i2) && f(i2.value)) {
      let t4 = [...e4.key.item.value, ...i2.key.value];
      mi(t4) < (n2.inlineTableStart ?? 1) && r2.push({ item: i2, nestedTableKey: t4 });
    }
  }
  for (let { item: i2, nestedTableKey: a2 } of r2) {
    let r3 = K(a2, n2.escapeSequenceUpperCase);
    $n(r3);
    let o2 = i2.value;
    for (let e5 of o2.items)
      H(r3, r3, e5.item);
    W(r3), U(e4, e4, i2), pi(e4), t2.push({ table: r3, parent: e4 }), gi(r3, t2, n2);
  }
  r2.length > 0 && W(e4);
}
function _i(e4) {
  let t2 = 0, n2 = 0;
  for (let r2 of e4.items)
    n2 === 0 && r2.loc.start.line > 1 ? t2 = 1 - r2.loc.start.line : r2.loc.start.line + t2 > n2 + 2 && (t2 += n2 + 2 - (r2.loc.start.line + t2)), G(r2, { lines: t2, columns: 0 }), n2 = r2.loc.end.line;
  return e4;
}
/*!
* Copyright (c) Squirrel Chat et al., All rights reserved.
* SPDX-License-Identifier: BSD-3-Clause
*
* Redistribution and use in source and binary forms, with or without
* modification, are permitted provided that the following conditions are met:
*
* 1. Redistributions of source code must retain the above copyright notice, this
*    list of conditions and the following disclaimer.
* 2. Redistributions in binary form must reproduce the above copyright notice,
*    this list of conditions and the following disclaimer in the
*    documentation and/or other materials provided with the distribution.
* 3. Neither the name of the copyright holder nor the names of its contributors
*    may be used to endorse or promote products derived from this software without
*    specific prior written permission.
*
* THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
* ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
* WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
* DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
* FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
* DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
* SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
* CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
* OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
* OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
*/
function vi(e4) {
  return e4 instanceof Date && typeof e4.isDate == `function` && typeof e4.isTime == `function` && typeof e4.isDateTime == `function`;
}
function yi(e4) {
  let t2 = e4.toISOString().replace(/\.000(?=([Zz]|[+-]\d{2}:\d{2})$|$)/, ``);
  return e4.isDate() ? new Ee(t2) : e4.isTime() ? new De(t2, t2) : e4.isLocal() ? new Oe(t2, false) : new ke(t2, false);
}
function bi(e4) {
  return e4.items.length > 0 && e4.loc.end.line - e4.loc.start.line + 1 > e4.items.length;
}
function xi(e4) {
  return u(e4) || f(e4);
}
function Si(e4, t2, n2) {
  if (!d(t2) || !xi(t2.item) || !bi(e4))
    return;
  let r2 = e4.items.find((e5) => xi(e5.item) && e5.item.type === t2.item.type && bi(e5.item));
  if (!r2 || !xi(r2.item))
    return;
  let i2 = t2.item, a2 = r2.item, o2 = a2.items.length > 0 ? a2.items[0].loc.start.column - a2.loc.start.column : n2, s2 = a2.items.length > 0 ? a2.items[0].loc.start.line - a2.loc.start.line : 1, c2 = a2.items.length > 0 ? a2.loc.end.line - a2.items[a2.items.length - 1].loc.end.line : 1, l2 = i2.loc.start.line, u2 = i2.loc.start.column, f2 = l2 + s2;
  for (let e5 of i2.items)
    G(e5, { lines: f2 - e5.loc.start.line, columns: u2 + o2 - e5.loc.start.column }), f2 = e5.loc.end.line + 1;
  i2.loc.end = { line: f2 - 1 + c2, column: a2.loc.end.column }, In(i2), t2.loc = { start: T(i2.loc.start), end: T(i2.loc.end) };
}
function Ci(e4, t2) {
  let n2 = (e5) => {
    let r2 = false;
    for (let i2 of e5.items) {
      if (!d(i2) || !xi(i2.item))
        continue;
      let a2 = i2.item;
      if (f(a2) && Wn(a2)) {
        delete i2.range, delete a2.range;
        let n3 = a2.loc.start.column + Math.max(t2, 2);
        for (let e6 of a2.items)
          G(e6, { lines: 0, columns: n3 - e6.loc.start.column });
        a2.loc.end.column = a2.loc.start.column + 1, Rn(a2), In(a2), r2 = true, Bn(e5), i2.comma = true, i2.loc.end = { line: a2.loc.end.line, column: a2.loc.end.column }, e5.loc.end = { line: a2.loc.end.line, column: a2.loc.end.column + (i2.comma ? 2 : 1) };
      }
      u(a2) && n2(a2) && (delete a2.range, delete i2.range, i2.loc.end = { line: a2.loc.end.line, column: a2.loc.end.column }, r2 = true, Bn(e5));
    }
    if (r2) {
      for (let t4 = 1;t4 < e5.items.length; t4++) {
        let n3 = e5.items[t4 - 1], r3 = e5.items[t4];
        n3.loc.end.line === r3.loc.start.line && G(r3, { lines: 0, columns: n3.loc.end.column + (n3.comma ? 2 : 1) - r3.loc.start.column });
      }
      let t3 = e5.items[e5.items.length - 1];
      t3 && (e5.loc.end = { line: Math.max(e5.loc.end.line, t3.loc.end.line), column: t3.loc.end.column + (t3.comma ? 2 : 1) });
    }
    return r2;
  };
  n2(e4);
}
function J(e4, t2 = R.default(), n2 = 0, r2 = false) {
  e4 = ki(e4);
  let i2 = Nr();
  $n(i2), Zn(i2, t2.indentWidth);
  for (let a2 of wi(e4, t2, n2, r2))
    H(i2, i2, a2);
  if (W(i2), ai(i2, t2), (t2.inlineTableStart ?? 1) > 1 && hi(i2, t2), t2.multilineTable !== `auto` || t2.multilineArray !== `auto`)
    for (let e5 of i2.items)
      (e5.type === `Table` || e5.type === `TableArray` || a(e5) && (u(e5.value) || f(e5.value))) && di(e5, t2.indentWidth, t2.bracketSpacing);
  return _i(i2);
}
function* wi(e4, t2, n2 = 0, r2 = false) {
  for (let i2 of Object.keys(e4)) {
    let a2 = e4[i2];
    if (a2 === undefined)
      continue;
    let o2 = ki(a2);
    o2 !== undefined && (yield Lr([i2], Ei(o2, t2, n2, r2), n2 > 0 && !r2, t2.escapeSequenceUpperCase));
  }
}
function Ti(e4, t2, n2) {
  let r2 = e4.items[e4.items.length - 1];
  r2 && (r2.comma = true);
  let i2 = r2 ? { line: r2.loc.end.line, column: r2.loc.end.column + 2 } : { line: e4.loc.start.line, column: e4.loc.start.column + (n2.bracketSpacing ? 2 : 1) };
  G(t2, { lines: i2.line - t2.loc.start.line, columns: i2.column - t2.loc.start.column }), e4.items.push(t2), t2.comma = false, e4.loc.end = { line: t2.loc.end.line, column: t2.loc.end.column + (n2.bracketSpacing ? 2 : 1) };
}
function Ei(e4, t2, n2, r2) {
  let i2 = t2.minimumDecimals ?? 0;
  if (e4 === null)
    throw Error(`"null" values are not supported`);
  if (e4 === undefined)
    throw Error(`"undefined" values are not supported inside arrays`);
  return vt(e4) ? Vr(e4, undefined, t2.escapeSequenceUpperCase) : bt(e4) ? Yr(e4) : yt(e4) ? i2 > 0 ? Xr(e4, i2) : Yr(e4) : xt(e4) ? Xr(e4, Math.max(i2, 1)) : St(e4) ? Zr(e4) : Tt(e4) ? $r(e4, t2.truncateZeroTimeInDates, t2.minimumTimeDecimals ?? 0) : vi(e4) ? Qr(yi(e4), t2.truncateZeroTimeInDates, t2.minimumTimeDecimals ?? 0) : Ct(e4) ? Qr(e4, t2.truncateZeroTimeInDates, t2.minimumTimeDecimals ?? 0) : Array.isArray(e4) ? Di(e4, t2, n2, r2) : Oi(e4, t2, n2, r2);
}
function Di(e4, t2, n2, r2) {
  let i2 = ei(), a2 = !(e4.length === 0 && n2 > 0) && Nn(`array`, n2, r2, t2);
  if (Pn(i2, a2), Zn(i2, t2.indentWidth), $n(i2), !a2) {
    for (let r3 of e4)
      Ti(i2, q(Ei(r3, t2, n2 + 1, a2)), t2);
    if (i2.items.length > 0 && t2.trailingComma) {
      let e5 = i2.items[i2.items.length - 1];
      e5.comma = true, i2.loc.end.column++;
    }
    return i2;
  }
  for (let r3 of e4) {
    let e5 = q(Ei(r3, t2, n2 + 1, a2));
    Si(i2, e5, t2.indentWidth), H(i2, i2, e5);
  }
  return vr(i2, i2, t2.bracketSpacing), yr(i2, i2, t2.trailingComma), W(i2), i2;
}
function Oi(e4, t2, n2, r2) {
  if (e4 = ki(e4), !F(e4))
    return Ei(e4, t2, n2, r2);
  let i2 = ti(), a2 = !(Object.keys(e4).length === 0 && n2 > 0) && Nn(`table`, n2, r2, t2);
  if (Pn(i2, a2), Zn(i2, t2.indentWidth), $n(i2), !a2) {
    for (let r3 of wi(e4, t2, n2 + 1, a2))
      Ti(i2, q(r3), t2);
    if (i2.items.length > 0 && t2.trailingComma) {
      let e5 = i2.items[i2.items.length - 1];
      e5.comma = true, i2.loc.end.column++;
    }
    return i2;
  }
  for (let r3 of wi(e4, t2, n2 + 1, a2))
    H(i2, i2, q(r3));
  return vr(i2, i2, t2.bracketSpacing), yr(i2, i2, t2.trailingComma), W(i2), i2;
}
function ki(e4) {
  return !e4 || Ct(e4) || Tt(e4) ? e4 : typeof e4.toJSON == `function` ? e4.toJSON() : e4;
}
var Ai = /(\r\n|\n)/g;
function ji(e4, t2) {
  let n2 = [], r2 = (e5) => {
    let t3 = { line: e5.loc.end.line, column: e5.loc.end.column - 1 }, n3 = e5.items[e5.items.length - 1];
    return n3 && (n3.loc.end.line > t3.line || n3.loc.end.line === t3.line && n3.loc.end.column > t3.column) && (t3.line = n3.loc.end.line, t3.column = n3.loc.end.column + +!!n3.comma), t3;
  };
  function i2(e5) {
    switch (e5.type) {
      case `Document`:
        for (let t3 = 0;t3 < e5.items.length; t3++)
          i2(e5.items[t3]);
        break;
      case `Table`: {
        let t3 = e5;
        i2(t3.key);
        for (let e6 = 0;e6 < t3.items.length; e6++)
          i2(t3.items[e6]);
        break;
      }
      case `TableKey`: {
        let t3 = e5;
        Pi(n2, t3.loc, `[` + t3.item.raw + `]`);
        break;
      }
      case `TableArray`: {
        let t3 = e5;
        i2(t3.key);
        for (let e6 = 0;e6 < t3.items.length; e6++)
          i2(t3.items[e6]);
        break;
      }
      case `TableArrayKey`: {
        let t3 = e5;
        Pi(n2, t3.loc, `[[` + t3.item.raw + `]]`);
        break;
      }
      case `KeyValue`: {
        let t3 = e5, r3 = t3.loc.start.line;
        Fi(n2, r3, t3.equals, `=`), i2(t3.key), i2(t3.value);
        break;
      }
      case `Key`:
        Pi(n2, e5.loc, e5.raw);
        break;
      case `String`:
        Pi(n2, e5.loc, e5.raw);
        break;
      case `Integer`:
        Pi(n2, e5.loc, e5.raw);
        break;
      case `Float`:
        Pi(n2, e5.loc, e5.raw);
        break;
      case `Boolean`:
        Pi(n2, e5.loc, e5.value.toString());
        break;
      case `DateTime`:
        Pi(n2, e5.loc, e5.raw);
        break;
      case `InlineArray`: {
        let t3 = e5, { start: a2 } = t3.loc, o2 = r2(t3);
        Fi(n2, a2.line, a2.column, `[`), Fi(n2, o2.line, o2.column, `]`);
        for (let e6 = 0;e6 < t3.items.length; e6++)
          i2(t3.items[e6]);
        break;
      }
      case `InlineTable`: {
        let t3 = e5, { start: a2 } = t3.loc, o2 = r2(t3);
        Fi(n2, a2.line, a2.column, `{`), Fi(n2, o2.line, o2.column, `}`);
        for (let e6 = 0;e6 < t3.items.length; e6++)
          i2(t3.items[e6]);
        break;
      }
      case `InlineItem`: {
        let t3 = e5;
        if (i2(t3.item), t3.comma) {
          let e6 = t3.loc.end;
          Fi(n2, e6.line, e6.column, `,`);
        }
        break;
      }
      case `Comment`:
        Pi(n2, e5.loc, e5.raw);
        break;
      default: {
        let t3 = e5.type;
        throw Error(`toTOML: Unrecognized node type: ${String(t3)}`);
      }
    }
  }
  if (Ot(e4))
    for (let t3 of e4)
      i2(t3);
  else
    i2(e4);
  if (t2.useTabsForIndentation) {
    let t3 = /* @__PURE__ */ new Set, r3 = (e5) => {
      if (e5.type === `String` && e5.loc.end.line > e5.loc.start.line)
        for (let n3 = e5.loc.start.line + 1;n3 <= e5.loc.end.line; n3++)
          t3.add(n3);
      if (m(e5))
        for (let t4 of e5.items)
          r3(t4);
      a(e5) && r3(e5.value), d(e5) && r3(e5.item);
    };
    if (Ot(e4))
      for (let t4 of e4)
        r3(t4);
    else
      r3(e4);
    for (let e5 = 0;e5 < n2.length; e5++) {
      if (t3.has(e5 + 1))
        continue;
      let r4 = n2[e5], i3 = r4.match(/^( +)/);
      if (i3) {
        let t4 = i3[1], a2 = `	`.repeat(t4.length);
        n2[e5] = a2 + r4.substring(t4.length);
      }
    }
  }
  return n2.join(t2.newLine) + t2.newLine.repeat(t2.trailingNewline);
}
function Mi(e4, n2) {
  let i2 = Ot(e4) ? Array.from(e4) : [e4], o2 = [], s2 = [], c2 = [], l2 = /* @__PURE__ */ new WeakSet, p2 = 1, g2 = 0, _2 = (e5) => {
    if (e5.type === `Comment` && c2.push(e5), a(e5))
      _2(e5.value);
    else if (d(e5))
      _2(e5.item);
    else if (e5.type === `Table` || e5.type === `TableArray`)
      for (let t2 of e5.items)
        _2(t2);
    else if (m(e5))
      for (let t2 of e5.items)
        _2(t2);
  };
  for (let e5 of i2)
    _2(e5);
  let v2 = /* @__PURE__ */ new WeakSet, y2 = (e5) => {
    for (let n3 of e5)
      if (a(n3)) {
        let e6 = n3.value;
        (f(e6) || u(e6)) && v2.add(e6);
      } else
        (t(n3) || r(n3)) && y2(n3.items);
  };
  y2(i2);
  let b2 = (e5) => (n2.useTabsForIndentation ? `	` : ` `).repeat(e5), x2 = (e5) => {
    if (e5.length === 0)
      return;
    o2.push(e5);
    let t2 = e5.split(/\r\n|\n/);
    t2.length === 1 ? g2 += e5.length : (p2 += t2.length - 1, g2 = t2[t2.length - 1].length);
  }, S2 = (e5, t2) => {
    e5 > p2 ? (x2(n2.newLine.repeat(e5 - p2)), t2 > 0 && x2(b2(t2))) : e5 === p2 && t2 > g2 ? x2(g2 === 0 ? b2(t2) : ` `.repeat(t2 - g2)) : o2.length > 0 && (e5 < p2 || e5 === p2 && t2 < g2) && (x2(n2.newLine), t2 > 0 && x2(b2(t2)));
  }, C2 = (e5) => {
    switch (e5.type) {
      case `Key`:
        return e5.raw;
      case `String`:
        return e5.raw;
      case `Integer`:
        return e5.raw;
      case `Float`:
        return e5.raw;
      case `Boolean`:
        return e5.value.toString();
      case `DateTime`:
        return e5.raw;
      case `Comment`:
        return e5.raw;
      default:
        return;
    }
  }, w2 = (e5) => {
    if (a(e5))
      return [e5.key, e5.value];
    if (d(e5) || h(e5))
      return [e5.item];
    if (e5.type === `Table` || e5.type === `TableArray`) {
      let t2 = e5;
      return [t2.key, ...t2.items];
    }
    return m(e5) ? e5.items : [];
  }, T2 = (e5) => {
    let t2 = [e5];
    for (;t2.length > 0; ) {
      let e6 = t2.pop();
      if (e6.dirty)
        return false;
      let n3 = C2(e6);
      if (n3 !== undefined) {
        let t3 = z(e6);
        if (!t3 || !e6.range || t3.slice(e6.range[0], e6.range[1]) !== n3)
          return false;
      } else if (!bn(e6))
        return false;
      t2.push(...w2(e6));
    }
    return true;
  }, E2 = (e5) => e5.type !== `Document` && e5.type !== `InlineItem` && e5.type !== `TableKey` && e5.type !== `TableArrayKey` && (C2(e5) !== undefined || bn(e5)), D2 = (e5, t2, r2 = false) => {
    t2.line > e5.line ? (x2(n2.newLine.repeat(t2.line - e5.line)), t2.column > 0 && x2(r2 ? ` `.repeat(t2.column) : b2(t2.column))) : t2.line === e5.line && t2.column > e5.column && x2(` `.repeat(t2.column - e5.column));
  }, O2 = (e5, t2, n3) => {
    var r2, i3;
    let a2 = z(e5);
    if (!a2 || !e5.range || u(e5) && Vn(e5) && (!n3 || t2 && !t2.range || n3 && !n3.range) || t2 && z(t2) !== a2 || n3 && z(n3) !== a2)
      return;
    let o3 = (t2 == null || (r2 = t2.range) == null ? undefined : r2[1]) ?? e5.range[0] + 1, s3 = (n3 == null || (i3 = n3.range) == null ? undefined : i3[0]) ?? e5.range[1] - 1;
    if (o3 === undefined || s3 === undefined || s3 < o3)
      return;
    let c3 = a2.slice(o3, s3);
    if (t2 != null && t2.comma && c3.startsWith(`,`) && (c3 = c3.slice(1)), /^[\t \r\n]*$/.test(c3))
      return c3;
  }, k2 = (e5, t2) => {
    let n3 = z(t2);
    return n3 !== undefined && z(e5) === n3 && t2.range !== undefined && e5.range !== undefined && e5.range[0] >= t2.range[0] && e5.range[1] <= t2.range[1];
  }, A2 = (e5) => {
    let t2 = f(e5) && zn(e5), r2;
    for (let n3 of e5.items) {
      let i4 = r2 ? { line: r2.loc.end.line, column: r2.loc.end.column + +!!r2.comma } : { line: e5.loc.start.line, column: e5.loc.start.column + 1 }, a3 = c2.filter((t3) => !l2.has(t3) && k2(t3, e5) && t3.loc.start.line >= i4.line && t3.loc.end.line <= n3.loc.start.line && (t3.loc.start.line > i4.line || t3.loc.start.column >= i4.column) && (t3.loc.end.line < n3.loc.start.line || t3.loc.end.column <= n3.loc.start.column) && t3.loc.start.line >= e5.loc.start.line && t3.loc.end.line <= e5.loc.end.line).sort((e6, t3) => e6.loc.start.line - t3.loc.start.line || e6.loc.start.column - t3.loc.start.column);
      if (a3.length > 0) {
        for (let e6 of a3)
          D2(i4, e6.loc.start), x2(e6.raw), l2.add(e6), i4 = e6.loc.end;
        D2(i4, n3.loc.start);
      } else {
        let a4 = O2(e5, r2, n3);
        if (a4 !== undefined)
          x2(a4);
        else {
          let a5 = z(n3) !== z(e5);
          if (r2 && a5 && n3.loc.start.line === r2.loc.end.line) {
            let t3 = pe(e5) ?? 2, n4 = Math.max(0, t3 - 1);
            n4 > 0 && x2(` `.repeat(n4));
          } else
            D2(i4, n3.loc.start, t2);
        }
      }
      j2(n3, false);
      for (let t3 of c2) {
        if (l2.has(t3) || !k2(t3, e5) || t3.loc.start.line !== n3.loc.end.line || t3.loc.start.column < n3.loc.end.column || t3.loc.start.line < e5.loc.start.line || t3.loc.end.line > e5.loc.end.line)
          continue;
        let r3 = n3.loc.end.column + +!!n3.comma;
        t3.loc.start.column > r3 && x2(` `.repeat(t3.loc.start.column - r3)), x2(t3.raw), l2.add(t3);
      }
      r2 = n3;
    }
    let i3 = r2 ? { line: r2.loc.end.line, column: r2.loc.end.column + +!!r2.comma } : { line: e5.loc.start.line, column: e5.loc.start.column + 1 }, a2 = c2.filter((t3) => !l2.has(t3) && k2(t3, e5) && t3.loc.start.line >= i3.line && t3.loc.end.line <= e5.loc.end.line).sort((e6, t3) => e6.loc.start.line - t3.loc.start.line || e6.loc.start.column - t3.loc.start.column);
    if (a2.length > 0) {
      for (let e6 of a2)
        D2(i3, e6.loc.start), x2(e6.raw), l2.add(e6), i3 = e6.loc.end;
      D2(i3, { line: e5.loc.end.line, column: e5.loc.end.column - 1 });
    } else {
      let a3 = O2(e5, r2, undefined);
      if (a3 !== undefined)
        x2(a3);
      else if (r2)
        t2 && r2.comma && x2(` `), D2(i3, { line: e5.loc.end.line, column: e5.loc.end.column - 1 }, t2);
      else {
        let t3 = z(e5);
        if (t3 && e5.range) {
          let r3 = t3.slice(e5.range[0], e5.range[1]), i4 = Math.max(r3.lastIndexOf(`
`), r3.lastIndexOf(`\r`)), a4 = v2.has(e5) || Un(e5);
          if (i4 !== -1 && a4 && Dn(e5)) {
            var o3;
            let e6 = ((o3 = r3.slice(i4 + 1, -1).match(/^[\t ]*/)) == null ? undefined : o3[0]) ?? ``;
            x2(n2.newLine + e6);
          }
        }
      }
    }
  }, j2 = (e5, t2 = true) => {
    if (e5.type === `Comment` && l2.has(e5))
      return;
    let n3 = z(e5);
    if (!(n3 !== undefined && e5.range && s2.some((t3) => t3.source === n3 && t3.start <= e5.range[0] && t3.end >= e5.range[1]))) {
      if (E2(e5) && T2(e5) && e5.range && n3 !== undefined) {
        let r2 = n3.slice(e5.range[0], e5.range[1]), i3 = C2(e5);
        if (i3 === undefined || i3 === r2) {
          t2 && S2(e5.loc.start.line, e5.loc.start.column), x2(r2), s2.push({ source: n3, start: e5.range[0], end: e5.range[1] });
          return;
        }
      }
      switch (e5.type) {
        case `Document`:
          for (let t3 of e5.items)
            j2(t3);
          break;
        case `Table`: {
          let n4 = e5;
          j2(n4.key, t2);
          for (let e6 of n4.items)
            j2(e6);
          break;
        }
        case `TableKey`: {
          let n4 = e5;
          t2 && S2(n4.loc.start.line, n4.loc.start.column), x2(`[${n4.item.raw}]`);
          break;
        }
        case `TableArray`: {
          let n4 = e5;
          j2(n4.key, t2);
          for (let e6 of n4.items)
            j2(e6);
          break;
        }
        case `TableArrayKey`: {
          let n4 = e5;
          t2 && S2(n4.loc.start.line, n4.loc.start.column), x2(`[[${n4.item.raw}]]`);
          break;
        }
        case `KeyValue`: {
          let n4 = e5;
          t2 && S2(n4.loc.start.line, n4.loc.start.column), j2(n4.key, false), D2(n4.key.loc.end, { line: n4.loc.start.line, column: n4.equals }), x2(`=`), D2({ line: n4.loc.start.line, column: n4.equals + 1 }, n4.value.loc.start), j2(n4.value, false);
          break;
        }
        case `Key`:
          t2 && S2(e5.loc.start.line, e5.loc.start.column), x2(e5.raw);
          break;
        case `String`:
          t2 && S2(e5.loc.start.line, e5.loc.start.column), x2(e5.raw);
          break;
        case `Integer`:
          t2 && S2(e5.loc.start.line, e5.loc.start.column), x2(e5.raw);
          break;
        case `Float`:
          t2 && S2(e5.loc.start.line, e5.loc.start.column), x2(e5.raw);
          break;
        case `Boolean`:
          t2 && S2(e5.loc.start.line, e5.loc.start.column), x2(e5.value.toString());
          break;
        case `DateTime`:
          t2 && S2(e5.loc.start.line, e5.loc.start.column), x2(e5.raw);
          break;
        case `InlineArray`: {
          let n4 = e5;
          t2 && S2(n4.loc.start.line, n4.loc.start.column), x2(`[`), A2(n4), x2(`]`);
          break;
        }
        case `InlineTable`: {
          let n4 = e5;
          t2 && S2(n4.loc.start.line, n4.loc.start.column), x2(`{`), A2(n4), x2(`}`);
          break;
        }
        case `InlineItem`: {
          let t3 = e5;
          if (j2(t3.item, false), t3.comma) {
            let e6 = z(t3);
            if (e6 && t3.range && t3.item.range && z(t3.item) === e6) {
              let n4 = e6.slice(t3.item.range[1], t3.range[1]);
              /^[\t ]*$/.test(n4) && x2(n4);
            }
            x2(`,`);
          }
          break;
        }
        case `Comment`:
          t2 && S2(e5.loc.start.line, e5.loc.start.column), x2(e5.raw);
          break;
        default:
          throw Error(`toTOMLCursor: Unrecognized node type: ${String(e5.type)}`);
      }
    }
  };
  for (let e5 of i2)
    j2(e5);
  return o2.join(``).replace(/\r\n|\n/g, n2.newLine) + n2.newLine.repeat(n2.trailingNewline);
}
function Ni(e4, t2) {
  let n2 = Array.isArray(e4) ? e4 : Ot(e4) ? Array.from(e4) : [e4], r2 = [], i2 = 1, a2 = 0, o2 = (e5) => (t2.useTabsForIndentation ? `	` : ` `).repeat(e5), s2 = (e5) => {
    if (e5.length === 0)
      return;
    r2.push(e5);
    let t3 = 0, n3 = -1, o3 = e5.indexOf(`
`);
    for (;o3 !== -1; )
      t3++, n3 = o3, o3 = e5.indexOf(`
`, o3 + 1);
    t3 === 0 ? a2 += e5.length : (i2 += t3, a2 = e5.length - n3 - 1);
  }, c2 = (e5, n3) => {
    e5 > i2 ? (s2(t2.newLine.repeat(e5 - i2)), n3 > 0 && s2(o2(n3))) : e5 === i2 && n3 > a2 ? s2(a2 === 0 ? o2(n3) : ` `.repeat(n3 - a2)) : r2.length > 0 && (e5 < i2 || e5 === i2 && n3 < a2) && (s2(t2.newLine), n3 > 0 && s2(o2(n3)));
  }, l2 = (e5) => {
    switch (e5.type) {
      case `Key`:
        return e5.raw;
      case `String`:
        return e5.raw;
      case `Integer`:
        return e5.raw;
      case `Float`:
        return e5.raw;
      case `Boolean`:
        return e5.value.toString();
      case `DateTime`:
        return e5.raw;
      case `Comment`:
        return e5.raw;
      default:
        return ``;
    }
  }, u2 = [], d2 = (e5, t3) => {
    switch (e5.type) {
      case `Document`: {
        let t4 = e5.items;
        for (let e6 = t4.length - 1;e6 >= 0; e6--)
          u2.push([0, t4[e6], true]);
        break;
      }
      case `Table`: {
        let n3 = e5, r3 = n3.items;
        for (let e6 = r3.length - 1;e6 >= 0; e6--)
          u2.push([0, r3[e6], true]);
        u2.push([0, n3.key, t3]);
        break;
      }
      case `TableKey`: {
        let n3 = e5;
        u2.push([1, `[${n3.item.raw}]`]), t3 && u2.push([3, n3.loc.start.line, n3.loc.start.column]);
        break;
      }
      case `TableArray`: {
        let n3 = e5, r3 = n3.items;
        for (let e6 = r3.length - 1;e6 >= 0; e6--)
          u2.push([0, r3[e6], true]);
        u2.push([0, n3.key, t3]);
        break;
      }
      case `TableArrayKey`: {
        let n3 = e5;
        u2.push([1, `[[${n3.item.raw}]]`]), t3 && u2.push([3, n3.loc.start.line, n3.loc.start.column]);
        break;
      }
      case `KeyValue`: {
        let n3 = e5;
        u2.push([0, n3.value, false]), u2.push([2, n3.loc.start.line, n3.equals + 1, n3.value.loc.start.line, n3.value.loc.start.column, false]), u2.push([1, `=`]), u2.push([2, n3.key.loc.end.line, n3.key.loc.end.column, n3.loc.start.line, n3.equals, false]), u2.push([0, n3.key, false]), t3 && u2.push([3, n3.loc.start.line, n3.loc.start.column]);
        break;
      }
      case `Key`:
      case `String`:
      case `Integer`:
      case `Float`:
      case `Boolean`:
      case `DateTime`:
      case `Comment`:
        u2.push([1, l2(e5)]), t3 && u2.push([3, e5.loc.start.line, e5.loc.start.column]);
        break;
      case `InlineArray`: {
        let n3 = e5, r3 = n3.items;
        if (u2.push([1, `]`]), r3.length > 0) {
          let e6 = r3[r3.length - 1];
          u2.push([2, e6.loc.end.line, e6.loc.end.column + +!!e6.comma, n3.loc.end.line, n3.loc.end.column - 1, false]);
        }
        for (let e6 = r3.length - 1;e6 >= 0; e6--) {
          let t4 = r3[e6], i3 = e6 > 0 ? r3[e6 - 1] : undefined;
          u2.push([0, t4, false]), u2.push(i3 ? [2, i3.loc.end.line, i3.loc.end.column + +!!i3.comma, t4.loc.start.line, t4.loc.start.column, false] : [2, n3.loc.start.line, n3.loc.start.column + 1, t4.loc.start.line, t4.loc.start.column, false]);
        }
        u2.push([1, `[`]), t3 && u2.push([3, n3.loc.start.line, n3.loc.start.column]);
        break;
      }
      case `InlineTable`: {
        let n3 = e5, r3 = n3.items, i3 = zn(n3);
        if (u2.push([1, `}`]), r3.length > 0) {
          let e6 = r3[r3.length - 1];
          i3 && e6.comma && u2.push([1, ` `]), u2.push([2, e6.loc.end.line, e6.loc.end.column + +!!e6.comma, n3.loc.end.line, n3.loc.end.column - 1, i3]);
        }
        for (let e6 = r3.length - 1;e6 >= 0; e6--) {
          let t4 = r3[e6], a3 = e6 > 0 ? r3[e6 - 1] : undefined;
          u2.push([0, t4, false]), u2.push(a3 ? [2, a3.loc.end.line, a3.loc.end.column + +!!a3.comma, t4.loc.start.line, t4.loc.start.column, i3] : [2, n3.loc.start.line, n3.loc.start.column + 1, t4.loc.start.line, t4.loc.start.column, i3]);
        }
        u2.push([1, `{`]), t3 && u2.push([3, n3.loc.start.line, n3.loc.start.column]);
        break;
      }
      case `InlineItem`: {
        let t4 = e5;
        t4.comma && u2.push([1, `,`]), u2.push([0, t4.item, false]);
        break;
      }
      default:
        throw Error(`toTOMLSequential: Unrecognized node type: ${String(e5.type)}`);
    }
  };
  for (let e5 = n2.length - 1;e5 >= 0; e5--)
    u2.push([0, n2[e5], true]);
  for (;u2.length > 0; ) {
    let e5 = u2.pop();
    switch (e5[0]) {
      case 0:
        d2(e5[1], e5[2]);
        break;
      case 1:
        s2(e5[1]);
        break;
      case 2: {
        let n3 = e5[1], r3 = e5[2], i3 = e5[3], a3 = e5[4], c3 = e5[5];
        i3 > n3 ? (s2(t2.newLine.repeat(i3 - n3)), a3 > 0 && s2(c3 ? ` `.repeat(a3) : o2(a3))) : i3 === n3 && a3 > r3 && s2(` `.repeat(a3 - r3));
        break;
      }
      case 3:
        c2(e5[1], e5[2]);
    }
  }
  return r2.join(``).replace(/\r\n|\n/g, t2.newLine) + t2.newLine.repeat(t2.trailingNewline);
}
function Pi(e4, t2, n2) {
  if (t2.start.line === t2.end.line) {
    let r3 = Ii(e4, t2.start.line), i3 = r3.substring(0, t2.start.column), a2 = i3.length < t2.start.column ? i3.padEnd(t2.start.column, ` `) : i3, o2 = r3.substring(t2.end.column);
    e4[t2.start.line - 1] = a2 + n2 + o2;
    return;
  }
  let r2 = n2.split(Ai).filter((e5) => e5 !== `
` && e5 !== `\r
`), i2 = t2.end.line - t2.start.line + 1;
  if (r2.length !== i2)
    throw Error(`Mismatch between location and raw string, expected ${i2} lines for "${n2}"`);
  for (let n3 = t2.start.line;n3 <= t2.end.line; n3++) {
    let i3 = Ii(e4, n3), a2 = n3 === t2.start.line, o2 = n3 === t2.end.line, s2 = ``;
    if (a2) {
      let e5 = i3.substring(0, t2.start.column);
      s2 = e5.length < t2.start.column ? e5.padEnd(t2.start.column, ` `) : e5;
    }
    let c2 = o2 ? i3.substring(t2.end.column) : ``;
    e4[n3 - 1] = s2 + r2[n3 - t2.start.line] + c2;
  }
}
function Fi(e4, t2, n2, r2) {
  let i2 = Ii(e4, t2), a2 = i2.length < n2 ? i2.padEnd(n2, ` `) : i2.substring(0, n2), o2 = i2.substring(n2 + 1);
  e4[t2 - 1] = a2 + r2 + o2;
}
function Ii(e4, t2) {
  if (!e4[t2 - 1])
    for (let n2 = 0;n2 < t2; n2++)
      e4[n2] || (e4[n2] = ``);
  return e4[t2 - 1];
}
function Li(e4, t2 = `asNeeded`) {
  let n2 = e4.replace(/_/g, ``), r2 = n2;
  if (/^[+-]?0x/i.test(n2) || /^[+-]?0o/i.test(n2) || /^[+-]?0b/i.test(n2)) {
    let e5 = n2[0] === `+` || n2[0] === `-` ? n2[0] : ``;
    r2 = e5 + n2.slice(+!!e5).toLowerCase();
  }
  let i2;
  try {
    i2 = BigInt(r2);
  } catch {
    return Number(n2);
  }
  return t2 === true ? i2 : t2 === false || i2 >= BigInt(-(2 ** 53 - 1)) && i2 <= BigInt(2 ** 53 - 1) ? Number(i2) : i2;
}
function Ri(e4, t2, n2) {
  for (let r2 of e4.items) {
    let e5 = r2.item;
    if (e5.value.type === `InlineTable`) {
      let r3 = t2.concat(e5.key.value);
      Yi(n2, r3, true).kind = `inline`, Ri(e5.value, r3, n2);
    }
  }
}
function zi(e4) {
  var t2, n2, r2, i2, a2, o2;
  if ((t2 = e4.constructor) != null && (t2 = t2.name) != null && (n2 = t2.startsWith) != null && n2.call(t2, `Temporal.`) || ((r2 = e4.constructor) == null ? undefined : r2.name) === `PlainDate` || ((i2 = e4.constructor) == null ? undefined : i2.name) === `PlainTime` || ((a2 = e4.constructor) == null ? undefined : a2.name) === `PlainDateTime` || ((o2 = e4.constructor) == null ? undefined : o2.name) === `ZonedDateTime`)
    return e4;
  let s2 = globalThis.Temporal;
  if (e4 instanceof Ee)
    return s2.PlainDate.from(e4.toISOString());
  if (e4 instanceof De)
    return s2.PlainTime.from(e4.toISOString());
  if (e4 instanceof Oe)
    return s2.PlainDateTime.from(e4.toISOString().replace(` `, `T`));
  if (e4 instanceof ke) {
    let t3 = e4.toISOString().replace(` `, `T`), n3 = t3.match(/([+-]\d{2}:\d{2}|Z)$/), r3 = n3 ? n3[1] : `Z`, i3 = t3.replace(/([+-]\d{2}:\d{2}|Z)$/, ``), a3 = r3 === `Z` ? `+00:00` : r3;
    return s2.ZonedDateTime.from(`${i3}${r3}[${a3}]`);
  }
  return s2.PlainDateTime.from(e4.toISOString().replace(`Z`, ``));
}
function Bi(e4, t2 = ``, n2 = {}) {
  let { integersAsBigInt: r2 = `asNeeded`, temporal: i2 = false } = n2, a2 = mt(), o2 = Ji(), s2 = a2, c2 = [];
  for (let t3 of e4)
    switch (t3.type) {
      case `Table`:
        l2(t3);
        for (let e5 of t3.items)
          e5.type === `KeyValue` && d2(e5);
        break;
      case `TableArray`:
        u2(t3);
        for (let e5 of t3.items)
          e5.type === `KeyValue` && d2(e5);
        break;
      case `KeyValue`:
        d2(t3);
    }
  return a2;
  function l2(e5) {
    let n3 = e5.key.item.value;
    try {
      Hi(o2, [], n3, e5.type);
    } catch (n4) {
      throw new O(t2, e5.key.loc.start, n4.message);
    }
    Yi(o2, n3, true).kind = `explicit`, s2 = Ui(a2, n3), c2 = n3;
  }
  function u2(e5) {
    let n3 = e5.key.item.value;
    try {
      Hi(o2, [], n3, e5.type);
    } catch (n4) {
      throw new O(t2, e5.key.loc.start, n4.message);
    }
    let r3 = Yi(o2, n3, true);
    r3.kind = `table-array`, r3.entries.push(Ji()), s2 = Wi(a2, n3), c2 = n3;
  }
  function d2(e5) {
    let n3 = e5.key.value;
    try {
      Hi(o2, c2, n3, e5.type);
    } catch (n4) {
      throw new O(t2, e5.key.loc.start, n4.message);
    }
    if (n3.length > 1)
      for (let e6 = 1;e6 < n3.length; e6++) {
        let t3 = Yi(o2, c2.concat(n3.slice(0, e6)), true);
        t3.kind === `undefined` && (t3.kind = `implicit`);
      }
    let a3;
    try {
      a3 = Vi(e5.value, { integersAsBigInt: r2, temporal: i2 });
    } catch (n4) {
      throw new O(t2, e5.value.loc.start, n4.message);
    }
    let l3 = c2.concat(n3);
    if (e5.value.type === `InlineTable`)
      Yi(o2, l3, true).kind = `inline`, Ri(e5.value, l3, o2);
    else {
      let t3 = Yi(o2, l3, true);
      t3.kind = e5.value.type === `InlineArray` ? `array` : e5.value.type === `DateTime` ? `date` : `value`, e5.value.type === `DateTime` && (t3.runtimeValue = a3);
    }
    let u3 = n3.length > 1 ? Ui(s2, n3.slice(0, -1)) : s2;
    u3[P(n3)] = a3;
  }
}
function Vi(e4, t2 = {}) {
  let { integersAsBigInt: n2 = `asNeeded`, temporal: r2 = false } = t2;
  switch (e4.type) {
    case `InlineTable`:
      let t3 = mt(), i2 = /* @__PURE__ */ new Set, a2 = /* @__PURE__ */ new Map;
      return e4.items.forEach(({ item: e5 }) => {
        let o2 = e5.key.value, s2 = Vi(e5.value, { integersAsBigInt: n2, temporal: r2 }), c2 = Ki(o2), l2 = qi(o2);
        if (i2.has(l2))
          throw Error(`Duplicate key "${c2}" in inline table`);
        for (let e6 = 1;e6 < o2.length; e6++) {
          let t4 = Ki(o2.slice(0, e6));
          if (i2.has(qi(o2.slice(0, e6))))
            throw Error(`Key "${c2}" conflicts with key: "${t4}"`);
        }
        if (a2.has(l2)) {
          let e6 = a2.get(l2);
          throw Error(`Key "${c2}" conflicts with key: "${e6}"`);
        }
        i2.add(l2);
        for (let e6 = 1;e6 < o2.length; e6++) {
          let t4 = qi(o2.slice(0, e6));
          a2.has(t4) || a2.set(t4, c2);
        }
        let u2 = o2.length > 1 ? Ui(t3, o2.slice(0, -1)) : t3;
        u2[P(o2)] = s2;
      }), t3;
    case `InlineArray`:
      return e4.items.map((e5) => Vi(e5.item, { integersAsBigInt: n2, temporal: r2 }));
    case `DateTime`:
      if (r2) {
        if (globalThis.Temporal === undefined)
          throw Error(`Temporal API is not available in this runtime. Set temporal: false or use a runtime with Temporal support.`);
        return zi(e4.value);
      }
      return e4.value;
    case `String`:
      return e4.value;
    case `Integer`:
      return Li(e4.raw, n2);
    case `Float`:
    case `Boolean`:
      return e4.value;
    default:
      throw Error(`Unrecognized value type "${e4.type}"`);
  }
}
function Hi(e4, t2, n2, r2) {
  let i2 = t2.concat(n2), a2 = Ki(i2), o2 = Yi(e4, i2);
  for (let t3 = 0;t3 < i2.length - 1; t3++) {
    let n3 = i2.slice(0, t3 + 1), r3 = Yi(e4, n3), a3 = i2[t3 + 1], o3 = r3.runtimeValue;
    if (r3.kind === `date` && !r3.children.has(a3) && typeof o3 == `object` && o3 && a3 in o3)
      throw Error(`Value already defined for ${Ki(n3.concat(a3))}`);
  }
  if (r2 === `KeyValue`) {
    if (n2.length > 1) {
      for (let r3 = 1;r3 < n2.length; r3++) {
        let i3 = t2.concat(n2.slice(0, r3)), a3 = Yi(e4, i3), o3 = Ki(i3);
        if (a3.kind === `inline`)
          throw Error(`Cannot extend inline table at ${o3}`);
        if (a3.kind === `array`)
          throw Error(`Cannot add to static array at ${o3}`);
        if (a3.kind === `table-array`)
          throw Error(`Cannot traverse Array of Tables at ${o3}`);
        if (a3.kind === `value`)
          throw Error(`Value already defined for ${o3}`);
      }
      for (let n3 = t2.length + 1;n3 <= i2.length; n3++) {
        let t3 = i2.slice(0, n3);
        if (Yi(e4, t3).kind === `explicit`)
          throw Error(`Cannot extend explicit table ${Ki(t3)} with dotted keys`);
      }
    }
    if (o2.kind === `implicit` || o2.kind === `explicit` || o2.kind === `table-array`)
      throw Error(`Table already defined: ${a2}`);
    if (o2.kind === `value` || o2.kind === `date` || o2.kind === `inline`)
      throw Error(`Value already defined for ${a2}`);
    if (o2.kind === `array`)
      throw Error(`Cannot add to static array at ${a2}`);
  } else {
    for (let t3 = 1;t3 < i2.length; t3++) {
      let n3 = i2.slice(0, t3), r3 = Yi(e4, n3), a3 = Ki(n3);
      if (r3.kind === `inline`)
        throw Error(`Cannot extend inline table at ${a3}`);
      if (r3.kind === `array`)
        throw Error(`Cannot add to static array at ${a3}`);
      if (r3.kind === `value`)
        throw Error(`Value already defined for ${a3}`);
    }
    if (o2.kind === `inline`)
      throw Error(`Cannot extend inline table at ${a2}`);
    if (o2.kind === `implicit`)
      throw Error(`Implicit table already defined: ${a2}`);
    if (o2.kind === `array`)
      throw Error(`Cannot add to static array at ${a2}`);
    if (r2 === `Table`) {
      if (o2.kind === `explicit` || o2.kind === `table-array`)
        throw Error(`Table already defined: ${a2}`);
      if (o2.kind === `value` || o2.kind === `date`)
        throw Error(`Value already defined for ${a2}`);
    } else if (o2.kind !== `undefined` && o2.kind !== `table-array` || o2.kind === `undefined` && o2.children.size > 0)
      throw Error(`Cannot add Array of Tables to table at ${a2}`);
  }
}
function Ui(e4, t2) {
  let n2 = Gi(e4, t2.slice(0, -1)), r2 = P(t2);
  return n2[r2] || (n2[r2] = mt()), n2[r2];
}
function Wi(e4, t2) {
  let n2 = Gi(e4, t2.slice(0, -1)), r2 = P(t2);
  n2[r2] || (n2[r2] = []);
  let i2 = mt();
  return n2[P(t2)].push(i2), i2;
}
function Gi(e4, t2) {
  return t2.reduce((e5, t3) => (e5[t3] || (e5[t3] = mt()), Array.isArray(e5[t3]) ? P(e5[t3]) : e5[t3]), e4);
}
function Ki(e4) {
  return e4.join(`.`);
}
function qi(e4) {
  return JSON.stringify(e4);
}
function Ji() {
  return { kind: `undefined`, children: /* @__PURE__ */ new Map, entries: [] };
}
function Yi(e4, t2, n2 = false) {
  let r2 = e4;
  for (let e5 of t2) {
    r2.kind === `table-array` && (r2 = r2.entries[r2.entries.length - 1] ?? r2);
    let t3 = r2.children.get(e5);
    if (!t3 && n2 && (t3 = Ji(), r2.children.set(e5, t3)), !t3)
      return Ji();
    r2 = t3;
  }
  return r2;
}
function Xi(e4) {
  return e4.type === `Add`;
}
function Zi(e4) {
  return e4.type === `Edit`;
}
function Qi(e4) {
  return e4.type === `Remove`;
}
function $i(e4) {
  return e4.type === `Move`;
}
function ea(e4) {
  return e4.type === `Rename`;
}
function ta(e4, t2, n2 = [], r2 = {}) {
  return ht(e4, t2) || Lt(e4, t2) || typeof e4 == `number` && typeof t2 == `number` && Number.isNaN(e4) && Number.isNaN(t2) && _t(e4) === _t(t2) ? [] : Array.isArray(e4) && Array.isArray(t2) ? oa(e4, t2, n2, r2) : F(e4) && F(t2) ? na(e4, t2, n2, r2) : [{ type: `Edit`, path: n2 }];
}
function na(e4, t2, n2 = [], r2 = {}) {
  let i2 = [], a2 = Object.keys(e4), o2 = a2.map((t3) => Rt(e4[t3])), s2 = Object.keys(t2), c2 = s2.map((e5) => Rt(t2[e5])), l2 = new Map(s2.map((e5, t3) => [e5, c2[t3]])), u2 = new Set(a2), d2 = new Set(s2), f2 = (e5, t3, n3) => {
    let r3 = /* @__PURE__ */ new Map;
    return e5.forEach((e6, i3) => {
      if (n3.has(e6))
        return;
      let a3 = r3.get(t3[i3]);
      a3 ? a3.push(e6) : r3.set(t3[i3], [e6]);
    }), r3;
  }, p2 = f2(a2, o2, d2), m2 = f2(s2, c2, u2), h2 = /* @__PURE__ */ new Map, g2 = /* @__PURE__ */ new Set, _2 = /* @__PURE__ */ new Map;
  for (let [e5, t3] of p2) {
    let n3 = m2.get(e5);
    if (!n3)
      continue;
    let r3 = Math.min(t3.length, n3.length);
    for (let e6 = 0;e6 < r3; e6++)
      h2.set(t3[e6], n3[e6]), g2.add(n3[e6]), _2.set(n3[e6], t3[e6]);
  }
  a2.forEach((a3, s3) => {
    let c3 = n2.concat(a3);
    if (d2.has(a3)) {
      let n3 = e4[a3], u3 = t2[a3], d3 = typeof n3 == `number` && !Number.isFinite(n3) || typeof u3 == `number` && !Number.isFinite(u3);
      (r2.updateOrder || d3 || o2[s3] !== l2.get(a3)) && zt(i2, ta(e4[a3], t2[a3], c3, r2));
    } else
      h2.has(a3) ? i2.push({ type: `Rename`, path: n2, from: a3, to: h2.get(a3) }) : i2.push({ type: `Remove`, path: c3 });
  }), s2.forEach((e5) => {
    if (!u2.has(e5) && !g2.has(e5)) {
      let t3 = { type: `Add`, path: n2.concat(e5) };
      if (r2.orderSource !== undefined) {
        let i3 = r2.orderSource;
        for (let e6 of n2)
          i3 = i3 == null ? undefined : i3[e6];
        if (F(i3)) {
          let n3 = Object.keys(i3), r3 = n3.indexOf(e5);
          for (let e6 = r3 + 1;e6 < n3.length; e6++) {
            let r4 = n3[e6], i4 = _2.get(r4) ?? (u2.has(r4) ? r4 : undefined);
            if (i4 !== undefined) {
              t3.before = i4;
              break;
            }
          }
        }
      }
      i2.push(t3);
    }
  });
  let v2 = s2;
  if (r2.orderSource !== undefined) {
    let e5 = r2.orderSource;
    for (let t3 of n2)
      e5 = e5 == null ? undefined : e5[t3];
    if (F(e5)) {
      let t3 = new Set(s2);
      v2 = Object.keys(e5).filter((e6) => t3.has(e6));
    }
  }
  let y2 = i2.filter((e5) => Xi(e5) && e5.path.length === n2.length + 1 || ea(e5) && e5.path.length === n2.length);
  if (r2.orderSource !== undefined && y2.length > 1) {
    let e5 = [...y2].sort((e6, t4) => {
      let n3 = Xi(e6) ? e6.path[e6.path.length - 1] : ea(e6) ? e6.to : ``, r3 = Xi(t4) ? t4.path[t4.path.length - 1] : ea(t4) ? t4.to : ``;
      return v2.indexOf(n3) - v2.indexOf(r3);
    }), t3 = 0;
    i2 = i2.map((n3) => y2.includes(n3) ? e5[t3++] : n3);
  }
  if (r2.updateOrder) {
    let e5 = [];
    for (let t3 of a2)
      if (d2.has(t3))
        e5.includes(t3) || e5.push(t3);
      else if (h2.has(t3)) {
        let n3 = h2.get(t3);
        e5.includes(n3) || e5.push(n3);
      }
    for (let t3 of s2)
      e5.includes(t3) || e5.push(t3);
    s2.forEach((t3, r3) => {
      if (e5[r3] === t3)
        return;
      let a3 = e5.indexOf(t3);
      i2.push({ type: `Move`, path: n2, from: a3, to: r3, key: t3 }), e5.splice(a3, 1), e5.splice(r3, 0, t3);
    });
  }
  return i2;
}
function ra(e4) {
  if (typeof e4 == `string`)
    return e4.includes(`
`);
  if (Array.isArray(e4))
    return e4.length > 0;
  if (typeof e4 == `object` && e4 && !(e4 instanceof Date)) {
    let t2 = Object.values(e4);
    return t2.some((e5) => typeof e5 == `object` && !!e5) || t2.some(ra);
  }
  return false;
}
function ia(e4) {
  return typeof e4 == `object` && !!e4 && !Array.isArray(e4) && !(e4 instanceof Date);
}
function aa(e4) {
  return e4.length > 4 && e4.some((e5) => typeof e5 == `string`) && e4.some(ia);
}
function oa(e4, t2, n2 = [], r2 = {}) {
  let i2 = [], a2 = e4.map(Rt), o2 = t2.map(Rt), s2 = e4.some(ra) || t2.some(ra) || aa(e4) || aa(t2), c2 = e4.slice(), l2 = 0, u2 = false, d2 = (e5) => {
    let t3 = { type: `Remove`, path: n2.concat(e5) };
    return (!u2 || l2 > 0) && Object.defineProperty(t3, "coordinate", { value: `source` }), t3;
  };
  for (let e5 = 0;e5 < o2.length; e5++) {
    let f2 = o2[e5], p2 = e5 >= a2.length;
    if (!p2 && a2[e5] === f2)
      continue;
    let m2 = p2 ? -1 : a2.indexOf(f2, e5 + 1);
    if (m2 > -1) {
      let r3 = a2[e5], p3 = 0;
      for (let t3 = e5;t3 < a2.length; t3++)
        a2[t3] === r3 && p3++;
      let h3 = 0;
      for (let t3 = e5;t3 < o2.length; t3++)
        o2[t3] === r3 && h3++;
      let g2 = p3 > h3;
      if (s2 && (o2.indexOf(a2[e5]) === -1 || g2) || l2 > 0 && g2) {
        i2.push(d2(e5 + l2)), a2.splice(e5, 1), c2.splice(e5, 1), l2++, e5--;
        continue;
      }
      if (s2 && l2 > 0) {
        i2.push({ type: `Add`, path: n2.concat(e5) }), u2 = true, a2.splice(e5, 0, f2), c2.splice(e5, 0, t2[e5]), l2--;
        continue;
      }
      i2.push({ type: `Move`, path: n2, from: m2, to: e5 });
      let _2 = a2.splice(m2, 1);
      a2.splice(e5, 0, ..._2);
      let v2 = c2.splice(m2, 1);
      c2.splice(e5, 0, ...v2);
      continue;
    }
    let h2 = false;
    if (!p2) {
      let t3 = a2[e5], n3 = 0;
      for (let r4 = e5;r4 < a2.length; r4++)
        a2[r4] === t3 && n3++;
      let r3 = 0;
      for (let n4 = e5;n4 < o2.length; n4++)
        o2[n4] === t3 && r3++;
      h2 = n3 > r3;
    }
    !p2 && h2 ? (zt(i2, ta(c2[e5], t2[e5], n2.concat(e5), r2)), a2[e5] = f2, c2[e5] = t2[e5]) : (i2.push({ type: `Add`, path: n2.concat(e5) }), u2 = true, a2.splice(e5, 0, f2), c2.splice(e5, 0, t2[e5]), l2 > 0 && l2--);
  }
  for (let e5 = o2.length;e5 < a2.length; e5++)
    i2.push(d2(e5 + l2));
  return i2;
}
function Y(n2, i2) {
  if (!i2.length)
    return d(n2) && a(n2.item) ? n2.item : n2;
  if (a(n2))
    return Y(n2.value, i2);
  let o2 = {}, s2, c2;
  if (m(n2) && n2.items.some((l2, u2) => {
    try {
      let f2 = [];
      if (a(l2))
        f2 = l2.key.value;
      else if (t(l2))
        f2 = l2.key.item.value;
      else if (r(l2)) {
        f2 = l2.key.item.value;
        let e4 = Rt(f2);
        o2[e4] || (o2[e4] = 0);
        let t2 = o2[e4]++;
        f2 = f2.concat(t2);
      } else
        d(l2) && a(l2.item) ? f2 = l2.item.key.value : d(l2) && (f2 = [u2]);
      if (f2.length && I(f2, i2.slice(0, f2.length))) {
        let t2 = i2.slice(f2.length);
        if (e(n2) && r(l2) && t2.length > 0) {
          let e4 = l2.key.item.value, i3 = n2, a2 = i3.items.findIndex((t3, n3) => n3 > u2 && r(t3) && I(t3.key.item.value, e4)), o3 = a2 === -1 ? i3.items.length : a2;
          s2 = sa(l2, t2, e4, i3.items.slice(u2 + 1, o3));
        } else
          s2 = d(l2) && a(l2.item) ? i2.length === f2.length ? l2 : Y(l2.item.value, t2) : d(l2) && i2.length > f2.length ? Y(l2.item, t2) : Y(l2, t2);
        return true;
      }
      return (a(l2) || d(l2) && a(l2.item)) && f2.length > i2.length && I(f2.slice(0, i2.length), i2) && (c2 ||= l2), false;
    } catch {
      return false;
    }
  }), !s2 && c2 && (s2 = c2), !s2)
    throw Error(`Node not found at ${i2.join(`.`)}`);
  return s2;
}
function sa(e4, n2, i2, a2) {
  try {
    return Y(e4, n2);
  } catch {}
  let o2 = {};
  for (let [e5, s2] of a2.entries()) {
    let c2 = [];
    if (t(s2)) {
      let e6 = s2.key.item.value;
      e6.length > i2.length && I(e6.slice(0, i2.length), i2) && (c2 = e6.slice(i2.length));
    } else if (r(s2)) {
      let e6 = s2.key.item.value;
      if (e6.length > i2.length && I(e6.slice(0, i2.length), i2)) {
        let t2 = e6.slice(i2.length), n3 = Rt(t2);
        o2[n3] || (o2[n3] = 0);
        let r2 = o2[n3]++;
        c2 = t2.concat(r2);
      }
    }
    if (c2.length && I(c2, n2.slice(0, c2.length)))
      try {
        let t2 = n2.slice(c2.length);
        if (!t2.length || !r(s2))
          return Y(s2, t2);
        let i3 = a2.findIndex((t3, n3) => n3 > e5 && r(t3) && I(t3.key.item.value, s2.key.item.value)), o3 = a2.slice(e5 + 1, i3 === -1 ? a2.length : i3);
        return sa(s2, t2, s2.key.item.value, o3);
      } catch {}
  }
  throw Error(`Node not found at (aot scope) ${n2.join(`.`)}`);
}
function X(e4, t2) {
  try {
    return Y(e4, t2);
  } catch {}
}
function ca(e4, t2) {
  let n2 = t2, r2;
  for (;n2.length && !r2; )
    n2 = n2.slice(0, -1), r2 = X(e4, n2);
  if (!r2)
    throw Error(`Parent not found for ${t2.join(`.`)}`);
  return r2;
}
var la = String.raw`(?:[\w-]+|"[^"]*"|'[^']*')`;
var ua = new RegExp(String.raw`^#\s*${la}(?:\s*\.\s*${la})*\s*=`);
var da = String.raw`(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|"""[\s\S]*?"""|'''[\s\S]*?'''|[^\s#]+)`;
var fa = new RegExp(String.raw`^#\s*${la}(?:\s*\.\s*${la})*\s*=\s*${da}\s*$`);
var pa = new RegExp(String.raw`^#\s*\[\[?\s*${la}(?:\s*\.\s*${la})*\s*\]\]?\s*$`);
function ma(e4) {
  return fa.test(e4.raw) || pa.test(e4.raw);
}
function ha(e4) {
  let t2 = e4.raw.indexOf(`=`);
  if (t2 < 0)
    return false;
  let n2 = false, r2 = false;
  for (let i2 = t2 + 1;i2 < e4.raw.length; i2++) {
    let t3 = e4.raw[i2];
    if (t3 === `\\`)
      i2++;
    else if (!r2 && t3 === `"`)
      n2 = !n2;
    else if (!n2 && t3 === `'`)
      r2 = !r2;
    else if (!n2 && !r2 && t3 === `#`)
      return true;
  }
  return false;
}
function ga(e4) {
  return ma(e4) ? true : ua.test(e4.raw) ? ha(e4) ? true : e4.raw.replace(/^[^=]*=\s*/, ``).split(/\s+/).filter(Boolean).length <= 3 : false;
}
function _a(e4) {
  let t2 = e4.raw.match(ua);
  if (!t2)
    return;
  let n2 = t2[0].replace(/^#\s*/, ``).replace(/\s*=.*$/, ``).trim(), r2 = n2.indexOf(`.`);
  return r2 >= 0 && (n2 = n2.substring(0, r2)), (n2.startsWith(`"`) && n2.endsWith(`"`) || n2.startsWith(`'`) && n2.endsWith(`'`)) && (n2 = n2.slice(1, -1)), n2 || undefined;
}
function va(e4) {
  return (f(e4) || u(e4)) && e4.loc.end.line > e4.loc.start.line;
}
function ya(e4) {
  if (a(e4))
    return e4.key.value[0];
  if (t(e4) || r(e4))
    return e4.key.item.value[0];
  if (d(e4) && a(e4.item))
    return e4.item.key.value[0];
}
function ba(e4, t2, n2, r2 = ya) {
  let i2 = [], a2 = t2, o2, s2 = [], c2 = () => {
    s2.length && (i2.push({ kind: `pinned`, items: s2, startLine: s2[0].loc.start.line, endLine: P(s2).loc.end.line }), s2 = []);
  };
  for (let t3 of e4) {
    if (p(t3)) {
      if (t3.loc.start.line <= a2) {
        o2 ? (o2.items.push(t3), o2.endLine = Math.max(o2.endLine, t3.loc.end.line)) : i2.push({ kind: `pinned`, items: [t3], startLine: t3.loc.start.line, endLine: t3.loc.end.line });
        continue;
      }
      let e6 = s2.length ? P(s2).loc.end.line : undefined;
      s2.length && t3.loc.start.line === e6 + 1 || c2(), s2.push(t3);
      continue;
    }
    let e5 = [];
    if (s2.length) {
      if (P(s2).loc.end.line + 1 === t3.loc.start.line && n2(t3)) {
        let n3 = r2(t3);
        if (n3 !== undefined) {
          let e6 = -1;
          for (let t4 = s2.length - 1;t4 >= 0; t4--) {
            let r3 = ga(s2[t4]) ? _a(s2[t4]) : undefined;
            if (r3 !== undefined && r3 !== n3) {
              e6 = t4;
              break;
            }
          }
          if (e6 >= 0) {
            let t4 = s2.splice(0, e6 + 1);
            i2.push({ kind: `pinned`, items: t4, startLine: t4[0].loc.start.line, endLine: P(t4).loc.end.line });
          }
        }
        e5 = s2, s2 = [];
      } else
        c2();
    }
    let l2 = [...e5, t3], u2 = { kind: `member`, member: t3, key: r2(t3), items: l2, startLine: l2[0].loc.start.line, endLine: t3.loc.end.line };
    i2.push(u2), o2 = u2, a2 = t3.loc.end.line;
  }
  return c2(), i2;
}
function xa(t2, n2 = () => true, r2 = ya) {
  let i2 = e(t2) ? 0 : t2.key.loc.end.line;
  return ba(t2.items, i2, n2, r2);
}
function Sa(e4, t2) {
  let n2 = t2.filter((t3) => p(t3) && (t3.loc.start.line > e4.loc.start.line || t3.loc.start.line === e4.loc.start.line && t3.loc.start.column >= e4.loc.start.column) && (t3.loc.end.line < e4.loc.end.line || t3.loc.end.line === e4.loc.end.line && t3.loc.end.column <= e4.loc.end.column));
  return ba([...e4.items, ...n2].sort((e5, t3) => e5.loc.start.line - t3.loc.start.line || e5.loc.start.column - t3.loc.start.column), e4.loc.start.line, () => true);
}
function Ca(e4, t2) {
  function n2(e5) {
    if (a(e5))
      return n2(e5.value);
    if (m(e5)) {
      for (let n3 of e5.items)
        if (d(n3) && n3.item === t2)
          return n3;
      for (let t3 of e5.items) {
        let e6 = n2(d(t3) ? t3.item : t3);
        if (e6)
          return e6;
      }
    }
  }
  return n2(e4);
}
function wa(e4, n2) {
  function i2(e5, t2) {
    if (e5 === n2)
      return t2;
    if (a(e5))
      return i2(e5.value, t2);
    if (f(e5) || u(e5))
      for (let r2 of e5.items) {
        if (r2 === n2)
          return t2;
        let e6 = i2(r2.item, t2);
        if (e6)
          return e6;
      }
  }
  function o2(e5) {
    for (let s2 of e5.items) {
      if (s2 === n2)
        return e5;
      if (a(s2)) {
        let t2 = i2(s2.value, e5);
        if (t2)
          return t2;
      } else if (t(s2) || r(s2)) {
        let e6 = o2(s2);
        if (e6)
          return e6;
      }
    }
  }
  return o2(e4);
}
function Ta(e4) {
  for (let n2 = 0;n2 < e4.items.length; n2++) {
    let i2 = e4.items[n2];
    if (!t(i2) && !r(i2))
      continue;
    let a2 = e4.items[n2 + 1];
    if (!a2)
      continue;
    let o2 = Ea(i2, a2);
    if (!o2)
      continue;
    let s2 = i2.items;
    s2.splice(s2.length - o2.length, o2.length), e4.items.splice(n2 + 1, 0, ...o2), _r(i2), n2 += o2.length;
  }
}
function Ea(e4, t2) {
  let n2 = P(xa(e4));
  if (!n2 || n2.kind !== `pinned`)
    return;
  let r2 = n2.items, i2 = n2.endLine + 1 === t2.loc.start.line, a2 = r2.every(ma);
  if (i2 && !a2)
    return r2;
}
function Z(n2, i2, a2) {
  if (e(i2) && (t(a2) || r(a2))) {
    let e4 = i2.items.indexOf(a2), o2 = e4 > 0 ? i2.items[e4 - 1] : undefined;
    if (o2 && (t(o2) || r(o2))) {
      let e5 = Ea(o2, a2);
      if (e5)
        for (let t2 of e5)
          U(n2, o2, t2);
    }
    let s2 = i2.items[e4 + 1];
    if (s2 && (t(s2) || r(s2))) {
      let t2 = Ea(a2, s2);
      if (t2) {
        let n3 = a2.items;
        n3.splice(n3.length - t2.length, t2.length), i2.items.splice(e4 + 1, 0, ...t2), _r(a2);
      }
    }
  }
  if (e(i2) || t(i2) || r(i2)) {
    let e4 = xa(i2).find((e5) => e5.member === a2);
    if (e4) {
      let t2 = e4.items.indexOf(a2);
      for (let r2 = 0;r2 <= t2; r2++) {
        let t3 = e4.items[r2];
        i2.items.includes(t3) && U(n2, i2, t3);
      }
      for (let n3 = t2 + 1;n3 < e4.items.length; n3++) {
        let t3 = e4.items[n3], r2 = i2.items.indexOf(t3);
        r2 < 0 || i2.items.splice(r2, 1);
      }
      return;
    }
  }
  if (va(i2) && e(n2)) {
    let e4 = wa(n2, i2);
    if (e4) {
      let t2 = Sa(i2, e4.items).find((e5) => e5.member === a2);
      if (t2) {
        let r2 = t2.items.filter((e5) => e5 !== a2);
        for (let t3 of r2) {
          let n3 = e4.items.indexOf(t3);
          n3 < 0 || e4.items.splice(n3, 1);
        }
        r2.length && (a2.loc.start = t2.items[0].loc.start, a2.loc.end = P(t2.items).loc.end), U(n2, i2, a2, e4.items), W(n2);
        return;
      }
    }
  }
  U(n2, i2, a2);
}
function Da(t2, n2, r2, i2) {
  let s2 = false;
  if (va(n2) && e(t2)) {
    let e4 = wa(t2, n2);
    if (e4) {
      let c3 = Sa(n2, e4.items);
      {
        let e5 = n2.items, r3 = 1;
        for (let n3 = 1;n3 < e5.length; n3++)
          if (e5[n3].loc.start.line === e5[n3 - 1].loc.start.line) {
            let i3 = B(t2).get(e5[n3 - 1]), a2 = B(t2).get(e5[n3]);
            if (i3 || a2)
              continue;
            if (r3++, r3 >= 3) {
              s2 = true;
              break;
            }
          } else
            r3 = 1;
      }
      let l3 = [], p3, h3, g3, _3 = [], v3 = (e5, t3) => {
        if (!m(e5))
          return;
        let n3 = e5.items;
        for (let e6 = 0;e6 < n3.length; e6++) {
          let r3 = n3[e6], i3 = r3.loc.start.line > t3;
          if (i3 && _3.push({ node: r3, start: T(r3.loc.start), end: T(r3.loc.end) }), r3.loc.end.line > t3 && r3.loc.end.line > r3.loc.start.line && _3.push({ node: r3, start: T(r3.loc.start), end: T(r3.loc.end), endOnly: true }), d(r3)) {
            let e7 = r3.item;
            if (i3) {
              let t4 = a(e7) ? e7 : undefined;
              _3.push({ node: e7, start: T(e7.loc.start), end: T(e7.loc.end), equals: t4 ? t4.equals : undefined }), t4 && (_3.push({ node: t4.key, start: T(t4.key.loc.start), end: T(t4.key.loc.end) }), _3.push({ node: t4.value, start: T(t4.value.loc.start), end: T(t4.value.loc.end) }));
            }
            e7.loc.end.line > t3 && e7.loc.end.line > e7.loc.start.line && _3.push({ node: e7, start: T(e7.loc.start), end: T(e7.loc.end), endOnly: true }), v3(e7, t3);
          } else
            m(r3) && v3(r3, t3);
        }
      };
      for (let t3 of c3) {
        if (t3.kind !== `member` || !t3.member)
          continue;
        let n3 = t3.items.filter((e5) => e5 !== t3.member);
        if (t3.member === r2 && (p3 = T(r2.loc.start), h3 = T(r2.loc.end), d(r2) && (g3 = T(r2.item.loc.end)), v3(d(r2) ? r2.item : r2, p3.line), n3.length && (r2.loc.start = T(t3.items[0].loc.start), r2.loc.end = T(P(t3.items).loc.end))), n3.length) {
          l3.push({ owner: t3.member, ownerOriginalStart: T(t3.member.loc.start), comments: n3 });
          for (let t4 of n3) {
            let n4 = e4.items.indexOf(t4);
            n4 >= 0 && e4.items.splice(n4, 1);
          }
        }
      }
      let y3 = n2.items.indexOf(r2), b3 = y3 === n2.items.length - 1, x3 = y3 > 0 ? n2.items[y3 - 1] : undefined, S2 = i2 === 0 && y3 > 0 && r2.loc.end.line > r2.loc.start.line && x3 !== undefined && x3.loc.start.line === r2.loc.start.line;
      U(t2, n2, r2, e4.items);
      let C2 = false;
      if (b3 && x3 !== undefined && r2.loc.end.line > r2.loc.start.line && !br(n2) && B(t2).get(x3) && (B(t2).delete(x3), C2 = true), W(t2), H(t2, n2, r2, i2, undefined, e4.items), C2) {
        let e5 = B(t2).get(r2);
        e5 && (e5.lines = 0, e5.columns = 0);
      }
      W(t2), p3 && h3 && r2.loc.end.line > r2.loc.start.line && (r2.loc.end.column = h3.column, d(r2) && g3 && r2.item.loc.end.line > r2.item.loc.start.line && (r2.item.loc.end.column = g3.column));
      for (let { node: e5, start: t3, end: n3, endOnly: r3, equals: i3 } of _3)
        r3 ? e5.loc.end.column = n3.column : (e5.loc.start.column = t3.column, e5.loc.end.line === e5.loc.start.line && (e5.loc.end.column = n3.column), i3 !== undefined && a(e5) && (e5.equals = i3));
      for (let { owner: t3, ownerOriginalStart: n3, comments: i3 } of l3) {
        let a2;
        t3 === r2 ? (a2 = { lines: r2.loc.start.line - n3.line, columns: r2.loc.start.column - n3.column }, r2.loc.start = { line: p3.line + a2.lines, column: p3.column + a2.columns }, r2.loc.end = { line: h3.line + a2.lines, column: h3.column + a2.columns }) : a2 = { lines: t3.loc.start.line - n3.line, columns: t3.loc.start.column - n3.column };
        for (let t4 of i3) {
          G(t4, a2);
          let n4 = e4.items.findIndex((e5) => e5.loc.start.line > t4.loc.start.line);
          n4 === -1 ? e4.items.push(t4) : e4.items.splice(n4, 0, t4);
        }
      }
      let w2 = n2;
      if (s2 || S2) {
        let e5 = (t3, n4) => {
          let r3;
          for (let n5 of t3.items) {
            if (!r3) {
              r3 = { line: n5.loc.end.line, column: n5.loc.end.column + 2 };
              continue;
            }
            let t4 = { lines: r3.line - n5.loc.start.line, columns: r3.column - n5.loc.start.column };
            if (t4.lines !== 0 || t4.columns !== 0) {
              G(n5, t4), n5.loc.end.line > n5.loc.start.line && (n5.loc.end.column -= t4.columns, d(n5) && n5.item.loc.end.line > n5.item.loc.start.line && (n5.item.loc.end.column -= t4.columns));
              let r4 = d(n5) ? a(n5.item) ? n5.item.value : n5.item : n5;
              (f(r4) || u(r4)) && r4.loc.end.line > r4.loc.start.line && e5(r4, n5);
            }
            r3 = { line: n5.loc.end.line, column: n5.loc.end.column + 2 };
          }
          r3 && (t3.loc.end = { line: r3.line, column: r3.column - 1 }, n4 && n4.loc.end.line === t3.loc.end.line && (n4.loc.end.column = t3.loc.end.column));
        }, n3;
        for (let t3 of w2.items) {
          if (t3 === r2) {
            n3 = { line: r2.loc.end.line, column: r2.loc.end.column + 2 };
            continue;
          }
          if (!n3)
            continue;
          let i3 = { lines: n3.line - t3.loc.start.line, columns: n3.column - t3.loc.start.column };
          if (i3.lines !== 0 || i3.columns !== 0) {
            G(t3, i3);
            let n4 = d(t3) ? a(t3.item) ? t3.item.value : t3.item : t3;
            (f(n4) || u(n4)) && n4.loc.end.line > n4.loc.start.line && e5(n4, d(t3) ? t3 : undefined);
          }
          let s3 = t3.loc.end.line, c4 = d(t3) ? t3.item : t3;
          o(c4) && c4.loc.end.line > c4.loc.start.line && (s3 = c4.loc.start.line + c4.raw.split(`
`).length - 1, c4.loc.end.line = s3, t3.loc.end.line = s3), n3 = { line: s3, column: t3.loc.end.column + 2 };
        }
        if (n3) {
          let e6 = T(w2.loc.end);
          w2.loc.end = { line: n3.line, column: n3.column - 1 };
          let r3 = Ca(t2, w2);
          r3 && (r3.loc.end = { line: w2.loc.end.line, column: w2.loc.end.column });
          let i3 = { lines: w2.loc.end.line - e6.line, columns: w2.loc.end.column - e6.column };
          (i3.lines !== 0 || i3.columns !== 0) && ar(t2, r3 ?? w2, i3);
        }
      }
      return;
    }
  }
  let c2 = n2, l2 = c2.items, p2 = l2[0], h2 = l2[l2.length - 1], g2 = p2.loc.start.column - c2.loc.start.column - 1, _2 = c2.loc.end.column - 1 - h2.loc.end.column;
  U(t2, n2, r2), H(t2, n2, r2, i2), W(t2);
  let v2 = c2.items, y2 = v2[0], b2 = y2.loc.start.column - c2.loc.start.column - 1;
  b2 !== g2 && G(y2, { lines: 0, columns: g2 - b2 });
  let x2 = v2[v2.length - 1];
  c2.loc.end.column - 1 - x2.loc.end.column !== _2 && (c2.loc.end.column = x2.loc.end.column + 1 + _2);
}
function Oa(e4) {
  let n2 = [];
  for (let i3 of e4) {
    if (i3.kind === `pinned`) {
      n2.push({ kind: `pinned`, isSection: false, movable: false, groups: [i3], startLine: i3.startLine, endLine: i3.endLine, items: i3.items });
      continue;
    }
    let e5 = t(i3.member) || r(i3.member), a2 = n2[n2.length - 1];
    a2 && a2.kind === `member` && i3.key !== undefined && a2.key === i3.key ? (a2.groups.push(i3), a2.endLine = i3.endLine, a2.items = a2.items.concat(i3.items)) : n2.push({ kind: `member`, key: i3.key, isSection: e5, movable: i3.key !== undefined, groups: [i3], startLine: i3.startLine, endLine: i3.endLine, items: [...i3.items] });
  }
  let i2 = /* @__PURE__ */ new Map;
  for (let e5 of n2)
    e5.kind === `member` && e5.key !== undefined && i2.set(e5.key, (i2.get(e5.key) ?? 0) + 1);
  for (let e5 of n2)
    e5.kind === `member` && e5.key !== undefined && i2.get(e5.key) > 1 && (e5.movable = false);
  return n2;
}
function ka(e4, t2) {
  let n2 = [...e4];
  for (let e5 of t2) {
    if (e5.key === undefined)
      continue;
    let t3 = n2.indexOf(e5.key);
    if (t3 === -1)
      continue;
    let r2 = Math.max(0, Math.min(e5.to, n2.length - 1));
    t3 !== r2 && (n2.splice(t3, 1), n2.splice(r2, 0, e5.key));
  }
  return n2;
}
function Aa(e4) {
  return [...e4.path, e4.key].join(`.`);
}
function ja(e4, n2, i2, o2) {
  if (n2.some((e5) => typeof e5 != `string`))
    return;
  let s2 = [...n2, i2], c2 = [{ container: e4, prefix: [] }];
  for (let n3 of e4.items)
    (t(n3) || r(n3)) && c2.push({ container: n3, prefix: n3.key.item.value });
  for (let e5 of c2)
    for (let t2 of e5.container.items) {
      if (!a(t2) || t2.key.value.length < 2 || o2.has(t2))
        continue;
      let n3 = [...e5.prefix, ...t2.key.value];
      if (n3.length === s2.length && n3.every((e6, t3) => e6 === s2[t3]))
        return { container: e5.container, dottedPrefix: t2.key.value.slice(0, -1) };
    }
}
function Ma(n2, i2, o2, s2) {
  if (i2.length === 0)
    return { container: n2 };
  let c2;
  try {
    c2 = X(n2, i2);
  } catch {
    return;
  }
  if (!c2)
    return;
  if (a(c2) && (c2 = c2.value), c2 && h(c2) && (c2 = c2.item), c2 && (e(c2) || t(c2) || r(c2)))
    return { container: c2 };
  if (o2 === undefined)
    return;
  let l2 = ja(n2, i2, o2, s2);
  if (l2)
    return l2;
  let u2 = -1;
  for (let e4 = i2.length - 1;e4 >= 0; e4--)
    if (typeof i2[e4] == `number`) {
      u2 = e4;
      break;
    }
  if (u2 < 0)
    return;
  let d2 = i2.slice(u2 + 1);
  if (d2.length === 0 || d2.some((e4) => typeof e4 != `string`))
    return;
  let f2 = X(n2, i2.slice(0, u2 + 1));
  if (!f2 || !r(f2))
    return;
  let p2 = [...d2, o2];
  return f2.items.some((e4) => a(e4) && e4.key.value.length === p2.length && e4.key.value.every((e5, t2) => e5 === p2[t2])) ? { container: f2, dottedPrefix: d2 } : undefined;
}
function Na(e4, t2, n2) {
  if (t2.key === undefined)
    return false;
  let r2;
  try {
    r2 = X(e4, t2.path.concat(t2.key));
  } catch {
    return false;
  }
  return r2 !== undefined && d(r2) && !n2.has(r2);
}
function Pa(t2, n2, r2, i2, o2) {
  let s2 = Oa(xa(t2, (e4) => r2.has(e4), o2 ? (e4) => {
    if (!a(e4))
      return;
    let t3 = e4.key.value;
    if (t3.length === o2.length + 1) {
      for (let e5 = 0;e5 < o2.length; e5++)
        if (t3[e5] !== o2[e5])
          return;
      return t3[o2.length];
    }
  } : undefined)), c2 = /* @__PURE__ */ new Map;
  for (let e4 of s2)
    e4.kind === `member` && e4.movable && e4.key !== undefined && c2.set(e4.key, e4);
  let l2 = new Set(s2.filter((e4) => e4.kind === `member` && e4.key !== undefined).map((e4) => e4.key));
  for (let e4 of n2)
    e4.key !== undefined && l2.has(e4.key) && !c2.has(e4.key) && i2.push(`"${Aa(e4)}" -- its entries are not contiguous in the document (e.g. the TOML spec's own "valid but discouraged" out-of-order table pattern), so reordering was skipped for it`);
  if (c2.size === 0)
    return;
  let u2 = o2 ? s2.filter((e4) => e4.kind === `member` && e4.movable).map((e4) => e4.key) : s2.filter((e4) => e4.kind === `member`).map((e4, t3) => e4.movable ? e4.key : `\x00anchor:${t3}`), d2 = n2.filter((e4) => e4.key !== undefined && c2.has(e4.key));
  if (d2.length === 0)
    return;
  let f2 = ka(u2, d2).filter((e4) => c2.has(e4)), p2 = f2.filter((e4) => !c2.get(e4).isSection), m2 = f2.filter((e4) => c2.get(e4).isSection), h2 = false;
  for (let e4 of f2)
    if (c2.get(e4).isSection)
      h2 = true;
    else if (h2) {
      i2.push(`the requested order asked for a root key-value to be positioned after a section header, which TOML cannot represent -- each group (root key-values, section blocks) was reordered to match its own requested relative order instead`);
      break;
    }
  let g2 = 0, _2 = 0, v2 = s2.map((e4) => {
    if (e4.kind !== `member` || !e4.movable)
      return e4;
    let t3 = e4.isSection ? m2[_2++] : p2[g2++];
    return c2.get(t3);
  });
  if (v2.every((e4, t3) => e4 === s2[t3]))
    return;
  let y2 = e(t2) ? 1 : t2.key.loc.end.line, b2 = s2.map((e4, t3) => t3 === 0 ? e4.startLine - y2 : e4.startLine - s2[t3 - 1].endLine - 1), x2 = y2;
  for (let e4 = 0;e4 < v2.length; e4++) {
    let t3 = v2[e4], n3 = b2[e4], r3 = (e4 === 0 ? x2 : x2 + 1) + n3 - t3.startLine;
    if (r3 !== 0)
      for (let e5 of t3.items)
        G(e5, { lines: r3, columns: 0 });
    x2 = t3.endLine + r3;
  }
  let S2 = v2.flatMap((e4) => e4.items), C2 = t2.items;
  C2.splice(0, C2.length, ...S2), _r(t2);
}
function Fa(e4, t2, n2) {
  if (t2.length === 0)
    return;
  Ta(e4);
  let r2 = [], i2 = /* @__PURE__ */ new Map;
  for (let o2 of t2) {
    var a2;
    if (o2.key === undefined)
      continue;
    let t3 = Ma(e4, o2.path, o2.key, n2);
    if (!t3) {
      if (Na(e4, o2, n2))
        continue;
      r2.push(`"${Aa(o2)}" -- unsupported location for reordering (e.g. a dotted-key implicit table, or an interior of an inline table/array-of-tables entry)`);
      continue;
    }
    let s2 = ((a2 = t3.dottedPrefix) == null ? undefined : a2.join(`\x00`)) ?? ``, c2 = i2.get(t3.container);
    c2 || (c2 = /* @__PURE__ */ new Map, i2.set(t3.container, c2));
    let l2 = c2.get(s2);
    l2 ? l2.moves.push(o2) : c2.set(s2, { ...t3, moves: [o2] });
  }
  for (let e5 of i2.values())
    for (let t3 of e5.values())
      Pa(t3.container, t3.moves, n2, r2, t3.dottedPrefix);
  if (r2.length > 0) {
    let e5 = [...new Set(r2)];
    console.warn(`toml-patch: updateOrder could not honor the requested position for ${e5.length === 1 ? `1 entry` : `${e5.length} entries`}, left unchanged:
` + e5.map((e6) => `  - ${e6}`).join(`
`));
  }
  _r(e4);
}
var Ia = /* @__PURE__ */ new WeakMap;
var La = /* @__PURE__ */ new WeakMap;
function Ra(e4, t2) {
  let n2 = e4[t2].loc.end.line;
  for (let r2 = t2 + 1;r2 < e4.length; r2++) {
    let t3 = e4[r2];
    if (p(t3) && t3.loc.start.line === n2)
      return t3;
    if (!p(t3) && t3.loc.start.line > n2)
      return;
  }
}
function za(e4, t2, n2) {
  for (let r2 = t2 + n2;r2 >= 0 && r2 < e4.length; r2 += n2)
    if (!p(e4[r2]))
      return r2;
}
function Ba(e4, t2, n2) {
  La.has(e4) || La.set(e4, e4.loc.start.column);
  let r2 = e4.loc.start.column + n2, i2 = Math.max(t2, r2) - r2;
  i2 !== 0 && (e4.loc.start.column += i2, e4.loc.end.column += i2);
}
function Va(e4, t2) {
  La.set(t2, t2.loc.start.column), Ia.set(t2, t2.loc.start.column - e4.loc.end.column);
}
function Ha(e4, t2, n2, r2) {
  if (!m(e4))
    return;
  let i2 = e4.items, a2 = i2.indexOf(t2);
  if (a2 < 0)
    return;
  let o2 = Ra(i2, a2);
  if (!o2 || n2.loc.start.line !== n2.loc.end.line || r2.loc.start.line !== r2.loc.end.line)
    return;
  let s2 = o2.loc.start.column, c2 = o2.loc.start.line, l2 = [za(i2, a2, -1), za(i2, a2, 1)], u2;
  for (let e5 of l2) {
    if (e5 == null)
      continue;
    let t3 = Ra(i2, e5);
    if (t3 && Math.abs(t3.loc.start.line - c2) === 1 && t3.loc.start.column === s2) {
      u2 = t3.loc.start.column;
      break;
    }
  }
  if (u2 == null)
    return;
  let d2 = x(n2.loc), f2 = x(r2.loc).columns - d2.columns;
  Ba(o2, u2, f2);
}
function Ua(e4, t2, n2) {
  if (!m(e4))
    return;
  let r2 = e4.items, i2 = r2.indexOf(t2);
  if (i2 < 0)
    return;
  let a2 = Ra(r2, i2);
  if (!a2)
    return;
  let o2 = a2.loc.start.column, s2 = a2.loc.start.line, c2 = [za(r2, i2, -1), za(r2, i2, 1)];
  for (let e5 of c2) {
    if (e5 == null)
      continue;
    let t3 = Ra(r2, e5);
    if (t3 && Math.abs(t3.loc.start.line - s2) === 1 && t3.loc.start.column === o2) {
      Ba(a2, t3.loc.start.column, n2);
      return;
    }
  }
}
function Wa(e4, t2, n2) {
  if (!m(e4) || n2 === 0)
    return;
  let r2 = e4.items, i2 = r2.indexOf(t2);
  if (i2 < 0)
    return;
  let a2 = Ra(r2, i2);
  a2 && Va(t2, a2);
}
function Ga(e4, t2, n2) {
  if (!u(e4) && !f(e4))
    return 0;
  let r2 = x(t2.loc), i2 = n2 > 0, a2 = n2 < e4.items.length, o2 = n2 === e4.items.length, s2 = d(t2) ? t2.comma : false, c2 = i2 && s2 && !a2 && o2;
  return r2.columns + (i2 || a2 ? 2 : 0) + (s2 ? 1 + (c2 ? -1 : 0) : 0);
}
function Ka(e4, n2 = []) {
  for (let i2 of e4.items)
    p(i2) ? n2.push(i2) : (t(i2) || r(i2)) && Ka(i2, n2);
  return n2;
}
function qa(e4, n2 = /* @__PURE__ */ new Set) {
  for (let i2 of e4.items)
    a(i2) && f(i2.value) && i2.loc.start.line === i2.loc.end.line ? n2.add(i2.loc.end.line) : (t(i2) || r(i2)) && qa(i2, n2);
  return n2;
}
function Ja(e4) {
  for (let n3 of e4.items)
    (t(n3) || r(n3)) && Ja(n3);
  let n2 = e4.loc.end.line, i2 = e4.loc.end.column, a2 = (e5, t2) => {
    (e5 > n2 || e5 === n2 && t2 > i2) && (n2 = e5, i2 = t2);
  };
  (t(e4) || r(e4)) && a2(e4.key.loc.end.line, e4.key.loc.end.column);
  for (let t2 of e4.items)
    a2(t2.loc.end.line, t2.loc.end.column);
  e4.loc.end.line = n2, e4.loc.end.column = i2;
}
function Ya(e4, t2, n2) {
  let r2 = n2.newLine, i2 = t2.match(/(?:\r\n|\n)+$/u), a2 = i2 ? i2[0] : ``, o2 = a2 ? t2.slice(0, -a2.length) : t2, s2 = o2.length ? o2.split(r2) : [], c2 = qa(e4), l2 = (e5, t3) => {
    let n3 = e5.lastIndexOf(t3.raw);
    return n3 >= 0 ? n3 : t3.loc.start.column;
  }, u2 = Ka(e4).filter((e5) => {
    let t3 = s2[e5.loc.start.line - 1] || ``, n3 = l2(t3, e5), r3 = t3.slice(0, n3);
    return r3.trim().length > 0 && /\s{2,}$/u.test(r3);
  }).sort((e5, t3) => e5.loc.start.line - t3.loc.start.line), d2 = [], f2 = [];
  for (let e5 of u2) {
    let t3 = f2[f2.length - 1];
    !t3 || e5.loc.start.line === t3.loc.start.line + 1 ? f2.push(e5) : (f2.length > 0 && d2.push(f2), f2 = [e5]);
  }
  f2.length > 0 && d2.push(f2);
  for (let e5 of d2) {
    if (e5.length < 2)
      continue;
    let t3 = La.get(e5[0]) ?? e5[0].loc.start.column, n3 = /* @__PURE__ */ new Map;
    for (let t4 of e5) {
      let e6 = La.get(t4) ?? t4.loc.start.column;
      n3.set(e6, (n3.get(e6) || 0) + 1);
    }
    let r3 = 1;
    for (let [e6, i4] of n3)
      i4 > r3 && (r3 = i4, t3 = e6);
    let i3 = Math.max(...e5.map((e6) => {
      let t4 = s2[e6.loc.start.line - 1] || ``, n4 = l2(t4, e6);
      return t4.slice(0, n4).trimEnd().length;
    })), a3 = Math.min(...e5.map((e6) => {
      let t4 = s2[e6.loc.start.line - 1] || ``, n4 = l2(t4, e6), r4 = t4.slice(0, n4).trimEnd();
      return Math.max(1, n4 - r4.length);
    })), o3 = e5.filter((e6) => Ia.has(e6)), u3 = e5.some((e6) => !c2.has(e6.loc.start.line));
    if (o3.length > 0 && u3) {
      let t4 = Math.min(...e5.map((e6) => {
        if (Ia.has(e6))
          return Ia.get(e6) || 1;
        let t5 = s2[e6.loc.start.line - 1] || ``, n4 = l2(t5, e6), r4 = t5.slice(0, n4).trimEnd();
        return Math.max(1, n4 - r4.length);
      }));
      a3 = Math.min(a3, t4);
    }
    if (t3 < i3 + 1) {
      let e6 = i3 + a3;
      t3 = Math.max(t3, e6);
    }
    for (let n4 of e5) {
      let e6 = n4.loc.start.line - 1, r4 = s2[e6] || ``, i4 = l2(r4, n4), a4 = r4.slice(0, i4).trimEnd(), o4 = Math.max(t3, a4.length + 1);
      i4 !== o4 && (s2[e6] = a4 + ` `.repeat(o4 - a4.length) + n4.raw), n4.loc.start.column !== o4 && (n4.loc.start.column = o4, n4.loc.end.column = o4 + n4.raw.length);
    }
  }
  return Ja(e4), s2.join(r2) + a2;
}
function Xa(e4, t2, n2) {
  let r2 = ee(), i2 = Kt(e4), a2 = Array.from(N(i2, r2));
  vn(a2, i2);
  let o2 = L(n2, R.autoDetectFormatWithCst(e4, a2));
  if (r2.mixed) {
    let e5 = o2.newLine === `\r
` ? `CRLF` : `LF`;
    console.warn(`toml-patch: Mixed line endings detected. Line endings in the output will be normalized to ${e5}`);
  }
  return ((e5) => o2.leadingBom ? `\uFEFF${e5}` : e5)(no(a2, t2, o2, n2 instanceof R || n2 != null && Object.prototype.hasOwnProperty.call(n2, `indentWidth`), n2 instanceof R || n2 != null && Object.prototype.hasOwnProperty.call(n2, `trailingComma`), n2 instanceof R || n2 != null && Object.prototype.hasOwnProperty.call(n2, `inlineTableStart`)).tomlString);
}
function Za(e4, t2, n2) {
  let r2 = e4.slice(n2), i2 = 0, a2 = Math.min(r2.length, t2.length);
  for (let e5 = 1;e5 <= a2; e5++)
    I(r2.slice(r2.length - e5), t2.slice(0, e5)) && (i2 = e5);
  return i2;
}
function Qa(e4, t2, n2) {
  if (n2 === undefined)
    return;
  let r2 = t2.key.value;
  if (r2.length < 2)
    return;
  let i2 = r2.slice(0, -1);
  for (let t3 = 0;t3 < e4.items.length; t3++) {
    let o2 = e4.items[t3];
    if (!d(o2) || !a(o2.item))
      continue;
    let s2 = o2.item.key.value;
    if (s2.length === r2.length && I(s2.slice(0, -1), i2) && s2[s2.length - 1] === n2)
      return t3;
  }
}
function $a(e4) {
  let t2 = /* @__PURE__ */ new WeakSet, n2 = (e5) => {
    t2.add(e5);
  };
  return Ut(e4, { Document: n2, Table: n2, TableKey: n2, TableArray: n2, TableArrayKey: n2, KeyValue: n2, Key: n2, String: n2, Integer: n2, Float: n2, Boolean: n2, DateTime: n2, InlineArray: n2, InlineItem: n2, InlineTable: n2, Comment: n2 }), t2;
}
function eo(e4, t2, n2, r2) {
  if (!F(t2))
    return t2;
  let i2 = Bi(J(e4, L({ ...n2, inlineTableStart: 0 }, n2)).items, ``, { temporal: r2 });
  if (!F(i2))
    return t2;
  let a2 = {};
  for (let e5 of Object.keys(i2))
    Object.prototype.hasOwnProperty.call(t2, e5) && (a2[e5] = t2[e5]);
  for (let e5 of Object.keys(t2))
    Object.prototype.hasOwnProperty.call(a2, e5) || (a2[e5] = t2[e5]);
  return a2;
}
function to(e4, n2 = false) {
  let i2 = e4.items;
  for (let e5 = 0;e5 < i2.length; e5++) {
    let a2 = i2[e5];
    if (!((t(a2) || r(a2)) && m(a2)))
      continue;
    let o2 = a2.items, s2 = o2.length;
    for (;s2 > 0 && p(o2[s2 - 1]); )
      s2--;
    if (s2 < o2.length) {
      let t2 = i2[e5 + 1];
      if (t2 && r(t2)) {
        let e6 = a2.key.item.value, r2 = t2.key.item.value, c2 = I(e6, r2.slice(0, e6.length)), l2 = I(r2, e6.slice(0, r2.length));
        if (n2 ? l2 : c2) {
          let e7 = o2.splice(s2), n3 = i2.indexOf(t2);
          for (let t3 of [...e7].reverse())
            i2.splice(n3, 0, t3);
          _r(a2);
        }
      }
    }
  }
}
function no(e4, t2, n2, r2 = false, i2 = true, a2 = false) {
  let o2 = [...e4];
  t2 = io(t2);
  let s2 = Dt(t2), c2 = 1, l2 = 0;
  for (let e5 of o2) {
    let t3 = e5.loc.end;
    (t3.line > c2 || t3.line === c2 && t3.column > l2) && (c2 = t3.line, l2 = t3.column);
  }
  let u2 = Bi(o2, ``, { temporal: s2 }), d2 = { type: `Document`, loc: { start: { line: 1, column: 0 }, end: { line: c2, column: l2 } }, items: o2 };
  Zn(d2, n2.indentWidth);
  let f2 = n2.inlineTableStart != null && n2.inlineTableStart > 1 ? 1 : n2.inlineTableStart, p2 = L({ ...n2, inlineTableStart: f2 }, n2), m2 = J(t2, p2), h2 = Bi(m2.items, ``, { temporal: s2 }), g2 = n2.updateOrder ? eo(t2, h2, p2, s2) : h2;
  if (!n2.updateOrder && ro(u2, g2))
    return { tomlString: ji(o2, n2), document: d2 };
  let _2 = ao(oo(d2, g2, ta(u2, g2, [], { updateOrder: n2.updateOrder, orderSource: t2 })));
  if (_2.length === 0)
    return { tomlString: ji(o2, n2), document: d2 };
  let v2 = xo(d2, m2, _2, n2, s2, n2.updateOrder ? $a(d2) : /* @__PURE__ */ new WeakSet, t2, r2, i2, a2, h2);
  return { tomlString: Ya(v2, Mi(v2.items, n2), n2), document: v2 };
}
function ro(e4, t2) {
  let n2 = [[e4, t2]];
  for (;n2.length > 0; ) {
    let [e5, t3] = n2.pop();
    if (typeof e5 == `number` && typeof t3 == `number` && (!Number.isFinite(e5) || !Number.isFinite(t3)) || typeof e5 == `number` && typeof t3 == `number` && Number.isNaN(e5) && Number.isNaN(t3))
      return false;
    if (Object.is(e5, t3))
      continue;
    if (Ct(e5) && Ct(t3)) {
      if (!Lt(e5, t3))
        return false;
      continue;
    }
    if (!e5 || !t3 || typeof e5 != `object` || typeof t3 != `object` || Array.isArray(e5) !== Array.isArray(t3))
      return false;
    if (!Array.isArray(e5)) {
      let n3 = Object.getPrototypeOf(e5), r3 = Object.getPrototypeOf(t3);
      if (n3 !== Object.prototype && n3 !== null || r3 !== Object.prototype && r3 !== null)
        return false;
    }
    let r2 = Object.keys(e5), i2 = Object.keys(t3);
    if (r2.length !== i2.length)
      return false;
    for (let i3 of r2) {
      if (!Object.prototype.hasOwnProperty.call(t3, i3))
        return false;
      n2.push([e5[i3], t3[i3]]);
    }
  }
  return true;
}
function io(e4) {
  if (Array.isArray(e4)) {
    let t3 = false, n2 = [];
    for (let r2 = 0;r2 < e4.length; r2++) {
      if (!Object.prototype.hasOwnProperty.call(e4, r2)) {
        t3 = true;
        continue;
      }
      let i2 = io(e4[r2]);
      t3 ||= i2 !== e4[r2], n2.push(i2);
    }
    return t3 ? n2 : e4;
  }
  if (!F(e4))
    return e4;
  let t2 = e4;
  for (let n2 of Object.keys(e4)) {
    let r2 = io(e4[n2]);
    r2 !== e4[n2] && (t2 === e4 && (t2 = { ...e4 }), t2[n2] = r2);
  }
  return t2;
}
function ao(e4) {
  for (let t2 = 0;t2 < e4.length; t2++) {
    let n2 = e4[t2];
    if (Qi(n2)) {
      let r2 = P(n2.path), i2 = n2.path.slice(0, -1), a2 = t2 + 1;
      for (;a2 < e4.length; ) {
        let o2 = e4[a2];
        if (Xi(o2)) {
          if (typeof P(o2.path) == `number` && I(i2, o2.path.slice(0, -1))) {
            if (n2.coordinate === `source`) {
              let n3 = -1;
              for (let t3 = a2 + 1;t3 < e4.length; t3++) {
                let r3 = e4[t3];
                if (Qi(r3) && r3.coordinate === `source` && I(i2, r3.path.slice(0, -1))) {
                  n3 = t3;
                  break;
                }
              }
              if (n3 !== -1) {
                let r3 = e4.splice(n3, 1)[0];
                e4.splice(t2, 0, r3), t2 = -1;
                break;
              }
            }
            break;
          }
          a2++;
          continue;
        }
        if ($i(o2) && o2.key === undefined) {
          if (I(i2, o2.path))
            break;
          a2++;
          continue;
        }
        if (!Qi(o2)) {
          a2++;
          continue;
        }
        let s2 = P(o2.path), c2 = o2.path.slice(0, -1);
        if (typeof r2 == `number` && typeof s2 == `number` && I(i2, c2) && s2 > r2) {
          e4.splice(a2, 1), e4.splice(t2, 0, o2), t2 = -1;
          break;
        }
        a2++;
      }
    }
  }
  return e4;
}
function oo(e4, t2, n2) {
  let i2 = /* @__PURE__ */ new Set, o2 = [], s2 = /* @__PURE__ */ new Map;
  for (let e5 of n2) {
    if (!Qi(e5) && !Xi(e5))
      continue;
    let t3 = e5.path.slice(0, -1);
    if (t3.length === 0)
      continue;
    let n3 = JSON.stringify(t3), r2 = s2.get(n3);
    r2 || (r2 = { path: t3, removes: [], adds: [] }, s2.set(n3, r2)), (Qi(e5) ? r2.removes : r2.adds).push(e5);
  }
  for (let t3 of s2.values())
    t3.removes.length !== 0 && t3.adds.length !== 0 && (X(e4, t3.path) || (t3.removes.forEach((e5) => i2.add(e5)), t3.adds.forEach((e5) => i2.add(e5)), o2.push({ type: `Edit`, path: t3.path })));
  for (let t3 of n2) {
    if (i2.has(t3) || !Qi(t3) && !Xi(t3))
      continue;
    let r2 = t3.path.slice(0, -1);
    if (r2.length === 0 || typeof P(r2) != `number`)
      continue;
    let s3 = X(e4, r2);
    if (!s3 || !d(s3) || !f(s3.item))
      continue;
    let c3 = n2.filter((e5) => !i2.has(e5) && (Qi(e5) || Xi(e5)) && I(e5.path.slice(0, -1), r2));
    if (c3.length === 0 || c3.some((e5) => e5.path.length !== r2.length + 1))
      continue;
    let l3 = new Set(s3.item.items.filter(d).map((e5) => {
      let t4 = a(e5.item) ? e5.item : undefined;
      return (t4 == null ? undefined : t4.key.value.length) === 1 ? t4.key.value[0] : undefined;
    }).filter((e5) => e5 !== undefined)), u2 = new Set(c3.filter(Qi).map((e5) => P(e5.path)));
    if (c3.some(Qi) && c3.some(Xi) && l3.size === u2.size && ![...l3].some((e5) => !u2.has(e5))) {
      for (let e5 of c3)
        i2.add(e5);
      o2.push({ type: `Edit`, path: r2 });
    }
  }
  let c2 = /* @__PURE__ */ new Map;
  for (let t3 of n2) {
    if (i2.has(t3) || !Zi(t3) && !Xi(t3) && !Qi(t3) || typeof P(t3.path) != `number`)
      continue;
    let n3 = t3.path.slice(0, -1);
    if (n3.length === 0)
      continue;
    let a2 = X(e4, n3.concat(0));
    a2 && r(a2) && c2.set(JSON.stringify(n3), n3);
  }
  for (let e5 of c2.values()) {
    let r2 = t2;
    for (let t3 of e5)
      r2 = r2 == null ? undefined : r2[t3];
    if (!Array.isArray(r2) || r2.every((e6) => F(e6)))
      continue;
    let a2 = n2.filter((t3) => !i2.has(t3) && (Zi(t3) || Xi(t3) || Qi(t3)) && t3.path.length > e5.length && I(t3.path.slice(0, e5.length), e5));
    if (!(a2.length < 2)) {
      for (let e6 of a2)
        i2.add(e6);
      o2.push({ type: `Edit`, path: e5 });
    }
  }
  if (i2.size === 0)
    return n2;
  let l2 = n2.filter((e5) => !i2.has(e5));
  return l2.push(...o2), l2;
}
function so(e4, t2, n2 = true) {
  return t2.map((t3) => A.test(t3) ? t3 : `"${Mr(t3, e4, `singleline-basic`, n2)}"`).join(`.`);
}
function co(e4) {
  let t2 = [], n2, r2 = false;
  for (let i2 = 0;i2 < e4.length; i2++) {
    let a2 = e4[i2];
    if (n2) {
      n2 === `"` && r2 ? r2 = false : n2 === `"` && a2 === `\\` ? r2 = true : a2 === n2 && (n2 = undefined);
      continue;
    }
    if (a2 === `"` || a2 === `'`) {
      n2 = a2;
      continue;
    }
    if (a2 !== `.`)
      continue;
    let o2 = i2;
    for (;o2 > 0 && (e4[o2 - 1] === ` ` || e4[o2 - 1] === `	`); )
      o2--;
    let s2 = i2 + 1;
    for (;s2 < e4.length && (e4[s2] === ` ` || e4[s2] === `	`); )
      s2++;
    t2.push(e4.slice(o2, s2));
  }
  return t2;
}
function lo(e4) {
  let t2 = [], n2 = 0, r2, i2 = false;
  for (let a2 = 0;a2 < e4.length; a2++) {
    let o2 = e4[a2];
    r2 ? r2 === `"` && i2 ? i2 = false : r2 === `"` && o2 === `\\` ? i2 = true : o2 === r2 && (r2 = undefined) : o2 === `"` || o2 === `'` ? r2 = o2 : o2 === `.` && (t2.push(e4.slice(n2, a2)), n2 = a2 + 1);
  }
  return t2.push(e4.slice(n2)), t2;
}
function uo(e4, t2) {
  let n2 = co(t2);
  n2.length !== 0 && (e4.raw = lo(e4.raw).reduce((e5, t3, r2) => r2 === 0 ? t3 : `${e5}${n2[Math.min(r2 - 1, n2.length - 1)]}${t3}`, ``), e4.loc.end.column = e4.loc.start.column + e4.raw.length);
}
function fo(e4, t2) {
  let n2;
  return Ut(e4, { KeyValue: (e5) => {
    !n2 && e5.key.value.length > t2.length && I(e5.key.value.slice(0, t2.length), t2) && co(e5.key.raw).length > 0 && (n2 = e5);
  } }), n2;
}
function po(e4) {
  let t2 = e4.search(/[eE]/), n2 = t2 === -1 ? e4 : e4.slice(0, t2), r2 = n2.indexOf(`.`), i2 = r2 === -1 ? `` : n2.slice(r2 + 1);
  return { hasExponent: t2 !== -1, fractionLength: i2.length, isRound: !/[1-9]/.test(i2) };
}
function mo(e4) {
  let t2 = e4.search(/[eE]/), n2 = t2 === -1 ? e4 : e4.slice(0, t2), r2 = n2.indexOf(`.`);
  return r2 === -1 ? 0 : n2.length - r2 - 1;
}
function ho(e4, t2, n2 = false) {
  let [r2, i2] = e4.toExponential().split(/[eE]/), a2 = Math.max(t2, mo(r2));
  return `${a2 > 0 ? Number(r2).toFixed(a2) : String(Number(r2))}${n2 ? `E` : `e`}${i2.replace(/^\+/, ``)}`;
}
function go(e4) {
  if (e4.startsWith(`0x`))
    return { radix: 16, prefix: `0x` };
  if (e4.startsWith(`0o`))
    return { radix: 8, prefix: `0o` };
  if (e4.startsWith(`0b`))
    return { radix: 2, prefix: `0b` };
}
function _o(e4) {
  let t2 = e4;
  (t2.startsWith(`+`) || t2.startsWith(`-`)) && (t2 = t2.slice(1)), (t2.startsWith(`0x`) || t2.startsWith(`0o`) || t2.startsWith(`0b`)) && (t2 = t2.slice(2));
  let n2 = t2.lastIndexOf(`_`);
  return n2 === -1 ? undefined : t2.length - n2 - 1;
}
function vo(e4, t2) {
  if (e4.length <= t2)
    return e4;
  let n2 = ``, r2 = 0;
  for (let i2 = e4.length - 1;i2 >= 0; i2--)
    n2 = e4[i2] + n2, r2++, r2 === t2 && i2 > 0 && (n2 = `_` + n2, r2 = 0);
  return n2;
}
function yo(e4, t2) {
  let n2 = go(t2), r2 = _o(t2);
  if (n2) {
    if (typeof e4 == `bigint` ? e4 < 0n : e4 < 0)
      return;
    let i2 = n2.radix === 16 && /[A-F]/.test(t2), a2 = e4.toString(n2.radix);
    return i2 && (a2 = a2.toUpperCase()), n2.prefix + (r2 ? vo(a2, r2) : a2);
  }
  if (r2) {
    let t3 = typeof e4 == `bigint` ? e4 < 0n : e4 < 0, n3 = t3 ? e4.toString().slice(1) : e4.toString();
    return (t3 ? `-` : ``) + vo(n3, r2);
  }
}
function bo(e4, t2, n2 = true, r2 = 0) {
  if (o(e4) && o(t2)) {
    let r3 = Vr(t2.value, e4.raw, n2);
    t2.raw = r3.raw, t2.loc = r3.loc;
  }
  if (l(e4) && l(t2)) {
    let n3 = e4.raw, i2 = t2.value;
    if (Tt(i2)) {
      let e5 = Et(i2);
      if (n3.includes(` `) && e5.includes(`T`) && (e5 = e5.replace(`T`, ` `)), /(?:\+00:00|-00:00)/.test(n3) && e5.endsWith(`Z`)) {
        let t3 = n3.match(/([+-]00:00)/)[1];
        e5 = e5.replace(/Z$/, t3);
      }
      e5 = we(e5, r2), t2.raw = e5, t2.loc.end.column = t2.loc.start.column + t2.raw.length;
    } else if (!(Te.IS_TIME_ONLY.test(n3) && i2 instanceof Date && i2.getUTCFullYear() > 1)) {
      let e5 = Te.createDateWithOriginalFormat(i2, n3);
      t2.value = e5, t2.raw = we(e5.toISOString(), r2), t2.loc.end.column = t2.loc.start.column + t2.raw.length;
    }
  }
  if (c(e4) && c(t2) && Number.isNaN(e4.value) && Number.isNaN(t2.value)) {
    let n3 = e4, r3 = t2;
    n3.nanSign && (r3.nanSign = `+`, r3.raw = `+nan`);
  }
  if (s(e4) && t2.type === `Integer`) {
    let n3 = e4, r3 = yo(t2.value, n3.raw);
    if (r3 !== undefined) {
      let e5 = t2;
      e5.raw = r3, e5.loc.end.column = e5.loc.start.column + r3.length;
    }
  }
  if (c(e4) && (t2.type === `Integer` || t2.type === `Float`)) {
    let n3 = e4, r3 = t2.value;
    if (typeof r3 == `number`) {
      let { hasExponent: e5, fractionLength: i2, isRound: a2 } = po(n3.raw), o2 = Number.isInteger(r3) && !Object.is(r3, -0), s2 = mo(t2.raw), c2;
      if (e5 && Number.isFinite(r3) && !Object.is(r3, -0)) {
        let e6 = n3.raw.includes(`E`);
        c2 = ho(r3, o2 ? Math.max(a2 ? i2 : 0, s2) : s2, e6);
      } else
        o2 && a2 && (c2 = r3.toFixed(Math.max(i2, s2)));
      if (c2 !== undefined) {
        let e6 = t2;
        e6.type = `Float`, e6.raw = c2, e6.loc.end.column = e6.loc.start.column + c2.length;
      }
    }
  }
  if (u(e4) && u(t2)) {
    let n3 = ri(e4);
    if (t2.items.length > 0) {
      let e5 = t2.items[t2.items.length - 1];
      e5.comma !== n3 && (e5.comma = n3, n3 && (t2.loc.end.column += 1));
    }
  }
  if (f(e4) && f(t2)) {
    let n3 = ii(e4);
    if (t2.items.length > 0) {
      let e5 = t2.items[t2.items.length - 1];
      e5.comma !== n3 && (e5.comma = n3, n3 && (t2.loc.end.column += 1));
    }
  }
}
function xo(n2, i2, s2, c2, l2 = false, g2 = /* @__PURE__ */ new WeakSet, _2 = undefined, v2 = false, y2 = true, b2 = false, S2 = undefined) {
  let C2 = S2 ?? Bi(i2.items, ``, { temporal: l2 }), w2 = /* @__PURE__ */ new Map, T2 = /* @__PURE__ */ new Set;
  function E2(e4) {
    let t2 = n2.items, r2 = t2.indexOf(e4);
    if (r2 > 0) {
      let n3 = t2[r2 - 1];
      p(n3) && n3.loc.end.line + 1 === e4.loc.start.line && T2.add(e4);
    }
  }
  let D2 = /* @__PURE__ */ new WeakMap;
  function O2(e4) {
    let i3 = D2.get(e4);
    if (i3 !== undefined)
      return i3;
    let o2 = {};
    function s3(n3, i4) {
      if (n3 === e4)
        return i4;
      if (a(n3))
        return s3(n3.value, i4);
      if (d(n3))
        return s3(n3.item, i4);
      if (m(n3))
        for (let e5 = 0;e5 < n3.items.length; e5++) {
          let c4 = n3.items[e5], l3 = [];
          if (a(c4))
            l3 = c4.key.value;
          else if (t(c4) || r(c4)) {
            if (l3 = c4.key.item.value, r(c4)) {
              let e6 = Rt(l3);
              o2[e6] = (o2[e6] ?? -1) + 1, l3 = l3.concat(o2[e6]);
            }
          } else
            d(c4) && (l3 = a(c4.item) ? c4.item.key.value : [e5]);
          let u2 = s3(c4, l3.length ? i4.concat(l3) : i4);
          if (u2)
            return u2;
        }
    }
    let c3 = s3(n2, []);
    return c3 !== undefined && D2.set(e4, c3), c3;
  }
  function k2(e4, t2) {
    let n3 = a(e4) ? e4 : d(e4) && a(e4.item) ? e4.item : undefined;
    if (!n3)
      return false;
    let r2 = n3.key.value.length;
    return r2 > t2.length || !I(n3.key.value, t2.slice(t2.length - r2));
  }
  function j2(e4, i3) {
    let o2 = e4.key.item.value.concat(i3);
    return e4.items.some((e5) => a(e5) && e5.key.value.length > i3.length && I(e5.key.value.slice(0, i3.length), i3)) ? true : n2.items.some((e5) => {
      if (!t(e5) && !r(e5))
        return false;
      let n3 = e5.key.item.value;
      return n3.length > o2.length && I(n3.slice(0, o2.length), o2);
    });
  }
  function ee2(e4, t2) {
    let n3 = [], r2 = false;
    for (let i4 of e4.items) {
      if (!a(i4) || !f(i4.value) || !j2(t2, i4.key.value)) {
        n3.push(i4);
        continue;
      }
      let e5 = [];
      for (let t3 of i4.value.items) {
        if (!d(t3) || !a(t3.item))
          continue;
        let n4 = Bi([t3.item], ``, { temporal: l2 });
        for (let e6 of t3.item.key.value)
          n4 = n4 == null ? undefined : n4[e6];
        let r3 = Io(n4, c2);
        r3 !== undefined && e5.push(Lr(i4.key.value.concat(t3.item.key.value), r3));
      }
      e5.length > 0 ? (n3.push(...e5), r2 = true) : n3.push(i4);
    }
    if (!r2)
      return e4;
    let i3 = Fr(e4.key.item.value, c2.escapeSequenceUpperCase);
    for (let e5 of n3)
      H(i3, i3, e5);
    return W(i3), i3;
  }
  function te2(e4, t2) {
    function n3(e5) {
      if (a(e5))
        return n3(e5.value);
      if (d(e5))
        return n3(e5.item);
      if (!m(e5))
        return;
      let r2 = e5.items;
      for (let n4 of r2)
        if (n4 === t2 || d(n4) && n4.item === t2)
          return e5;
      for (let e6 of r2) {
        let t3 = n3(d(e6) ? e6.item : e6);
        if (t3)
          return t3;
      }
    }
    return n3(e4);
  }
  function ne2(e4, t2, r2, i3) {
    let a2 = t2.concat(e4.key.value), o2 = e4.key.raw;
    e4.key.value = a2, e4.key.raw = a2.map((e5) => A.test(e5) ? e5 : JSON.stringify(e5).replace(/\x7f/g, `\\u007f`)).join(`.`);
    let s3 = e4.key.raw.length - o2.length;
    e4.key.loc.end.column = e4.key.loc.start.column + e4.key.raw.length, e4.equals += s3, G(e4.value, { lines: 0, columns: s3 }, { first_line_only: true }), e4.loc.end.line === e4.loc.start.line && (e4.loc.end.column += s3), V(n2, i3, r2, e4), To(n2, e4);
  }
  function M2(e4, t2) {
    let n3 = e4.key.item, r2 = n3.raw, i3 = t2.concat(n3.value), a2 = i3.map((e5) => A.test(e5) ? e5 : JSON.stringify(e5).replace(/\x7f/g, `\\u007f`)).join(`.`), o2 = a2.length - r2.length;
    n3.value = i3, n3.raw = a2, n3.loc.end.column = n3.loc.start.column + a2.length, e4.key.loc.end.line === e4.key.loc.start.line && (e4.key.loc.end.column += o2);
  }
  function re2(e4, t2, r2, i3) {
    M2(e4, t2), V(n2, i3, r2, e4);
  }
  function ie2(e4, t2, r2) {
    let i3 = X(n2, e4);
    if (i3 && !k2(i3, e4))
      return null;
    let a2 = e4.length;
    for (;a2 > 0; ) {
      let t3 = X(n2, e4.slice(0, a2));
      if (t3 && !k2(t3, e4.slice(0, a2)))
        break;
      a2--;
    }
    let o2 = e4.slice(a2);
    if (o2.length === 0 || !o2.every((e5) => typeof e5 == `string`))
      return null;
    if (_2 !== undefined) {
      let e5 = _2;
      for (let t3 of r2)
        e5 = e5 == null ? undefined : e5[t3];
      if (e5 !== undefined) {
        let n3 = Io(e5, c2);
        if (n3 !== undefined)
          return Lr([...o2, ...t2.key.value], n3, false, c2.escapeSequenceUpperCase);
      }
    }
    let s3 = t2.key, l3 = [...o2, ...s3.value].map((e5) => A.test(e5) ? e5 : JSON.stringify(e5).replace(/\x7f/g, `\\u007f`)).join(`.`), u2 = l3.length - s3.raw.length;
    return s3.raw = l3, s3.value = [...o2, ...s3.value], s3.loc.end.column = s3.loc.start.column + l3.length, t2.equals += u2, G(t2.value, { lines: 0, columns: u2 }, { first_line_only: true }), t2.loc.end.line === t2.loc.start.line && (t2.loc.end.column += u2), t2;
  }
  let ae2 = /* @__PURE__ */ new Set, oe2 = /* @__PURE__ */ new Set, se2 = /* @__PURE__ */ new WeakMap;
  function ce2(e4, t2) {
    return se2.get(e4) ?? t2;
  }
  let le2 = [], ue2 = /* @__PURE__ */ new Set, de2 = [];
  function fe2(e4, t2, r2) {
    if (!u(e4) && !f(e4) || !d(r2) || f(e4) && !a(r2.item))
      return r2;
    let i3 = _2;
    for (let e5 of t2)
      i3 = i3 == null ? undefined : i3[e5];
    if (!Array.isArray(i3) && !F(i3))
      return r2;
    let o2 = Gn(n2, e4) ?? 0, s3 = br(e4) || e4.items.length === 0 && e4.loc.end.line > e4.loc.start.line, l3 = v2 ? c2.indentWidth : u(e4) && e4.items.length === 0 ? Math.max(c2.indentWidth, 4) : c2.indentWidth;
    u(e4) && e4.items.length === 0 && !c2.useTabsForIndentation && Qn(e4, Math.max(l3, 4));
    let p2 = Array.isArray(i3) ? `array` : `table`, m2 = e4.items.map((t3) => f(e4) && a(t3.item) ? t3.item.value : t3.item).find((e5) => p2 === `array` ? u(e5) : f(e5)), h2 = m2 && p2 === `array` ? ri(m2) : m2 && p2 === `table` ? ii(m2) : false, g3 = m2, b3 = g3 && g3.items.length > 0 ? g3.items[0].loc.start.column - g3.loc.start.column > 1 : undefined, x2 = Nn(p2, o2 + 1, s3, c2), S3 = p2 === `array` ? `multilineArray` : `multilineTable`, C3 = L({ ...c2, inlineTableStart: 0, [S3]: x2, trailingComma: y2 ? c2.trailingComma : h2, bracketSpacing: b3 ?? c2.bracketSpacing, indentWidth: l3 }, c2), w3 = J({ tmp: i3 }, C3, o2 + 1, s3).items[0];
    if (!w3 || !a(w3))
      return r2;
    let T3 = w3.value;
    if (x2 && (u(T3) || f(T3))) {
      let e5 = T3.loc.start.column;
      T3.loc.start.column = 0, T3.loc.end.line === T3.loc.start.line ? T3.loc.end.column -= e5 : Nn(u(T3) ? `array` : `table`, o2 + 1, s3, C3) && (T3.loc.end.column = 1);
    }
    if (f(e4)) {
      let e5 = q(Lr(r2.item.key.value, T3, false, c2.escapeSequenceUpperCase));
      return e5.comma = r2.comma, e5;
    }
    let E3 = q(T3);
    return e4.items.length === 0 && u(e4) && f(T3) && (E3.comma = true), E3;
  }
  function pe2(e4, t2, r2) {
    let i3 = d(t2) ? t2.item : t2;
    if (!u(i3) && !f(i3))
      return t2;
    let o2 = _2;
    for (let e5 of r2)
      o2 = o2 == null ? undefined : o2[e5];
    if (!Array.isArray(o2) && !F(o2))
      return t2;
    let s3 = Kn(n2, e4), l3 = s3 ? Gn(n2, s3) ?? 0 : -1, p2 = s3 ? br(s3) || s3.items.length === 0 && s3.loc.end.line > s3.loc.start.line : false, m2 = Array.isArray(o2) ? `array` : `table`, h2 = m2 === `array` ? c2.multilineArray : c2.multilineTable, g3 = Nn(m2, l3 + 1, p2, c2), v3 = d(e4) ? e4.item : e4, b3 = u(v3) || f(v3) ? v3 : undefined, x2 = u(v3) ? `array` : f(v3) ? `table` : undefined, S3 = b3 !== undefined && x2 !== m2 && Wn(b3) && h2 === `auto`;
    if (!(g3 || S3))
      return t2;
    let C3 = m2 === `array` ? `multilineArray` : `multilineTable`, w3 = L({ ...c2, inlineTableStart: 0, [C3]: true, trailingComma: y2 ? c2.trailingComma : false }, c2), T3 = J({ tmp: o2 }, w3, l3 + 1, p2).items[0];
    if (!T3 || !a(T3))
      return t2;
    let E3 = T3.value;
    if (u(E3) || f(E3)) {
      let t3 = d(e4) ? e4.item.loc.start.column : e4.loc.start.column;
      E3.loc.end.line === E3.loc.start.line ? E3.loc.end.column += t3 - E3.loc.start.column : E3.loc.end.column = 1, E3.loc.start.column = t3;
    }
    if (d(t2)) {
      let e5 = q(E3);
      return e5.comma = t2.comma, e5;
    }
    return E3;
  }
  let me2 = s2.some((e4) => {
    if (!Xi(e4))
      return false;
    let t2 = Y(i2, e4.path);
    if (t2 && r(t2))
      return true;
    let a2 = e4.path.slice(0, -1), o2 = P(e4.path), s3 = X(n2, a2.concat(0));
    return yt(o2) && !yt(P(a2)) && !!s3 && r(s3);
  }) ? [...n2.items] : undefined, he2 = /* @__PURE__ */ new Map, ge2 = (e4, i3) => {
    let o2 = he2.get(i3);
    o2 || (o2 = /* @__PURE__ */ new Map, he2.set(i3, o2));
    let s3 = JSON.stringify(e4);
    if (o2.has(s3))
      return o2.get(s3);
    let c3 = { tablePaths: /* @__PURE__ */ new Set, tableArrayPaths: /* @__PURE__ */ new Set, inlineTablePaths: /* @__PURE__ */ new Set }, l3 = me2 ?? n2.items, u2 = i3 ? new Set(Bo(n2, i3, l3.indexOf(i3), l3)) : undefined, p2 = (e5, t2) => {
      for (let n3 of e5.items) {
        if (!d(n3) || !a(n3.item) || !f(n3.item.value))
          continue;
        let e6 = t2.concat(n3.item.key.value);
        c3.inlineTablePaths.add(JSON.stringify(e6)), p2(n3.item.value, e6);
      }
    }, m2 = (e5, t2) => {
      for (let n3 of e5.items) {
        if (!a(n3) || !f(n3.value))
          continue;
        let e6 = t2.concat(n3.key.value);
        c3.inlineTablePaths.add(JSON.stringify(e6)), p2(n3.value, e6);
      }
    };
    for (let i4 = 0;i4 < l3.length; i4++) {
      let a2 = l3[i4];
      if (!r(a2) || !I(a2.key.item.value, e4) || u2 && !u2.has(a2))
        continue;
      m2(a2, e4);
      let o3 = Bo(n2, a2, i4, l3);
      for (let n3 of o3) {
        if (!t(n3) && !r(n3))
          continue;
        let i5 = Ro(n3);
        !i5 || i5.length <= e4.length || !zo(i5, e4) || (m2(n3, i5), t(n3) ? c3.tablePaths.add(JSON.stringify(i5)) : c3.tableArrayPaths.add(JSON.stringify(i5)));
      }
    }
    let h2 = c3.tablePaths.size > 0 || c3.tableArrayPaths.size > 0 || c3.inlineTablePaths.size > 0 ? c3 : undefined;
    return o2.set(s3, h2), h2;
  };
  s2.forEach((s3) => {
    if (Xi(s3)) {
      var v3;
      let o2 = Y(i2, s3.path), l3 = s3.path.slice(0, -1), h2 = P(s3.path), _3 = r(o2);
      if (yt(h2) && !_3 && !yt(P(l3))) {
        let e4 = X(n2, l3.concat(0));
        e4 && r(e4) && (_3 = true);
      }
      let y3 = Vo(n2, l3);
      if (_3 && yt(h2) && !yt(P(l3))) {
        let i3 = C2;
        for (let e4 of l3)
          i3 = i3 == null ? undefined : i3[e4];
        if (Array.isArray(i3) && !i3.every(F)) {
          let a2 = l3.filter((e4) => typeof e4 == `string`), o3 = Uo(n2, a2, (y3 == null ? undefined : y3.key.item.value.length) ?? 0, y3), s4 = (o3 == null ? undefined : o3.key.item.value) ?? (y3 == null ? undefined : y3.key.item.value) ?? [], u2 = Wo(a2.slice(s4.length), i3, c2);
          if (u2) {
            let i4 = $(n2, a2, y3).filter((e4) => (t(e4) || r(e4)) && zo(Ro(e4), a2)), s5 = new Set(i4), c3 = /* @__PURE__ */ new Set;
            for (let e4 of i4)
              Ut(e4, { Comment: (e5) => c3.add(e5) });
            for (let e4 of xa(n2))
              if (e4.member && s5.has(e4.member))
                for (let t2 of e4.items)
                  p(t2) && c3.add(t2);
            let l4 = [...c3].sort((e4, t2) => e4.loc.start.line - t2.loc.start.line || e4.loc.start.column - t2.loc.start.column).map((e4) => e4.raw);
            for (let e4 of i4.reverse())
              Z(n2, n2, e4);
            let d2 = o3 ?? y3 ?? n2, f2 = e(d2) ? wo(n2) : undefined;
            for (let e4 of l4)
              H(n2, d2, ni(e4), f2), f2 !== undefined && f2++;
            H(n2, d2, u2, f2), g2.add(u2);
            return;
          }
        }
      }
      if (_3 && yt(h2) && !yt(P(l3))) {
        let e4 = X(n2, l3), t2 = e4 && a(e4) ? e4.value : e4;
        if (t2 && u(t2)) {
          let e5 = C2;
          for (let t3 of s3.path)
            e5 = e5 == null ? undefined : e5[t3];
          let r2 = L({ ...c2, inlineTableStart: 0 }, c2), i3 = e5 === undefined ? undefined : J({ tmp: e5 }, r2), l4 = i3 == null ? undefined : i3.items[0];
          if (l4 && a(l4) && (o2 = q(l4.value), _3 = false, d(o2) && f(o2.item) && o2.item.items.length > 0)) {
            let e6 = o2.item;
            if (!(e6.items[0].loc.start.column - e6.loc.start.column > 1)) {
              let r3 = t2.items.map((e7) => e7.item).find((e7) => f(e7) && e7.items.length > 0);
              r3 && r3.items[0].loc.start.column - r3.loc.start.column > 1 && vr(n2, e6, true);
            }
          }
        }
      }
      let x2 = l3.filter((e4) => typeof e4 == `string`), S3 = _3 && !b2 ? ge2(x2, y3) : undefined, w3 = _3 && !b2 && !!S3, T3 = C2;
      for (let e4 of s3.path)
        T3 = T3 == null ? undefined : T3[e4];
      let E3 = (e4, t2 = []) => !e4 || typeof e4 != `object` ? false : Array.isArray(e4) ? e4.some((e5) => E3(e5, t2)) : Object.entries(e4).some(([e5, n3]) => {
        let r2 = JSON.stringify(x2.concat(t2, e5));
        return S3 != null && S3.inlineTablePaths.has(r2) && F(n3) ? true : E3(n3, t2.concat(e5));
      }), D3 = (e4, t2 = []) => !e4 || typeof e4 != `object` ? false : Array.isArray(e4) ? e4.some((e5) => D3(e5, t2)) : Object.entries(e4).some(([e5, n3]) => {
        let r2 = JSON.stringify(x2.concat(t2, e5));
        return S3 != null && S3.tablePaths.has(r2) && !Array.isArray(n3) || S3 != null && S3.tableArrayPaths.has(r2) && Array.isArray(n3) ? true : D3(n3, t2.concat(e5));
      }), O3 = w3 && E3(T3), A2 = w3 && (O3 || D3(T3));
      if (_3 && (!r(o2) || A2) && T3 !== undefined) {
        let e4 = Fr(x2, c2.escapeSequenceUpperCase), n3 = O3 ? L({ ...c2, inlineTableStart: 0 }, c2) : c2, i3 = J(T3, n3);
        for (let t2 of i3.items)
          H(e4, e4, t2, undefined);
        if (w3 && S3) {
          let n4 = (i4, o3) => {
            for (let s5 of [...i4.items]) {
              if (a(s5) && f(s5.value)) {
                let t2 = x2.concat(o3, s5.key.value);
                if (S3.tablePaths.has(JSON.stringify(t2))) {
                  U(e4, i4, s5);
                  let t3 = K(o3.concat(s5.key.value), c2.escapeSequenceUpperCase);
                  for (let n5 of s5.value.items)
                    H(e4, t3, n5.item, undefined, undefined, undefined, undefined, true);
                  H(e4, i4, t3), n4(t3, o3.concat(s5.key.value));
                  continue;
                }
              }
              if (a(s5) && u(s5.value)) {
                let t2 = x2.concat(o3, s5.key.value);
                if (S3.tableArrayPaths.has(JSON.stringify(t2)) && s5.value.items.length > 0 && s5.value.items.every((e5) => d(e5) && f(e5.item))) {
                  U(e4, i4, s5);
                  for (let t3 of s5.value.items) {
                    let r2 = Fr(o3.concat(s5.key.value), c2.escapeSequenceUpperCase);
                    for (let n5 of t3.item.items)
                      H(e4, r2, n5.item, undefined, undefined, undefined, undefined, true);
                    H(e4, i4, r2), n4(r2, o3.concat(s5.key.value));
                  }
                  continue;
                }
              }
              (t(s5) || r(s5)) && n4(s5, o3.concat(s5.key.item.value));
            }
          };
          n4(e4, []);
        }
        let s4 = (e5) => {
          if (m(e5))
            for (let n4 of e5.items) {
              if (!t(n4) && !r(n4))
                continue;
              let e6 = n4.key, i4 = e6.item, a2 = x2.concat(i4.value);
              i4.value = a2, i4.raw = Br(a2, c2.escapeSequenceUpperCase).raw, i4.loc.start.column = e6.loc.start.column + 1, i4.loc.end.column = i4.loc.start.column + i4.raw.length, e6.loc.end.column = i4.loc.start.column + i4.raw.length + 1, s4(n4);
            }
        };
        s4(e4), W(e4), o2 = e4;
      }
      let j3;
      if (t(o2))
        j3 = n2;
      else if (_3) {
        j3 = n2;
        let e4 = n2, i3 = X(e4, l3.concat(h2 - 1)), a2 = X(e4, l3.concat(h2));
        if (a2)
          h2 = e4.items.indexOf(a2);
        else if (i3) {
          if (h2 = e4.items.indexOf(i3) + 1, r(i3)) {
            let n3 = i3.key.item.value, a3 = h2 - 1;
            for (let i4 = h2;i4 < e4.items.length; i4++) {
              let o3 = e4.items[i4];
              if (r(o3)) {
                let e5 = o3.key.item.value;
                if (e5.length < n3.length && I(n3.slice(0, e5.length), e5))
                  break;
              }
              let s4 = t(o3) || r(o3) ? o3.key.item.value : undefined;
              s4 && s4.length > n3.length && I(s4.slice(0, n3.length), n3) && (a3 = i4);
            }
            h2 = a3 + 1, r(o2) && (o2 = ee2(o2, i3));
          }
        } else
          h2 = e4.items.length;
      } else {
        j3 = n2;
        for (let e4 = s3.path.length - 1;e4 >= 0; e4--) {
          let t2 = X(n2, s3.path.slice(0, e4));
          if (t2 && !k2(t2, s3.path.slice(0, e4))) {
            j3 = t2;
            break;
          }
        }
        a(j3) ? j3 = j3.value : d(j3) && a(j3.item) ? j3 = j3.item.value : (d(j3) && f(j3.item) || d(j3) && u(j3.item)) && (j3 = j3.item);
      }
      if ((u(j3) || f(j3)) && (o2 = fe2(j3, s3.path, o2), Si(j3, o2, c2.indentWidth)), u(j3)) {
        let e4 = X(n2, l3), t2 = X(n2, l3.slice(0, -1));
        if (e4 && a(e4) && t2) {
          let n3 = Ga(j3, o2, h2);
          n3 !== 0 && Ua(t2, e4, n3);
        }
      }
      let te3 = (u(j3) || f(j3)) && j3.loc.end.line > j3.loc.start.line;
      te3 && oe2.has(j3) && W(n2);
      let ne3 = u(j3) || f(j3) ? (v3 = wa(n2, j3)) == null ? undefined : v3.items : undefined;
      if (r(j3) || u(j3) || e(j3)) {
        if (_3 && !yt(P(l3)) && to(n2, true), u(j3)) {
          let e4 = ce2(j3, ri(j3));
          if (d(o2)) {
            let t2 = j3.items.length === 0 && f(o2.item) && br(o2.item);
            o2.comma = t2 || e4;
            let n3 = o2, r2 = f(n3.item) ? n3.item : undefined, i3 = r2 && r2.items.length > 0 ? j3.items.map((e5) => e5.item).find((e5) => e5 !== n3.item && f(e5)) : undefined;
            if (r2 && i3) {
              let e5 = ii(i3);
              if (e5 !== ii(r2)) {
                let t3 = C2;
                for (let e6 of s3.path)
                  t3 = t3 == null ? undefined : t3[e6];
                let r3 = L({ ...c2, inlineTableStart: 0, trailingComma: e5 }, c2), i4 = t3 === undefined ? undefined : J({ tmp: t3 }, r3).items[0];
                if (i4 && a(i4)) {
                  let e6 = q(i4.value);
                  e6.comma = n3.comma, o2 = e6;
                }
              }
            }
          }
        }
        if (c2.inlineTableStart !== undefined && c2.inlineTableStart > 0 && e(j3) && t(o2)) {
          let e4 = Po(o2, n2, c2);
          H(n2, j3, o2, h2);
          for (let t2 of e4)
            H(n2, n2, t2, undefined);
        } else {
          let i3 = o2;
          d(o2) && (r(j3) || e(j3)) && (i3 = o2.item);
          let c3 = h2;
          if (e(j3) && a(i3)) {
            let e4 = wo(j3);
            e4 !== undefined && (c3 = e4);
          }
          let f2 = false;
          if ((r(j3) || e(j3)) && a(i3)) {
            let e4 = ie2(l3, i3, s3.path);
            e4 && (ae2.has(j3) && W(n2), i3 = e4, f2 = true);
          }
          if (u(j3) && j3.items.length === 0 && W(n2), c3 === 0 && u(j3) && lr(n2).has(j3) && W(n2), c3 === 0 && (e(j3) || t(j3) || r(j3)) && lr(n2).has(j3) && W(n2), a(i3) && i3.key.value.length > 1) {
            let e4 = fo(n2, i3.key.value.slice(0, -1));
            if (e4) {
              let t2 = i3.equals;
              uo(i3.key, e4.key.raw), i3.equals = i3.key.loc.end.column + e4.equals - e4.key.loc.end.column;
              let n3 = i3.equals - t2;
              G(i3.value, { lines: 0, columns: n3 }, { first_line_only: true }), i3.loc.end.line === i3.loc.start.line && (i3.loc.end.column += n3);
            }
          }
          H(n2, j3, i3, c3, undefined, ne3), f2 && ae2.add(j3);
        }
      } else if (f(j3)) {
        j3.items.length === 0 && (W(n2), rr(j3) && j3.loc.end.line > j3.loc.start.line && (j3.loc.end.line = j3.loc.start.line));
        let e4 = ce2(j3, ii(j3));
        if (a(o2)) {
          let t2 = q(o2);
          t2.comma = e4;
          let r2 = Qa(j3, o2, s3.before);
          H(n2, j3, t2, r2, undefined, ne3);
        } else if (d(o2) && a(o2.item)) {
          let t2 = o2.item, r2 = ie2(l3, t2, s3.path);
          r2 && (ae2.has(j3) && W(n2), t2 = r2);
          let i3 = q(t2);
          i3.comma = e4;
          let a2 = Qa(j3, t2, s3.before);
          H(n2, j3, i3, a2, undefined, ne3), r2 && ae2.add(j3);
        } else
          H(n2, j3, o2, undefined, undefined, ne3);
      } else if (c2.inlineTableStart !== undefined && c2.inlineTableStart > 0 && a(o2) && f(o2.value) && t(j3))
        mi([...j3.key.item.value, ...o2.key.value]) < c2.inlineTableStart ? Fo(o2, j3, n2, c2) : H(n2, j3, o2);
      else if (c2.inlineTableStart === 0 && a(o2) && f(o2.value) && e(j3))
        H(n2, j3, o2, undefined, true);
      else {
        let i3 = o2;
        d(o2) && (t(j3) || r(j3) || e(j3)) && (i3 = o2.item);
        let c3 = false;
        if (t(j3) && a(i3)) {
          let e4 = ie2(l3, i3, s3.path);
          e4 && (ae2.has(j3) && W(n2), i3 = e4, c3 = true);
        }
        let u2 = (t(j3) || r(j3)) && j3.items.length > 0 && j3.items.every(p) ? 2 : undefined;
        H(n2, j3, i3, undefined, undefined, undefined, u2), c3 && ae2.add(j3);
      }
      te3 && oe2.add(j3);
    } else if (Zi(s3)) {
      let p2 = X(n2, s3.path), h2;
      try {
        h2 = Y(i2, s3.path);
      } catch {
        h2 = undefined;
      }
      if (!p2 || !h2) {
        Do(n2, i2, s3, c2, l2, g2, T2);
        return;
      }
      if (a(p2) && t(h2)) {
        let e4 = h2.key.item.value;
        if (Q(n2, e4).some((e5) => e5 !== p2)) {
          Do(n2, i2, s3, c2, l2, g2, T2);
          return;
        }
      }
      if (d(p2) && (t(h2) || r(h2))) {
        let e4 = X(n2, s3.path.slice(0, -1)), t2 = e4 && a(e4) ? e4.value : e4;
        if (t2 && u(t2)) {
          let e5 = _2;
          for (let t3 of s3.path)
            e5 = e5 == null ? undefined : e5[t3];
          if (e5 !== undefined) {
            let t3 = L({ ...c2, inlineTableStart: 0 }, c2), n3 = J({ tmp: e5 }, t3), r2 = n3 == null ? undefined : n3.items[0];
            r2 && a(r2) && (h2 = q(r2.value));
          }
        }
      }
      let v4, y3 = X(n2, s3.path.slice(0, -1));
      y3 && a(y3) && k2(y3, s3.path.slice(0, -1)) && (y3 = te2(n2, y3));
      let b3 = Lo(n2, s3.path);
      if (a(p2) && a(h2)) {
        let i3 = false;
        if (p2.key.value.length > 1) {
          let o2 = O2(p2), c3 = Za(s3.path, p2.key.value, o2 ? o2.length - p2.key.value.length : 0);
          if (c3 > 0 && c3 < p2.key.value.length) {
            p2.key.value = p2.key.value.slice(0, c3), p2.key.raw = Br(p2.key.value).raw;
            let o3 = p2.key.loc.end.column, l3 = p2.key.loc.start.column + p2.key.raw.length, u2 = l3 - o3;
            p2.key.loc.end.column = l3, p2.equals += u2, p2.value.loc.start.column += u2, p2.value.loc.end.line === p2.value.loc.start.line && (p2.value.loc.end.column += u2), p2.loc.end.line === p2.loc.start.line && (p2.loc.end.column += u2), i3 = true;
            let d2 = p2.key.value;
            if (y3 && (t(y3) || e(y3) || r(y3))) {
              let e4 = [...y3.items];
              for (let i4 = e4.length - 1;i4 >= 0; i4--) {
                let o4 = e4[i4];
                if (o4 === p2)
                  continue;
                let s4 = a(o4) ? o4.key.value : t(o4) || r(o4) ? o4.key.item.value : undefined;
                s4 && s4.length >= d2.length && I(s4.slice(0, d2.length), d2) && Z(n2, y3, o4);
              }
            }
            $o(n2, s3.path, p2);
          }
        }
        if (!i3 && a(h2) && y3 && (t(y3) || e(y3) || r(y3)) && Qo(n2, y3, p2.key.value, p2), bo(p2.value, h2.value, c2.escapeSequenceUpperCase, c2.minimumTimeDecimals ?? 0), y3 && Ha(y3, p2, p2.value, h2.value), v4 = p2, p2 = p2.value, h2 = h2.value, i3 && _2 !== undefined) {
          let e4 = _2;
          for (let t2 of s3.path)
            e4 = e4 == null ? undefined : e4[t2];
          if (e4 !== undefined) {
            let t2 = Io(e4, c2);
            t2 !== undefined && (h2 = t2, bo(p2, h2, c2.escapeSequenceUpperCase, c2.minimumTimeDecimals ?? 0));
          }
        }
      } else if (a(p2) && d(h2) && a(h2.item)) {
        let i3 = false;
        if (p2.key.value.length > 1) {
          let o2 = O2(p2), c3 = Za(s3.path, p2.key.value, o2 ? o2.length - p2.key.value.length : 0);
          if (c3 > 0 && c3 < p2.key.value.length) {
            p2.key.value = p2.key.value.slice(0, c3), p2.key.raw = Br(p2.key.value).raw;
            let o3 = p2.key.loc.end.column, l3 = p2.key.loc.start.column + p2.key.raw.length, u2 = l3 - o3;
            p2.key.loc.end.column = l3, p2.equals += u2, p2.value.loc.start.column += u2, p2.value.loc.end.line === p2.value.loc.start.line && (p2.value.loc.end.column += u2), p2.loc.end.line === p2.loc.start.line && (p2.loc.end.column += u2), i3 = true;
            let d2 = p2.key.value;
            if (y3 && (t(y3) || e(y3) || r(y3))) {
              let e4 = [...y3.items];
              for (let i4 = e4.length - 1;i4 >= 0; i4--) {
                let o4 = e4[i4];
                if (o4 === p2)
                  continue;
                let s4 = a(o4) ? o4.key.value : t(o4) || r(o4) ? o4.key.item.value : undefined;
                s4 && s4.length >= d2.length && I(s4.slice(0, d2.length), d2) && Z(n2, y3, o4);
              }
            }
            $o(n2, s3.path, p2);
          }
        }
        if (!i3 && a(h2.item) && y3 && (t(y3) || e(y3) || r(y3)) && Qo(n2, y3, p2.key.value, p2), v4 = p2, p2 = p2.value, h2 = h2.item.value, i3 && _2 !== undefined) {
          let e4 = _2;
          for (let t2 of s3.path)
            e4 = e4 == null ? undefined : e4[t2];
          if (e4 !== undefined) {
            let t2 = Io(e4, c2);
            t2 !== undefined && (h2 = t2);
          }
        }
      } else if (d(p2) && a(p2.item) && a(h2)) {
        let e4 = p2.item, i3 = false;
        if (e4.key.value.length > 1) {
          let o2 = O2(e4), l3 = Za(s3.path, e4.key.value, o2 ? o2.length - e4.key.value.length : 0);
          if (l3 > 0 && l3 < e4.key.value.length) {
            e4.key.value = e4.key.value.slice(0, l3), e4.key.raw = Br(e4.key.value, c2.escapeSequenceUpperCase).raw;
            let o3 = e4.key.loc.end.column, s4 = e4.key.loc.start.column + e4.key.raw.length, u2 = s4 - o3;
            e4.key.loc.end.column = s4, e4.equals += u2, e4.value.loc.start.column += u2, e4.value.loc.end.line === e4.value.loc.start.line && (e4.value.loc.end.column += u2), e4.loc.end.line === e4.loc.start.line && (e4.loc.end.column += u2), e4.loc.end.line === e4.loc.start.line && ar(n2, e4, { lines: 0, columns: u2 }), i3 = true;
            let f2 = e4.key.value, h3 = y3;
            if (h3 && d(h3) && (h3 = h3.item), h3 && a(h3) && (h3 = h3.value), h3 && m(h3)) {
              let e5 = [...h3.items];
              for (let i4 = e5.length - 1;i4 >= 0; i4--) {
                let o4 = e5[i4];
                if (o4 === p2)
                  continue;
                let s5 = a(o4) ? o4.key.value : d(o4) && a(o4.item) ? o4.item.key.value : t(o4) || r(o4) ? o4.key.item.value : undefined;
                s5 && s5.length >= f2.length && I(s5.slice(0, f2.length), f2) && Z(n2, h3, o4);
              }
            }
          }
        }
        if (bo(e4.value, h2.value, c2.escapeSequenceUpperCase, c2.minimumTimeDecimals ?? 0), v4 = e4, p2 = e4.value, h2 = h2.value, i3 && _2 !== undefined) {
          let e5 = _2;
          for (let t2 of s3.path)
            e5 = e5 == null ? undefined : e5[t2];
          if (e5 !== undefined) {
            let t2 = Io(e5, c2);
            t2 !== undefined && (h2 = t2, bo(p2, h2, c2.escapeSequenceUpperCase, c2.minimumTimeDecimals ?? 0));
          }
        }
      } else if (d(p2) && d(h2) && a(p2.item) && a(h2.item)) {
        let e4 = false, i3 = p2.item;
        if (i3.key.value.length > 1) {
          let o2 = O2(i3), l3 = Za(s3.path, i3.key.value, o2 ? o2.length - i3.key.value.length : 0);
          if (l3 > 0 && l3 < i3.key.value.length) {
            i3.key.value = i3.key.value.slice(0, l3), i3.key.raw = Br(i3.key.value, c2.escapeSequenceUpperCase).raw;
            let o3 = i3.key.loc.end.column, s4 = i3.key.loc.start.column + i3.key.raw.length, u2 = s4 - o3;
            i3.key.loc.end.column = s4, i3.equals += u2, i3.value.loc.start.column += u2, i3.value.loc.end.line === i3.value.loc.start.line && (i3.value.loc.end.column += u2), i3.loc.end.line === i3.loc.start.line && (i3.loc.end.column += u2), i3.loc.end.line === i3.loc.start.line && ar(n2, i3, { lines: 0, columns: u2 }), e4 = true;
            let f2 = i3.key.value, h3 = y3;
            if (h3 && d(h3) && (h3 = h3.item), h3 && a(h3) && (h3 = h3.value), h3 && m(h3)) {
              let e5 = [...h3.items];
              for (let i4 = e5.length - 1;i4 >= 0; i4--) {
                let o4 = e5[i4];
                if (o4 === p2)
                  continue;
                let s5 = a(o4) ? o4.key.value : d(o4) && a(o4.item) ? o4.item.key.value : t(o4) || r(o4) ? o4.key.item.value : undefined;
                s5 && s5.length >= f2.length && I(s5.slice(0, f2.length), f2) && Z(n2, h3, o4);
              }
            }
          }
        }
        if (bo(i3.value, h2.item.value, c2.escapeSequenceUpperCase, c2.minimumTimeDecimals ?? 0), v4 = i3, p2 = i3.value, h2 = h2.item.value, e4 && _2 !== undefined) {
          let e5 = _2;
          for (let t2 of s3.path)
            e5 = e5 == null ? undefined : e5[t2];
          if (e5 !== undefined) {
            let t2 = Io(e5, c2);
            t2 !== undefined && (h2 = t2, bo(p2, h2, c2.escapeSequenceUpperCase, c2.minimumTimeDecimals ?? 0));
          }
        }
      } else if (t(p2)) {
        let i3 = C2;
        for (let e4 of s3.path)
          i3 = i3 == null ? undefined : i3[e4];
        if (i3 !== undefined) {
          let o2 = p2.key.item.value, l3 = o2.slice(-1), u2 = o2.slice(0, -1), d2 = te2(n2, p2) ?? ca(n2, s3.path), f2 = Vo(n2, s3.path);
          if (e(d2)) {
            let e4 = (f2 ? $(n2, o2, f2) : Q(n2, o2)).filter((e5) => e5 !== p2 && (t(e5) || r(e5)));
            for (let t2 of e4)
              Z(n2, d2, t2);
          }
          let m2 = J({ [l3[0]]: i3 }, c2), h3 = m2.items[0];
          if (a(h3) && f2 && zo(u2, f2.key.item.value)) {
            let e4 = I(u2, f2.key.item.value) ? f2 : $(n2, u2, f2).find((e5) => t(e5) && I(e5.key.item.value, u2));
            if (e4) {
              Z(n2, d2, p2), H(n2, e4, h3, undefined), g2.add(h3);
              return;
            }
          }
          if (u2.length > 0) {
            if (t(h3) || r(h3))
              re2(h3, u2, p2, d2), g2.add(h3);
            else if (Q(n2, u2).some(a))
              ne2(h3, u2, p2, d2), g2.add(h3);
            else {
              let e4 = n2.items.find((e5) => e5 !== p2 && (t(e5) || r(e5)) && I(e5.key.item.value, u2));
              if (e4)
                H(n2, e4, h3, undefined), Z(n2, d2, p2), g2.add(h3);
              else {
                let e5 = K(u2, c2.escapeSequenceUpperCase);
                T2.add(e5), H(n2, e5, h3, 0), V(n2, d2, p2, e5), g2.add(e5);
              }
            }
          } else
            V(n2, d2, p2, h3), g2.add(h3), To(n2, h3);
          if (m2.items.length > 1)
            for (let e4 = 1;e4 < m2.items.length; e4++) {
              let t2 = m2.items[e4];
              u2.length > 0 && M2(t2, u2);
              let r2 = e4 === 1 ? h3 : m2.items[e4 - 1];
              H(n2, d2, t2, d2.items.indexOf(r2) + 1), g2.add(t2);
            }
          return;
        }
        v4 = ca(n2, s3.path);
      } else if (r(p2)) {
        let i3 = C2, o2 = p2.key.item.value, l3 = i3, u2 = typeof s3.path[s3.path.length - 1] == `number` ? s3.path.slice(0, -1) : s3.path;
        for (let e4 of u2)
          l3 = l3 == null ? undefined : l3[e4];
        if (l3 !== undefined) {
          let i4 = o2.slice(-1), d2 = o2.slice(0, -1), f2 = te2(n2, p2) ?? ca(n2, s3.path), m2 = Vo(n2, u2), h3 = J({ [i4[0]]: l3 }, c2).items[0];
          if (Array.isArray(l3) && !l3.every((e4) => F(e4))) {
            let e4 = (m2 ? $(n2, o2, m2) : Q(n2, o2)).filter((e5) => e5 !== p2 && (t(e5) || r(e5)));
            for (let t2 of e4)
              Z(n2, n2, t2);
          }
          if (d2.length > 0) {
            if (a(h3) && m2 && zo(d2, m2.key.item.value)) {
              let e4 = I(d2, m2.key.item.value) ? m2 : $(n2, d2, m2).find((e5) => t(e5) && I(e5.key.item.value, d2));
              if (e4) {
                Z(n2, f2, p2), H(n2, e4, h3, undefined), g2.add(h3);
                return;
              }
            }
            if (t(h3) || r(h3))
              re2(h3, d2, p2, f2), g2.add(h3);
            else {
              let r2 = e(f2) ? f2.items.find((e4) => t(e4) && I(e4.key.item.value, d2)) : undefined;
              if (r2) {
                let e4 = r2.items.find((e5) => a(e5) && I(e5.key.value, h3.key.value));
                e4 ? V(n2, r2, e4, h3) : H(n2, r2, h3, undefined), Z(n2, f2, p2), g2.add(r2);
                return;
              }
              if (Q(n2, d2).some(a))
                ne2(h3, d2, p2, f2), g2.add(h3);
              else {
                let e4 = K(d2, c2.escapeSequenceUpperCase);
                T2.add(e4), H(n2, e4, h3, 0), V(n2, f2, p2, e4), g2.add(e4);
              }
            }
          } else
            V(n2, f2, p2, h3), g2.add(h3), To(n2, h3);
          return;
        }
        v4 = ca(n2, s3.path);
      } else if (v4 = ca(n2, s3.path), a(v4)) {
        let e4 = Y(n2, s3.path.slice(0, -1));
        a(e4) && u(e4.value) && (v4 = e4.value);
      } else
        d(v4) && a(v4.item) ? v4 = v4.item.value : (d(v4) && f(v4.item) || d(v4) && u(v4.item)) && (v4 = v4.item);
      if (d(p2) && d(h2) && (o(p2.item) && o(h2.item) && (bo(p2.item, h2.item, c2.escapeSequenceUpperCase, c2.minimumTimeDecimals ?? 0), h2.loc = { start: { ...h2.item.loc.start }, end: { ...h2.item.loc.end } }), h2.comma = p2.comma), b3) {
        let e4 = x(p2.loc), t2 = x(h2.loc).columns - e4.columns;
        t2 !== 0 && Wa(b3.container, b3.row, t2);
      }
      h2 = pe2(p2, h2, s3.path), V(n2, v4, p2, h2), u(h2) && ue2.add(h2), (u(h2) || f(h2)) && (W(n2), fi(h2, c2.indentWidth), de2.push({ owner: v4, container: h2 })), e(v4) && a(p2) && (t(h2) || r(h2)) && Eo(n2, h2);
    } else if (Qi(s3)) {
      let o2 = X(n2, s3.path);
      if (o2) {
        let l3 = ca(n2, s3.path);
        if (l3 === o2 && (l3 = ca(n2, s3.path.slice(0, -1))), l3 === o2) {
          let e4 = wa(n2, o2);
          e4 && (l3 = e4);
        }
        a(l3) && (l3 = l3.value), d(l3) && a(l3.item) && (l3 = l3.item.value), d(l3) && f(l3.item) && (l3 = l3.item), d(l3) && u(l3.item) && (l3 = l3.item), (!m(l3) || !l3.items.includes(o2)) && (l3 = te2(n2, o2) ?? (m(l3) ? n2 : wa(n2, o2) ?? n2));
        let p2 = false;
        if (s3.path.length > 1 && t(o2) && _2 !== undefined) {
          let e4 = s3.path.slice(0, -1), t2 = o2.key.item.value.slice(0, -1), r2 = Vo(n2, s3.path);
          if ((r2 ? $(n2, t2, r2) : Q(n2, t2)).filter((e5) => e5 !== o2).length === 0 && !(r2 && I(t2, r2.key.item.value))) {
            let r3 = _2;
            for (let t3 of e4)
              r3 = r3 == null ? undefined : r3[t3];
            if (F(r3) && Object.keys(r3).length === 0) {
              let e5 = o2;
              for (;e5.items.length > 0; )
                U(n2, e5, P(e5.items));
              W(n2);
              let r4 = e5.key, i3 = h(r4) ? r4.item : r4;
              i3.value = t2, i3.raw = so(i3.raw, i3.value, c2.escapeSequenceUpperCase), i3.loc.end.column = i3.loc.start.column + i3.raw.length, r4.loc.end.column = r4.loc.start.column + i3.raw.length + 2, e5.loc.end.line = r4.loc.end.line, e5.loc.end.column = r4.loc.end.column, E2(e5), p2 = true;
            }
          }
        }
        let g3 = e(l3) && m(l3) ? l3.items.indexOf(o2) : -1, v4 = m(l3) && !e(l3) ? l3.items.indexOf(o2) : -1, y3 = d(o2) ? o2.comma : undefined;
        d(o2) && (u(l3) || f(l3)) && Qn(l3, o2.loc.start.column), d(o2) && (u(l3) || f(l3)) && v4 === l3.items.length - 1 && y3 !== undefined && se2.set(l3, y3);
        let b3 = d(o2) && (u(l3) || f(l3)) && o2.loc.end.line === l3.loc.end.line ? l3.loc.end.column - o2.loc.end.column : undefined, x2 = O2(d(o2) && a(o2.item) ? o2.item : o2), S3 = a(o2) ? o2 : d(o2) && a(o2.item) ? o2.item : undefined;
        if (S3 && x2 && m(l3)) {
          let e4 = x2.filter((e5) => typeof e5 == `string`).length - S3.key.value.length, i3 = s3.path.filter((e5) => typeof e5 == `string`).slice(e4);
          if (i3.length > 0 && i3.length < S3.key.value.length) {
            let e5 = l3.items, s4 = [];
            for (let n3 of e5) {
              if (n3 === o2)
                continue;
              let e6 = a(n3) ? n3.key.value : d(n3) && a(n3.item) ? n3.item.key.value : t(n3) || r(n3) ? n3.key.item.value : undefined;
              e6 && e6.length > i3.length && I(e6.slice(0, i3.length), i3) && s4.push(n3);
            }
            for (let e6 of s4)
              Z(n2, l3, e6);
          }
        }
        if (S3 && x2 && m(l3)) {
          let e4 = S3.key.value, i3 = l3.items, s4 = [];
          for (let n3 of i3) {
            if (n3 === o2)
              continue;
            let i4 = a(n3) ? n3.key.value : d(n3) && a(n3.item) ? n3.item.key.value : t(n3) || r(n3) ? n3.key.item.value : undefined;
            i4 && i4.length > e4.length && I(i4.slice(0, e4.length), e4) && s4.push(n3);
          }
          for (let e5 of s4)
            Z(n2, l3, e5);
        }
        if ((t(o2) || r(o2)) && m(l3)) {
          let e4 = o2.key.item.value, i3 = l3.items, s4 = [], c3 = i3.indexOf(o2), u2;
          if (r(o2))
            u2 = o2;
          else
            for (let t2 = c3 - 1;t2 >= 0; t2--) {
              let n3 = i3[t2];
              if (!r(n3))
                continue;
              let a2 = n3.key.item.value;
              if (e4.length > a2.length && I(e4.slice(0, a2.length), a2)) {
                u2 = n3;
                break;
              }
            }
          let d2 = u2 !== undefined, f2 = u2 ? i3.indexOf(u2) : c3, p3 = i3.length;
          if (d2) {
            let e5 = u2.key.item.value;
            for (let t2 = f2 + 1;t2 < i3.length; t2++) {
              let n3 = i3[t2];
              if (!r(n3))
                continue;
              let a2 = n3.key.item.value;
              if (a2.length <= e5.length && I(a2, e5.slice(0, a2.length))) {
                p3 = t2;
                break;
              }
            }
          }
          for (let [n3, c4] of i3.entries()) {
            if (c4 === o2 || d2 && (n3 < f2 || n3 >= p3))
              continue;
            let i4 = a(c4) ? c4.key.value : t(c4) || r(c4) ? c4.key.item.value : undefined;
            i4 && i4.length > e4.length && I(i4.slice(0, e4.length), e4) && s4.push(c4);
          }
          for (let e5 of s4)
            Z(n2, l3, e5);
        }
        if (S3 && x2) {
          let e4 = r(l3) ? l3 : Vo(n2, s3.path);
          if (e4) {
            let i3 = Zo(n2, s3.path), a2 = $(n2, i3, e4).filter((e5) => e5 !== o2 && (t(e5) || r(e5))).filter((e5) => zo(Ro(e5), i3));
            for (let e5 of a2)
              Z(n2, n2, e5);
          }
        }
        if (p2 || Z(n2, l3, o2), d(o2) && (u(l3) || f(l3)) && o2.loc.end.line === l3.loc.end.line) {
          let e4 = l3.items, t2 = l3.loc.end.line === l3.loc.start.line ? e4.every((e5) => e5.loc.end.line === l3.loc.start.line) : e4.length > 0 && P(e4).loc.end.line === l3.loc.end.line;
          if (e4.length > 0 && v4 === e4.length && t2) {
            let t3 = b3 ?? l3.loc.end.column - o2.loc.end.column;
            W(n2);
            let r2 = P(e4).loc.end.column + t3;
            l3.loc.end.column !== r2 && (l3.loc.end.column = r2);
            let i3, s4 = (e5) => {
              if (a(e5))
                return e5.value === l3 ? e5 : s4(e5.value);
              if (d(e5))
                return s4(e5.item);
              if (m(e5))
                for (let t4 of e5.items) {
                  let e6 = s4(d(t4) ? t4.item : t4);
                  if (e6)
                    return e6;
                }
            };
            if (i3 = s4(n2), i3 && i3.loc.end.line === l3.loc.end.line) {
              i3.loc.end.column = l3.loc.end.column;
              let e5 = (t5) => {
                if (a(t5))
                  return e5(t5.value);
                if (d(t5))
                  return t5.item === i3 ? t5 : e5(t5.item);
                if (m(t5))
                  for (let n3 of t5.items) {
                    let t6 = e5(n3);
                    if (t6)
                      return t6;
                  }
              }, t4 = e5(n2);
              if (t4) {
                let e6 = l3.loc.end.column - t4.loc.end.column;
                t4.loc.end.column = l3.loc.end.column, e6 !== 0 && (ar(n2, t4, { lines: 0, columns: e6 }), or(n2), W(n2));
              }
            }
          }
        }
        if (!p2 && s3.path.length > 1 && (t(o2) || r(o2)) && _2 !== undefined) {
          let e4 = s3.path.slice(0, -1), t2 = o2.key.item.value.slice(0, -1);
          if (Q(n2, t2).length === 0) {
            let r2 = _2;
            for (let t3 of e4)
              r2 = r2 == null ? undefined : r2[t3];
            if (F(r2) && Object.keys(r2).length === 0) {
              let e5 = K(t2, c2.escapeSequenceUpperCase);
              T2.add(e5);
              let r3 = g3 >= 0 ? Math.min(g3, n2.items.length) : n2.items.length;
              W(n2), H(n2, n2, e5, r3);
            }
          }
        }
        if (!p2 && s3.path.length > 1 && _2 !== undefined) {
          let i3 = a(o2) ? o2 : d(o2) && a(o2.item) ? o2.item : undefined;
          if (i3 && i3.key.value.length > 1) {
            let o3 = s3.path.slice(0, -1), u2 = e(l3) || t(l3) || r(l3) || f(l3) ? l3 : n2;
            if (m(u2)) {
              let s4;
              if (t(u2) || r(u2)) {
                let e4 = u2.key.item.value, t2 = 0, n3 = 0;
                for (let r2 = 0;r2 < e4.length && t2 < o3.length; r2++) {
                  for (;t2 < o3.length && typeof o3[t2] == `number`; )
                    t2++;
                  if (t2 >= o3.length || o3[t2] !== e4[r2])
                    break;
                  n3++, t2++;
                }
                for (;t2 < o3.length && typeof o3[t2] == `number`; )
                  t2++;
                s4 = n3 === e4.length ? o3.slice(t2) : o3.slice(e4.length + +!!r(u2));
              } else if (f(u2)) {
                if (x2) {
                  let e4 = x2.slice(0, x2.length - i3.key.value.length), t2 = 0, n3 = 0;
                  for (;n3 < e4.length && t2 < o3.length; ) {
                    for (;t2 < o3.length && typeof o3[t2] == `number`; )
                      t2++;
                    if (t2 >= o3.length || o3[t2] !== e4[n3])
                      break;
                    n3++, t2++;
                  }
                  for (;t2 < o3.length && typeof o3[t2] == `number`; )
                    t2++;
                  s4 = n3 === e4.length ? o3.slice(t2) : o3.slice(e4.length);
                } else
                  s4 = o3.slice(o3.length - (i3.key.value.length - 1));
              } else
                s4 = o3;
              s4 = s4.filter((e4) => typeof e4 == `string`);
              let l4 = u2.items.filter((e4) => {
                let t2 = a(e4) ? e4.key.value : d(e4) && a(e4.item) ? e4.item.key.value : undefined;
                return t2 ? I(t2.slice(0, s4.length), s4) : false;
              }), p3 = r(u2), m2 = [];
              p3 && l4.length === 0 && (m2 = $(n2, u2.key.item.value.concat(s4), u2));
              let h2 = s4.length === 0 && (t(u2) || r(u2) || f(u2));
              if (l4.length === 0 && m2.length === 0 && !h2) {
                let i4 = _2;
                for (let e4 of o3)
                  i4 = i4 == null ? undefined : i4[e4];
                if (F(i4) && Object.keys(i4).every((e4) => i4[e4] === undefined)) {
                  if (f(u2)) {
                    let e4 = s4.map((e5) => A.test(e5) ? e5 : JSON.stringify(e5).replace(/\x7f/g, `\\u007f`)).join(`.`), t2 = Array.from(N(`${e4} = {}`))[0];
                    if (a(t2)) {
                      let e5 = q(t2);
                      e5.comma = y3 ?? false, W(n2), rr(u2) && u2.loc.end.line > u2.loc.start.line && (u2.loc.end.line = u2.loc.start.line), H(n2, u2, e5, v4 >= 0 ? v4 : undefined), c2.bracketSpacing && G(e5, { lines: 0, columns: 1 });
                      let r2 = u2.items[v4 + 1], i6 = B(n2).get(e5);
                      r2 && i6 && r2.loc.start.line === e5.loc.end.line && (i6.columns = e5.loc.end.column + 2 - r2.loc.start.column);
                    }
                    return;
                  }
                  if (t(u2) || r(u2)) {
                    let e4 = s4.map((e5) => A.test(e5) ? e5 : JSON.stringify(e5).replace(/\x7f/g, `\\u007f`)).join(`.`), r2 = Array.from(N(`${e4} = {}`))[0];
                    a(r2) && (W(n2), H(n2, u2, r2, v4 >= 0 ? Math.min(v4, u2.items.length) : u2.items.length, undefined, undefined, u2.items.length === 0 && t(u2) ? 0 : undefined));
                    return;
                  }
                  let i5 = K(p3 ? u2.key.item.value.concat(s4) : s4, c2.escapeSequenceUpperCase);
                  T2.add(i5);
                  let o4 = g3 >= 0 ? g3 : n2.items.length;
                  if (p3) {
                    let e4 = n2.items.indexOf(u2);
                    o4 = e4 >= 0 ? e4 + 1 : n2.items.length;
                  } else if (t(u2)) {
                    let e4 = n2.items.indexOf(u2);
                    o4 = e4 >= 0 ? e4 + 1 : n2.items.length;
                  } else
                    e(u2) && (o4 = wo(n2) ?? n2.items.length);
                  W(n2), H(n2, n2, i5, o4);
                }
              }
            }
          }
        }
        if (r(o2)) {
          let e4 = s3.path.slice(0, -1);
          !X(n2, e4.concat(0)) && X(i2, e4) && w2.set(Rt(e4), e4);
        }
      } else {
        let e4 = () => X(n2, s3.path.concat(0)) || Q(n2, s3.path).filter(r)[0], a2 = e4();
        if (a2) {
          let o3 = n2.items.indexOf(a2), l3 = false;
          if (s3.path.length > 1 && _2 !== undefined) {
            let e5 = s3.path.slice(0, -1), t2 = Zo(n2, e5), i3 = Vo(n2, s3.path);
            if ((i3 ? $(n2, t2, i3) : Q(n2, t2)).filter((e6) => e6 !== a2 && !(r(e6) && I(e6.key.item.value, Zo(n2, s3.path)))).length === 0 && !(i3 && I(t2, i3.key.item.value))) {
              let r2 = _2;
              for (let t3 of e5)
                r2 = r2 == null ? undefined : r2[t3];
              if (F(r2) && Object.keys(r2).length === 0) {
                let e6 = a2, r3 = e6.key;
                for (;e6.items.length > 0; )
                  Z(n2, e6, P(e6.items));
                W(n2), e6.type = `Table`, r3.type = `TableKey`;
                let i4 = h(r3) ? r3.item : r3;
                i4.value = t2, i4.raw = so(i4.raw, i4.value, c2.escapeSequenceUpperCase), i4.loc.end.column = i4.loc.start.column + i4.raw.length, r3.loc.end.column = r3.loc.start.column + i4.raw.length + 2, e6.loc.end.line = r3.loc.end.line, e6.loc.end.column = r3.loc.end.column, E2(e6), l3 = true;
              }
            }
          }
          let u2 = Zo(n2, s3.path), d2 = Vo(n2, s3.path), f2;
          for (;f2 = e4(); ) {
            if (r(f2)) {
              let e5 = Bo(n2, f2).filter((e6) => t(e6) || r(e6)).filter((e6) => zo(Ro(e6), u2));
              for (let t2 of e5)
                Z(n2, n2, t2);
            }
            Z(n2, n2, f2);
          }
          if (!d2)
            for (let e5 of Q(n2, u2).filter(t))
              Z(n2, n2, e5);
          if (X(i2, s3.path)) {
            let e5 = s3.path;
            w2.set(Rt(e5), e5);
          }
          if (!l3 && s3.path.length > 1 && _2 !== undefined) {
            let e5 = s3.path.slice(0, -1), t2 = Zo(n2, e5), r2 = Vo(n2, s3.path);
            if ($(n2, t2, r2).length === 0 && !(r2 && I(t2, r2.key.item.value))) {
              let i3 = _2;
              for (let t3 of e5)
                i3 = i3 == null ? undefined : i3[t3];
              if (F(i3) && Object.keys(i3).length === 0) {
                let e6 = K(t2, c2.escapeSequenceUpperCase);
                T2.add(e6);
                let i4 = r2 && zo(t2, r2.key.item.value) ? n2.items.indexOf(r2) : -1, a3 = i4 >= 0 ? i4 + 1 : o3 >= 0 ? Math.min(o3, n2.items.length) : n2.items.length;
                if (W(n2), H(n2, n2, e6, a3), i4 >= 0) {
                  W(n2);
                  let t3 = n2.items[i4], r3 = e6.loc.start.line - t3.loc.end.line - 1;
                  if (r3 > 0)
                    for (let e7 of n2.items.slice(i4 + 1))
                      G(e7, { lines: -r3, columns: 0 });
                }
              }
            }
          }
        } else {
          let e5 = Zo(n2, s3.path), t2 = Vo(n2, s3.path), r2 = $(n2, e5, t2);
          if (r2.length > 0) {
            let i3 = n2.items.indexOf(r2[0]);
            for (let e6 of r2)
              Z(n2, n2, e6);
            if (e5.length > 1 && _2 !== undefined) {
              let r3 = e5.slice(0, -1);
              if ($(n2, r3, t2).length === 0 && !(t2 && I(r3, t2.key.item.value))) {
                let e6 = _2;
                for (let t3 of s3.path.slice(0, -1))
                  e6 = e6 == null ? undefined : e6[t3];
                if (F(e6) && Object.keys(e6).length === 0) {
                  let e7 = K(r3, c2.escapeSequenceUpperCase);
                  T2.add(e7);
                  let t3 = i3 >= 0 ? Math.min(i3, n2.items.length) : n2.items.length;
                  W(n2), H(n2, n2, e7, t3);
                }
              }
            }
          } else
            Y(n2, s3.path);
        }
      }
    } else if ($i(s3)) {
      if (s3.key !== undefined) {
        le2.push(s3);
        return;
      }
      let e4 = X(n2, s3.path);
      if (e4) {
        if (h(e4) && (e4 = e4.item), a(e4) && (e4 = e4.value), s3.from >= e4.items.length)
          return;
        let t2 = e4.items[s3.from];
        Da(n2, e4, t2, s3.to);
      } else {
        to(n2);
        let e5 = Y(n2, s3.path.concat(s3.from)), i3 = xa(n2).find((t2) => t2.member === e5), a2 = i3 ? [...i3.items] : [e5], o2 = a2.map((e6) => ({ startLine: e6.loc.start.line, endLine: e6.loc.end.line })), c3 = n2.items.indexOf(i3 ? i3.items[0] : e5), l3 = o2[o2.length - 1].endLine, u2;
        for (let e6 = 0;e6 < n2.items.length; e6++) {
          let t2 = n2.items[e6];
          if (t2.loc.start.line > l3) {
            u2 = t2.loc.start.line - l3;
            break;
          }
        }
        if (u2 === undefined && c3 > 0) {
          let e6 = n2.items[c3 - 1];
          u2 = o2[0].startLine - e6.loc.end.line;
        }
        let d2 = i3 ? i3.items.indexOf(e5) : 0;
        for (let e6 = 0;e6 <= d2; e6++)
          n2.items.includes(a2[e6]) && U(n2, n2, a2[e6]);
        for (let e6 = d2 + 1;e6 < a2.length; e6++) {
          let t2 = n2.items.indexOf(a2[e6]);
          t2 >= 0 && n2.items.splice(t2, 1);
        }
        let f2 = X(n2, s3.path.concat(s3.to)), m2, h2 = false, g3 = i3 && i3.items[0] !== e5 && p(i3.items[0]);
        if (f2) {
          let e6 = xa(n2).find((e7) => e7.member === f2);
          h2 = !!(e6 && e6.items[0] !== f2 && p(e6.items[0])), m2 = h2 && g3 ? n2.items.indexOf(e6.items[0]) : n2.items.indexOf(f2);
        } else
          m2 = n2.items.length;
        let _3 = m2 > 0 ? n2.items[m2 - 1].loc.end.line : 0, v4 = m2 < n2.items.length ? n2.items[m2].loc.start.line : undefined, y3 = h2 && g3, b3 = m2;
        for (let e6 = 0;e6 < a2.length; e6++) {
          let i4 = a2[e6], s4;
          if ((y3 || g3 && m2 > 0 && m2 < n2.items.length) && b3 > 0) {
            let n3 = e6 === 0 ? _3 : o2[e6 - 1].endLine, a3 = e6 === 0 && v4 !== undefined ? v4 - _3 : o2[e6].startLine - n3;
            a3 !== (t(i4) || r(i4) ? 2 : 1) && (s4 = a3);
          }
          H(n2, n2, i4, b3, undefined, undefined, s4), b3++;
        }
        if (u2 !== undefined) {
          W(n2);
          let e6 = a2[a2.length - 1], t2 = n2.items.indexOf(e6) + 1;
          if (t2 < n2.items.length) {
            let r2 = n2.items[t2].loc.start.line - e6.loc.end.line, i4 = u2 - r2;
            if (i4 !== 0)
              for (let e7 = t2;e7 < n2.items.length; e7++)
                G(n2.items[e7], { lines: i4, columns: 0 });
          }
        }
      }
    } else if (ea(s3)) {
      let e4 = s3.path.concat(s3.from), o2 = X(n2, e4);
      if (!o2) {
        let i3 = Q(n2, e4);
        if (i3.length === 1 && (t(i3[0]) || r(i3[0]))) {
          let t2 = i3[0].key, n3 = h(t2) ? t2.item : t2, r2 = e4.length - 1, a2 = n3.raw;
          n3.value[r2] = s3.to, n3.raw = so(n3.raw, n3.value, c2.escapeSequenceUpperCase), uo(n3, a2), n3.loc.end.column = n3.loc.start.column + n3.raw.length;
          return;
        }
      }
      o2 ||= Y(n2, e4);
      let l3 = Y(i2, s3.path.concat(s3.to));
      h(o2) && (o2 = o2.item), h(l3) && (l3 = l3.item);
      let u2 = o2.key, d2 = l3.key, f2 = h(u2) ? u2.item : u2, p2 = h(d2) ? d2.item : d2;
      if (f2.value.length !== p2.value.length) {
        let e5 = s3.path.concat(s3.from);
        if ((t(o2) || r(o2)) && a(l3) && I(f2.value.slice(0, e5.length), e5)) {
          let t2 = e5.length - 1, n3 = f2.raw;
          f2.value[t2] = s3.to, f2.raw = so(f2.raw, f2.value, c2.escapeSequenceUpperCase), uo(f2, n3), f2.loc.end.column = f2.loc.start.column + f2.raw.length;
          return;
        }
        if (a(o2) && a(l3) && f2.value.length <= e5.length && I(f2.value, e5.slice(e5.length - f2.value.length))) {
          let e6 = f2.raw;
          f2.value[f2.value.length - 1] = s3.to, f2.raw = so(f2.raw, f2.value, c2.escapeSequenceUpperCase), f2.loc.end.column = f2.loc.start.column + f2.raw.length;
          let t2 = f2.raw.length - e6.length;
          t2 > 0 && (o2.equals += t2, G(o2.value, { lines: 0, columns: t2 }, { first_line_only: true }), ar(n2, o2.value, { lines: 0, columns: t2 }));
          return;
        }
        throw Error(`Cannot rename "${f2.raw}" to "${p2.raw}": the replacement key has ${p2.value.length} segment(s) where the existing key has ${f2.value.length}, so one cannot be substituted for the other.`);
      }
      p2.raw = so(f2.raw, p2.value, c2.escapeSequenceUpperCase), uo(p2, f2.raw), p2.loc.end.column = p2.loc.start.column + p2.raw.length, V(n2, h(u2) ? u2 : o2, f2, p2);
    }
  }), W(n2);
  for (let e4 = 1;e4 < n2.items.length; e4++) {
    let r2 = n2.items[e4 - 1], i3 = n2.items[e4];
    if (p(r2) && t(i3) && T2.has(i3)) {
      let e5 = i3.loc.start.line - r2.loc.end.line - 1;
      e5 > 0 && G(i3, { lines: -e5, columns: 0 });
    }
  }
  let _e2 = n2.items;
  for (let e4 = 0;e4 < _e2.length - 1; e4++) {
    let n3 = _e2[e4], i3 = _e2[e4 + 1];
    if ((t(n3) || r(n3)) && n3.items.length === 0 && (t(i3) || r(i3))) {
      let t2 = i3.loc.start.line - n3.loc.end.line - 1;
      if (t2 > 1) {
        let n4 = 1 - t2;
        for (let t3 = e4 + 1;t3 < _e2.length; t3++)
          G(_e2[t3], { lines: n4, columns: 0 });
      }
    }
  }
  let ve2 = false;
  Ut(n2, { InlineTable: (e4) => {
    rr(e4) && (ve2 = true);
  }, InlineArray: (e4) => {
    rr(e4) && (ve2 = true);
  } }), ve2 && W(n2);
  let ye2 = false, be2 = [];
  if (Ut(n2, { InlineTable: (e4) => {
    rr(e4) && (be2.push(e4), Oo(e4), ir(e4), vr(n2, e4, c2.bracketSpacing), ye2 = true);
  }, InlineArray: (e4) => {
    rr(e4) && (Oo(e4), ir(e4), vr(n2, e4, c2.bracketSpacing), ye2 = true);
  } }), ye2) {
    W(n2);
    for (let e4 of be2)
      ko(n2, e4);
    Ao(n2);
  }
  if (Mo(n2), No(n2, w2, c2), Fa(n2, le2, g2), le2.length > 0 && or(n2), ue2.size > 0) {
    W(n2);
    for (let e4 of ue2)
      Ci(e4, c2.indentWidth);
  }
  if (de2.length > 0) {
    W(n2);
    for (let { owner: e4, container: t2 } of de2)
      So(t2), ui(t2, e4.loc.start.column, c2.indentWidth, c2.bracketSpacing);
  }
  return n2;
}
function So(e4) {
  if (delete e4.range, m(e4))
    for (let t2 of e4.items)
      So(t2);
  h(e4) && So(e4.item), a(e4) && (So(e4.key), So(e4.value));
}
function Co(e4) {
  return e4.items.findIndex((e5) => t(e5) || r(e5));
}
function wo(e4) {
  let t2 = Co(e4);
  if (t2 === -1)
    return;
  if (t2 === 0 || !p(e4.items[t2 - 1]))
    return t2;
  W(e4);
  let n2 = e4.items[t2], r2 = xa(e4).find((e5) => e5.member === n2);
  return r2 ? e4.items.indexOf(r2.items[0]) : t2;
}
function To(e4, t2) {
  let n2 = e4.items.indexOf(t2);
  if (n2 < 0)
    return;
  let r2 = Co(e4);
  r2 === -1 || r2 > n2 || (U(e4, e4, t2), W(e4), H(e4, e4, t2, wo(e4) ?? r2));
}
function Eo(e4, n2) {
  let i2 = e4.items.indexOf(n2);
  if (i2 < 0)
    return;
  let o2 = e4.items.findIndex((e5, n3) => n3 > i2 && (t(e5) || r(e5)));
  if (!e4.items.some((e5, t2) => t2 > i2 && a(e5) && (o2 === -1 || t2 < o2)))
    return;
  let s2 = o2 === -1 ? e4.items.length : o2;
  W(e4), U(e4, e4, n2), H(e4, e4, n2, s2 - 1);
}
function Do(e4, n2, i2, o2, s2, c2, l2) {
  let u2 = Bi(n2.items, ``, { temporal: s2 });
  for (let e5 of i2.path)
    u2 = u2 == null ? undefined : u2[e5];
  if (u2 === undefined)
    return;
  {
    let n3 = -1, s3;
    for (let t2 = i2.path.length - 1;t2 > 0; t2--) {
      if (typeof i2.path[t2] != `number`)
        continue;
      let a2 = X(e4, i2.path.slice(0, t2 + 1));
      if (a2 && r(a2)) {
        n3 = t2, s3 = a2;
        break;
      }
    }
    if (n3 > 0 && s3 && i2.path.slice(n3 + 1).every((e5) => typeof e5 == `string`)) {
      let l3 = s3, d2 = l3.key.item.value, f2 = i2.path.slice(n3 + 1), p3 = d2.concat(f2), m3 = $(e4, d2.concat(f2), l3), h3 = m3.length > 0 ? e4.items.indexOf(m3[0]) : -1;
      for (let t2 of m3)
        Z(e4, e4, t2);
      let g3 = l3.items.filter((e5) => {
        let t2 = a(e5) ? e5.key.value : undefined;
        return t2 && t2.length > f2.length && I(t2.slice(0, f2.length), f2);
      });
      for (let t2 of g3)
        Z(e4, l3, t2);
      if (f2.length > 1) {
        let t2 = Uo(e4, p3, d2.length, l3);
        if (t2) {
          let n4 = p3.slice(t2.key.item.value.length), r2 = Ho(u2) ? undefined : Wo(n4, u2, o2);
          if (r2) {
            Ko(e4, t2, n4, r2), c2.add(r2);
            return;
          }
        }
      }
      let _3;
      if (Ho(u2))
        _3 = { [f2[f2.length - 1]]: u2 };
      else {
        _3 = u2;
        for (let e5 = i2.path.length - 1;e5 > n3; e5--)
          _3 = { [i2.path[e5]]: _3 };
      }
      let v3 = ji(J(_3, o2).items, o2), y3 = Array.from(N(v3)), b2 = h3 >= 0 ? h3 : qo(e4, l3, Bo(e4, l3)), x2 = (t2) => {
        let n4 = l3.items.find((e5) => a(e5) && I(e5.key.value, t2.key.value));
        n4 ? V(e4, l3, n4, t2) : H(e4, l3, t2, undefined);
      };
      for (let n4 of y3)
        if (a(n4))
          x2(n4);
        else {
          if (t(n4)) {
            let r2 = n4.key.item.value, i3 = d2.concat(r2), s4 = $(e4, i3, l3).find((e5) => t(e5) && I(e5.key.item.value, i3));
            if (s4) {
              for (let t2 of n4.items) {
                if (!a(t2))
                  continue;
                let n5 = s4.items.find((e5) => a(e5) && I(e5.key.value, t2.key.value));
                n5 ? V(e4, s4, n5, t2) : H(e4, s4, t2, undefined);
              }
              continue;
            }
            for (let e5 of n4.items)
              a(e5) && (Go(e5, r2.concat(e5.key.value), o2), x2(e5));
          }
          r(n4) && Jo(e4, n4, p3.slice(0, -1), b2++, o2, c2);
        }
      return;
    }
  }
  if (i2.path.length > 1 && i2.path.every((e5) => typeof e5 == `string`)) {
    let t2 = i2.path, n3 = Uo(e4, t2, 0, undefined);
    if (n3 && Yo(e4, n3, t2, u2, o2, c2) || !n3 && Xo(e4, t2, u2, o2, c2))
      return;
  }
  let p2 = u2;
  for (let e5 = i2.path.length - 1;e5 >= 0; e5--)
    p2 = { [i2.path[e5]]: p2 };
  let m2 = Q(e4, i2.path);
  for (let t2 of m2)
    U(e4, e4, t2);
  let h2 = ji(J(p2, o2).items, o2), g2 = Array.from(N(h2)), _2 = wo(e4);
  _2 !== undefined && W(e4);
  let v2;
  for (let n3 = 0;n3 < g2.length; n3++) {
    let i3 = g2[n3], o3 = t(i3) ? e4.items.find((e5) => t(e5) && I(e5.key.item.value, i3.key.item.value)) : undefined;
    if (o3) {
      for (let t2 of i3.items)
        H(e4, o3, t2, undefined);
      v2 ||= o3;
    } else {
      if (a(i3) && f(i3.value)) {
        let o4 = i3.key.value, s3 = e4.items.find((e5) => t(e5) && I(e5.key.item.value, o4));
        if (s3) {
          for (let t2 of i3.value.items)
            H(e4, s3, d(t2) ? t2.item : t2, undefined);
          v2 ||= s3;
          continue;
        }
        if (Q(e4, o4).filter((e5) => a(e5) || t(e5) || r(e5)).length > 0) {
          for (let t2 of i3.value.items) {
            let r2 = d(t2) ? t2.item : t2;
            if (a(r2)) {
              let e5 = r2.key.raw, t3 = o4.concat(r2.key.value);
              r2.key.value = t3, r2.key.raw = t3.map((e6) => A.test(e6) ? e6 : JSON.stringify(e6).replace(/\x7f/g, `\\u007f`)).join(`.`);
              let n4 = r2.key.raw.length - e5.length;
              r2.key.loc.end.column = r2.key.loc.start.column + r2.key.raw.length, r2.equals += n4, G(r2.value, { lines: 0, columns: n4 }, { first_line_only: true }), r2.loc.end.line === r2.loc.start.line && (r2.loc.end.column += n4);
            }
            H(e4, e4, r2, n3 === 0 ? _2 : undefined), v2 ||= r2;
          }
          continue;
        }
      }
      if (t(i3)) {
        let t2 = i3.key.item.value;
        if (Q(e4, t2).filter((e5) => a(e5)).length > 0) {
          for (let r2 of i3.items) {
            if (a(r2)) {
              let e5 = r2.key.raw, n4 = t2.concat(r2.key.value);
              r2.key.value = n4, r2.key.raw = n4.map((e6) => A.test(e6) ? e6 : JSON.stringify(e6).replace(/\x7f/g, `\\u007f`)).join(`.`);
              let i4 = r2.key.raw.length - e5.length;
              r2.key.loc.end.column = r2.key.loc.start.column + r2.key.raw.length, r2.equals += i4, G(r2.value, { lines: 0, columns: i4 }, { first_line_only: true }), r2.loc.end.line === r2.loc.start.line && (r2.loc.end.column += i4);
            }
            H(e4, e4, r2, n3 === 0 ? _2 : undefined), v2 ||= r2;
          }
          continue;
        }
      }
      n3 > 0 && v2 && t(v2) && a(i3) ? H(e4, v2, i3, undefined) : H(e4, e4, i3, n3 === 0 ? _2 : undefined), v2 ||= i3;
    }
  }
  let y2 = v2;
  t(y2) && l2.add(y2), c2.add(y2);
}
function Oo(e4) {
  if (e4.items.length > 0) {
    let t2 = e4.items[e4.items.length - 1];
    e4.loc.end.column = t2.loc.end.column + 1;
  } else
    e4.loc.end.line = e4.loc.start.line, e4.loc.end.column = e4.loc.start.column + 2;
}
function ko(e4, t2) {
  let n2 = [], r2 = (e5) => {
    if (n2.push(e5), e5 === t2)
      return true;
    if (a(e5)) {
      if (r2(e5.value))
        return true;
    } else if (d(e5)) {
      if (r2(e5.item))
        return true;
    } else if (m(e5)) {
      for (let t3 of e5.items)
        if (r2(t3))
          return true;
    }
    return n2.pop(), false;
  };
  if (!r2(e4))
    return;
  let i2 = n2.findLast(d);
  if (!i2)
    return;
  let o2 = t2.loc.end.line - i2.loc.end.line;
  if (o2 === 0)
    return;
  let s2 = n2.findLastIndex((e5, t3) => t3 < n2.length - 1 && (f(e5) || u(e5)));
  if (s2 < 0)
    return;
  let c2 = n2[s2], l2 = n2[s2 + 1], p2 = c2.items.indexOf(l2), h2 = p2 >= 0 ? c2.items[p2 + 1] : undefined;
  if (p2 < 0 || !h2)
    return;
  let g2 = h2.loc.start.column - l2.loc.end.column, _2 = jo(l2) + g2 - h2.loc.start.column;
  for (let e5 = p2 + 1;e5 < c2.items.length; e5++)
    G(c2.items[e5], { lines: o2, columns: _2 });
  c2.loc.end.column += _2;
  for (let e5 of n2)
    e5 !== t2 && e5.loc.end.line > t2.loc.end.line && (e5.loc.end.line += o2);
  for (let e5 = n2.length - 1;e5 >= 0; e5--) {
    let r3 = n2[e5];
    a(r3) ? (r3.loc.end = { ...r3.value.loc.end }, r3.value !== t2 && f(r3.value) && (r3.loc.end.column += _2)) : d(r3) && (r3.loc.end = { ...r3.item.loc.end });
  }
}
function Ao(e4) {
  Ut(e4, { InlineTable: { exit: (e5) => {
    if (e5.items.length === 0 || e5.loc.end.line !== e5.loc.start.line)
      return;
    let t2 = e5.items[e5.items.length - 1], n2 = jo(t2), r2 = e5.loc.end.column, i2 = n2 + (r2 - t2.loc.end.column);
    i2 !== r2 && (e5.loc.end.column = i2);
  } }, InlineArray: { exit: (e5) => {
    if (e5.items.length === 0 || e5.loc.end.line !== e5.loc.start.line)
      return;
    let t2 = e5.items[e5.items.length - 1], n2 = jo(t2), r2 = e5.loc.end.column, i2 = n2 + (r2 - t2.loc.end.column);
    i2 !== r2 && (e5.loc.end.column = i2);
  } } });
}
function jo(e4) {
  if (!d(e4))
    return e4.loc.end.column;
  if (a(e4.item)) {
    let t2 = e4.item.value;
    if (f(t2) || u(t2))
      return t2.loc.end.column;
  }
  return f(e4.item) || u(e4.item) ? e4.item.loc.end.column : e4.loc.end.column;
}
function Mo(e4) {
  Ut(e4, { KeyValue: (t2) => {
    let n2 = t2.value;
    if (!u(n2) || n2.items.length > 0)
      return;
    let r2 = ca(e4, [t2.key.value[0]]);
    if (!r2 || !m(r2))
      return;
    let i2 = t2.loc.start.line, a2 = t2.loc.end.line, o2 = r2.items;
    for (let e5 = o2.length - 1;e5 >= 0; e5--) {
      let t3 = o2[e5];
      if (!p(t3))
        continue;
      let n3 = t3.loc.start.line;
      n3 >= i2 && n3 <= a2 && o2.splice(e5, 1);
    }
  } });
}
function No(e4, n2, i2) {
  if (n2.size !== 0) {
    for (let a2 of n2.values()) {
      if (a2.length > 1) {
        let n4 = a2.slice(0, -1), o3 = X(e4, typeof n4[n4.length - 1] == `number` ? n4 : n4.concat([0]));
        if (o3 && r(o3)) {
          let t2 = a2[a2.length - 1];
          if (typeof t2 != `string`)
            continue;
          let n5 = J({ [t2]: [] }, i2), r2 = Lr([t2], n5.items[0].value);
          W(e4), H(e4, o3, r2);
          continue;
        }
        let s2;
        for (let n5 = a2.length - 1;n5 >= 1; n5--) {
          let i3 = X(e4, a2.slice(0, n5));
          if (i3 && (t(i3) || r(i3))) {
            s2 = i3;
            break;
          }
        }
        if (s2) {
          let t2 = a2.filter((e5) => typeof e5 == `string`).slice(s2.key.item.value.length), n5 = Lr(t2, J({ [t2[t2.length - 1]]: [] }, i2).items[0].value);
          W(e4), H(e4, s2, n5);
          continue;
        }
      }
      let n3 = a2.filter((e5) => typeof e5 == `string`), o2 = Lr(n3, J({ [n3[n3.length - 1]]: [] }, i2).items[0].value);
      W(e4), H(e4, e4, o2, wo(e4));
    }
    W(e4);
  }
}
function Po(e4, t2, n2) {
  let r2 = [], i2 = (e5, r3) => {
    for (let o2 = e5.items.length - 1;o2 >= 0; o2--) {
      let s2 = e5.items[o2];
      if (a(s2) && f(s2.value)) {
        let c2 = [...e5.key.item.value, ...s2.key.value];
        if (mi(c2) < (n2.inlineTableStart ?? 1) && n2.inlineTableStart !== 0) {
          let l2 = K(c2, n2.escapeSequenceUpperCase);
          for (let e6 of s2.value.items)
            d(e6) && a(e6.item) && H(t2, l2, e6.item, undefined);
          e5.items.splice(o2, 1), pi(e5), r3.push(l2), i2(l2, r3);
        }
      }
    }
  };
  return i2(e4, r2), r2;
}
function Fo(e4, t2, n2, r2) {
  let i2 = K([...t2.key.item.value, ...e4.key.value], r2.escapeSequenceUpperCase);
  if (f(e4.value))
    for (let t3 of e4.value.items)
      d(t3) && a(t3.item) && H(n2, i2, t3.item, undefined);
  H(n2, n2, i2, undefined), pi(t2);
  let o2 = Po(i2, n2, r2);
  for (let e5 of o2)
    H(n2, n2, e5, undefined);
}
function Io(e4, n2) {
  let r2 = L({ ...n2, inlineTableStart: 0 }, n2), i2 = ji(J({ __tmp__: e4 }, r2).items, r2), o2 = Array.from(N(i2))[0];
  if (a(o2))
    return o2.value;
  if (t(o2) && o2.items.length > 0 && a(o2.items[0]))
    return o2.items[0].value;
}
function Lo(e4, t2) {
  for (let n2 = t2.length - 1;n2 > 0; n2--) {
    let r2 = X(e4, t2.slice(0, n2));
    if (!r2 || !a(r2) || !f(r2.value))
      continue;
    let i2 = X(e4, t2.slice(0, n2 - 1));
    if (i2 && m(i2))
      return { container: i2, row: r2 };
  }
}
function Q(e4, n2) {
  let i2 = [];
  for (let o2 of e4.items) {
    let e5;
    a(o2) ? e5 = o2.key.value : (t(o2) || r(o2)) && (e5 = o2.key.item.value), e5 && I(e5.slice(0, n2.length), n2) && i2.push(o2);
  }
  return i2;
}
function Ro(e4) {
  if (a(e4))
    return e4.key.value;
  if (t(e4) || r(e4))
    return e4.key.item.value;
}
function zo(e4, t2) {
  return e4 !== undefined && t2.every((t3, n2) => typeof t3 == `string` && e4[n2] === t3);
}
function Bo(e4, t2, n2, i2) {
  let a2 = i2 ?? e4.items, o2 = n2 ?? a2.indexOf(t2);
  if (o2 < 0)
    return [];
  let s2 = t2.key.item.value, c2 = a2.length;
  for (let e5 = o2 + 1;e5 < a2.length; e5++) {
    let t3 = a2[e5];
    if (!r(t3))
      continue;
    let n3 = t3.key.item.value;
    if (n3.length <= s2.length && I(n3, s2.slice(0, n3.length))) {
      c2 = e5;
      break;
    }
  }
  return a2.slice(o2 + 1, c2);
}
function Vo(e4, t2) {
  for (let n2 = t2.length - 1;n2 >= 0; n2--) {
    if (typeof t2[n2] != `number`)
      continue;
    let i2 = X(e4, t2.slice(0, n2 + 1));
    if (i2 && r(i2))
      return i2;
  }
}
function $(e4, t2, n2) {
  let r2 = Q(e4, t2);
  if (!n2)
    return r2;
  let i2 = new Set(Bo(e4, n2));
  return r2.filter((e5) => i2.has(e5));
}
function Ho(e4) {
  return Array.isArray(e4) && e4.length > 0 && e4.every(F);
}
function Uo(e4, n2, r2, i2) {
  for (let a2 = n2.length - 1;a2 > r2; a2--) {
    let r3 = n2.slice(0, a2), o2 = $(e4, r3, i2).find((e5) => t(e5) && I(e5.key.item.value, r3));
    if (o2)
      return o2;
  }
}
function Wo(e4, t2, n2) {
  let r2 = L({ ...n2, inlineTableStart: 0 }, n2), i2 = J({ [e4[e4.length - 1]]: t2 }, r2), o2 = Array.from(N(ji(i2.items, n2)));
  if (o2.length !== 1 || !a(o2[0]))
    return;
  let s2 = o2[0];
  return e4.length > 1 && Go(s2, e4, n2), s2;
}
function Go(e4, t2, n2) {
  let r2 = e4.key.raw;
  e4.key.value = t2, e4.key.raw = Br(t2, n2.escapeSequenceUpperCase).raw;
  let i2 = e4.key.raw.length - r2.length;
  e4.key.loc.end.column = e4.key.loc.start.column + e4.key.raw.length, e4.equals += i2, G(e4.value, { lines: 0, columns: i2 }, { first_line_only: true }), e4.loc.end.line === e4.loc.start.line && (e4.loc.end.column += i2);
}
function Ko(e4, t2, n2, r2) {
  let i2 = t2.items.filter((e5) => a(e5) && zo(e5.key.value, n2)), o2 = i2.find((e5) => I(e5.key.value, n2));
  for (let n3 of i2)
    n3 !== o2 && Z(e4, t2, n3);
  o2 ? V(e4, t2, o2, r2) : H(e4, t2, r2, undefined);
}
function qo(e4, n2, i2) {
  let a2 = n2.key.item.value, o2 = e4.items.indexOf(n2) + 1;
  for (let n3 of i2) {
    if (!zo(t(n3) || r(n3) ? n3.key.item.value : undefined, a2))
      break;
    o2 = e4.items.indexOf(n3) + 1;
  }
  return o2;
}
function Jo(e4, t2, n2, r2, i2, a2) {
  let o2 = t2.key.item, s2 = o2.raw, c2 = n2.concat(o2.value);
  o2.value = c2, o2.raw = Br(c2, i2.escapeSequenceUpperCase).raw;
  let l2 = o2.raw.length - s2.length;
  o2.loc.end.column = o2.loc.start.column + o2.raw.length, t2.key.loc.end.line === t2.key.loc.start.line && (t2.key.loc.end.column += l2), H(e4, e4, t2, r2, undefined, undefined, 1), a2.add(t2);
}
function Yo(e4, n2, i2, o2, s2, c2) {
  let l2 = i2.slice(n2.key.item.value.length);
  if (Ho(o2)) {
    let u3 = n2.items.filter((e5) => a(e5) && e5.key.value[0] === l2[0]);
    if (u3.some((e5) => !zo(e5.key.value, l2)))
      return false;
    let d2 = i2[i2.length - 1], f2 = J({ [d2]: o2 }, s2), p2 = Array.from(N(ji(f2.items, s2)));
    if (!p2.every((e5) => t(e5) || r(e5)))
      return false;
    let m2 = Q(e4, i2), h2 = m2.length > 0 ? e4.items.indexOf(m2[0]) : -1;
    for (let t2 of m2)
      Z(e4, e4, t2);
    for (let t2 of u3)
      Z(e4, n2, t2);
    let g2 = h2 >= 0 ? h2 : qo(e4, n2, e4.items.slice(e4.items.indexOf(n2) + 1));
    for (let t2 of p2)
      Jo(e4, t2, i2.slice(0, -1), g2++, s2, c2);
    return true;
  }
  let u2 = Wo(l2, o2, s2);
  if (!u2)
    return false;
  for (let t2 of Q(e4, i2))
    Z(e4, e4, t2);
  return Ko(e4, n2, l2, u2), c2.add(u2), true;
}
function Xo(e4, n2, i2, a2, o2) {
  if (n2.length < 3 || Ho(i2))
    return false;
  let s2 = n2.slice(0, 2);
  if (!e4.items.some((e5) => {
    let i3 = t(e5) || r(e5) ? e5.key.item.value : undefined;
    return zo(i3, s2) && !zo(i3, n2);
  }))
    return false;
  let c2 = Wo(n2, i2, a2);
  if (!c2)
    return false;
  for (let t2 of Q(e4, n2))
    Z(e4, e4, t2);
  let l2 = wo(e4);
  return l2 !== undefined && W(e4), H(e4, e4, c2, l2), o2.add(c2), true;
}
function Zo(e4, t2) {
  let n2 = [];
  for (let i2 of t2)
    typeof i2 == `number` && Q(e4, n2).some(r) || n2.push(i2);
  return n2;
}
function Qo(e4, n2, i2, o2) {
  let s2 = [...n2.items];
  for (let c2 = s2.length - 1;c2 >= 0; c2--) {
    let l2 = s2[c2];
    if (l2 === o2)
      continue;
    let u2 = a(l2) ? l2.key.value : t(l2) || r(l2) ? l2.key.item.value : undefined;
    u2 && u2.length > i2.length && I(u2.slice(0, i2.length), i2) && Z(e4, n2, l2);
  }
}
function $o(e4, t2, n2) {
  let r2 = Zo(e4, t2), i2 = Vo(e4, t2);
  for (let t3 of $(e4, r2, i2))
    t3 !== n2 && Z(e4, e4, t3);
}
function es(e4, t2) {
  return e4.line === t2.line ? e4.column - t2.column : e4.line - t2.line;
}
function ts(e4, t2, n2) {
  let r2 = { line: t2, column: n2 }, i2 = [], a2 = null;
  for (let t3 of e4) {
    let e5 = es(t3.loc.end, r2) < 0, n3 = es(t3.loc.start, r2) < 0;
    if (e5)
      i2.push(t3), a2 = t3.loc.end;
    else if (n3 && !e5)
      break;
    else
      break;
  }
  return { truncatedCst: i2, lastEndPosition: a2 };
}
var ns = class {
  _cst;
  _currentTomlString;
  _format;
  _integersAsBigInt;
  _temporal;
  constructor(e4, t2) {
    let n2 = typeof e4 == `string` ? e4 : Wt(e4), r2 = Kt(n2);
    this._currentTomlString = r2, this._cst = Array.from(N(r2)), this._integersAsBigInt = (t2 == null ? undefined : t2.integersAsBigInt) ?? `asNeeded`, this._temporal = (t2 == null ? undefined : t2.temporal) ?? false, this._format = R.autoDetectFormatWithCst(n2, this._cst);
  }
  get toTomlString() {
    return this._format.leadingBom ? `\uFEFF${this._currentTomlString}` : this._currentTomlString;
  }
  get toJsObject() {
    let e4 = Bi(this._cst, this._currentTomlString, { integersAsBigInt: this._integersAsBigInt, temporal: this._temporal });
    return this._temporal ? e4 : as(e4);
  }
  get cst() {
    return this._cst;
  }
  patch(e4, t2) {
    let n2 = L(t2, this._format), r2 = this._currentTomlString;
    if (!this._temporal && rs(e4)) {
      let t3 = Bi(this._cst, r2, { integersAsBigInt: this._integersAsBigInt, temporal: false });
      e4 = is(e4, t3);
    }
    let i2 = t2 instanceof R || t2 != null && Object.prototype.hasOwnProperty.call(t2, `indentWidth`), a2 = t2 instanceof R || t2 != null && Object.prototype.hasOwnProperty.call(t2, `trailingComma`), o2 = t2 instanceof R || t2 != null && Object.prototype.hasOwnProperty.call(t2, `inlineTableStart`);
    vn(this._cst, r2);
    let s2 = no(this._cst, e4, n2, i2, a2, o2);
    this._cst = Array.from(N(s2.tomlString)), this._format = n2, this._currentTomlString = s2.tomlString;
  }
  update(e4) {
    let t2 = Kt(e4);
    if (t2 === this._currentTomlString) {
      this._format.leadingBom = Gt(e4);
      return;
    }
    let n2 = this._currentTomlString.split(this._format.newLine), r2 = tn(t2), i2 = t2.split(r2), a2 = 0;
    for (;a2 < n2.length && a2 < i2.length && n2[a2] === i2[a2]; )
      a2++;
    let o2 = 0;
    if (a2 < n2.length && a2 < i2.length) {
      let e5 = n2[a2], t3 = i2[a2];
      for (let n3 = 0;n3 < Math.max(e5.length, t3.length); n3++)
        if (e5[n3] !== t3[n3]) {
          o2 = n3;
          break;
        }
    }
    let s2 = a2 + 1, { truncatedCst: c2, lastEndPosition: l2 } = ts(this._cst, s2, o2), u2 = l2 ? l2.line : 1, d2 = l2 ? l2.column + 1 : 0, f2 = i2.slice(u2 - 1);
    f2.length > 0 && d2 > 0 && (f2[0] = f2[0].substring(d2));
    let p2 = f2.join(this._format.newLine);
    this._cst = Array.from(Xe(c2, p2, { line: u2, column: d2 })), this._currentTomlString = t2, this._format = R.autoDetectFormatWithCst(e4, this._cst);
  }
  overwrite(e4) {
    let t2 = Kt(e4);
    t2 === this._currentTomlString ? this._format.leadingBom = Gt(e4) : (this._cst = Array.from(N(t2)), this._currentTomlString = t2, this._format = R.autoDetectFormatWithCst(e4, this._cst));
  }
};
function rs(e4, t2 = /* @__PURE__ */ new WeakSet) {
  return e4 instanceof Date ? e4.constructor === Date : !e4 || typeof e4 != `object` || t2.has(e4) ? false : (t2.add(e4), Array.isArray(e4) ? e4.some((e5) => rs(e5, t2)) : Object.keys(e4).some((n2) => rs(e4[n2], t2)));
}
function is(e4, t2, n2 = /* @__PURE__ */ new WeakSet) {
  if (e4 instanceof Date)
    return e4.constructor === Date && t2 instanceof Date && t2.constructor !== Date && t2.getTime() === e4.getTime() ? t2 : e4;
  if (!e4 || typeof e4 != `object` || n2.has(e4))
    return e4;
  if (n2.add(e4), Array.isArray(e4)) {
    if (!Array.isArray(t2))
      return e4;
    let r3 = false, i3 = e4.map((e5, i4) => {
      let a2 = is(e5, t2[i4], n2);
      return a2 !== e5 && (r3 = true), a2;
    });
    return r3 ? i3 : e4;
  }
  if (!F(t2))
    return e4;
  let r2 = false, i2 = {};
  for (let a2 of Object.keys(e4)) {
    let o2 = e4[a2], s2 = is(o2, t2[a2], n2);
    i2[a2] = s2, s2 !== o2 && (r2 = true);
  }
  return r2 ? i2 : e4;
}
function as(e4) {
  if (e4 instanceof Date)
    return new Date(e4.getTime());
  if (Array.isArray(e4))
    return e4.map(as);
  if (e4 && typeof e4 == `object`) {
    let t2 = {};
    for (let [n2, r2] of Object.entries(e4))
      t2[n2] = as(r2);
    return t2;
  }
  return e4;
}
var os = Object.freeze(R.default());
function ss(e4) {
  let t2 = os;
  return e4.newLine === t2.newLine && e4.trailingNewline === t2.trailingNewline && e4.trailingComma === t2.trailingComma && e4.bracketSpacing === t2.bracketSpacing && e4.inlineTableStart === t2.inlineTableStart && e4.truncateZeroTimeInDates === t2.truncateZeroTimeInDates && e4.useTabsForIndentation === t2.useTabsForIndentation && e4.indentWidth === t2.indentWidth && e4.minimumDecimals === t2.minimumDecimals && e4.minimumTimeDecimals === t2.minimumTimeDecimals && e4.leadingBom === t2.leadingBom && e4.updateOrder === t2.updateOrder && e4.multilineTable === t2.multilineTable && e4.multilineArray === t2.multilineArray;
}
function cs(e4, t2) {
  let n2 = Kt(typeof e4 == `string` ? e4 : Wt(e4));
  return Bi(N(n2), n2, { integersAsBigInt: (t2 == null ? undefined : t2.integersAsBigInt) ?? `asNeeded`, temporal: (t2 == null ? undefined : t2.temporal) ?? false });
}
function ls(e4, t2) {
  let n2 = t2 == null ? os : L(t2, R.default()), r2 = J(e4, n2), i2 = ss(n2) ? Ni(r2.items, n2) : ji(r2.items, n2);
  return n2.leadingBom ? `\uFEFF${i2}` : i2;
}
function us(e4, t2) {
  return new ns(e4, t2);
}
export {
  ls as stringify,
  Xa as patch,
  us as parseDocument,
  cs as parse,
  R as TomlFormat,
  ns as TomlDocument,
  ke as OffsetDateTime,
  De as LocalTime,
  Oe as LocalDateTime,
  Ee as LocalDate
};

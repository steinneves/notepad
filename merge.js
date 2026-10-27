// Small text-merging helpers, kept separate from app.js so they can be tested.
(function (global) {
  "use strict";

  // The single changed region that turns `a` into `b`:
  // a.slice(start, end) was replaced by `text`.
  function diffSpan(a, b) {
    const max = Math.min(a.length, b.length);
    let start = 0;
    while (start < max && a[start] === b[start]) start++;
    let tail = 0;
    while (tail < max - start && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
    return { start, end: a.length - tail, text: b.slice(start, b.length - tail) };
  }

  // Three-way merge: `local` and `remote` were both edited from `base`.
  // Returns the combined text, or null if the two edits overlap.
  function merge3(base, local, remote) {
    if (local === base || local === remote) return remote;
    if (remote === base) return local;
    const l = diffSpan(base, local);
    const r = diffSpan(base, remote);
    if (l.end <= r.start) {
      return base.slice(0, l.start) + l.text + base.slice(l.end, r.start) + r.text + base.slice(r.end);
    }
    if (r.end <= l.start) {
      return base.slice(0, r.start) + r.text + base.slice(r.end, l.start) + l.text + base.slice(l.end);
    }
    return null;
  }

  // Where a cursor at `pos` in `a` should end up after `a` becomes `b`.
  function moveCursor(pos, a, b) {
    const d = diffSpan(a, b);
    if (pos <= d.start) return pos;
    if (pos >= d.end) return pos + d.text.length - (d.end - d.start);
    return d.start + d.text.length;
  }

  global.NotepadMerge = { diffSpan, merge3, moveCursor };
})(typeof window !== "undefined" ? window : globalThis);

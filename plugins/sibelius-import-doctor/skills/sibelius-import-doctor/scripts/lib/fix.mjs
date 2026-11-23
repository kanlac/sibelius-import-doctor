// Repairs for what Sibelius mishandles on MusicXML import. See references/problems.md.
//
// Ported from the Python prototype; the order of operations, element placement and number
// handling follow it so outputs match byte for byte. Deliberate differences, each covered by a
// test: pickup (implicit) bars are never stretched to the full time signature, and bars that
// were not otherwise repaired are not padded unless fillShortBars is set (the prototype always
// padded them; Sibelius handles short bars on its own, see problems.md).

import { Frac, fmax } from "./frac.mjs";
import { TICKS_PER_QUARTER, analyse, partNames, partStaves, toInt } from "./score.mjs";
import {
  kids, find, findText, text, setText, attr, setAttr, iter, make, sub, append, remove,
  addNext, addPrevious, insertFirst, nextSibling,
} from "./xml.mjs";
import { abbreviate } from "./abbreviations.mjs";

const BASE = [
  ["breve", new Frac(8)], ["whole", new Frac(4)], ["half", new Frac(2)], ["quarter", new Frac(1)],
  ["eighth", new Frac(1, 2)], ["16th", new Frac(1, 4)], ["32nd", new Frac(1, 8)], ["64th", new Frac(1, 16)],
];
export const HALF_OF = { breve: "whole", whole: "half", half: "quarter", quarter: "eighth", eighth: "16th", "16th": "32nd" };

/** Quarter-length -> [type, dots] or null. */
export function representable(q) {
  for (const [t, b] of BASE) {
    for (let dots = 0; dots < 3; dots++) {
      if (b.mul(new Frac(2).sub(new Frac(1, 2 ** dots))).eq(q)) return [t, dots];
    }
  }
  return null;
}

/** Greedy split of a quarter-length into undotted values, largest first: [parts, remainder]. */
export function splitRepresentable(q) {
  const out = [];
  for (const [t, b] of BASE) {
    while (q.cmp(b) >= 0) {
      out.push([t, 0, b]);
      q = q.sub(b);
    }
  }
  return [out, q];
}

const dur = (el) => toInt(findText(el, "duration") || "0", "duration");
const hasChild = (el, name) => !!find(el, name);
const tk = (d, divisions) => new Frac(d * TICKS_PER_QUARTER, divisions);

function setType(note, t, dots) {
  let ty = find(note, "type");
  if (!ty) {
    ty = make("type");
    addNext(find(note, "voice") ?? find(note, "duration"), ty);
  }
  setText(ty, t);
  for (const d of kids(note, "dot")) remove(note, d);
  for (let i = 0; i < dots; i++) addNext(ty, make("dot"));
}

function makeRest(d, voice, staff, t, dots) {
  const n = make("note");
  sub(n, "rest");
  sub(n, "duration", {}, d);
  sub(n, "voice", {}, voice);
  sub(n, "type", {}, t);
  for (let i = 0; i < dots; i++) sub(n, "dot");
  if (staff != null) sub(n, "staff", {}, staff);
  return n;
}

/** Entries of a measure with positions in divisions. */
function walk(m) {
  let pos = 0;
  let last = 0;
  const out = [];
  for (const el of kids(m)) {
    if (el.name === "note") {
      const chord = hasChild(el, "chord");
      const grace = hasChild(el, "grace");
      const d = grace ? 0 : dur(el);
      const start = chord ? last : pos;
      if (!chord) {
        last = pos;
        pos += d;
      }
      out.push({ el, kind: "note", start, dur: d, chord, grace, rest: hasChild(el, "rest"),
        voice: findText(el, "voice") || "1", staff: findText(el, "staff") });
    } else if (el.name === "backup") {
      pos -= dur(el);
      out.push({ el, kind: "backup", target: pos });
    } else if (el.name === "forward") {
      const d = dur(el);
      out.push({ el, kind: "forward", start: pos, dur: d, voice: findText(el, "voice") || "1", staff: findText(el, "staff") });
      pos += d;
    }
  }
  return [out, pos];
}

const voiceKey = (v) => (/^\d+$/.test(v) ? Number(v) : 99);

export class Fixer {
  constructor(doc, { mode = "pad", tremolo = true, unmeasured = true, abbreviations = true, composer = null, fillShortBars = false } = {}) {
    this.doc = doc;
    this.root = doc.root;
    this.mode = mode;
    this.opts = { tremolo, unmeasured, abbreviations, composer, fillShortBars };
    this.log = [];
    this.warnings = [];
  }

  // ---------- bar targets ----------
  barTargets() {
    const an = analyse(this.root);
    const pids = [...an.keys()];
    const n = Math.max(...[...an.values()].map((v) => v.length));
    const targets = [];
    const overlong = [];
    for (let i = 0; i < n; i++) {
      const ms = pids.filter((p) => i < an.get(p).length).map((p) => an.get(p)[i]);
      const exp = ms[0].expected;
      const maxFill = ms.reduce((a, m) => fmax(a, m.fill), new Frac(0));
      overlong.push(maxFill.gt(exp));
      if (this.mode === "pad") {
        targets.push(maxFill);
        continue;
      }
      if (ms.some((m) => m.implicit) && maxFill.gt(0)) {
        // a pickup bar is as long as its longest part, never the full time signature
        targets.push(maxFill);
        continue;
      }
      const noted = ms.filter((m) => m.heads > 0).map((m) => m.fill);
      const distinct = new Set(noted.map(String));
      if (noted.length >= 2 && distinct.size === 1 && noted[0].lt(exp)) targets.push(noted[0]);
      else targets.push(exp);
    }
    return { targets, overlong };
  }

  // ---------- measure repair ----------
  fixMeasures() {
    const { targets, overlong } = this.barTargets();
    const names = Object.fromEntries(partNames(this.root).map((p) => [p.id, p.name]));
    for (const part of kids(this.root, "part")) {
      const pid = attr(part, "id");
      const staves = partStaves(part);
      const multi = staves != null;
      const nstaves = staves && text(staves) ? toInt(text(staves), "staves") : 1;
      let divisions = 1;
      kids(part, "measure").forEach((m, k) => {
        const idx = k + 1;
        const a = kids(m, "attributes").find((x) => find(x, "divisions"));
        const d = a ? findText(a, "divisions") : null;
        if (d) divisions = toInt(d, "divisions");
        const tTicks = targets[idx - 1];
        const tq = tTicks.mul(divisions).div(TICKS_PER_QUARTER);
        if (!tq.isInt()) {
          this.warnings.push(`${pid} m${idx}: bar length not expressible in divisions=${divisions}`);
          return;
        }
        const T = tq.n;
        const ctx = { part: pid, name: names[pid] ?? "", measure: idx, number: attr(m, "number"), target_ticks: tTicks };
        const [entries0] = walk(m);
        const backups = new Map(entries0.filter((e) => e.kind === "backup").map((e) => [e.el, Math.max(0, e.target)]));
        this.measureRests(m, T, divisions, ctx);
        this.rebackup(m, backups);
        let trimmed = false;
        if (this.mode === "trim") {
          trimmed = this.trim(m, T, divisions, ctx);
          this.rebackup(m, backups);
        }
        const padHere = this.opts.fillShortBars || (this.mode === "pad" ? overlong[idx - 1] : trimmed);
        if (padHere) this.pad(m, T, divisions, ctx, multi, nstaves);
      });
    }
  }

  measureRests(m, T, divisions, ctx) {
    for (const n of kids(m, "note")) {
      const r = find(n, "rest");
      if (r && attr(r, "measure") === "yes" && find(n, "duration")) {
        const old = dur(n);
        if (old !== T) {
          setText(find(n, "duration"), String(T));
          this.log.push({ ...ctx, fix: "measure-rest", from_ticks: tk(old, divisions), to_ticks: tk(T, divisions) });
        }
      }
    }
  }

  /** Cut what runs past the bar line. Returns true if anything changed. */
  trim(m, T, divisions, ctx) {
    const [entries] = walk(m);
    const drop = new Set();
    let deletedHeads = 0;
    let deletedRests = 0;
    const shortened = [];
    let headDropped = false;
    for (const e of entries) {
      if (e.kind === "backup") continue;
      if (e.kind === "note" && e.chord) {
        if (headDropped) {
          drop.add(e.el);
          deletedHeads += e.rest ? 0 : 1;
        }
        continue;
      }
      headDropped = false;
      const { start, dur: d } = e;
      if (start >= T && (d > 0 || e.grace)) {
        drop.add(e.el);
        headDropped = true;
        if (e.kind === "note") {
          if (e.rest) deletedRests++;
          else deletedHeads++;
        }
      } else if (start < T && T < start + d) {
        shortened.push({ el: e.el, start, old: d, new: T - start, kind: e.kind, rest: e.rest });
      }
    }
    if (!drop.size && !shortened.length) return false;
    for (const s of shortened) {
      const group = [s.el];
      let nxt = nextSibling(s.el);
      while (nxt && nxt.type === "element" && nxt.name === "note" && hasChild(nxt, "chord")) {
        group.push(nxt);
        nxt = nextSibling(nxt);
      }
      const q = new Frac(s.new, divisions);
      const rep = representable(q);
      for (const el of group) {
        setText(find(el, "duration"), String(s.new));
        if (el.name === "note" && !hasChild(el, "time-modification")) {
          if (rep) setType(el, ...rep);
          else {
            const [parts] = splitRepresentable(q);
            if (parts.length) {
              setType(el, parts[0][0], 0);
              const nd = parts[0][2].mul(divisions).trunc();
              setText(find(el, "duration"), String(nd));
              s.new = nd;
              s.note = "shortened to largest single value; remainder filled by padding";
            }
          }
        }
      }
      this.log.push({
        ...ctx, fix: "trim-shorten", what: s.kind !== "note" ? s.kind : s.rest ? "rest" : "note",
        chord_size: group.length, from_ticks: tk(s.old, divisions), to_ticks: tk(s.new, divisions),
        ...(s.note ? { note: s.note } : {}),
      });
    }
    for (const e of entries) if (drop.has(e.el)) remove(m, e.el);
    if (deletedHeads || deletedRests) {
      this.log.push({ ...ctx, fix: "trim-delete", deleted_noteheads: deletedHeads, deleted_rests: deletedRests });
    }
    return true;
  }

  /** Re-point every original <backup> at the position it originally returned to. */
  rebackup(m, targets) {
    let pos = 0;
    for (const el of [...kids(m)]) {
      if (el.name === "note") {
        if (hasChild(el, "chord") || hasChild(el, "grace")) continue;
        pos += dur(el);
      } else if (el.name === "forward") {
        pos += dur(el);
      } else if (el.name === "backup") {
        const tgt = targets.get(el);
        if (tgt === undefined) {
          pos -= dur(el);
          continue;
        }
        const d = pos - tgt;
        if (d > 0) {
          setText(find(el, "duration"), String(d));
          pos = tgt;
        } else if (d === 0) {
          remove(m, el);
        } else {
          const fw = make("forward");
          sub(fw, "duration", {}, -d);
          addPrevious(el, fw);
          remove(m, el);
          pos = tgt;
        }
      }
    }
  }

  /** Fill each staff's first voice up to the bar length with rests; give empty staves a bar rest. */
  pad(m, T, divisions, ctx, multi, nstaves) {
    let [entries, endPos] = walk(m);
    const byStaff = new Map();
    for (const e of entries) {
      if ((e.kind === "note" || e.kind === "forward") && !(e.kind === "note" && e.grace)) {
        const s = e.staff || "1";
        if (!byStaff.has(s)) byStaff.set(s, []);
        byStaff.get(s).push(e);
      }
    }
    for (let k = 1; k <= nstaves; k++) {
      if (byStaff.has(String(k))) continue;
      if (endPos !== 0) {
        const mv = make("backup");
        sub(mv, "duration", {}, endPos);
        append(m, mv);
      }
      const n = make("note");
      sub(n, "rest", { measure: "yes" });
      sub(n, "duration", {}, T);
      sub(n, "voice", {}, k === 1 ? "1" : String(4 * (k - 1) + 1));
      if (multi) sub(n, "staff", {}, k);
      append(m, n);
      endPos = T;
      this.log.push({ ...ctx, fix: "pad-empty-measure", staff: String(k) });
    }
    for (const staff of [...byStaff.keys()].sort()) {
      const es = byStaff.get(staff);
      const voices = [...new Set(es.map((e) => e.voice))].sort((a, b) => voiceKey(a) - voiceKey(b));
      const v = voices[0];
      const vend = Math.max(...es.filter((e) => e.voice === v).map((e) => e.start + e.dur));
      if (vend >= T) continue;
      const gap = T - vend;
      const [parts, rem] = splitRepresentable(new Frac(gap, divisions));
      const durs = parts.map(([, , q]) => q.mul(divisions));
      if (durs.some((x) => !x.isInt())) {
        this.warnings.push(`${ctx.part} m${ctx.measure}: cannot fill ${gap} divisions with plain rests at divisions=${divisions}`);
        continue;
      }
      if (endPos !== vend) {
        const mv = make(endPos > vend ? "backup" : "forward");
        sub(mv, "duration", {}, Math.abs(endPos - vend));
        append(m, mv);
      }
      if (rem.n !== 0) this.warnings.push(`${ctx.part} m${ctx.measure}: padding remainder ${rem} quarter not representable`);
      parts.forEach(([t, dots], j) => append(m, makeRest(durs[j].n, v, multi ? staff : null, t, dots)));
      endPos = T;
      this.log.push({ ...ctx, fix: "pad", staff, voice: v, added_ticks: tk(gap, divisions) });
    }
  }

  // ---------- tremolo ----------
  fixTremolo() {
    for (const part of kids(this.root, "part")) {
      kids(part, "measure").forEach((m, k) => {
        for (const tr of [...iter(m, "tremolo")]) {
          const note = tr.parent?.parent?.parent;
          const ty = attr(tr, "type");
          const ctx = { part: attr(part, "id"), measure: k + 1, number: attr(m, "number") };
          if (this.opts.tremolo && (ty === "start" || ty === "stop")) {
            const tm = note && find(note, "time-modification");
            if (tm && findText(tm, "actual-notes") === "2" && findText(tm, "normal-notes") === "1") {
              const tEl = find(note, "type");
              const old = tEl ? text(tEl) : null;
              if (old in HALF_OF) {
                setText(tEl, HALF_OF[old]);
                remove(note, tm);
                this.log.push({ ...ctx, fix: "tremolo-pair", type: `${old}->${HALF_OF[old]}`, removed: "time-modification 2:1" });
              }
            }
          } else if (this.opts.unmeasured && ty === "unmeasured") {
            setAttr(tr, "type", "single");
            setText(tr, "3");
            this.log.push({ ...ctx, fix: "unmeasured", to: "single 3 strokes" });
          }
        }
      });
    }
  }

  // ---------- metadata ----------
  fixMetadata() {
    const root = this.root;
    if (this.opts.abbreviations) {
      for (const sp of iter(root, "score-part")) {
        let ab = find(sp, "part-abbreviation");
        if (ab && (text(ab) ?? "").trim()) continue;
        const name = (findText(sp, "part-name") ?? "").trim();
        const val = abbreviate(name);
        if (!val) continue;
        if (!ab) {
          const anchor = find(sp, "part-name-display") ?? find(sp, "part-name");
          if (!anchor) continue;
          ab = make("part-abbreviation");
          addNext(anchor, ab);
        }
        setText(ab, val);
        this.log.push({ part: attr(sp, "id"), fix: "abbreviation", name, abbreviation: val });
      }
    }
    const comp = this.opts.composer;
    if (comp) {
      let ident = find(root, "identification");
      if (!ident) {
        ident = make("identification");
        const anchor = ["movement-title", "movement-number", "work"].map((t) => find(root, t)).find(Boolean);
        if (anchor) addNext(anchor, ident);
        else insertFirst(root, ident);
      }
      let cr = kids(ident, "creator").filter((c) => attr(c, "type") === "composer");
      if (!cr.length) {
        const c = make("creator", { type: "composer" });
        insertFirst(ident, c);
        cr = [c];
      }
      if (!(text(cr[0]) ?? "").trim()) {
        setText(cr[0], comp);
        this.log.push({ fix: "composer", value: comp });
      }
    }
  }

  run() {
    this.fixTremolo();
    this.fixMeasures();
    this.fixMetadata();
    return this.log;
  }
}

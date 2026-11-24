#!/usr/bin/env node
// Check a MusicXML import inside Sibelius over Sibelius Connect. Zero dependencies, Node 22+.
//
//   node connect.mjs status [--port N]
//       What is installed and ready: Sibelius version, whether it runs, the Connect port, the plug-in,
//       the stored import-dialog choice. Never opens a Connect connection, so no approval box appears.
//
//   node connect.mjs check --fixed FIXED.musicxml [--original ORIGINAL.musicxml] [--changes CHANGES.json]
//                          [--out DIR] [--import-dialog user-clicks|agent-clicks] [--port N] [--close]
//       Connects (Sibelius asks the user to allow it), imports the original (if given) and the fixed
//       file, reads every note back through the SibeliusImportDoctor plug-in and compares each bar
//       with the MusicXML. Then it leaves one comment in the fixed score on every bar the doctor
//       changed or could not fix (from CHANGES.json, format at loadChanges below), every bar that
//       still differs from the original, and every bar Sibelius did not import as the fixed file
//       says, each in plain words. It saves <fixed name>.checked.sib and <fixed name>.sibelius-check.json
//       in DIR (default: next to the fixed file) and leaves the checked score open unless --close.
//
// Output: one JSON object per line on stdout. Lines with "event":"waiting" mean a person has to act in
// Sibelius now ("for":"approval" = click Yes on the connection box, "for":"import-ok" = click OK on the
// import options box). The last line is "event":"done" (exit 0) or "event":"error" (exit 1).
// Progress for people goes to stderr. Details: ../references/connect.md
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { execFile, execFileSync, spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { getSetting } from "./config.mjs";
import { InputError, meterTicks, readScore as readMusicXml, TimewiseError, TICKS_PER_QUARTER as TICKS } from "./lib/score.mjs";
import { attr, find as kid, findText, iter, kids } from "./lib/xml.mjs";
import { PLUGIN_NAME, PLUGIN_VERSION, compareVersions, pluginStatus, sibeliusRunning } from "./plugin/install.mjs";

const TESTED = { year: 26, month: 11, label: "26.11" };
const CLIENT_NAME = "Sibelius Import Doctor";
const MAX_COMMENTS = 300;
const IMPORT_BOX = "Open MusicXML File";
const SCHEMA_BOX = "MusicXML format warning";

const emit = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const say = (s) => process.stderr.write(s + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const debug = (s) => { if (process.env.SIBELIUS_IMPORT_DOCTOR_DEBUG) process.stderr.write(`[${new Date().toISOString()}] ${s}\n`); };

class Fail extends Error {
  constructor(code, message, hint) {
    super(message);
    this.code = code;
    this.hint = hint;
  }
}

// ---------------------------------------------------------------- MusicXML reading

const kidText = (el, name) => findText(el, name)?.trim() ?? null;

export function loadScore(file) {
  try {
    return readMusicXml(file).doc.root;
  } catch (error) {
    if (error instanceof TimewiseError) throw new Fail("unsupported-musicxml", error.message);
    if (error instanceof InputError) throw new Fail("bad-musicxml", error.message);
    throw error;
  }
}

// ---------------------------------------------------------------- MusicXML analysis

function tremoloKinds(note) {
  const out = [];
  for (const el of iter(note, "tremolo")) out.push(attr(el, "type") || "single");
  return out;
}

function measureFacts(m, st) {
  // partTrem: tremolos of the whole part, one per voice and onset, so a chord spread over two staves
  // (cross-staff notation) counts once, as Sibelius shows it.
  // tuplets: onsets of notes the file puts in a tuplet (<time-modification>), one per voice and onset.
  const f = { number: attr(m, "number") ?? "", implicit: attr(m, "implicit") === "yes", heads: {}, graceHeads: 0, partTrem: { single: new Set(), double: new Set() }, tuplets: new Set(), fill: 0 };
  let pos = 0, lastStart = 0, lastVoice = "1";
  for (const el of kids(m)) {
    if (el.name === "attributes") {
      const d = kidText(el, "divisions"); if (d) st.divisions = Number(d);
      const n = kidText(el, "staves"); if (n) st.staves = Math.max(st.staves, Number(n));
      const t = kid(el, "time");
      const meter = t && meterTicks(t);
      if (meter) st.expected = meter.n / meter.d;
    } else if (el.name === "backup" || el.name === "forward") {
      const d = (Number(kidText(el, "duration")) || 0) * TICKS / st.divisions;
      pos += el.name === "backup" ? -d : d;
      f.fill = Math.max(f.fill, pos);
    } else if (el.name === "note") {
      const isChord = !!kid(el, "chord"), isGrace = !!kid(el, "grace"), isRest = !!kid(el, "rest");
      // Chord members often omit <voice>; they belong to the voice of the chord's first note.
      const staff = kidText(el, "staff") || "1", voice = kidText(el, "voice") || (isChord ? lastVoice : "1");
      if (!isChord) lastVoice = voice;
      const d = isGrace ? 0 : (Number(kidText(el, "duration")) || 0) * TICKS / st.divisions;
      const start = isChord ? lastStart : pos;
      if (!isChord) { lastStart = pos; pos += d; f.fill = Math.max(f.fill, pos); }
      if (isRest) continue;
      f.heads[staff] = (f.heads[staff] || 0) + 1;
      if (isGrace) f.graceHeads += 1;
      if (!isGrace && kid(el, "time-modification")) f.tuplets.add(`${voice}@${start}`);
      for (const kind of tremoloKinds(el)) {
        const set = kind === "single" || kind === "unmeasured" ? f.partTrem.single : kind === "start" ? f.partTrem.double : null;
        if (set) set.add(`${voice}@${start}@${isGrace}`);
      }
    }
  }
  f.expected = Math.round(st.expected);
  return f;
}

// Staves in Sibelius order, each with per-bar facts; plus per-bar intended lengths.
export function analyseScore(root) {
  const order = [];
  const names = {};
  const partList = kid(root, "part-list");
  for (const sp of partList ? kids(partList, "score-part") : []) { order.push(attr(sp, "id")); names[attr(sp, "id")] = kidText(sp, "part-name") || ""; }
  const parts = new Map(kids(root, "part").map((p) => [attr(p, "id"), p]));
  for (const id of parts.keys()) if (!order.includes(id)) order.push(id);
  const staves = [];
  const partsOut = [];
  let bars = null;
  for (const id of order) {
    const part = parts.get(id);
    if (!part) continue;
    const st = { divisions: 1, expected: 4 * TICKS, staves: 1 };
    const facts = kids(part, "measure").map((m) => measureFacts(m, st));
    if (!bars) bars = facts.map((f) => ({ number: f.number, expected: f.expected, implicit: f.implicit, fill: 0 }));
    facts.forEach((f, i) => { if (bars[i]) bars[i].fill = Math.max(bars[i].fill, f.fill); });
    const first = staves.length + 1;
    for (let k = 1; k <= st.staves; k++) {
      staves.push({ part: id, name: names[id] || id, staffInPart: k, bars: facts.map((f) => ({ heads: f.heads[String(k)] || 0 })) });
    }
    partsOut.push({
      id,
      name: names[id] || id,
      staves: Array.from({ length: st.staves }, (_, k) => first + k),
      bars: facts.map((f) => ({
        heads: Object.values(f.heads).reduce((a, n) => a + n, 0),
        graceHeads: f.graceHeads,
        single: f.partTrem.single.size,
        double: f.partTrem.double.size,
        tuplets: f.tuplets.size,
        fill: Math.round(f.fill),
      })),
    });
  }
  // Some exporters omit the pickup flag. A shared short opening, or a closing bar that
  // completes that opening in the same meter, can have its own length.
  const first = bars?.[0];
  const lastIndex = (bars?.length ?? 0) - 1;
  const agreedShort = (b, i) => {
    const fill = Math.round(b.fill);
    return fill > 0 && fill < b.expected && partsOut.every((p) => p.bars[i]?.fill === fill);
  };
  const pickup = first && (first.implicit || (lastIndex > 0 && agreedShort(first, 0)));
  for (const [i, b] of (bars || []).entries()) {
    const fill = Math.round(b.fill);
    const closesPickup = pickup && i > 0 && i === lastIndex && b.expected === first.expected &&
      fill + Math.round(first.fill) === b.expected && agreedShort(b, i);
    b.intended = b.implicit || (i === 0 && pickup) || closesPickup ? fill : Math.max(b.expected, fill);
  }
  return { staves, parts: partsOut, bars: bars || [] };
}

// ---------------------------------------------------------------- Sibelius readback analysis

// ReadNotes rows: [staff, bar, pos, dur, voice, noteCount, tupletLeft, tupletRight, doubleTrem, singleTrem, grace]
export function analyseReadback(rows, barLengths) {
  const cells = new Map();
  const ends = new Map();
  for (const r of rows) {
    const [s, b, pos, dur, voice, count, tl, tr, dtrem, strem, grace] = r;
    const key = `${s}:${b}`;
    const c = cells.get(key) || { heads: 0, graceHeads: 0, single: 0, double: 0, doubleInTuplet: 0, tuplets: 0, tupletGroups: 0 };
    c.heads += count;
    if (grace) c.graceHeads += count;
    if (tl && !grace) {
      if (count > 0) c.tuplets += 1;
      c.tupletGroups += 1 / tl; // a 3:2 group of three note-rests adds up to one group
    }
    if (count > 0 && strem) c.single += 1;
    if (dtrem > 0) { c.double += 1; if (tl) c.doubleInTuplet += 1; }
    cells.set(key, c);
    if (!grace) {
      const end = pos + (tl ? (dur * tr) / tl : dur);
      const vk = `${key}:${voice}`;
      ends.set(vk, Math.max(ends.get(vk) || 0, end));
    }
  }
  const overflow = new Map();
  for (const [vk, end] of ends) {
    const [s, b, v] = vk.split(":").map(Number);
    if (end > (barLengths[b - 1] ?? Infinity) + 0.5) {
      const key = `${s}:${b}`;
      overflow.set(key, [...(overflow.get(key) || []), v]);
    }
  }
  return { cells, overflow };
}

const quarters = (ticks) => {
  const q = ticks / TICKS;
  return Number.isInteger(q) ? String(q) : q.toFixed(2).replace(/0+$/, "");
};

function plural(n, word) { return `${n} ${word}${n === 1 ? "" : "s"}`; }

// Every finding carries a short form (what and how much, for the comment), an explanation (said once
// per part and kind in the comments) and the full text for the details JSON.
function finding(at, kind, short, explain) {
  return { ...at, kind, short, explain, text: explain ? `${short}: ${explain}` : short };
}

const counts = (file, sib, whole, fileWord = "file") => `(${fileWord} ${file}, Sibelius ${sib}${whole ? ", all staves of the part" : ""})`;

// Notes and tremolos are compared per part and bar, summed over the part's staves: Sibelius may put a
// note on another staff of the same part than the file's <staff> says (cross-staff notation in piano,
// harp or accordion parts), which is not a loss. Such moves are only counted (movedBetweenStaves).
// A part-level difference is reported on the staff of the part where it shows most.
function partCell(cells, part, b) {
  const per = part.staves.map((s) => ({ s, c: cells.get(`${s}:${b}`) || { heads: 0, graceHeads: 0, single: 0, double: 0, doubleInTuplet: 0, tuplets: 0, tupletGroups: 0 } }));
  const sum = (k) => per.reduce((a, x) => a + x.c[k], 0);
  return { per, heads: sum("heads"), graceHeads: sum("graceHeads"), single: sum("single"), double: sum("double"), tuplets: sum("tuplets") };
}

function staffDiffs(xml, part, per, b) {
  return per.map(({ s, c }) => ({ s, d: c.heads - xml.staves[s - 1].bars[b - 1].heads }));
}

function pickStaff(diffs, sign) {
  let best = diffs[0];
  for (const x of diffs) if (sign * x.d > sign * best.d) best = x;
  return best.s;
}

// Bar length. Sibelius counts in whole ticks (256 per quarter), so a tuplet can come out up to a tick
// longer or shorter than its exact value: a difference of at most one tick per tuplet group in the bar
// is rounding, not a problem. A note the file puts in a tuplet but Sibelius shows as a plain note
// (tuplet lost) lengthens the bar by far more, e.g. 128 - 85.33 ticks for a triplet eighth; that is
// reported as such. Any other difference is reported as a bar-length problem (e.g. notes past the
// bar line that Sibelius kept by making the bar longer).
function tupletRounding(cells, nStaves, b) {
  let groups = 0;
  for (let s = 1; s <= nStaves; s++) groups += (cells.get(`${s}:${b}`) || { tupletGroups: 0 }).tupletGroups;
  return Math.ceil(groups - 1e-9);
}

function barLengthShort(sib, intended) {
  return `bar lasts ${quarters(sib)} quarters in Sibelius (file ${quarters(intended)})`;
}

function barLengthExplain(sib, intended) {
  return sib < intended ? "Sibelius cut the bar; compare the rhythm with the original" : "Sibelius lengthened the bar; compare the rhythm with the original";
}

// The staves a bar-length difference belongs to: parts whose music in the file reaches the length the
// bar should have (they set it) when that differs from the time signature; otherwise parts whose music
// in Sibelius ends somewhere other than the file's bar end; otherwise the first staff with notes.
function barLengthStaves(xml, cells, overflow, b, bar) {
  const setters = xml.parts.filter((p) => p.bars[b - 1] && p.bars[b - 1].fill === bar.intended && bar.intended !== bar.expected);
  if (setters.length) return setters.map((p) => ({ staff: p.staves[0], part: p.name }));
  const spill = xml.parts.filter((p) => p.staves.some((s) => overflow.has(`${s}:${b}`)));
  if (spill.length) return spill.map((p) => ({ staff: p.staves.find((s) => overflow.has(`${s}:${b}`)), part: p.name }));
  const withNotes = xml.parts.find((p) => p.staves.some((s) => (cells.get(`${s}:${b}`) || { heads: 0 }).heads > 0));
  const p = withNotes || xml.parts[0];
  return p ? [{ staff: p.staves.find((s) => (cells.get(`${s}:${b}`) || { heads: 0 }).heads > 0) || p.staves[0], part: p.name }] : [{ staff: 1, part: null }];
}

// Compare one imported file with its MusicXML. Returns totals and a list of bars that look wrong.
export function compare(xml, info, rows, barLengths) {
  const { cells, overflow } = analyseReadback(rows, barLengths);
  const structure = { xmlStaves: xml.staves.length, sibeliusStaves: info.staffCount, xmlBars: xml.bars.length, sibeliusBars: barLengths.length };
  const staffMatch = structure.xmlStaves === structure.sibeliusStaves;
  const problems = [];
  let xmlNotes = 0, sibNotes = 0, lost = 0, gained = 0, moved = 0, roundedBars = 0;
  for (const st of xml.staves) for (const b of st.bars) xmlNotes += b.heads;
  for (const c of cells.values()) sibNotes += c.heads;
  const nBars = Math.max(xml.bars.length, barLengths.length);
  for (let b = 1; b <= nBars; b++) {
    const bar = xml.bars[b - 1];
    const label = bar ? bar.number : String(b);
    const sibLen = barLengths[b - 1];
    const lengthOff = bar && sibLen !== undefined && Math.abs(sibLen - bar.intended) > tupletRounding(cells, info.staffCount, b);
    let lengthExplained = false;
    if (bar && sibLen !== undefined && sibLen !== bar.intended && !lengthOff) roundedBars += 1;
    if (staffMatch && bar) for (const part of xml.parts) {
      const want = part.bars[b - 1] || { heads: 0, graceHeads: 0, single: 0, double: 0 };
      const got = partCell(cells, part, b);
      const diffs = staffDiffs(xml, part, got.per, b);
      const short = diffs.reduce((a, x) => a + Math.max(0, -x.d), 0), extra = diffs.reduce((a, x) => a + Math.max(0, x.d), 0);
      moved += Math.min(short, extra);
      const at = (sign) => ({ staff: pickStaff(diffs, sign), bar: b, measure: label, part: part.name });
      const whole = part.staves.length > 1;
      if (got.heads < want.heads) {
        const n = want.heads - got.heads;
        lost += n;
        const graceLost = want.graceHeads - got.graceHeads === n;
        const noun = graceLost ? "grace note" : "note";
        const displayCounts = graceLost
          ? counts(want.graceHeads, got.graceHeads, whole)
          : counts(want.heads, got.heads, whole);
        problems.push({ ...finding(at(-1), "notes-missing", `${plural(n, noun)} missing ${displayCounts}`, "lost on import"), file: want.heads, sib: got.heads });
      }
      if (got.heads > want.heads) { const n = got.heads - want.heads; gained += n; problems.push({ ...finding(at(1), "notes-extra", `${plural(n, "extra note")} ${counts(want.heads, got.heads, whole)}`, "added on import"), file: want.heads, sib: got.heads }); }
      if (got.single < want.single) problems.push(finding(at(-1), "tremolo-missing", `${plural(want.single - got.single, "tremolo")} missing`, "lost on import"));
      if (got.double < want.double) problems.push(finding(at(-1), "two-note-tremolo-missing", `${plural(want.double - got.double, "two-note tremolo")} missing`, "lost on import"));
      if (got.tuplets < (want.tuplets || 0)) {
        const n = want.tuplets - got.tuplets;
        let short = `tuplet lost (${plural(n, "note")})`;
        if (lengthOff && !lengthExplained) { short += `, ${barLengthShort(sibLen, bar.intended).replace(" in Sibelius", "")}`; lengthExplained = true; }
        const tupStaff = got.per.reduce((best, x) => (x.c.tuplets < best.c.tuplets ? x : best), got.per[0]).s;
        problems.push(finding({ staff: tupStaff, bar: b, measure: label, part: part.name }, "tuplet-lost", short, "plain notes in Sibelius, rhythm off"));
      }
      for (const { s, c } of got.per) {
        const cell = { staff: s, bar: b, measure: label, part: part.name };
        if (c.doubleInTuplet > 0) problems.push(finding(cell, "two-note-tremolo-in-tuplet", "two-note tremolo inside a tuplet", "may show as double whole notes"));
        const voices = overflow.get(`${s}:${b}`);
        if (voices) problems.push(finding(cell, "voice-overflow", `voice ${voices.join(" and ")} runs past the bar line`, "too many beats"));
      }
    }
    if (lengthOff && !lengthExplained) {
      for (const at of barLengthStaves(xml, cells, overflow, b, bar)) problems.push(finding({ ...at, bar: b, measure: label }, "bar-length", barLengthShort(sibLen, bar.intended), barLengthExplain(sibLen, bar.intended)));
    }
  }
  // What Sibelius holds in bars with a length or tuplet problem, kept in the details for diagnosis.
  const flagged = new Set(problems.filter((p) => p.kind === "bar-length" || p.kind === "tuplet-lost").map((p) => p.bar));
  const evidence = {};
  for (const b of [...flagged].slice(0, 20)) evidence[b] = { barLength: barLengths[b - 1], rows: rows.filter((r) => r[1] === b) };
  return { structure, staffMatch, xmlNotes, sibeliusNotes: sibNotes, lost, gained, movedBetweenStaves: moved, barLengthWithinTupletRounding: roundedBars, problems, evidence, cells: { staffCount: info.staffCount, map: cells } };
}

// Bars of the fixed import whose note count differs from the user's original file, per part and bar
// (like compare). Only meaningful when both files have the same staves and bars.
export function compareToOriginal(orig, cells, nSibBars) {
  const out = [];
  if (!orig) return { compared: false, reason: "no original given", bars: out };
  if (orig.staves.length !== cells.staffCount || orig.bars.length !== nSibBars) {
    return { compared: false, reason: "the original and the fixed score have different staves or bar counts", bars: out };
  }
  for (const part of orig.parts) {
    part.bars.forEach((want, j) => {
      const got = partCell(cells.map, part, j + 1);
      if (got.heads === want.heads) return;
      const diff = want.heads - got.heads;
      const staff = pickStaff(staffDiffs(orig, part, got.per, j + 1), diff > 0 ? -1 : 1);
      const short = `${plural(Math.abs(diff), "note")} ${diff > 0 ? "missing" : "more"} ${counts(want.heads, got.heads, part.staves.length > 1, "your file")}`;
      out.push({ ...finding({ staff, bar: j + 1, measure: orig.bars[j].number, part: part.name }, "differs-from-original", short, "compare this bar with your file"), file: want.heads, sib: got.heads });
    });
  }
  return { compared: true, bars: out };
}

// What the doctor changed and what it could not fix. Two accepted shapes:
// 1. The doctor's own <name>.report.json (its "log" of changes and its "found" list with fixed: false).
// 2. A plain list:
//    {"changed": [{"part": "P1", "measure": "12", "text": "notes past the bar line were removed"}],
//     "unfixed": [{"part": "P2", "measure": "30", "staff": 2, "text": "this bar is still too long"}]}
//    part: MusicXML part id (or part name); measure: the number printed in the file, or measureIndex
//    (1-based position) instead; staff: staff inside the part, default 1; "harmless": true for a change
//    that leaves every note and tremolo as it was (it gets no comment).
// Only changes to notes or tremolos get a comment. Rest-only normalisations (whole-bar rest set to the
// bar length, rests added to fill a bar) are harmless: counted, never commented.
const HARMLESS_FIXES = new Set(["measure-rest", "pad", "pad-empty-measure"]);
const HARMLESS_UNFIXED = new Set(["overlong-rest"]);
// Short form and one-time explanation of each doctor change and each problem it could not fix.
const FIX_TEXT = {
  "trim-delete": ["note past the bar line removed", "compare with the original", 2],
  "trim-shorten": ["note shortened to end at the bar line", "compare with the original", 2],
  "tremolo-pair": ["two-note tremolo rewritten", "so Sibelius draws it correctly"],
  unmeasured: ["unmeasured tremolo rewritten as three strokes", "Sibelius would have dropped it"],
};
const UNFIXED_TEXT = {
  "overlong-bar": ["music longer than the bar", "not fixed; Sibelius may cut the end", 3],
  "two-note-tremolo": ["two-note tremolo not fixed", "Sibelius may draw it as double whole notes", 2],
  "two-note-tremolo-unusual": ["unusual two-note tremolo left as is", "check how Sibelius draws it", 2],
  "unmeasured-tremolo": ["unmeasured tremolo left as is", "Sibelius may drop it", 2],
};

function fromDoctorReport(raw) {
  const changed = [];
  let harmless = 0;
  for (const c of raw.log) {
    if (HARMLESS_FIXES.has(c.fix)) { harmless += 1; continue; }
    if (!FIX_TEXT[c.fix] || !c.measure) continue;
    let [short, explain, level] = FIX_TEXT[c.fix];
    if (c.fix === "trim-delete" && c.deleted_noteheads > 1) short = `${c.deleted_noteheads} notes past the bar line removed`;
    changed.push({ part: c.part, measureIndex: c.measure, staff: Number(c.staff) || 1, kind: c.fix, short, explain, level, text: `${short}: ${explain}` });
  }
  const unfixed = [];
  for (const p of raw.found || []) {
    if (p.fixed || !p.where || HARMLESS_UNFIXED.has(p.kind)) continue;
    const [short, explain, level] = UNFIXED_TEXT[p.kind] || [`${String(p.kind).replace(/-/g, " ")} not fixed`, "", 2];
    for (const w of p.where) for (const bar of w.bars || []) unfixed.push({ part: w.part_id ?? w.part, measure: bar, staff: 1, kind: p.kind, short, explain, level, text: explain ? `${short}: ${explain}` : short });
  }
  return { changed, unfixed, harmless, attention: attentionItems(raw) };
}

// Bars the doctor tells the user to look at (its needs_attention list) are always commented, at
// level 2, even where the change itself was harmless (an overlong bar kept long by padding with rests).
// A finding listed here replaces the doctor's level-1 change of the same bar ("supersedes").
const ATTENTION_TEXT = {
  "bars-longer-than-time-signature": ["bar longer than the time signature", "one note value is probably wrong; compare with the original", []],
  "notes-removed": ["notes past the bar line removed", "compare with the original", ["trim-delete"]],
};
const ATTENTION_COVERED = new Set(["notes-shortened", "unusual-tremolo", "composer-unknown", "short-names-missing"]);

function attentionItems(raw) {
  const out = [];
  const overlongParts = new Map(); // printed bar number -> part ids the doctor found running long there
  for (const p of raw.found || []) {
    if (p.kind !== "overlong-bar" || !p.where) continue;
    for (const w of p.where) for (const bar of w.bars || []) overlongParts.set(String(bar), [...(overlongParts.get(String(bar)) || []), w.part_id ?? w.part]);
  }
  for (const a of raw.needs_attention || []) {
    if (ATTENTION_COVERED.has(a.kind)) continue;
    const [short, explain, supersedes] = ATTENTION_TEXT[a.kind] || [String(a.kind).replace(/-/g, " "), "see the report", []];
    const base = { kind: a.kind, short, explain, level: 2, supersedes, text: a.message || short };
    for (const w of a.where || []) for (const bar of w.bars || []) out.push({ ...base, part: w.part_id ?? w.part, measure: bar, staff: 1 });
    for (const bar of a.bars || []) {
      const parts = overlongParts.get(String(bar)) || [null];
      for (const part of parts) out.push({ ...base, part, measure: bar, staff: 1 });
    }
  }
  return out;
}

const LIST_KEYS = { changed: ["changed", "changes", "fixed", "fixes"], unfixed: ["unfixed", "notFixed", "not_fixed", "remaining"] };

export function loadChanges(file) {
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  if (Array.isArray(raw.log)) return fromDoctorReport(raw);
  const pick = (keys) => { for (const k of keys) if (Array.isArray(raw[k])) return raw[k]; return []; };
  const all = [...pick(LIST_KEYS.changed), ...pick(LIST_KEYS.unfixed)];
  const norm = (e) => ({
    part: e.part ?? e.partId ?? e.part_id ?? null,
    measure: e.measure ?? e.bar ?? e.measureNumber ?? null,
    measureIndex: e.measureIndex ?? e.index ?? null,
    staff: Number(e.staff ?? 1) || 1,
    text: String(e.text ?? e.summary ?? e.description ?? e.what ?? "").trim(),
    level: [1, 2, 3].includes(e.level) ? e.level : undefined,
  });
  const keep = (list) => list.filter((e) => !e.harmless).map(norm);
  return { changed: keep(pick(LIST_KEYS.changed)), unfixed: keep(pick(LIST_KEYS.unfixed)), harmless: all.filter((e) => e.harmless).length, attention: [] };
}

// A null part means "the whole score" and lands on the first staff.
export function locate(xml, e) {
  const staffIdx = e.part == null ? 0 : xml.staves.findIndex((s) => (s.part === e.part || s.name === e.part) && s.staffInPart === e.staff);
  let bar = e.measureIndex ? Number(e.measureIndex) : xml.bars.findIndex((b) => String(b.number) === String(e.measure)) + 1;
  if (staffIdx < 0 || !(bar >= 1 && bar <= xml.bars.length)) return null;
  return { staff: staffIdx + 1, bar, measure: xml.bars[bar - 1].number, part: xml.staves[staffIdx].name };
}

// Severity of each finding: 1 = changed, nothing to do; 2 = please check; 3 = serious (music lost or
// added that the doctor could not fix). A comment takes the highest level of its findings.
const LEVEL = {
  changed: 1,
  unfixed: 2,
  "differs-from-original": 2,
  "notes-missing": 3,
  "notes-extra": 3,
  "tremolo-missing": 2,
  "two-note-tremolo-missing": 2,
  "two-note-tremolo-in-tuplet": 2,
  "voice-overflow": 2,
  "tuplet-lost": 2,
  "bar-length": 2,
};
export function levelOf(it) {
  if (it.source === "changed") return it.level || 1;
  if (it.source === "unfixed" || it.source === "attention") return it.level || 2;
  return LEVEL[it.kind] || 2;
}

// Comment background colours per level, as 24-bit RGB (red * 65536 + green * 256 + blue), the format
// ManuScript uses for colours: grey-green, amber, red.
export const LEVEL_COLOR = { 1: 0xc8dcc8, 2: 0xffc864, 3: 0xff7a7a };

// One comment per staff and bar, shortest wording first. Inside a part, the first finding of a kind
// gets its explanation; later ones of the same kind say "same: ..." with only the short form.
// Only serious comments are created maximised.
// The same finding (same kind and wording) in the same bar in several parts becomes one finding on
// the topmost of those staves, naming how many parts and the first few of them.
const NAMES_SHOWN = 3;

export function aggregateAcrossParts(items) {
  const groups = new Map();
  const out = [];
  for (const it of items) {
    const key = `${it.bar}|${it.source || "import"}|${it.kind || ""}|${it.short || it.text}`;
    const g = groups.get(key);
    if (g) g.push(it);
    else { const list = [it]; groups.set(key, list); out.push(list); }
  }
  return out.map((list) => {
    const parts = [...new Set(list.map((it) => it.part ?? ""))];
    if (parts.length < 2) return list;
    const top = list.reduce((a, b) => (b.staff < a.staff ? b : a));
    const shown = parts.slice(0, NAMES_SHOWN).join(", ") + (parts.length > NAMES_SHOWN ? `, +${parts.length - NAMES_SHOWN} more` : "");
    return [{ ...top, part: "*", parts, short: `${top.short || top.text} in ${parts.length} parts (${shown})`, sameKey: `${top.source}|${top.kind || top.short}|parts` }];
  }).flat();
}

export function buildComments(items) {
  const byCell = new Map();
  for (const it of aggregateAcrossParts(items)) {
    const key = `${it.staff}:${it.bar}`;
    const g = byCell.get(key) || { staff: it.staff, bar: it.bar, measure: it.measure, part: it.part, parts: new Set(), findings: new Map() };
    for (const name of it.parts || [it.part]) if (name && name !== "*") g.parts.add(name);
    const fk = `${it.source}|${it.kind || ""}|${it.short || it.text}`;
    const f = g.findings.get(fk) || { ...it, source: it.source || "import", short: it.short || it.text, count: 0, level: levelOf(it) };
    f.count += it.count || 1;
    g.findings.set(fk, f);
    byCell.set(key, g);
  }
  const seen = new Set();
  return [...byCell.values()]
    .sort((a, b) => a.bar - b.bar || a.staff - b.staff)
    .map((g) => {
      // A note count against the user's file that says the same as the import finding is dropped.
      const all = [...g.findings.values()];
      const importCounts = all.filter((f) => f.kind === "notes-missing" || f.kind === "notes-extra");
      const superseded = new Set(all.flatMap((f) => f.supersedes || []));
      const findings = all
        .filter((f) => !(f.kind === "differs-from-original" && importCounts.some((x) => x.file === f.file && x.sib === f.sib)))
        .filter((f) => !(f.source === "changed" && superseded.has(f.kind)))
        .sort((a, b) => b.level - a.level);
      const level = Math.max(...findings.map((f) => f.level));
      const parts = findings.map((f) => {
        const short = f.count > 1 && !/^\d/.test(f.short) ? `${f.count} × ${f.short}` : f.short;
        const kindKey = f.sameKey || `${f.part}|${f.source}|${f.kind || f.short}`;
        if (seen.has(kindKey)) return `same: ${short}`;
        seen.add(kindKey);
        return f.explain ? `${short}: ${f.explain}` : short;
      });
      return {
        staff: g.staff, bar: g.bar, measure: g.measure, part: [...g.parts][0] ?? null, parts: [...g.parts], level,
        needsEyes: level >= 2,
        kinds: findings.map((f) => f.kind || f.source),
        color: LEVEL_COLOR[level],
        text: parts.join("; "),
      };
    });
}

// ---------------------------------------------------------------- Sibelius on this computer

function macAppPath() {
  const home = process.env.HOME || "";
  for (const p of ["/Applications/Sibelius.app", path.join(home, "Applications", "Sibelius.app")]) if (fs.existsSync(p)) return p;
  try {
    const found = execFileSync("mdfind", ["kMDItemCFBundleIdentifier == 'com.avid.sibelius'"], { encoding: "utf8" }).split("\n").filter(Boolean);
    return found[0] || null;
  } catch {
    return null;
  }
}

function winExePath() {
  const roots = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]].filter(Boolean);
  for (const r of roots) { const p = path.join(r, "Avid", "Sibelius", "Sibelius.exe"); if (fs.existsSync(p)) return p; }
  return null;
}

export function sibeliusInstall() {
  let appPath = null, version = null;
  try {
    if (process.platform === "darwin") {
      appPath = macAppPath();
      if (appPath) version = execFileSync("plutil", ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", path.join(appPath, "Contents", "Info.plist")], { encoding: "utf8" }).trim();
    } else if (process.platform === "win32") {
      appPath = winExePath();
      if (appPath) version = execFileSync("powershell", ["-NoProfile", "-Command", `(Get-Item '${appPath.replace(/'/g, "''")}').VersionInfo.ProductVersion`], { encoding: "utf8" }).trim();
    }
  } catch {}
  const m = version && /^(\d+)\.(\d+)/.exec(version);
  let older = null, label = null;
  if (m) {
    const year = Number(m[1]) >= 2000 ? Number(m[1]) - 2000 : Number(m[1]);
    const month = Number(m[2]);
    label = `${year}.${month}`;
    older = year < TESTED.year || (year === TESTED.year && month < TESTED.month);
  }
  return { installed: !!appPath, path: appPath, version, release: label, testedRelease: TESTED.label, olderThanTested: older };
}

function portOpen(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port });
    const done = (v) => { s.destroy(); resolve(v); };
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
    s.setTimeout(1500, () => done(false));
  });
}

async function status(port) {
  const install = sibeliusInstall();
  const running = sibeliusRunning();
  const open = running ? await portOpen(port) : false;
  return {
    event: "status",
    platform: process.platform,
    node: process.versions.node,
    sibelius: { ...install, running },
    connect: { port, listening: open },
    plugin: pluginStatus(),
    importDialog: getSetting("importDialog"),
    ready: install.installed && running && open && pluginStatus().current,
  };
}

function launchSibelius(appPath) {
  if (process.platform === "darwin") spawn("open", ["-b", "com.avid.sibelius"], { detached: true, stdio: "ignore" }).unref();
  else if (process.platform === "win32" && appPath) spawn(appPath, [], { detached: true, stdio: "ignore" }).unref();
  else throw new Fail("no-sibelius", "Sibelius is not installed on this computer.");
}

// ---------------------------------------------------------------- Connect session

export class Session {
  constructor(port, Socket = WebSocket) {
    this.port = port;
    this.Socket = Socket;
    this.ws = null;
    this.pending = null;
    this.broken = null;
  }

  // One attempt: resolves "ok" | "starting" | "busy" | "denied" | "refused"; never rejects.
  attempt(approvalMs) {
    return new Promise((resolve) => {
      let settled = false, accepted = false, opened = 0, waitingTimer = null, giveUp = null;
      const ws = new this.Socket(`ws://127.0.0.1:${this.port}`);
      const finish = (result) => {
        if (settled) return;
        settled = true;
        accepted = result === "ok";
        clearTimeout(waitingTimer);
        clearTimeout(giveUp);
        if (!accepted) { try { ws.close(); } catch {} }
        resolve(result);
      };
      ws.onopen = () => {
        opened = Date.now();
        ws.send(JSON.stringify({ message: "connect", clientName: CLIENT_NAME, handshakeVersion: "1.0", plugins: [PLUGIN_NAME] }));
        waitingTimer = setTimeout(() => { if (this.askedApproval) return; this.askedApproval = true; emit({ event: "waiting", for: "approval", say: `Sibelius is asking whether to allow "${CLIENT_NAME}" to connect. Please click Yes in Sibelius.` }); say("Waiting for you to click Yes in Sibelius..."); }, 1500);
        giveUp = setTimeout(() => finish("timeout"), approvalMs);
      };
      ws.onmessage = (e) => {
        debug(`<- ${String(e.data).slice(0, 300)}`);
        let j; try { j = JSON.parse(String(e.data)); } catch { return; }
        if (!settled) {
          if (j.message === "connectResponse") finish(j.result ? "ok" : "denied");
          else if (j.message === "busyError") finish("busy");
          return;
        }
        this.onMessage(j);
      };
      ws.onerror = () => {};
      ws.onclose = (e) => {
        debug(`close code=${e.code} reason=${e.reason || "-"} afterOpenMs=${opened ? Date.now() - opened : "never opened"}`);
        // Only a close whose reason says rejected (kClientRejected_*) is a refusal; any other close
        // before an answer means Sibelius is not ready yet, and the caller retries.
        if (!settled) finish(!opened ? "refused" : /reject/i.test(e.reason || "") ? "denied" : "starting");
        else if (accepted) this.onClose(e);
      };
      this.ws = ws;
    });
  }

  // startupMs bounds the retries for "not ready yet" (refused, closed, busy): 3 minutes, or 5 when this
  // run has just launched Sibelius.
  // A rejection or busyError while Sibelius shows a box of its own (Missing Fonts, file recovery after
  // a crash, a leftover connection box) is not the user's No: report the box and keep trying.
  async connect({ approvalMs = Number(process.env.SIBELIUS_IMPORT_DOCTOR_APPROVAL_SECONDS || 300) * 1000, startupMs = 180000, mode = "user-clicks" } = {}) {
    const t0 = Date.now();
    let busyNoted = false, boxSince = 0;
    for (;;) {
      const r = await this.attempt(approvalMs);
      if (r === "ok") return;
      if (r === "denied" || r === "busy") {
        const handled = await handleOpenBoxes(mode);
        if (handled) {
          boxSince ||= Date.now();
          if (Date.now() - boxSince > approvalMs) throw new Fail("sibelius-busy", `Sibelius kept showing a box (${handled}).`, "Ask the user to close the box in Sibelius, then run again.");
          await sleep(3000);
          continue;
        }
      }
      if (r === "denied") throw new Fail("not-allowed", "Sibelius did not allow the connection (No was clicked, or another Sibelius box was in the way).", "Ask the user whether they clicked No. If Sibelius was showing another box (for example Missing Fonts), close it and run again; otherwise ask whether to try again, then they click Yes.");
      if (r === "timeout") throw new Fail("approval-timeout", "Nobody answered Sibelius' connection box in time.", "The box stays open in Sibelius. Ask the user to click No on it, then run the check again and click Yes on the new box.");
      if (Date.now() - t0 > startupMs) {
        if (r === "busy") throw new Fail("sibelius-busy", "Sibelius is busy: a dialog box is open, often a connection box left over from an earlier attempt.", "Ask the user to close any open dialog in Sibelius (for a leftover connection box, click No), then run again.");
        throw new Fail("no-connect", "Could not reach Sibelius Connect.", "Make sure Sibelius is open and finished starting, and that Preferences > Input Devices > Sibelius Connect allows remote control on this port.");
      }
      if (r === "busy" && !busyNoted) { busyNoted = true; emit({ event: "waiting", for: "sibelius-busy", say: "Sibelius has a dialog box open. Please close it; if it is an old box asking to allow a connection, click No (a new one will follow)." }); }
      if (r === "starting") say("Sibelius is still starting; retrying...");
      await sleep(3000);
    }
  }

  onMessage(j) {
    const p = this.pending;
    if (!p) return;
    if (j.message === p.expect || j.message === "messageProcessingError" || j.message === "busyError") { this.pending = null; clearTimeout(p.timer); p.resolve(j); }
  }

  onClose(e) {
    this.broken = `closed (${e.code})`;
    const p = this.pending;
    if (p) { this.pending = null; clearTimeout(p.timer); p.reject(new Fail("sibelius-closed", "Sibelius closed the connection, most likely because it quit or crashed.", "Reopen Sibelius. If it offers to recover files, answering No is fine; then run the check again.")); }
  }

  request(msg, timeoutMs) {
    if (this.broken) return Promise.reject(new Fail("sibelius-closed", `The connection to Sibelius is ${this.broken}.`, "Reopen Sibelius and run the check again."));
    return new Promise((resolve, reject) => {
      const p = { expect: msg.message + "Response", resolve, reject };
      p.timer = setTimeout(() => {
        this.pending = null;
        this.broken = "no longer reliable after a request timed out";
        reject(new Fail("sibelius-timeout", `Sibelius did not answer ${msg.method || msg.message} in time.`, "Sibelius may be showing a dialog box or still working; check its window."));
      }, timeoutMs);
      this.pending = p;
      this.ws.send(JSON.stringify(msg));
    });
  }

  async plugin(method, args = [], timeoutMs = 120000) {
    const r = await this.request({ message: "invokePlugin", name: PLUGIN_NAME, method, args }, timeoutMs);
    if (r.message !== "invokePluginResponse" || !r.result) {
      throw new Fail("plugin-missing", `The ${PLUGIN_NAME} plug-in did not answer ${method} (${r.errorDetails || r.message}).`, "Install it with scripts/plugin/install.mjs, then quit and reopen Sibelius so it loads.");
    }
    return r.returnValue;
  }

  close() { try { this.ws.close(1000, "done"); } catch {} }
}

// ---------------------------------------------------------------- the import options box

// Finds a named dialog among the Sibelius windows, and presses
// its OK button wherever it sits (directly in the window, in a group, or deeper). Reports what it saw.
const CLICK_OK_SCRIPT = `on run argv
  set dialogTitle to item 1 of argv
  tell application "System Events"
    if not (exists process "Sibelius") then return "no-process"
    tell process "Sibelius"
      set wins to windows
      if (count of wins) is 0 then return "no-windows"
      repeat with w in wins
        set t to ""
        try
          set t to (name of w as text)
        end try
        if t is dialogTitle then
          try
            click button "OK" of w
            return "clicked"
          end try
          repeat with g in (groups of w)
            try
              click button "OK" of g
              return "clicked"
            end try
          end repeat
          repeat with e in (entire contents of w)
            try
              if role of e is "AXButton" and (name of e as text) is "OK" then
                click e
                return "clicked"
              end if
            end try
          end repeat
          return "no-button"
        end if
      end repeat
      return "no-window"
    end tell
  end tell
end run`;

// Shift (key code 56) wakes a screen saver, which otherwise hides Sibelius' windows from Accessibility.
const WAKE_SCRIPT = 'tell application "System Events" to key code 56';

function osa(args) {
  return new Promise((resolve) => {
    execFile("osascript", args, { timeout: 20000 }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout.trim());
      const text = `${stderr} ${err.message}`;
      resolve(/-1719|-25211|-1743|assistive|not allowed|not authori[sz]ed/i.test(text) ? "no-permission" : "error");
    });
  });
}

const clickImportOk = () => osa(["-e", CLICK_OK_SCRIPT, IMPORT_BOX]);

// Sibelius' own dialog windows, as "subrole<TAB>name" lines.
const LIST_WINDOWS_SCRIPT = `tell application "System Events"
  if not (exists process "Sibelius") then return ""
  set out to ""
  tell process "Sibelius"
    repeat with w in windows
      set sr to ""
      set nm to ""
      try
        set sr to (subrole of w as text)
      end try
      try
        set nm to (name of w as text)
      end try
      if sr is "AXDialog" and nm is "" then
        try
          if (description of w as text) starts with "Some elements of the MusicXML file you're opening do not meet the MusicXML schema" then set nm to "${SCHEMA_BOX}"
        end try
      end if
      set out to out & sr & tab & nm & linefeed
    end repeat
  end tell
  return out
end tell`;

// Windows that are not blocking boxes even when Accessibility calls them dialogs.
const NOT_A_BOX = new Set(["Quick Start", "Importing MusicXML file"]);
// Boxes that are safe to dismiss with OK in agent-clicks mode. Never click a box not listed here.
export const HARMLESS_BOXES = new Set(["Missing Fonts"]);

export function parseBoxes(listing) {
  return listing.split("\n").map((l) => l.split("\t")).filter(([sr, name]) => /dialog/i.test(sr || "") && !NOT_A_BOX.has((name || "").trim())).map(([, name]) => (name || "").trim());
}

// null when the windows cannot be read (no Accessibility permission, not macOS).
async function openBoxes() {
  if (process.platform !== "darwin") return null;
  const r = await osa(["-e", LIST_WINDOWS_SCRIPT]);
  if (r === "no-permission" || r === "error") return null;
  return parseBoxes(r);
}

const boxesSeen = new Set();

export function openBoxSay(names) {
  if (names.includes(SCHEMA_BOX)) return "Sibelius found a problem with the MusicXML file. Read its warning and click OK if you want to continue importing.";
  const named = names.filter(Boolean);
  if (named.length) return `Sibelius is showing a box (${named.join(", ")}); please click OK on it, then I will continue.`;
  return "Sibelius is showing a box; please close it (if it asks to allow a connection from an earlier attempt, click No), then I will continue.";
}

// Returns a label for the open boxes when there are any (after reporting them, and in agent-clicks
// mode dismissing the harmless ones), or null when none can be seen.
async function handleOpenBoxes(mode, { importing = false, reported = boxesSeen } = {}) {
  const boxes = (await openBoxes())?.filter((box) => !importing || box !== IMPORT_BOX);
  if (!boxes || !boxes.length) return null;
  const label = boxes.map((b) => b || "unnamed box").join(", ");
  const dismissed = new Set();
  if (mode === "agent-clicks") {
    for (const name of boxes.filter((b) => HARMLESS_BOXES.has(b))) {
      const r = await osa(["-e", CLICK_OK_SCRIPT, name]);
      if (r === "clicked") { dismissed.add(name); emit({ event: "dismissed-sibelius-box", box: name }); say(`Clicked OK on Sibelius' "${name}" box.`); }
    }
  }
  const remaining = boxes.filter((b) => !dismissed.has(b));
  if (remaining.length && !reported.has(label)) {
    reported.add(label);
    emit({ event: "sibelius-has-open-box", boxes: remaining, say: openBoxSay(remaining) });
  }
  return label;
}
const wakeScreen = () => osa(["-e", WAKE_SCRIPT]);

// agent-clicks: keep looking for the box until the import returns. After 30 s without success the user
// is asked too, and whoever is first wins.
async function pressImportOk(open, isDone, cannotClick) {
  const t0 = Date.now();
  let misses = 0, askedUser = false;
  while (!isDone()) {
    await Promise.race([open.catch(() => {}), sleep(1000)]);
    if (isDone()) return;
    const r = await clickImportOk();
    debug(`import box: ${r}`);
    if (r === "clicked") { say("Clicked OK on the import options box."); return; }
    if (r === "no-permission") {
      cannotClick("accessibility-permission");
      return;
    }
    misses += 1;
    if (r === "no-windows" || misses % 3 === 0) await wakeScreen();
    if (!askedUser && Date.now() - t0 > 30000) { askedUser = true; cannotClick("box-not-found"); }
    await sleep(1000);
  }
}

const CANNOT_CLICK_SAY = {
  "accessibility-permission": "I can't click in Sibelius for you yet. To let me do it next time, open System Settings > Privacy & Security > Accessibility and switch on the app I run in.",
  "box-not-found": "I can't find Sibelius' import options. Check which dialog is open in Sibelius.",
  "not-macos": "Clicking for you only works on macOS.",
};

async function watchImportBoxes(open, isDone, mode) {
  const reported = new Set();
  while (!isDone()) {
    await Promise.race([open.catch(() => {}), sleep(3000)]);
    if (!isDone()) await handleOpenBoxes(mode, { importing: true, reported });
  }
}

async function importFile(sess, file, mode) {
  const label = path.basename(file);
  say(`Importing ${label} into Sibelius...`);
  const waiting = { event: "waiting", for: "import-ok", file, say: `When Sibelius shows its MusicXML import options for "${label}", please click OK.` };
  // agent-clicks could not click: one unmistakable event with a sentence to pass on, then the usual wait.
  const cannotClick = (reason) => {
    emit({ event: "agent-cannot-click", reason, file, say: `${CANNOT_CLICK_SAY[reason]} ${waiting.say}` });
    emit(waiting);
  };
  const open = sess.plugin("OpenFile", [path.resolve(file)], 900000);
  let done = false;
  open.then(() => (done = true), () => (done = true));
  if (mode === "agent-clicks" && process.platform === "darwin") {
    const isDone = () => done;
    await Promise.all([pressImportOk(open, isDone, cannotClick), watchImportBoxes(open, isDone, mode)]);
  }
  else if (mode === "agent-clicks") cannotClick("not-macos");
  else emit(waiting);
  const ok = await open;
  if (!ok) throw new Fail("import-failed", `Sibelius did not open ${label} (the import was cancelled or the file could not be read).`, "Run again and click OK on the import box; if it keeps failing, Sibelius cannot read this file.");
}

async function readScore(sess) {
  const info = await sess.plugin("Info");
  if (!info || !info.ok) throw new Fail("no-score", "Sibelius has no open score after the import.");
  const barLengths = await sess.plugin("BarLengths");
  const rows = [];
  for (let s = 1; s <= info.staffCount; s++) rows.push(...(await sess.plugin("ReadNotes", [s, s], 300000)));
  return { info, barLengths, rows };
}

// ---------------------------------------------------------------- check

const cellCount = (list) => new Set(list.map((p) => `${p.staff}:${p.bar}`)).size;

function importSummary(c) {
  return { xmlNotes: c.xmlNotes, sibeliusNotes: c.sibeliusNotes, lost: c.lost, gained: c.gained, movedBetweenStaves: c.movedBetweenStaves ?? 0, barLengthWithinTupletRounding: c.barLengthWithinTupletRounding ?? 0, barsThatLookWrong: cellCount(c.problems), structure: c.structure };
}

async function importAndRead(sess, file, mode, timings) {
  const t0 = Date.now();
  await importFile(sess, file, mode);
  const t1 = Date.now();
  const read = await readScore(sess);
  timings[path.basename(file)] = { importSeconds: (t1 - t0) / 1000, readSeconds: (Date.now() - t1) / 1000 };
  return read;
}

export function doctorItems(changes, xml, unplaced = []) {
  const items = [];
  for (const source of ["changed", "unfixed", "attention"]) {
    for (const e of changes ? changes[source] || [] : []) {
      const at = e.text ? locate(xml, e) : null;
      if (at) items.push({ ...at, source, kind: e.kind, short: e.short || e.text, explain: e.explain, count: e.count, level: e.level, supersedes: e.supersedes, text: e.text });
      else unplaced.push({ source, ...e });
    }
  }
  return items;
}

async function check(opts) {
  if (!opts.fixed) throw new Fail("usage", "Give the fixed file with --fixed.");
  for (const f of [opts.fixed, opts.original, opts.changes].filter(Boolean)) if (!fs.existsSync(f)) throw new Fail("no-file", `File not found: ${f}`);
  const mode = opts.importDialog || getSetting("importDialog") || "user-clicks";
  const outDir = path.resolve(opts.out || path.dirname(opts.fixed));
  const stem = path.basename(opts.fixed).replace(/\.(musicxml|xml|mxl)$/i, "");
  const install = sibeliusInstall();
  if (!install.installed) throw new Fail("no-sibelius", "Sibelius is not installed on this computer.");
  if (install.olderThanTested) throw new Fail("sibelius-too-old", `This check is built for Sibelius ${TESTED.label}; this computer has ${install.release}.`, "Tell the user to update Sibelius, and hand back the fixed file without the in-Sibelius check.");
  const xmlFixed = analyseScore(loadScore(opts.fixed));
  const xmlOrig = opts.original ? analyseScore(loadScore(opts.original)) : null;
  const changes = opts.changes ? loadChanges(opts.changes) : null;
  fs.mkdirSync(outDir, { recursive: true });
  const launched = !sibeliusRunning();
  if (launched) { say("Starting Sibelius..."); emit({ event: "starting-sibelius" }); launchSibelius(install.path); }
  const sess = new Session(opts.port);
  await sess.connect({ startupMs: launched ? 300000 : 180000, mode });
  emit({ event: "connected" });
  try {
    const ping = await sess.plugin("Ping");
    if (compareVersions(String(ping.plugin), PLUGIN_VERSION) < 0) throw new Fail("plugin-outdated", `Sibelius has plug-in version ${ping.plugin}, this check needs ${PLUGIN_VERSION} or newer.`, "Run scripts/plugin/install.mjs, then quit and reopen Sibelius.");
    const timings = {};
    const report = { sibelius: { ...install, programVersion: ping.programVersion }, importDialog: mode, timings };
    if (opts.original) {
      const o = await importAndRead(sess, opts.original, mode, timings);
      const c = compare(xmlOrig, o.info, o.rows, o.barLengths);
      report.original = { file: path.resolve(opts.original), ...importSummary(c), problems: c.problems, sibeliusEvidence: c.evidence };
      if (!(await sess.plugin("CloseScore", [o.info.staffCount, o.info.title ?? ""]))) say("Left the original open in Sibelius (the active window changed).");
    }
    const f = await importAndRead(sess, opts.fixed, mode, timings);
    const c = compare(xmlFixed, f.info, f.rows, f.barLengths);
    const vsOrig = compareToOriginal(xmlOrig, c.cells, f.barLengths.length);
    const unplaced = [];
    const items = [
      ...doctorItems(changes, xmlFixed, unplaced),
      ...vsOrig.bars.map((p) => ({ ...p, source: "differs-from-original" })),
      ...c.problems.map((p) => ({ ...p, source: "import" })),
    ];
    const comments = buildComments(items);
    for (const g of comments.slice(0, MAX_COMMENTS)) await sess.plugin("Comment", [g.staff, g.bar, g.text, g.color, g.level]);
    const sib = path.join(outDir, `${stem}.checked.sib`);
    await sess.plugin("SaveSib", [sib]);
    if (opts.close) await sess.plugin("CloseScore", [f.info.staffCount, f.info.title ?? ""]);
    const needsEyes = comments.filter((g) => g.needsEyes);
    report.fixed = { file: path.resolve(opts.fixed), ...importSummary(c), problems: c.problems, sibeliusEvidence: c.evidence };
    report.comparedWithOriginal = { compared: vsOrig.compared, reason: vsOrig.reason ?? null, bars: vsOrig.bars };
    report.doctorChanges = changes ? { commented: changes.changed.length + changes.unfixed.length, harmlessNotCommented: changes.harmless, unplaced } : null;
    report.comments = comments;
    const details = path.join(outDir, `${stem}.sibelius-check.json`);
    fs.writeFileSync(details, JSON.stringify(report, null, 1) + "\n");
    const eyes = [...needsEyes].sort((a, b) => b.level - a.level || a.bar - b.bar);
    return {
      event: "done",
      // What the assistant's first sentence needs.
      headline: {
        notesLostImportingOriginal: report.original ? report.original.lost : null,
        notesLostAfterFix: c.lost,
        barsNeedingEyes: needsEyes.length,
        seriousBars: comments.filter((g) => g.level === 3).length,
        barsChangedNothingToDo: comments.length - needsEyes.length,
      },
      sib: fs.existsSync(sib) ? sib : null,
      details,
      sibelius: install.release,
      original: report.original ? importSummary({ ...report.original, problems: report.original.problems }) : null,
      fixed: importSummary(c),
      differsFromOriginalBars: vsOrig.compared ? cellCount(vsOrig.bars) : null,
      comments: {
        added: Math.min(comments.length, MAX_COMMENTS),
        bars: comments.length,
        byLevel: { 1: comments.filter((g) => g.level === 1).length, 2: comments.filter((g) => g.level === 2).length, 3: comments.filter((g) => g.level === 3).length },
        changedNothingToDo: comments.length - needsEyes.length,
        needYourEyes: needsEyes.length,
        harmlessChangesNotCommented: changes ? changes.harmless : 0,
        doctorEntriesNotPlaced: unplaced.length,
      },
      barsNeedingEyes: eyes.slice(0, 100).map((g) => ({ part: g.part ?? null, measure: g.measure, level: g.level, text: g.text })),
    };
  } finally {
    sess.close();
  }
}

// ---------------------------------------------------------------- CLI

function parseArgs(argv) {
  const o = { port: Number(process.env.SIBELIUS_CONNECT_PORT || 1898) };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { if (i + 1 >= argv.length) throw new Fail("usage", `${a} needs a value`); return argv[++i]; };
    if (a === "--fixed") o.fixed = val();
    else if (a === "--original") o.original = val();
    else if (a === "--out") o.out = val();
    else if (a === "--changes") o.changes = val();
    else if (a === "--port") o.port = Number(val());
    else if (a === "--close") o.close = true;
    else if (a === "--import-dialog") {
      o.importDialog = val();
      if (!["user-clicks", "agent-clicks"].includes(o.importDialog)) throw new Fail("usage", "--import-dialog is user-clicks or agent-clicks");
    } else if (!o.cmd) o.cmd = a;
    else throw new Fail("usage", `unexpected argument ${a}`);
  }
  return o;
}

async function main() {
  try {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.cmd === "status") emit(await status(opts.port));
    else if (opts.cmd === "check") emit(await check(opts));
    else throw new Fail("usage", "usage: connect.mjs status | check --fixed FILE [--original FILE] [--changes FILE] [--out DIR] [--import-dialog user-clicks|agent-clicks] [--close]");
    process.exit(0);
  } catch (e) {
    emit({ event: "error", code: e.code || "unexpected", message: e.message, hint: e.hint || null });
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();

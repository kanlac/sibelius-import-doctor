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
import zlib from "node:zlib";
import { execFile, execFileSync, spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { getSetting } from "./config.mjs";
import { PLUGIN_NAME, PLUGIN_VERSION, pluginStatus, sibeliusRunning } from "./plugin/install.mjs";

const TESTED = { year: 26, month: 11, label: "26.11" };
const CLIENT_NAME = "Sibelius Import Doctor";
const TICKS = 256; // Sibelius ticks per quarter note
const MAX_COMMENTS = 300;
const IMPORT_BOX_NEEDLE = "MusicXML"; // the box is titled "Open MusicXML File"

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

function decodeEntities(s) {
  if (!s.includes("&")) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, e) => {
    if (e[0] === "#") return String.fromCodePoint(e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[e];
  });
}

function skipTo(s, needle, from) {
  const k = s.indexOf(needle, from);
  if (k < 0) throw new Fail("bad-musicxml", "The MusicXML file is cut off or not valid XML.");
  return k + needle.length;
}

function tagEnd(s, from) {
  let q = null;
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (q) { if (c === q) q = null; } else if (c === '"' || c === "'") q = c; else if (c === ">") return j;
  }
  throw new Fail("bad-musicxml", "The MusicXML file is cut off or not valid XML.");
}

function skipDoctype(s, from) {
  let depth = 0;
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === "[") depth++;
    else if (c === "]") depth--;
    else if (c === ">" && depth <= 0) return j + 1;
  }
  throw new Fail("bad-musicxml", "The MusicXML file is cut off or not valid XML.");
}

// Small non-validating XML parser: elements, attributes and text, enough for MusicXML.
export function parseXml(s) {
  const doc = { name: "#document", attrs: {}, children: [], text: "" };
  const stack = [doc];
  let i = 0;
  while (i < s.length) {
    const lt = s.indexOf("<", i);
    if (lt < 0) break;
    const top = stack[stack.length - 1];
    if (lt > i && stack.length > 1) top.text += decodeEntities(s.slice(i, lt));
    if (s.startsWith("<!--", lt)) { i = skipTo(s, "-->", lt); continue; }
    if (s.startsWith("<![CDATA[", lt)) { const e = skipTo(s, "]]>", lt); top.text += s.slice(lt + 9, e - 3); i = e; continue; }
    if (s.startsWith("<?", lt)) { i = skipTo(s, "?>", lt); continue; }
    if (s.startsWith("<!", lt)) { i = skipDoctype(s, lt + 2); continue; }
    const j = tagEnd(s, lt + 1);
    let body = s.slice(lt + 1, j);
    i = j + 1;
    if (body[0] === "/") { if (stack.length > 1) stack.pop(); continue; }
    const selfClose = body.endsWith("/");
    if (selfClose) body = body.slice(0, -1);
    const name = /^[^\s/>]+/.exec(body)[0];
    const el = { name, attrs: {}, children: [], text: "" };
    const re = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    const rest = body.slice(name.length);
    let a;
    while ((a = re.exec(rest))) el.attrs[a[1]] = decodeEntities(a[2] ?? a[3]);
    top.children.push(el);
    if (!selfClose) stack.push(el);
  }
  return doc;
}

const kids = (el, name) => el.children.filter((c) => c.name === name);
const kid = (el, name) => el.children.find((c) => c.name === name);
const kidText = (el, name) => { const c = kid(el, name); return c ? c.text.trim() : null; };
function* walk(el) { for (const c of el.children) { yield c; yield* walk(c); } }

// .mxl is a zip: read the central directory, find the root file named in META-INF/container.xml.
function unzipEntries(buf) {
  let eocd = -1;
  for (let k = buf.length - 22; k >= Math.max(0, buf.length - 65557); k--) if (buf.readUInt32LE(k) === 0x06054b50) { eocd = k; break; }
  if (eocd < 0) throw new Fail("bad-musicxml", "The .mxl file is not a readable zip archive.");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let n = 0; n < count && buf.readUInt32LE(p) === 0x02014b50; n++) {
    const method = buf.readUInt16LE(p + 10), size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    entries.set(name, () => {
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + size);
      if (method === 0) return data;
      if (method === 8) return zlib.inflateRawSync(data);
      throw new Fail("bad-musicxml", "The .mxl file uses a compression method this check cannot read.");
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function readMxl(buf) {
  const entries = unzipEntries(buf);
  let name = null;
  if (entries.has("META-INF/container.xml")) {
    const c = parseXml(decodeText(entries.get("META-INF/container.xml")()));
    for (const el of walk(c)) if (el.name === "rootfile" && el.attrs["full-path"]) { name = el.attrs["full-path"]; break; }
  }
  if (!name) name = [...entries.keys()].find((k) => !k.startsWith("META-INF/") && /\.(xml|musicxml)$/i.test(k));
  if (!name || !entries.has(name)) throw new Fail("bad-musicxml", "The .mxl file does not contain a MusicXML score.");
  return decodeText(entries.get(name)());
}

function decodeText(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString("utf16le");
  if (buf[0] === 0xfe && buf[1] === 0xff) return Buffer.from(buf.subarray(2)).swap16().toString("utf16le");
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString("utf8");
  return buf.toString("utf8");
}

export function loadScore(file) {
  const buf = fs.readFileSync(file);
  const text = buf[0] === 0x50 && buf[1] === 0x4b ? readMxl(buf) : decodeText(buf);
  const doc = parseXml(text);
  const root = doc.children.find((c) => c.name.startsWith("score-"));
  if (!root) throw new Fail("bad-musicxml", `${path.basename(file)} is not a MusicXML score.`);
  if (root.name !== "score-partwise") throw new Fail("unsupported-musicxml", "Only part-by-part (score-partwise) MusicXML can be compared; timewise files are not supported.");
  return root;
}

// ---------------------------------------------------------------- MusicXML analysis

function tremoloKinds(note) {
  const out = [];
  for (const el of walk(note)) if (el.name === "tremolo") out.push(el.attrs.type || "single");
  return out;
}

function measureFacts(m, st) {
  const f = { number: m.attrs.number ?? "", implicit: m.attrs.implicit === "yes", heads: {}, trem: {}, fill: 0 };
  let pos = 0, lastStart = 0;
  for (const el of m.children) {
    if (el.name === "attributes") {
      const d = kidText(el, "divisions"); if (d) st.divisions = Number(d);
      const n = kidText(el, "staves"); if (n) st.staves = Math.max(st.staves, Number(n));
      const t = kid(el, "time");
      if (t && kidText(t, "beats")) {
        const beats = kidText(t, "beats").split("+").reduce((a, b) => a + Number(b), 0);
        if (Number.isFinite(beats)) { st.beats = beats; st.beatType = Number(kidText(t, "beat-type")) || 4; }
      }
    } else if (el.name === "backup" || el.name === "forward") {
      const d = (Number(kidText(el, "duration")) || 0) * TICKS / st.divisions;
      pos += el.name === "backup" ? -d : d;
      f.fill = Math.max(f.fill, pos);
    } else if (el.name === "note") {
      const isChord = !!kid(el, "chord"), isGrace = !!kid(el, "grace"), isRest = !!kid(el, "rest");
      const staff = kidText(el, "staff") || "1", voice = kidText(el, "voice") || "1";
      const d = isGrace ? 0 : (Number(kidText(el, "duration")) || 0) * TICKS / st.divisions;
      const start = isChord ? lastStart : pos;
      if (!isChord) { lastStart = pos; pos += d; f.fill = Math.max(f.fill, pos); }
      if (isRest) continue;
      f.heads[staff] = (f.heads[staff] || 0) + 1;
      for (const kind of tremoloKinds(el)) {
        const t = (f.trem[staff] ||= { single: new Set(), unmeasured: new Set(), start: new Set() });
        if (t[kind]) t[kind].add(`${voice}@${start}@${isGrace}`);
      }
    }
  }
  f.expected = Math.round(st.beats * 4 * TICKS / st.beatType);
  return f;
}

// Staves in Sibelius order, each with per-bar facts; plus per-bar intended lengths.
export function analyseScore(root) {
  const order = [];
  const names = {};
  const partList = kid(root, "part-list");
  for (const sp of partList ? kids(partList, "score-part") : []) { order.push(sp.attrs.id); names[sp.attrs.id] = kidText(sp, "part-name") || ""; }
  const parts = new Map(kids(root, "part").map((p) => [p.attrs.id, p]));
  for (const id of parts.keys()) if (!order.includes(id)) order.push(id);
  const staves = [];
  let bars = null;
  for (const id of order) {
    const part = parts.get(id);
    if (!part) continue;
    const st = { divisions: 1, beats: 4, beatType: 4, staves: 1 };
    const facts = kids(part, "measure").map((m) => measureFacts(m, st));
    if (!bars) bars = facts.map((f) => ({ number: f.number, expected: f.expected, implicit: f.implicit, fill: 0 }));
    facts.forEach((f, i) => { if (bars[i]) bars[i].fill = Math.max(bars[i].fill, f.fill); });
    for (let k = 1; k <= st.staves; k++) {
      staves.push({
        part: id,
        name: names[id] || id,
        staffInPart: k,
        bars: facts.map((f) => {
          const t = f.trem[String(k)];
          return { heads: f.heads[String(k)] || 0, single: t ? t.single.size + t.unmeasured.size : 0, double: t ? t.start.size : 0 };
        }),
      });
    }
  }
  // What the file asks for: a pickup lasts as long as its music; any other bar at least its time
  // signature, longer when the music in it is longer (Sibelius pads short bars with rests).
  for (const b of bars || []) b.intended = b.implicit ? Math.round(b.fill) : Math.max(b.expected, Math.round(b.fill));
  return { staves, bars: bars || [] };
}

// ---------------------------------------------------------------- Sibelius readback analysis

// ReadNotes rows: [staff, bar, pos, dur, voice, noteCount, tupletLeft, tupletRight, doubleTrem, singleTrem, grace]
export function analyseReadback(rows, barLengths) {
  const cells = new Map();
  const ends = new Map();
  for (const r of rows) {
    const [s, b, pos, dur, voice, count, tl, tr, dtrem, strem, grace] = r;
    const key = `${s}:${b}`;
    const c = cells.get(key) || { heads: 0, single: 0, double: 0, doubleInTuplet: 0 };
    c.heads += count;
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

// Compare one imported file with its MusicXML. Returns totals and a list of bars that look wrong.
export function compare(xml, info, rows, barLengths) {
  const { cells, overflow } = analyseReadback(rows, barLengths);
  const structure = { xmlStaves: xml.staves.length, sibeliusStaves: info.staffCount, xmlBars: xml.bars.length, sibeliusBars: barLengths.length };
  const staffMatch = structure.xmlStaves === structure.sibeliusStaves;
  const problems = [];
  let xmlNotes = 0, sibNotes = 0, lost = 0, gained = 0;
  for (const st of xml.staves) for (const b of st.bars) xmlNotes += b.heads;
  for (const c of cells.values()) sibNotes += c.heads;
  const nBars = Math.max(xml.bars.length, barLengths.length);
  for (let b = 1; b <= nBars; b++) {
    const bar = xml.bars[b - 1];
    const label = bar ? bar.number : String(b);
    if (bar && barLengths[b - 1] !== undefined && barLengths[b - 1] !== bar.intended) {
      problems.push({ staff: 1, bar: b, measure: label, kind: "bar-length", text: `this bar lasts ${quarters(barLengths[b - 1])} quarter notes in Sibelius, but the music in the file lasts ${quarters(bar.intended)}` });
    }
    if (!staffMatch) continue;
    xml.staves.forEach((st, i) => {
      const s = i + 1;
      const want = st.bars[b - 1] || { heads: 0, single: 0, double: 0 };
      const got = cells.get(`${s}:${b}`) || { heads: 0, single: 0, double: 0, doubleInTuplet: 0 };
      const at = { staff: s, bar: b, measure: label, part: st.name };
      if (got.heads < want.heads) { lost += want.heads - got.heads; problems.push({ ...at, kind: "notes-missing", text: `the file has ${plural(want.heads, "note")} here, Sibelius shows ${got.heads}` }); }
      if (got.heads > want.heads) { gained += got.heads - want.heads; problems.push({ ...at, kind: "notes-extra", text: `the file has ${plural(want.heads, "note")} here, Sibelius shows ${got.heads}` }); }
      if (got.single < want.single) problems.push({ ...at, kind: "tremolo-missing", text: `${plural(want.single - got.single, "tremolo")} from the file ${want.single - got.single === 1 ? "is" : "are"} missing` });
      if (got.double < want.double) problems.push({ ...at, kind: "two-note-tremolo-missing", text: `${plural(want.double - got.double, "two-note tremolo")} from the file ${want.double - got.double === 1 ? "is" : "are"} missing` });
      if (got.doubleInTuplet > 0) problems.push({ ...at, kind: "two-note-tremolo-in-tuplet", text: "a two-note tremolo here sits inside a tuplet, so it may be drawn as double whole notes" });
      const voices = overflow.get(`${s}:${b}`);
      if (voices) problems.push({ ...at, kind: "voice-overflow", text: `notes in voice ${voices.join(" and ")} run past the end of the bar` });
    });
  }
  return { structure, staffMatch, xmlNotes, sibeliusNotes: sibNotes, lost, gained, problems, cells: { staffCount: info.staffCount, map: cells } };
}

// Bars of the fixed import whose note count differs from the user's original file.
// Only meaningful when both files have the same staves and bars.
export function compareToOriginal(orig, cells, nSibBars) {
  const out = [];
  if (!orig) return { compared: false, reason: "no original given", bars: out };
  if (orig.staves.length !== cells.staffCount || orig.bars.length !== nSibBars) {
    return { compared: false, reason: "the original and the fixed score have different staves or bar counts", bars: out };
  }
  orig.staves.forEach((st, i) => st.bars.forEach((want, j) => {
    const got = (cells.map.get(`${i + 1}:${j + 1}`) || { heads: 0 }).heads;
    if (got !== want.heads) {
      const diff = want.heads - got;
      out.push({ staff: i + 1, bar: j + 1, measure: orig.bars[j].number, part: st.name, kind: "differs-from-original", text: `${plural(Math.abs(diff), "note")} ${diff > 0 ? "missing" : "more"} (your file has ${want.heads}, Sibelius shows ${got})` });
    }
  }));
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
const FIX_TEXT = {
  "trim-delete": "notes past the bar line were removed",
  "trim-shorten": "a note crossing the bar line was shortened to end at it",
  "tremolo-pair": "two-note tremolo rewritten so Sibelius draws it correctly",
  unmeasured: "unmeasured tremolo rewritten as a three-stroke tremolo",
};
const UNFIXED_TEXT = {
  "overlong-bar": "the music in this bar is longer than the time signature",
  "overlong-rest": "the whole-bar rest is longer than the bar",
  "two-note-tremolo": "a two-note tremolo is still written in a way Sibelius draws wrongly",
  "two-note-tremolo-unusual": "an unusual two-note tremolo was left as it is; check how Sibelius draws it",
  "unmeasured-tremolo": "an unmeasured tremolo was left as it is; Sibelius may drop it",
};

function fromDoctorReport(raw) {
  const changed = [];
  let harmless = 0;
  for (const c of raw.log) {
    if (HARMLESS_FIXES.has(c.fix)) { harmless += 1; continue; }
    if (!FIX_TEXT[c.fix] || !c.measure) continue;
    const n = c.deleted_noteheads;
    const text = c.fix === "trim-delete" && n ? `${plural(n, "note")} past the bar line ${n === 1 ? "was" : "were"} removed` : FIX_TEXT[c.fix];
    changed.push({ part: c.part, measureIndex: c.measure, staff: Number(c.staff) || 1, text });
  }
  const unfixed = [];
  for (const p of raw.found || []) {
    if (p.fixed || !p.where || HARMLESS_UNFIXED.has(p.kind)) continue;
    const text = UNFIXED_TEXT[p.kind] || `${String(p.kind).replace(/-/g, " ")} (not fixed)`;
    for (const w of p.where) for (const bar of w.bars || []) unfixed.push({ part: w.part_id ?? w.part, measure: bar, staff: 1, text });
  }
  return { changed, unfixed, harmless };
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
  });
  const keep = (list) => list.filter((e) => !e.harmless).map(norm);
  return { changed: keep(pick(LIST_KEYS.changed)), unfixed: keep(pick(LIST_KEYS.unfixed)), harmless: all.filter((e) => e.harmless).length };
}

export function locate(xml, e) {
  const staffIdx = xml.staves.findIndex((s) => (s.part === e.part || s.name === e.part) && s.staffInPart === e.staff);
  let bar = e.measureIndex ? Number(e.measureIndex) : xml.bars.findIndex((b) => String(b.number) === String(e.measure)) + 1;
  if (staffIdx < 0 || !(bar >= 1 && bar <= xml.bars.length)) return null;
  return { staff: staffIdx + 1, bar, measure: xml.bars[bar - 1].number, part: xml.staves[staffIdx].name };
}

// Sources in the order they are told, with the lead-in each gets in the comment.
const SECTION = [
  ["changed", "Changed"],
  ["unfixed", "Could not be fixed"],
  ["differs-from-original", "Still differs from your file"],
  ["import", "Sibelius shows this differently from the fixed file"],
];
export const NEEDS_EYES = new Set(["unfixed", "differs-from-original", "import"]);

// One comment per staff and bar, all reasons merged into one plain-words text.
export function buildComments(items) {
  const byCell = new Map();
  for (const it of items) {
    const key = `${it.staff}:${it.bar}`;
    const g = byCell.get(key) || { staff: it.staff, bar: it.bar, measure: it.measure, part: it.part, texts: new Map() };
    const list = g.texts.get(it.source) || [];
    if (!list.includes(it.text)) list.push(it.text);
    g.texts.set(it.source, list);
    byCell.set(key, g);
  }
  return [...byCell.values()]
    .sort((a, b) => a.bar - b.bar || a.staff - b.staff)
    .map((g) => {
      const sources = SECTION.map(([src]) => src).filter((src) => g.texts.has(src));
      const body = SECTION.filter(([src]) => g.texts.has(src)).map(([src, lead]) => `${lead}: ${g.texts.get(src).join("; ")}.`).join(" ");
      return { staff: g.staff, bar: g.bar, measure: g.measure, part: g.part, sources, needsEyes: sources.some((src) => NEEDS_EYES.has(src)), text: `Import Doctor: ${body}` };
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

class Session {
  constructor(port) {
    this.port = port;
    this.ws = null;
    this.pending = null;
    this.broken = null;
  }

  // One attempt: resolves "ok" | "starting" | "busy" | "denied" | "refused"; never rejects.
  attempt(approvalMs) {
    return new Promise((resolve) => {
      let settled = false, opened = 0, waitingTimer = null, giveUp = null;
      const ws = new WebSocket(`ws://127.0.0.1:${this.port}`);
      const finish = (v) => { if (settled) return; settled = true; clearTimeout(waitingTimer); clearTimeout(giveUp); if (v !== "ok") { try { ws.close(); } catch {} } resolve(v); };
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
        else this.onClose(e);
      };
      this.ws = ws;
    });
  }

  // startupMs bounds the retries for "not ready yet" (refused, closed, busy): 3 minutes, or 5 when this
  // run has just launched Sibelius.
  async connect({ approvalMs = Number(process.env.SIBELIUS_IMPORT_DOCTOR_APPROVAL_SECONDS || 300) * 1000, startupMs = 180000 } = {}) {
    const t0 = Date.now();
    let busyNoted = false;
    for (;;) {
      const r = await this.attempt(approvalMs);
      if (r === "ok") return;
      if (r === "denied") throw new Fail("not-allowed", "Sibelius did not allow the connection (No was clicked).", "Ask the user whether to try again; then they click Yes.");
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

// Finds the import options box in any Sibelius window whose title contains the needle, and presses
// its OK button wherever it sits (directly in the window, in a group, or deeper). Reports what it saw.
const CLICK_OK_SCRIPT = `on run argv
  set needle to item 1 of argv
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
        if t contains needle then
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

const clickImportOk = () => osa(["-e", CLICK_OK_SCRIPT, IMPORT_BOX_NEEDLE]);
const wakeScreen = () => osa(["-e", WAKE_SCRIPT]);

// agent-clicks: keep looking for the box until the import returns. After 30 s without success the user
// is asked too, and whoever is first wins.
async function pressImportOk(open, isDone, asked) {
  const t0 = Date.now();
  let misses = 0, askedUser = false;
  while (!isDone()) {
    await Promise.race([open.catch(() => {}), sleep(1000)]);
    if (isDone()) return;
    const r = await clickImportOk();
    debug(`import box: ${r}`);
    if (r === "clicked") { say("Clicked OK on the import options box."); return; }
    if (r === "no-permission") {
      emit({ event: "accessibility-needed", say: "macOS did not let the assistant click in Sibelius. To allow it: System Settings > Privacy & Security > Accessibility, turn on the app your assistant runs in (and allow it to control System Events under Automation if asked). For now, please click OK yourself." });
      asked();
      return;
    }
    misses += 1;
    if (r === "no-windows" || misses % 3 === 0) await wakeScreen();
    if (!askedUser && Date.now() - t0 > 30000) { askedUser = true; asked(); }
    await sleep(1000);
  }
}

async function importFile(sess, file, mode) {
  const label = path.basename(file);
  say(`Importing ${label} into Sibelius...`);
  const asked = () => emit({ event: "waiting", for: "import-ok", file, say: `Sibelius is showing its MusicXML import options for "${label}". Please click OK.` });
  const open = sess.plugin("OpenFile", [path.resolve(file)], 900000);
  let done = false;
  open.then(() => (done = true), () => (done = true));
  if (mode === "agent-clicks" && process.platform === "darwin") await pressImportOk(open, () => done, asked);
  else {
    if (mode === "agent-clicks") say("Clicking for you works only on macOS; asking the user instead.");
    asked();
  }
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
  return { xmlNotes: c.xmlNotes, sibeliusNotes: c.sibeliusNotes, lost: c.lost, gained: c.gained, barsThatLookWrong: cellCount(c.problems), structure: c.structure };
}

async function importAndRead(sess, file, mode, timings) {
  const t0 = Date.now();
  await importFile(sess, file, mode);
  const t1 = Date.now();
  const read = await readScore(sess);
  timings[path.basename(file)] = { importSeconds: (t1 - t0) / 1000, readSeconds: (Date.now() - t1) / 1000 };
  return read;
}

function doctorItems(changes, xml, unplaced) {
  const items = [];
  for (const source of ["changed", "unfixed"]) {
    for (const e of changes ? changes[source] : []) {
      const at = e.text ? locate(xml, e) : null;
      if (at) items.push({ ...at, source, text: e.text });
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
  await sess.connect({ startupMs: launched ? 300000 : 180000 });
  emit({ event: "connected" });
  try {
    const ping = await sess.plugin("Ping");
    if (ping.plugin !== PLUGIN_VERSION) throw new Fail("plugin-outdated", `Sibelius has plug-in version ${ping.plugin}, this check needs ${PLUGIN_VERSION}.`, "Run scripts/plugin/install.mjs, then quit and reopen Sibelius.");
    const timings = {};
    const report = { sibelius: { ...install, programVersion: ping.programVersion }, importDialog: mode, timings };
    if (opts.original) {
      const o = await importAndRead(sess, opts.original, mode, timings);
      const c = compare(xmlOrig, o.info, o.rows, o.barLengths);
      report.original = { file: path.resolve(opts.original), ...importSummary(c), problems: c.problems };
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
    for (const g of comments.slice(0, MAX_COMMENTS)) await sess.plugin("Comment", [g.staff, g.bar, g.text]);
    const sib = path.join(outDir, `${stem}.checked.sib`);
    await sess.plugin("SaveSib", [sib]);
    if (opts.close) await sess.plugin("CloseScore", [f.info.staffCount, f.info.title ?? ""]);
    const needsEyes = comments.filter((g) => g.needsEyes);
    report.fixed = { file: path.resolve(opts.fixed), ...importSummary(c), problems: c.problems };
    report.comparedWithOriginal = { compared: vsOrig.compared, reason: vsOrig.reason ?? null, bars: vsOrig.bars };
    report.doctorChanges = changes ? { commented: changes.changed.length + changes.unfixed.length, harmlessNotCommented: changes.harmless, unplaced } : null;
    report.comments = comments;
    const details = path.join(outDir, `${stem}.sibelius-check.json`);
    fs.writeFileSync(details, JSON.stringify(report, null, 1) + "\n");
    return {
      event: "done",
      sib: fs.existsSync(sib) ? sib : null,
      details,
      sibelius: install.release,
      original: report.original ? importSummary({ ...report.original, problems: report.original.problems }) : null,
      fixed: importSummary(c),
      differsFromOriginalBars: vsOrig.compared ? cellCount(vsOrig.bars) : null,
      comments: {
        added: Math.min(comments.length, MAX_COMMENTS),
        bars: comments.length,
        changedNothingToDo: comments.length - needsEyes.length,
        needYourEyes: needsEyes.length,
        harmlessChangesNotCommented: changes ? changes.harmless : 0,
        doctorEntriesNotPlaced: unplaced.length,
      },
      firstNeedingEyes: needsEyes.slice(0, 20).map((g) => ({ part: g.part ?? null, measure: g.measure, text: g.text })),
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

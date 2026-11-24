// Reading MusicXML (.musicxml, .xml, .mxl) and measuring it.
// All durations are in Sibelius ticks (quarter note = 256), as in the Python prototype.

import { readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import { Frac } from "./frac.mjs";
import { XmlError, parse, kids, find, findText, attr, iter, text } from "./xml.mjs";

export const TICKS_PER_QUARTER = 256;

export class InputError extends Error {}
export class TimewiseError extends InputError {}

/** Python int(): optional sign and digits, surrounding whitespace allowed. */
export function toInt(s, what) {
  const t = (s ?? "").trim();
  if (!/^[+-]?\d+$/.test(t)) throw new InputError(`${what} is "${s}", expected a whole number`);
  return Number(t);
}

// ---------- bytes -> text ----------

export function decode(buf) {
  const b = buf;
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return new TextDecoder("utf-8", { fatal: true }).decode(b.subarray(3));
  if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder("utf-16le").decode(b.subarray(2));
  if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder("utf-16be").decode(b.subarray(2));
  if (b[0] === 0x3c && b[1] === 0x00) return new TextDecoder("utf-16le").decode(b);
  if (b[0] === 0x00 && b[1] === 0x3c) return new TextDecoder("utf-16be").decode(b);
  const head = b.subarray(0, 200).toString("latin1");
  const m = head.match(/^<\?xml[^>]*encoding\s*=\s*["']([^"']+)["']/);
  const label = m ? m[1].toLowerCase() : "utf-8";
  if (label === "utf-8" || label === "utf8" || label === "us-ascii" || label === "ascii") {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(b);
    } catch {
      throw new InputError("the file says it is UTF-8 but contains bytes that are not valid UTF-8");
    }
  }
  try {
    return new TextDecoder(label).decode(b);
  } catch {
    throw new InputError(`unsupported text encoding "${m[1]}"`);
  }
}

// ---------- .mxl (zip) ----------

/** List and read the entries of a zip archive (stored or deflated). */
export function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new InputError("the .mxl file is not a readable zip archive");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  if (p === 0xffffffff) throw new InputError("zip64 .mxl archives are not supported");
  const entries = new Map();
  for (let k = 0; k < count; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new InputError("damaged zip directory in the .mxl file");
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28);
    const xlen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString("utf8");
    entries.set(name, { method, csize, local });
    p += 46 + nlen + xlen + clen;
  }
  const read = (name) => {
    const e = entries.get(name);
    if (!e) throw new InputError(`"${name}" is missing from the .mxl file`);
    if (buf.readUInt32LE(e.local) !== 0x04034b50) throw new InputError("damaged zip entry in the .mxl file");
    const start = e.local + 30 + buf.readUInt16LE(e.local + 26) + buf.readUInt16LE(e.local + 28);
    const data = buf.subarray(start, start + e.csize);
    if (e.method === 0) return Buffer.from(data);
    if (e.method === 8) return inflateRawSync(data);
    throw new InputError(`unsupported compression method ${e.method} in the .mxl file`);
  };
  return { names: [...entries.keys()], read };
}

function mxlScoreBytes(buf) {
  const zip = readZip(buf);
  let target = null;
  if (zip.names.includes("META-INF/container.xml")) {
    const c = parse(decode(zip.read("META-INF/container.xml")));
    for (const rf of iter(c.root, "rootfile")) {
      const fp = attr(rf, "full-path");
      const mt = attr(rf, "media-type");
      if (fp && (!mt || /musicxml|xml/.test(mt))) {
        target = fp;
        break;
      }
    }
  }
  if (!target) target = zip.names.find((n) => !n.startsWith("META-INF/") && /\.(musicxml|xml)$/i.test(n));
  if (!target) throw new InputError("no MusicXML score found inside the .mxl file");
  return { bytes: zip.read(target), inner: target };
}

function readScoreText(path) {
  const buf = readFileSync(path);
  if (buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50) {
    const { bytes, inner } = mxlScoreBytes(buf);
    return { xml: decode(bytes), kind: "mxl", inner };
  }
  return { xml: decode(buf), kind: "musicxml", inner: null };
}

/** Read a score file. Returns { doc, kind: "musicxml" | "mxl", inner }. */
export function readScore(path) {
  const { xml, kind, inner } = readScoreText(path);
  let doc;
  try {
    doc = parse(xml);
  } catch (e) {
    if (e instanceof XmlError) throw new InputError(`not readable as XML: ${e.message}`);
    throw e;
  }
  if (doc.root.name === "score-timewise") {
    throw new TimewiseError("this is a score-timewise MusicXML file; only score-partwise (what every notation program exports) is supported");
  }
  if (doc.root.name !== "score-partwise") throw new InputError(`not a MusicXML score (root element is <${doc.root.name}>)`);
  return { doc, kind, inner };
}

// ---------- measuring ----------

export function partNames(root) {
  return [...iter(root, "score-part")].map((sp) => ({
    id: attr(sp, "id"),
    name: (findText(sp, "part-name") ?? "").trim(),
    abbr: (findText(sp, "part-abbreviation") ?? "").trim(),
  }));
}

const ticks = (dur, divisions, what) => new Frac(toInt(dur, what) * TICKS_PER_QUARTER, divisions);

/** Duration of a metered bar, including signatures such as 2/4 + 3/8 or 3+2/8. */
export function meterTicks(time) {
  const numerators = kids(time, "beats");
  const denominators = kids(time, "beat-type");
  if (!numerators.length || numerators.length !== denominators.length) return null;
  let length = new Frac(0);
  for (const [i, numerator] of numerators.entries()) {
    const groups = (text(numerator) ?? "").split("+").map((n) => n.trim());
    const unit = (text(denominators[i]) ?? "").trim();
    if (!groups.every((n) => /^\d+$/.test(n) && Number(n) > 0) || !/^\d+$/.test(unit) || Number(unit) === 0) return null;
    const beats = groups.reduce((sum, n) => sum + Number(n), 0);
    length = length.add(new Frac(beats * 4 * TICKS_PER_QUARTER, Number(unit)));
  }
  return length;
}

/** First <staves> of a part, like lxml part.find(".//attributes/staves"). */
export function partStaves(part) {
  for (const a of iter(part, "attributes")) {
    const st = find(a, "staves");
    if (st) return st;
  }
  return null;
}

/**
 * Per-part list of measures. Each: index (1-based), number, implicit, expected (ticks from the
 * time signature), fill (furthest position reached), heads (pitched noteheads incl. chord members
 * and grace notes), onsets, tremolo counts, staffHeads, notes.
 */
export function analyse(root) {
  const result = new Map();
  for (const part of kids(root, "part")) {
    const pid = attr(part, "id");
    let divisions = 1;
    let expected = new Frac(4 * TICKS_PER_QUARTER);
    const measures = [];
    kids(part, "measure").forEach((m, k) => {
      const where = `part ${pid}, measure ${attr(m, "number") ?? k + 1}`;
      let pos = new Frac(0);
      let lastStart = new Frac(0);
      let fill = new Frac(0);
      let heads = 0;
      let onsets = 0;
      const trem = {};
      const notes = [];
      for (const el of kids(m)) {
        if (el.name === "attributes") {
          const d = findText(el, "divisions");
          if (d) divisions = toInt(d, `divisions in ${where}`);
          const t = find(el, "time");
          if (t) expected = meterTicks(t) ?? expected;
        } else if (el.name === "backup") {
          pos = pos.sub(ticks(findText(el, "duration"), divisions, `backup duration in ${where}`));
        } else if (el.name === "forward") {
          pos = pos.add(ticks(findText(el, "duration"), divisions, `forward duration in ${where}`));
          if (pos.gt(fill)) fill = pos;
        } else if (el.name === "note") {
          const isRest = !!find(el, "rest");
          const isChord = !!find(el, "chord");
          const isGrace = !!find(el, "grace");
          const v = findText(el, "voice") || "1";
          const stf = findText(el, "staff") || "1";
          const dtext = findText(el, "duration");
          const d = dtext && !isGrace ? ticks(dtext, divisions, `note duration in ${where}`) : new Frac(0);
          for (const tr of iter(el, "tremolo")) {
            const ty = attr(tr, "type") || "single";
            trem[ty] = (trem[ty] ?? 0) + 1;
          }
          let start;
          if (isChord) start = lastStart;
          else {
            start = pos;
            lastStart = pos;
            pos = pos.add(d);
            if (pos.gt(fill)) fill = pos;
          }
          if (!isRest) {
            heads++;
            if (!isChord) onsets++;
          }
          notes.push({ start, dur: d, voice: v, rest: isRest, chord: isChord, grace: isGrace, staff: stf });
        }
      }
      const staffHeads = {};
      for (const n of notes) if (!n.rest) staffHeads[n.staff] = (staffHeads[n.staff] ?? 0) + 1;
      measures.push({
        index: k + 1,
        number: attr(m, "number"),
        implicit: attr(m, "implicit") === "yes",
        expected,
        fill,
        heads,
        onsets,
        tremolo: trem,
        staffHeads,
        notes,
      });
    });
    result.set(pid, measures);
  }
  return result;
}

/** [partId, staffNumber] in Sibelius staff order. */
export function staffMap(root) {
  const out = [];
  for (const part of kids(root, "part")) {
    const st = partStaves(part);
    const n = st ? toInt(text(st), "staves") : 1;
    for (let k = 1; k <= n; k++) out.push([attr(part, "id"), String(k)]);
  }
  return out;
}

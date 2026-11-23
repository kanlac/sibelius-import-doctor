// Offline tests for the in-Sibelius check (no Sibelius needed).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPTS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "plugins", "sibelius-import-doctor", "skills", "sibelius-import-doctor", "scripts");
const { parseXml, loadScore, analyseScore, compare, compareToOriginal, loadChanges, locate, buildComments } = await import(path.join(SCRIPTS, "connect.mjs"));

const SCORE = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="4.0">
  <!-- a comment with <tags> inside -->
  <part-list>
    <score-part id="P1"><part-name>Flute &amp; Piccolo</part-name></score-part>
    <score-part id="P2"><part-name>Piano</part-name></score-part>
  </part-list>
  <part id="P1">
    <measure number="0" implicit="yes">
      <attributes><divisions>2</divisions><time><beats>3</beats><beat-type>4</beat-type></time></attributes>
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice></note>
    </measure>
    <measure number="1">
      <note><grace/><pitch><step>A</step><octave>4</octave></pitch><voice>1</voice></note>
      <note><pitch><step>B</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice><notations><ornaments><tremolo type="unmeasured">0</tremolo></ornaments></notations></note>
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>2</duration><voice>1</voice><notations><ornaments><tremolo type="start">2</tremolo></ornaments></notations></note>
      <note><pitch><step>E</step><octave>5</octave></pitch><duration>2</duration><voice>1</voice><notations><ornaments><tremolo type="stop">2</tremolo></ornaments></notations></note>
    </measure>
  </part>
  <part id="P2">
    <measure number="0" implicit="yes">
      <attributes><divisions>1</divisions><staves>2</staves><time><beats>3</beats><beat-type>4</beat-type></time></attributes>
      <note><rest/><duration>1</duration><voice>1</voice><staff>1</staff></note>
    </measure>
    <measure number="1">
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>3</duration><voice>1</voice><staff>1</staff></note>
      <note><chord/><pitch><step>E</step><octave>4</octave></pitch><duration>3</duration><voice>1</voice><staff>1</staff></note>
      <backup><duration>3</duration></backup>
      <note><pitch><step>C</step><octave>3</octave></pitch><duration>3</duration><voice>5</voice><staff>2</staff></note>
    </measure>
  </part>
</score-partwise>
`;

function tmpFile(name, data) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sid-test-"));
  const p = path.join(dir, name);
  fs.writeFileSync(p, data);
  return p;
}

// Rows as the plug-in returns them: [staff, bar, pos, dur, voice, noteCount, tl, tr, dtrem, strem, grace]
const PERFECT = [
  [1, 1, 0, 256, 1, 1, 0, 0, 0, 0, 0],
  [1, 2, 0, 256, 1, 1, 0, 0, 0, 0, 1],
  [1, 2, 0, 256, 1, 1, 0, 0, 0, 3, 0],
  [1, 2, 256, 256, 1, 1, 0, 0, 2, 0, 0],
  [1, 2, 512, 256, 1, 1, 0, 0, 0, 0, 0],
  [2, 1, 0, 256, 1, 0, 0, 0, 0, 0, 0],
  [2, 2, 0, 768, 1, 2, 0, 0, 0, 0, 0],
  [3, 2, 0, 768, 1, 1, 0, 0, 0, 0, 0],
];
const INFO = { ok: true, staffCount: 3 };
const LENGTHS = [256, 768];

test("parser handles doctype, comments and entities", () => {
  const doc = parseXml(SCORE);
  const root = doc.children.find((c) => c.name === "score-partwise");
  assert.ok(root);
  const name = root.children[0].children[0].children[0];
  assert.equal(name.text, "Flute & Piccolo");
});

test("analysis expands staves and counts chords, grace notes and tremolos", () => {
  const a = analyseScore(loadScore(tmpFile("s.musicxml", SCORE)));
  assert.deepEqual(a.staves.map((s) => [s.part, s.staffInPart]), [["P1", 1], ["P2", 1], ["P2", 2]]);
  assert.deepEqual(a.staves[0].bars.map((b) => b.heads), [1, 4]);
  assert.deepEqual(a.staves[1].bars.map((b) => b.heads), [0, 2]);
  assert.deepEqual(a.staves[2].bars.map((b) => b.heads), [0, 1]);
  assert.equal(a.staves[0].bars[1].single, 1);
  assert.equal(a.staves[0].bars[1].double, 1);
  assert.deepEqual(a.bars.map((b) => [b.number, b.intended]), [["0", 256], ["1", 768]]);
});

test("a faithful import has no problems", () => {
  const a = analyseScore(loadScore(tmpFile("s.musicxml", SCORE)));
  const c = compare(a, INFO, PERFECT, LENGTHS);
  assert.deepEqual(c.problems, []);
  assert.equal(c.xmlNotes, 8);
  assert.equal(c.sibeliusNotes, 8);
});

test("missing notes, lost tremolos, tuplet tremolos, overflow and bar length are reported", () => {
  const a = analyseScore(loadScore(tmpFile("s.musicxml", SCORE)));
  const rows = PERFECT.map((r) => r.slice());
  rows[2][9] = 0; // unmeasured tremolo dropped
  rows[3][6] = 2; rows[3][7] = 1; // two-note tremolo inside a tuplet
  rows.pop(); // the left-hand note vanished
  rows.push([3, 2, 768, 512, 1, 0, 0, 0, 0, 0, 0]); // a rest running past the bar line
  const c = compare(a, INFO, rows, [256, 1024]);
  const kinds = c.problems.map((p) => `${p.staff}:${p.bar}:${p.kind}`).sort();
  assert.deepEqual(kinds, ["1:2:bar-length", "1:2:tremolo-missing", "1:2:two-note-tremolo-in-tuplet", "3:2:notes-missing", "3:2:voice-overflow"].sort());
  assert.equal(c.lost, 1);
});

test("comments cover changed, unfixed, differing and mis-imported bars", () => {
  const a = analyseScore(loadScore(tmpFile("s.musicxml", SCORE)));
  const changesFile = tmpFile("c.json", JSON.stringify({
    changed: [{ part: "P1", measure: "1", text: "two-note tremolo rewritten" }],
    unfixed: [{ part: "P2", measure: "1", staff: 2, text: "voice 5 could not be shortened" }, { part: "P9", measure: "1", text: "nowhere" }],
  }));
  const ch = loadChanges(changesFile);
  assert.deepEqual(locate(a, ch.changed[0]), { staff: 1, bar: 2, measure: "1", part: "Flute & Piccolo" });
  assert.equal(locate(a, ch.unfixed[1]), null);
  const rows = PERFECT.filter((r) => r[0] !== 3);
  const c = compare(a, INFO, rows, LENGTHS);
  const vs = compareToOriginal(a, c.cells, LENGTHS.length);
  const items = [
    { ...locate(a, ch.changed[0]), source: "changed", text: ch.changed[0].text },
    { ...locate(a, ch.unfixed[0]), source: "unfixed", text: ch.unfixed[0].text },
    ...vs.bars.map((p) => ({ ...p, source: "differs-from-original" })),
    ...c.problems.map((p) => ({ ...p, source: "import" })),
  ];
  const comments = buildComments(items);
  assert.equal(comments.length, 2);
  assert.equal(comments[0].text, "Fixed: two-note tremolo rewritten.");
  assert.match(comments[1].text, /^Not fixed: voice 5 could not be shortened\. Still differs from your file: 1 note missing \(your file has 1, Sibelius shows 0\)\. Sibelius did not import this as the fixed file says: /);
});

test(".mxl archives are read through META-INF/container.xml", () => {
  const entries = [
    ["META-INF/container.xml", '<container><rootfiles><rootfile full-path="score/main.musicxml"/></rootfiles></container>'],
    ["score/main.musicxml", SCORE],
  ];
  const locals = [], centrals = [];
  let offset = 0;
  for (const [name, text] of entries) {
    const data = zlib.deflateRawSync(Buffer.from(text));
    const nameBuf = Buffer.from(name);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8); local.writeUInt32LE(data.length, 18); local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(8, 10); central.writeUInt32LE(data.length, 20); central.writeUInt16LE(nameBuf.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 10); eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  const file = tmpFile("s.mxl", Buffer.concat([...locals, cd, eocd]));
  const a = analyseScore(loadScore(file));
  assert.equal(a.staves.length, 3);
});

test("config stores and validates the import-dialog choice", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sid-config-"));
  const run = (...args) => {
    try {
      return JSON.parse(execFileSync(process.execPath, [path.join(SCRIPTS, "config.mjs"), ...args], { env: { ...process.env, SIBELIUS_IMPORT_DOCTOR_CONFIG_DIR: dir }, encoding: "utf8" }));
    } catch (e) {
      return JSON.parse(e.stdout);
    }
  };
  assert.equal(run("get", "importDialog").value, null);
  assert.equal(run("set", "importDialog", "agent-clicks").value, "agent-clicks");
  assert.equal(run("get", "importDialog").value, "agent-clicks");
  assert.ok(run("set", "importDialog", "maybe").error);
  assert.ok(run("get", "nope").error);
  assert.equal(run("get", "importDialog").value, "agent-clicks");
});

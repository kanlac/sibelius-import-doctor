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
const { parseXml, loadScore, analyseScore, compare, compareToOriginal, loadChanges, locate, buildComments, doctorItems, LEVEL_COLOR, parseBoxes, openBoxSay, HARMLESS_BOXES } = await import(path.join(SCRIPTS, "connect.mjs"));

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
  assert.equal(a.parts[0].bars[1].single, 1);
  assert.equal(a.parts[0].bars[1].double, 1);
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
  assert.deepEqual(kinds, ["3:2:bar-length", "1:2:tremolo-missing", "1:2:two-note-tremolo-in-tuplet", "3:2:notes-missing", "3:2:voice-overflow"].sort());
  assert.equal(c.lost, 1);
});

test("comments are graded, short, and drop a count that repeats the import finding", () => {
  const a = analyseScore(loadScore(tmpFile("s.musicxml", SCORE)));
  const changesFile = tmpFile("c.json", JSON.stringify({
    changed: [{ part: "P1", measure: "1", text: "two-note tremolo rewritten" }],
    unfixed: [{ part: "P2", measure: "1", staff: 2, text: "voice 5 could not be shortened" }, { part: "P9", measure: "1", text: "nowhere" }],
  }));
  const ch = loadChanges(changesFile);
  assert.deepEqual(locate(a, ch.changed[0]), { staff: 1, bar: 2, measure: "1", part: "Flute & Piccolo" });
  assert.equal(locate(a, ch.unfixed[1]), null);
  const unplaced = [];
  const rows = PERFECT.filter((r) => r[0] !== 3);
  const c = compare(a, INFO, rows, LENGTHS);
  const vs = compareToOriginal(a, c.cells, LENGTHS.length);
  const items = [
    ...doctorItems(ch, a, unplaced),
    ...vs.bars.map((p) => ({ ...p, source: "differs-from-original" })),
    ...c.problems.map((p) => ({ ...p, source: "import" })),
  ];
  assert.equal(unplaced.length, 1);
  const comments = buildComments(items);
  assert.equal(comments.length, 2);
  assert.equal(comments[0].text, "Doctor 1: two-note tremolo rewritten");
  assert.equal(comments[0].level, 1);
  assert.equal(comments[0].color, LEVEL_COLOR[1]);
  assert.equal(comments[1].level, 3);
  assert.equal(comments[1].staff, 3);
  assert.equal(comments[1].text, "Doctor 3: 1 note missing (file 3, Sibelius 2, all staves of the part): lost on import; voice 5 could not be shortened");
});

test("a repeated kind in the same part is only named the second time", () => {
  const item = (bar) => ({ staff: 1, bar, measure: String(bar), part: "Violin", source: "import", kind: "tuplet-lost", short: "tuplet lost (1 note)", explain: "the rhythm is off" });
  const comments = buildComments([item(3), item(7), { ...item(9), part: "Viola" }]);
  assert.deepEqual(comments.map((g) => g.text), [
    "Doctor 2: tuplet lost (1 note): the rhythm is off",
    "Doctor 2: same: tuplet lost (1 note)",
    "Doctor 2: tuplet lost (1 note): the rhythm is off",
  ]);
});

test("a note Sibelius puts on the other staff of the same part is not a loss", () => {
  const a = analyseScore(loadScore(tmpFile("s.musicxml", SCORE)));
  const rows = PERFECT.map((r) => r.slice());
  rows[6][5] = 1; // right hand shows one note of its chord ...
  rows.push([3, 2, 0, 768, 2, 1, 0, 0, 0, 0, 0]); // ... the other on the left-hand staff
  const c = compare(a, INFO, rows, LENGTHS);
  assert.deepEqual(c.problems, []);
  assert.equal(c.lost, 0);
  assert.equal(c.gained, 0);
  assert.equal(c.movedBetweenStaves, 1);
  assert.deepEqual(compareToOriginal(a, c.cells, LENGTHS.length).bars, []);
});

test("a tremolo on a chord spread over both staves counts once, as Sibelius shows it", () => {
  const xml = SCORE.replace('<note><pitch><step>C</step><octave>3</octave></pitch><duration>3</duration><voice>5</voice><staff>2</staff></note>',
    '<note><chord/><pitch><step>C</step><octave>3</octave></pitch><duration>3</duration><voice>1</voice><staff>2</staff><notations><ornaments><tremolo type="single">3</tremolo></ornaments></notations></note>')
    .replace('<note><chord/><pitch><step>E</step><octave>4</octave></pitch><duration>3</duration><voice>1</voice><staff>1</staff></note>',
    '<note><chord/><pitch><step>E</step><octave>4</octave></pitch><duration>3</duration><voice>1</voice><staff>1</staff><notations><ornaments><tremolo type="single">3</tremolo></ornaments></notations></note>')
    .replace("<backup><duration>3</duration></backup>", "");
  const a = analyseScore(loadScore(tmpFile("x.musicxml", xml)));
  assert.equal(a.parts[1].bars[1].single, 1);
  const rows = PERFECT.filter((r) => r[0] !== 3).map((r) => r.slice());
  rows[6][5] = 3; rows[6][9] = 3; // one chord of three notes with a tremolo, all on the right-hand staff
  const c = compare(a, INFO, rows, LENGTHS);
  assert.deepEqual(c.problems, []);
  assert.equal(c.movedBetweenStaves, 1);
});

test("chord members without <voice> belong to the chord's voice (one tremolo per chord)", () => {
  const xml = SCORE.replace('<note><pitch><step>C</step><octave>3</octave></pitch><duration>3</duration><voice>5</voice><staff>2</staff></note>',
    '<note><pitch><step>C</step><octave>3</octave></pitch><duration>3</duration><voice>5</voice><staff>2</staff><notations><ornaments><tremolo type="single">3</tremolo></ornaments></notations></note>' +
    '<note><chord/><pitch><step>G</step><octave>3</octave></pitch><duration>3</duration><staff>2</staff><notations><ornaments><tremolo type="single">3</tremolo></ornaments></notations></note>');
  const a = analyseScore(loadScore(tmpFile("v.musicxml", xml)));
  assert.equal(a.parts[1].bars[1].single, 1);
});

function oneBar(notes) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Flute</part-name></score-part></part-list>
<part id="P1"><measure number="1"><attributes><divisions>12</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>
${notes}
</measure></part></score-partwise>`;
}
const TRIPLET = '<note><pitch><step>C</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><type>eighth</type><time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification></note>';
const tripletRows = () => Array.from({ length: 12 }, (_, i) => [1, 1, Math.floor((i * 256) / 3), 128, 1, 1, 3, 2, 0, 0, 0]);

test("a bar of triplets a tick longer in Sibelius is rounding, not a problem", () => {
  const a = analyseScore(loadScore(tmpFile("t.musicxml", oneBar(TRIPLET.repeat(12)))));
  assert.equal(a.parts[0].bars[0].tuplets, 12);
  const c = compare(a, { ok: true, staffCount: 1 }, tripletRows(), [1025]);
  assert.deepEqual(c.problems, []);
  assert.equal(c.barLengthWithinTupletRounding, 1);
});

test("a triplet note shown as a plain eighth is reported once, with the longer bar", () => {
  const a = analyseScore(loadScore(tmpFile("t.musicxml", oneBar(TRIPLET.repeat(12)))));
  const rows = tripletRows();
  rows[11][6] = 0; rows[11][7] = 0; // the last note lost its tuplet: 128 ticks instead of 85.33
  const c = compare(a, { ok: true, staffCount: 1 }, rows, [1067]);
  assert.deepEqual(c.problems.map((p) => p.kind), ["tuplet-lost"]);
  assert.equal(c.problems[0].short, "tuplet lost (1 note), bar lasts 4.17 quarters (file 4)");
  assert.ok(c.evidence[1].rows.length === 12);
});

test("an overlong bar is still reported (notes past the bar line, no tuplets)", () => {
  const q = '<note><pitch><step>D</step><octave>5</octave></pitch><duration>12</duration><voice>1</voice><type>quarter</type></note>';
  const a = analyseScore(loadScore(tmpFile("o.musicxml", oneBar(q.repeat(5)))));
  const rows = [0, 256, 512, 768].map((pos) => [1, 1, pos, 256, 1, 1, 0, 0, 0, 0, 0]);
  const c = compare(a, { ok: true, staffCount: 1 }, rows, [1024]);
  assert.deepEqual(c.problems.map((p) => p.kind).sort(), ["bar-length", "notes-missing"]);
  assert.equal(c.lost, 1);
});

test("the doctor's report.json: harmless rest changes get no comment, note and tremolo changes do", () => {
  const a = analyseScore(loadScore(tmpFile("s.musicxml", SCORE)));
  const report = tmpFile("r.report.json", JSON.stringify({
    log: [
      { part: "P1", measure: 2, number: "1", fix: "measure-rest" },
      { part: "P2", measure: 2, number: "1", fix: "pad", staff: "2" },
      { part: "P1", measure: 2, number: "1", fix: "tremolo-pair" },
      { part: "P1", measure: 2, number: "1", fix: "trim-delete", deleted_noteheads: 2 },
      { part: "P1", fix: "abbreviation" },
    ],
    found: [
      { kind: "overlong-rest", fixed: false, where: [{ part_id: "P1", part: "Flute", bars: ["1"] }] },
      { kind: "unmeasured-tremolo", fixed: false, where: [{ part_id: "P2", part: "Piano", bars: ["1"] }] },
    ],
  }));
  const ch = loadChanges(report);
  assert.equal(ch.harmless, 2);
  assert.equal(ch.changed.length, 2);
  assert.equal(ch.unfixed.length, 1);
  const comments = buildComments(doctorItems(ch, a));
  assert.equal(comments.length, 2);
  assert.equal(comments[0].text, "Doctor 1: two-note tremolo rewritten: so Sibelius draws it correctly; 2 notes past the bar line removed: Sibelius would have dropped them");
  assert.equal(comments[1].staff, 2);
  assert.equal(comments[1].level, 2);
  assert.match(comments[1].text, /^Doctor 2: unmeasured tremolo left as is: Sibelius may drop it$/);
});

test("bars the doctor kept longer than the time signature are commented at level 2 on the overlong part", () => {
  const a = analyseScore(loadScore(tmpFile("s.musicxml", SCORE)));
  const report = tmpFile("pad.report.json", JSON.stringify({
    log: [{ part: "P2", measure: 2, number: "1", fix: "pad", staff: "1" }],
    found: [{ kind: "overlong-bar", fixed: true, where: [{ part_id: "P1", part: "Flute", bars: ["1"] }] }],
    needs_attention: [
      { kind: "bars-longer-than-time-signature", message: "These bars were kept longer...", bars: ["1"] },
      { kind: "composer-unknown", message: "The file has no composer." },
    ],
  }));
  const ch = loadChanges(report);
  assert.equal(ch.harmless, 1);
  const comments = buildComments(doctorItems(ch, a));
  assert.equal(comments.length, 1);
  assert.equal(comments[0].staff, 1);
  assert.equal(comments[0].part, "Flute & Piccolo");
  assert.equal(comments[0].text, "Doctor 2: bar longer than the time signature: one note value is probably wrong; compare with the original");
});

test("notes the doctor removed are level 2 (compare with the original), replacing the level-1 change", () => {
  const a = analyseScore(loadScore(tmpFile("s.musicxml", SCORE)));
  const report = tmpFile("trim.report.json", JSON.stringify({
    log: [{ part: "P1", measure: 2, number: "1", fix: "trim-delete", deleted_noteheads: 1 }],
    found: [],
    needs_attention: [{ kind: "notes-removed", message: "...", where: [{ part: "Flute & Piccolo", bars: ["1"], notes: 1 }] }],
  }));
  const comments = buildComments(doctorItems(loadChanges(report), a));
  assert.deepEqual(comments.map((g) => g.text), ["Doctor 2: notes past the bar line removed: compare with the original"]);
});

test("a bar Sibelius cut short is reported on the part whose music sets its length, with what to do", () => {
  const two = (staffNotes) => `<?xml version="1.0"?><score-partwise version="4.0"><part-list>
<score-part id="P1"><part-name>Flute</part-name></score-part><score-part id="P2"><part-name>Oboe</part-name></score-part></part-list>
<part id="P1"><measure number="1"><attributes><divisions>1</divisions><time><beats>2</beats><beat-type>4</beat-type></time></attributes>${staffNotes[0]}</measure></part>
<part id="P2"><measure number="1"><attributes><divisions>1</divisions><time><beats>2</beats><beat-type>4</beat-type></time></attributes>${staffNotes[1]}</measure></part></score-partwise>`;
  const q = '<note><pitch><step>C</step><octave>5</octave></pitch><duration>1</duration><voice>1</voice><type>quarter</type></note>';
  const a = analyseScore(loadScore(tmpFile("cut.musicxml", two([q.repeat(2), q.repeat(3)]))));
  const rows = [[1, 1, 0, 256, 1, 1, 0, 0, 0, 0, 0], [1, 1, 256, 256, 1, 1, 0, 0, 0, 0, 0], [2, 1, 0, 256, 1, 1, 0, 0, 0, 0, 0], [2, 1, 256, 256, 1, 1, 0, 0, 0, 0, 0]];
  const c = compare(a, { ok: true, staffCount: 2 }, rows, [384]);
  const len = c.problems.find((p) => p.kind === "bar-length");
  assert.equal(len.staff, 2);
  assert.equal(len.part, "Oboe");
  assert.equal(len.text, "bar lasts 1.5 quarters in Sibelius (file 3): Sibelius cut the bar; compare the rhythm with the original");
});

test("the installer only upgrades, and says so when it keeps a newer plug-in", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sid-plugins-"));
  const run = (...args) => JSON.parse(execFileSync(process.execPath, [path.join(SCRIPTS, "plugin", "install.mjs"), ...args], { env: { ...process.env, SIBELIUS_PLUGINS_DIR: dir }, encoding: "utf8" }));
  const first = run();
  assert.equal(first.changed, true);
  const file = first.path;
  const newer = fs.readFileSync(file).toString("utf16le").replace(/'plugin', '[^']*'/, "'plugin', '99.0.0'");
  fs.writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(newer.slice(1), "utf16le")]));
  const kept = run();
  assert.equal(kept.changed, false);
  assert.equal(kept.installedVersion, "99.0.0");
  assert.equal(kept.current, true);
  assert.match(kept.note, /newer than this copy/);
  const older = newer.replace("'99.0.0'", "'0.0.1'");
  fs.writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(older.slice(1), "utf16le")]));
  assert.equal(run().changed, true);
});

test("the same finding in one bar in several parts becomes one comment on the topmost staff", () => {
  const attn = (staff, part, bar) => ({ staff, bar, measure: String(bar), part, source: "attention", kind: "bars-longer-than-time-signature", short: "bar longer than the time signature", explain: "compare with the original", level: 2 });
  const missing = { staff: 4, bar: 6, measure: "6", part: "Harp", source: "import", kind: "notes-missing", short: "1 note missing (file 4, Sibelius 3)", explain: "lost on import" };
  const comments = buildComments([attn(5, "Oboe 2", 6), attn(2, "Flute 1", 6), attn(7, "Clarinet 1", 6), attn(9, "Horn", 6), missing, attn(2, "Flute 1", 7), attn(3, "Flute 2", 7)]);
  assert.deepEqual(comments.map((g) => [g.bar, g.staff, g.level]), [[6, 2, 2], [6, 4, 3], [7, 2, 2]]);
  assert.equal(comments[0].text, "Doctor 2: bar longer than the time signature in 4 parts (Oboe 2, Flute 1, Clarinet 1, +1 more): compare with the original");
  assert.deepEqual(comments[0].parts, ["Oboe 2", "Flute 1", "Clarinet 1", "Horn"]);
  assert.equal(comments[2].text, "Doctor 2: same: bar longer than the time signature in 2 parts (Flute 1, Flute 2)");
});

test("Sibelius' own boxes are recognised from the window list; only known harmless ones may be clicked", () => {
  const listing = "AXFloatingWindow\tKeypad\nAXStandardWindow\tSong - Sibelius\nAXDialog\tMissing Fonts\nAXDialog\tQuick Start\nAXDialog\t\n";
  assert.deepEqual(parseBoxes(listing), ["Missing Fonts", ""]);
  assert.deepEqual(parseBoxes("AXStandardWindow\tSong\n"), []);
  assert.ok(HARMLESS_BOXES.has("Missing Fonts"));
  assert.equal(HARMLESS_BOXES.has(""), false);
  assert.equal(openBoxSay(["Missing Fonts"]), "Sibelius is showing a box (Missing Fonts); please click OK on it, then I will continue.");
  assert.match(openBoxSay([""]), /^Sibelius is showing a box; please close it/);
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

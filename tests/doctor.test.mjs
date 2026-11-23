import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DOCTOR, SCRIPTS, fixture, read, tmp, zip } from "./helpers.mjs";

const { analyse, readScore } = await import(join(SCRIPTS, "lib", "score.mjs"));
const { parse, iter, find, findText, attr, text, kids } = await import(join(SCRIPTS, "lib", "xml.mjs"));

function doctor(args) {
  const r = spawnSync(process.execPath, [DOCTOR, ...args], { encoding: "utf8" });
  const lines = r.stdout.trim().split("\n");
  assert.equal(lines.length, 1, `expected one line of JSON, got: ${r.stdout}${r.stderr}`);
  return { code: r.status, out: JSON.parse(lines[0]), stderr: r.stderr };
}

const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const fixedRoot = (out) => parse(read(out.fixed)).root;
const bar = (root, pid, index) => analyse(root).get(pid)[index - 1];

test("never touches the original and writes the three outputs", () => {
  const dir = tmp();
  const src = join(dir, "score.musicxml");
  copyFileSync(fixture("overlong"), src);
  const before = sha(src);
  const { code, out } = doctor([src, dir]);
  assert.equal(code, 0);
  assert.equal(sha(src), before);
  assert.notEqual(out.fixed, src);
  for (const p of [out.fixed, out.report, out.report_json]) assert.ok(existsSync(p), p);
  assert.deepEqual(readdirSync(dir).sort(), ["score.fixed.musicxml", "score.musicxml", "score.report.json", "score.report.md"]);
});

test("every output re-parses and is still score-partwise MusicXML", () => {
  for (const name of ["overlong", "piano-two-staves", "tremolos", "pickup"]) {
    for (const mode of ["pad", "trim"]) {
      const { out } = doctor([fixture(name), tmp(), "--mode", mode, "--composer", "A. Composer"]);
      const root = fixedRoot(out);
      assert.equal(root.name, "score-partwise");
      JSON.parse(read(out.report_json));
    }
  }
});

test("pad (default): bars that run long keep every note, and every part is made as long as the longest", () => {
  const { out } = doctor([fixture("overlong"), tmp()]);
  assert.equal(out.mode, "pad");
  assert.equal(out.notes_removed, 0);
  const root = fixedRoot(out);
  const src = readScore(fixture("overlong")).doc.root;
  const heads = (r) => [...analyse(r).values()].flat().reduce((s, m) => s + m.heads, 0);
  assert.equal(heads(root), heads(src));
  for (const index of [1, 2]) {
    assert.ok(bar(root, "P1", index).fill.eq(bar(root, "P2", index).fill), `bar ${index} parts equal`);
  }
  assert.ok(out.needs_attention.includes("bars-longer-than-time-signature"));
  // bar 3 of the flute ends early but was not overlong: left alone without --fill-short-bars
  assert.equal(bar(root, "P1", 3).fill.toJSON(), 768);
});

test("trim: cuts what runs past the bar line and says how many notes went", () => {
  const { out } = doctor([fixture("overlong"), tmp(), "--mode", "trim"]);
  assert.equal(out.notes_removed, 5);
  assert.ok(out.needs_attention.includes("notes-removed"));
  const root = fixedRoot(out);
  for (const pid of ["P1", "P2"]) for (const index of [1, 2, 3, 4]) {
    assert.ok(!bar(root, pid, index).fill.gt(bar(root, pid, index).expected), `${pid} bar ${index}`);
  }
  const report = JSON.parse(read(out.report_json));
  const removed = report.needs_attention.find((a) => a.kind === "notes-removed");
  assert.deepEqual(removed.where.map((w) => [w.part, w.bars, w.notes]), [["Flute", ["1"], 4], ["Violin 1", ["2"], 1]]);
});

test("a pickup bar is never stretched to a full bar", () => {
  for (const extra of [[], ["--fill-short-bars"], ["--mode", "trim"], ["--mode", "trim", "--fill-short-bars"]]) {
    const { out } = doctor([fixture("pickup"), tmp(), ...extra]);
    const root = fixedRoot(out);
    for (const pid of ["P1", "P2"]) assert.equal(bar(root, pid, 1).fill.toJSON(), 256, `${pid} ${extra}`);
  }
  const { out } = doctor([fixture("pickup"), tmp()]);
  assert.deepEqual(out.changes, {});
});

test("an empty staff in a bar that is not repaired is left alone; with --fill-short-bars it gets a bar rest", () => {
  const plain = fixedRoot(doctor([fixture("piano-two-staves"), tmp()]).out);
  assert.deepEqual(bar(plain, "P1", 1).staffHeads, { 1: 1 });
  assert.equal(bar(plain, "P1", 1).notes.length, 1);
  const filled = fixedRoot(doctor([fixture("piano-two-staves"), tmp(), "--fill-short-bars"]).out);
  const n = bar(filled, "P1", 1).notes;
  assert.equal(n.length, 2);
  assert.equal(n[1].staff, "2");
});

test("two-note tremolos: written value halved, 2:1 time modification removed; unmeasured -> three strokes", () => {
  const { out } = doctor([fixture("tremolos"), tmp()]);
  assert.equal(out.changes["tremolo-pair"], 6);
  assert.equal(out.changes.unmeasured, 3);
  const root = fixedRoot(out);
  const pairs = [...iter(root, "tremolo")].filter((t) => ["start", "stop"].includes(attr(t, "type")));
  const types = pairs.map((t) => findText(t.parent.parent.parent, "type"));
  assert.deepEqual(types, ["half", "half", "quarter", "quarter", "eighth", "eighth"]);
  for (const t of pairs) assert.equal(find(t.parent.parent.parent, "time-modification"), null);
  const singles = [...iter(root, "tremolo")].filter((t) => attr(t, "type") === "single");
  assert.deepEqual(singles.map((t) => text(t)), ["3", "3", "3", "3"]);
  assert.equal([...iter(root, "tremolo")].filter((t) => attr(t, "type") === "unmeasured").length, 0);
  // durations (what is played) are unchanged
  const src = readScore(fixture("tremolos")).doc.root;
  const durs = (r) => [...iter(r, "note")].map((n) => findText(n, "duration"));
  assert.deepEqual(durs(root), durs(src));
});

test("the tremolo fixes can be switched off", () => {
  const { out } = doctor([fixture("tremolos"), tmp(), "--no-tremolo", "--no-unmeasured"]);
  assert.equal(out.changes["tremolo-pair"], undefined);
  assert.equal(out.changes.unmeasured, undefined);
  assert.deepEqual(out.found.filter((p) => p.kind.includes("tremolo")).map((p) => p.fixed), [false, false]);
});

test("parts without a short name are reported, and nothing is made up", () => {
  const { out } = doctor([fixture("tremolos"), tmp()]);
  const p = out.found.find((x) => x.kind === "missing-abbreviation");
  assert.equal(p.fixed, false);
  assert.deepEqual(p.parts, [{ id: "P1", name: "Violoncello" }, { id: "P2", name: "Timpani" }]);
  assert.ok(out.needs_attention.includes("short-names-missing"));
  assert.equal(out.changes.abbreviation, undefined);
  const root = fixedRoot(out);
  assert.deepEqual([...iter(root, "score-part")].map((sp) => find(sp, "part-abbreviation")), [null, null]);
  assert.match(read(out.report), /no short names were given/);
});

test("--short-name applies the given names right after the part name", () => {
  const { out } = doctor([fixture("tremolos"), tmp(), "--short-name", "P1=Vc.", "--short-name", "P2 = Timp."]);
  assert.equal(out.found.find((x) => x.kind === "missing-abbreviation").fixed, true);
  assert.equal(out.changes.abbreviation, 2);
  assert.ok(!out.needs_attention.includes("short-names-missing"));
  const sp = [...iter(fixedRoot(out), "score-part")];
  assert.deepEqual(sp.map((s) => findText(s, "part-abbreviation")), ["Vc.", "Timp."]);
  assert.deepEqual(kids(sp[0]).map((e) => e.name), ["part-name", "part-abbreviation"]);
});

test("--short-names reads a JSON file; --short-name wins over it; some parts may stay without", () => {
  const dir = tmp();
  const f = join(dir, "names.json");
  writeFileSync(f, JSON.stringify({ P1: "Vlc.", P2: "Pk." }));
  const both = doctor([fixture("tremolos"), dir, "--short-names", f, "--short-name", "P1=Vc."]).out;
  assert.deepEqual([...iter(fixedRoot(both), "score-part")].map((s) => findText(s, "part-abbreviation")), ["Vc.", "Pk."]);
  writeFileSync(f, JSON.stringify({ P2: "Timp." }));
  const partial = doctor([fixture("tremolos"), tmp(), "--short-names", f]).out;
  const p = partial.found.find((x) => x.kind === "missing-abbreviation");
  assert.equal(p.fixed, false);
  assert.deepEqual(p.parts, [{ id: "P1", name: "Violoncello" }]);
  assert.ok(partial.needs_attention.includes("short-names-missing"));
});

test("an existing short name is never replaced", () => {
  const { out } = doctor([fixture("overlong"), tmp(), "--short-name", "P1=Fl.", "--short-name", "P2=V1"]);
  const root = fixedRoot(out);
  assert.deepEqual([...iter(root, "score-part")].map((sp) => findText(sp, "part-abbreviation")), ["Fl.", "Vln. 1"]);
  assert.equal(out.warnings.length, 1);
  assert.match(out.warnings[0], /P2.*already has the short name "Vln. 1"/);
});

test("bad short-name arguments stop with exit code 2", () => {
  const dir = tmp();
  for (const args of [["--short-name", "P9=X."], ["--short-name", "P1"], ["--short-name", "P1="], ["--short-names", join(dir, "missing.json")]]) {
    const r = doctor([fixture("tremolos"), dir, ...args]);
    assert.equal(r.code, 2, args.join(" "));
    assert.equal(r.out.ok, false);
  }
  const f = join(dir, "list.json");
  writeFileSync(f, '["Vc."]');
  assert.equal(doctor([fixture("tremolos"), dir, "--short-names", f]).code, 2);
});

test("composer: reported when missing, filled only when given", () => {
  const a = doctor([fixture("overlong"), tmp()]).out;
  assert.deepEqual(a.found.find((p) => p.kind === "missing-composer"), { kind: "missing-composer", fixed: false });
  assert.ok(a.needs_attention.includes("composer-unknown"));
  const b = doctor([fixture("tremolos"), tmp(), "--composer", "Clara Example"]).out;
  assert.equal(b.found.find((p) => p.kind === "missing-composer").fixed, true);
  const creators = [...iter(fixedRoot(b), "creator")];
  assert.deepEqual(creators.map((c) => [attr(c, "type"), text(c)]), [["composer", "Clara Example"]]);
});

test("running again on the fixed file changes nothing", () => {
  for (const name of ["overlong", "piano-two-staves", "tremolos", "pickup"]) {
    for (const mode of ["pad", "trim"]) {
      const first = doctor([fixture(name), tmp(), "--mode", mode, "--composer", "A. Composer"]).out;
      const second = doctor([first.fixed, tmp(), "--mode", mode, "--composer", "A. Composer"]).out;
      assert.deepEqual(second.changes, {}, `${name} ${mode}`);
      assert.equal(read(second.fixed), read(first.fixed), `${name} ${mode}`);
    }
  }
});

test(".mxl input (stored and deflated entries) gives the same result as the plain file", () => {
  const dir = tmp();
  const xml = readFileSync(fixture("tremolos"));
  const container = Buffer.from('<?xml version="1.0" encoding="UTF-8"?>\n<container><rootfiles><rootfile full-path="score/tremolos.musicxml" media-type="application/vnd.recordare.musicxml+xml"/></rootfiles></container>');
  for (const deflate of [false, true]) {
    const p = join(dir, `t-${deflate}.mxl`);
    writeFileSync(p, zip([
      { name: "mimetype", data: Buffer.from("application/vnd.recordare.musicxml"), deflate: false },
      { name: "META-INF/container.xml", data: container, deflate },
      { name: "score/tremolos.musicxml", data: xml, deflate },
    ]));
    const z = doctor([p, join(dir, String(deflate))]).out;
    const plain = doctor([fixture("tremolos"), join(dir, `plain-${deflate}`)]).out;
    assert.equal(read(z.fixed), read(plain.fixed));
    assert.ok(z.fixed.endsWith(`t-${deflate}.fixed.musicxml`));
  }
});

test("UTF-16 input gives the same result as UTF-8", () => {
  const dir = tmp();
  const p = join(dir, "u16.musicxml");
  const s = read(fixture("overlong")).replace('encoding="UTF-8"', 'encoding="UTF-16"');
  writeFileSync(p, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s, "utf16le")]));
  const a = doctor([p, dir]).out;
  const b = doctor([fixture("overlong"), tmp()]).out;
  assert.equal(read(a.fixed), read(b.fixed));
});

test("--dry-run reports and writes nothing", () => {
  const dir = join(tmp(), "out");
  const { code, out } = doctor([fixture("tremolos"), dir, "--dry-run"]);
  assert.equal(code, 0);
  assert.equal(out.fixed, null);
  assert.equal(existsSync(dir), false);
  assert.deepEqual(out.found.map((p) => p.kind), ["two-note-tremolo", "unmeasured-tremolo", "missing-abbreviation", "missing-composer"]);
  assert.deepEqual(out.needs_attention, ["short-names-missing", "composer-unknown"]);
});

test("bad input: one line of JSON with ok false and exit code 2", () => {
  const dir = tmp();
  const missing = doctor([join(dir, "nope.musicxml"), dir]);
  assert.equal(missing.code, 2);
  assert.equal(missing.out.ok, false);
  const notXml = join(dir, "x.musicxml");
  writeFileSync(notXml, "<score-partwise><part></score-partwise>");
  assert.equal(doctor([notXml, dir]).code, 2);
  const timewise = join(dir, "tw.musicxml");
  writeFileSync(timewise, '<?xml version="1.0"?><score-timewise version="4.0"><part-list/></score-timewise>');
  const tw = doctor([timewise, dir]);
  assert.equal(tw.code, 2);
  assert.match(tw.out.error, /timewise/);
  const entity = join(dir, "e.musicxml");
  writeFileSync(entity, "<score-partwise>&nbsp;</score-partwise>");
  assert.equal(doctor([entity, dir]).code, 2);
  assert.equal(doctor([fixture("overlong"), dir, "--mode", "stretch"]).code, 2);
  assert.equal(doctor([fixture("overlong")]).code, 2);
});

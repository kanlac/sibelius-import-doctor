// The Node port must write exactly what the original Python prototype wrote.
//
// tests/fixtures/python/ holds the prototype's output for each synthetic fixture in both modes,
// produced with: Fixer(tree, mode=<mode>, abbreviations=False, composer="Test Composer") and
// tree.write(xml_declaration=True, encoding="UTF-8", doctype=tree.docinfo.doctype) (lxml).
// Comparison is byte for byte. The prototype always padded short bars, so the port runs with
// fillShortBars here; abbreviations are off because the prototype only knew Chinese names
// (the port adds English ones and is checked separately in doctor.test.mjs).

import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { PYTHON, SCRIPTS, fixture, read } from "./helpers.mjs";

const { readScore } = await import(join(SCRIPTS, "lib", "score.mjs"));
const { serialize } = await import(join(SCRIPTS, "lib", "xml.mjs"));
const { Fixer } = await import(join(SCRIPTS, "lib", "fix.mjs"));

for (const name of ["overlong", "piano-two-staves", "tremolos"]) {
  for (const mode of ["trim", "pad"]) {
    test(`${name} (${mode}) matches the Python prototype byte for byte`, () => {
      const { doc } = readScore(fixture(name));
      const fx = new Fixer(doc, { mode, abbreviations: false, composer: "Test Composer", fillShortBars: true });
      const log = fx.run();
      assert.equal(serialize(doc), read(join(PYTHON, `${name}.${mode}.musicxml`)));
      const expected = JSON.parse(read(join(PYTHON, `${name}.${mode}.changes.json`)));
      const counts = {};
      for (const c of log) counts[c.fix] = (counts[c.fix] ?? 0) + 1;
      assert.deepEqual(counts, expected.change_counts);
      assert.equal(log.reduce((s, c) => s + (c.deleted_noteheads ?? 0), 0), expected.deleted_noteheads);
    });
  }
}

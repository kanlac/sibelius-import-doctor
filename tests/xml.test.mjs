// The XML layer must round-trip files and place edits the way lxml does (see parity.test.mjs).

import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { SCRIPTS } from "./helpers.mjs";

const x = await import(join(SCRIPTS, "lib", "xml.mjs"));

const roundTrip = (s) => x.serialize(x.parse(s));

test("declaration, doctype and trailing newline are written the way lxml writes them", () => {
  assert.equal(
    roundTrip('<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n<!DOCTYPE r PUBLIC "p" "s">\n<r/>\n'),
    "<?xml version='1.0' encoding='UTF-8'?>\n<!DOCTYPE r PUBLIC \"p\" \"s\">\n<r/>",
  );
  assert.equal(roundTrip('<!DOCTYPE r SYSTEM "s.dtd"><r/>'), "<?xml version='1.0' encoding='UTF-8'?>\n<!DOCTYPE r SYSTEM \"s.dtd\">\n<r/>");
  assert.equal(roundTrip("<r/>"), "<?xml version='1.0' encoding='UTF-8'?>\n\n<r/>");
  assert.equal(roundTrip("<!-- top -->\n<!DOCTYPE r>\n<?pi x?>\n<r/>\n<!-- after -->"), "<?xml version='1.0' encoding='UTF-8'?>\n<!-- top --><!DOCTYPE r>\n<?pi x?><r/><!-- after -->");
});

test("text and attributes are escaped like libxml2; entities and character references are decoded", () => {
  const s = "\ufeff<r a=\"x&gt;y&#10;z\tq\" b='&apos;' xmlns:k=\"u\"><![CDATA[a<b]]>&#233;&#x41; &amp; &quot;\r\n<e></e></r>";
  assert.equal(roundTrip(s), "<?xml version='1.0' encoding='UTF-8'?>\n\n<r xmlns:k=\"u\" a=\"x&gt;y&#10;z q\" b=\"'\">a&lt;béA &amp; \"\n<e/></r>");
});

test("whitespace survives a round trip untouched", () => {
  const s = "<r>\n  <a x=\"1\">t</a>\n\t<b/>  <!-- c -->\n</r>";
  assert.equal(roundTrip(s), "<?xml version='1.0' encoding='UTF-8'?>\n\n" + s);
});

test("edits follow lxml's tail rules", () => {
  const doc = x.parse("<r>\n  <a/>\n  <b/>\n  <c/>\n</r>");
  const r = doc.root;
  x.addNext(x.find(r, "a"), x.make("n")); // after a's tail, no tail of its own
  const b = x.find(r, "b");
  x.addPrevious(b, x.make("p")); // directly before b
  x.remove(r, b); // b goes with its tail
  x.append(r, x.make("z")); // after the last tail
  x.insertFirst(r, x.make("f")); // after the leading text
  assert.equal(x.serialize(doc), "<?xml version='1.0' encoding='UTF-8'?>\n\n<r>\n  <f/><a/>\n  <n/><p/><c/>\n<z/></r>");
});

test("refuses what it cannot read faithfully", () => {
  assert.throws(() => x.parse("<r>&nbsp;</r>"), /entity/);
  assert.throws(() => x.parse('<!DOCTYPE r [<!ENTITY e "x">]><r/>'), /internal subset/);
  assert.throws(() => x.parse("<r><a></r>"), /unexpected/);
  assert.throws(() => x.parse("<r/><s/>"), /more than one root/);
  assert.throws(() => x.parse("<r>a & b</r>"), /&/);
});

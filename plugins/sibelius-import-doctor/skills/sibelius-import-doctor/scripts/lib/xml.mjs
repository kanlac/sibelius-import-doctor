// Minimal XML tree with whitespace-preserving round trips.
//
// The tree keeps every text node, comment and processing instruction, so an unchanged file
// serializes back almost byte for byte. Editing helpers follow lxml's rules for where
// whitespace ends up (an element's "tail" is the text node right after it), and the serializer
// follows libxml2's output conventions, so fixed files match what the original Python
// prototype (lxml) wrote. No DTD processing: entity declarations are refused.

const NAMED = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

export class XmlError extends Error {}

function decodeEntities(s, where) {
  if (s.indexOf("&") < 0) return s;
  return s.replace(/&([^;&\s]*);?/g, (m, body) => {
    if (!m.endsWith(";")) throw new XmlError(`bad "&" in ${where}`);
    if (body[0] === "#") {
      const cp = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(cp)) throw new XmlError(`bad character reference &${body}; in ${where}`);
      return String.fromCodePoint(cp);
    }
    if (body in NAMED) return NAMED[body];
    throw new XmlError(`unknown entity &${body}; in ${where} (DTD entities are not supported)`);
  });
}

function el(name, attrs = [], parent = null) {
  return { type: "element", name, attrs, children: [], parent };
}

/** Parse an XML string into { prolog, doctype, docAt, root, epilog }. */
export function parse(input) {
  let s = input.replace(/\r\n?/g, "\n");
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  let i = 0;
  const doc = { prolog: [], doctype: null, docAt: 0, root: null, epilog: [] };
  const fail = (msg) => {
    const line = s.slice(0, i).split("\n").length;
    throw new XmlError(`${msg} (line ${line})`);
  };
  if (/^<\?xml\s/.test(s)) {
    const e = s.indexOf("?>");
    if (e < 0) fail("unterminated XML declaration");
    i = e + 2;
  }
  const top = (node) => (doc.root ? doc.epilog : doc.prolog).push(node);
  const stack = [];
  let cur = null;
  const addText = (t) => {
    if (!cur) {
      if (t.trim()) fail("text outside the root element");
      return;
    }
    const last = cur.children[cur.children.length - 1];
    if (last && last.type === "text") last.value += t;
    else cur.children.push({ type: "text", value: t });
  };
  const add = (node) => {
    if (cur) {
      node.parent = cur;
      cur.children.push(node);
    } else top(node);
  };
  while (i < s.length) {
    const lt = s.indexOf("<", i);
    if (lt < 0) {
      addText(decodeEntities(s.slice(i), "text"));
      break;
    }
    if (lt > i) addText(decodeEntities(s.slice(i, lt), "text"));
    i = lt;
    if (s.startsWith("<!--", i)) {
      const e = s.indexOf("-->", i + 4);
      if (e < 0) fail("unterminated comment");
      add({ type: "comment", value: s.slice(i + 4, e) });
      i = e + 3;
    } else if (s.startsWith("<![CDATA[", i)) {
      const e = s.indexOf("]]>", i + 9);
      if (e < 0) fail("unterminated CDATA section");
      if (!cur) fail("CDATA outside the root element");
      addText(s.slice(i + 9, e));
      i = e + 3;
    } else if (s.startsWith("<!DOCTYPE", i)) {
      if (cur || doc.root) fail("misplaced DOCTYPE");
      let j = i + 9;
      let q = null;
      for (; j < s.length; j++) {
        const c = s[j];
        if (q) {
          if (c === q) q = null;
        } else if (c === '"' || c === "'") q = c;
        else if (c === "[") fail("DOCTYPE with an internal subset is not supported");
        else if (c === ">") break;
      }
      if (j >= s.length) fail("unterminated DOCTYPE");
      const body = s.slice(i + 9, j).trim();
      const m = body.match(/^([^\s]+)(?:\s+(?:PUBLIC\s+(["'])(.*?)\2\s*(?:(["'])(.*?)\4)?|SYSTEM\s+(["'])(.*?)\6))?\s*$/s);
      if (!m) fail("unreadable DOCTYPE");
      doc.doctype = { name: m[1], publicId: m[3] ?? null, systemId: m[5] ?? m[7] ?? null };
      doc.docAt = doc.prolog.length;
      i = j + 1;
    } else if (s.startsWith("<!", i)) {
      fail("unsupported markup declaration");
    } else if (s.startsWith("<?", i)) {
      const e = s.indexOf("?>", i + 2);
      if (e < 0) fail("unterminated processing instruction");
      const body = s.slice(i + 2, e);
      const m = body.match(/^(\S+)\s*([\s\S]*)$/);
      if (!m) fail("bad processing instruction");
      add({ type: "pi", target: m[1], data: m[2] });
      i = e + 2;
    } else if (s[i + 1] === "/") {
      const e = s.indexOf(">", i);
      if (e < 0) fail("unterminated end tag");
      const name = s.slice(i + 2, e).trim();
      if (!cur || cur.name !== name) fail(`unexpected </${name}>`);
      cur = stack.pop() ?? null;
      i = e + 1;
    } else {
      // start tag
      let j = i + 1;
      const nm = /[^\s/>]+/y;
      nm.lastIndex = j;
      const mm = nm.exec(s);
      if (!mm) fail("bad start tag");
      const name = mm[0];
      j = nm.lastIndex;
      const attrs = [];
      const at = /\s*([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/y;
      for (;;) {
        at.lastIndex = j;
        const a = at.exec(s);
        if (!a) break;
        const raw = a[2] ?? a[3];
        if (raw.includes("<")) fail(`"<" in attribute ${a[1]}`);
        attrs.push([a[1], decodeEntities(raw.replace(/[\t\n]/g, " "), `attribute ${a[1]}`)]);
        j = at.lastIndex;
      }
      while (j < s.length && /\s/.test(s[j])) j++;
      let selfClose = false;
      if (s[j] === "/") {
        selfClose = true;
        j++;
      }
      if (s[j] !== ">") fail(`bad start tag <${name}>`);
      const node = el(name, attrs);
      if (!cur && doc.root) fail("more than one root element");
      if (cur) add(node);
      else doc.root = node;
      if (!selfClose) {
        if (cur) stack.push(cur);
        cur = node;
      }
      i = j + 1;
    }
  }
  if (cur) fail(`unclosed <${cur.name}>`);
  if (!doc.root) throw new XmlError("no root element");
  return doc;
}

// ---------- serialization (libxml2 conventions, as lxml writes them) ----------

const escText = (t) => t.replace(/[&<>\r]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\r": "&#13;" })[c]);
const escAttr = (t) =>
  t.replace(/[&<>"\n\r\t]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "\n": "&#10;", "\r": "&#13;", "\t": "&#9;" })[c]);

function serializeNode(n, out) {
  if (n.type === "text") out.push(escText(n.value));
  else if (n.type === "comment") out.push(`<!--${n.value}-->`);
  else if (n.type === "pi") out.push(n.data ? `<?${n.target} ${n.data}?>` : `<?${n.target}?>`);
  else {
    out.push("<", n.name);
    // libxml2 writes namespace declarations before ordinary attributes
    const ns = n.attrs.filter(([k]) => k === "xmlns" || k.startsWith("xmlns:"));
    const rest = n.attrs.filter(([k]) => !(k === "xmlns" || k.startsWith("xmlns:")));
    for (const [k, v] of [...ns, ...rest]) out.push(" ", k, '="', escAttr(v), '"');
    if (n.children.length === 0) out.push("/>");
    else {
      out.push(">");
      for (const c of n.children) serializeNode(c, out);
      out.push("</", n.name, ">");
    }
  }
}

function doctypeString(d) {
  if (!d) return "";
  if (d.publicId != null) return `<!DOCTYPE ${d.name} PUBLIC "${d.publicId}" "${d.systemId ?? ""}">`;
  if (d.systemId != null) return `<!DOCTYPE ${d.name} SYSTEM "${d.systemId}">`;
  return `<!DOCTYPE ${d.name}>`;
}

/** Serialize a parsed document the way lxml's tree.write(xml_declaration=True, encoding="UTF-8") does. */
export function serialize(doc) {
  const out = ["<?xml version='1.0' encoding='UTF-8'?>\n"];
  const before = doc.doctype ? doc.prolog.slice(0, doc.docAt) : [];
  const after = doc.doctype ? doc.prolog.slice(doc.docAt) : doc.prolog;
  for (const n of before) serializeNode(n, out);
  out.push(doctypeString(doc.doctype), "\n");
  for (const n of after) serializeNode(n, out);
  serializeNode(doc.root, out);
  for (const n of doc.epilog) serializeNode(n, out);
  return out.join("");
}

// ---------- tree helpers (lxml semantics) ----------

export const isEl = (n, name) => n != null && n.type === "element" && (name === undefined || n.name === name);
export const kids = (e, name) => e.children.filter((c) => isEl(c, name));
export const find = (e, name) => e.children.find((c) => isEl(c, name)) ?? null;

/** Element .text: the text before the first child node, or null. */
export function text(e) {
  const f = e.children[0];
  return f && f.type === "text" ? f.value : null;
}

/** Like lxml findtext: null when the child is missing, "" when it has no text. */
export function findText(e, name) {
  const c = find(e, name);
  return c ? (text(c) ?? "") : null;
}

export function setText(e, value) {
  const f = e.children[0];
  if (f && f.type === "text") f.value = value;
  else e.children.unshift({ type: "text", value });
}

export function attr(e, k) {
  const a = e.attrs.find(([n]) => n === k);
  return a ? a[1] : null;
}

export function setAttr(e, k, v) {
  const a = e.attrs.find(([n]) => n === k);
  if (a) a[1] = v;
  else e.attrs.push([k, v]);
}

/** Preorder walk of e and its descendants, yielding elements with the given name. */
export function* iter(e, name) {
  if (isEl(e, name)) yield e;
  for (const c of e.children) if (c.type === "element") yield* iter(c, name);
}

/** Create an element; attrs is an object, children are optional {name: text} pairs added in order. */
export function make(name, attrs = {}) {
  return el(name, Object.entries(attrs));
}

/** lxml SubElement: append a new element as the last child. */
export function sub(parent, name, attrs = {}, value) {
  const c = make(name, attrs);
  if (value !== undefined) setText(c, String(value));
  append(parent, c);
  return c;
}

export function append(parent, child) {
  child.parent = parent;
  parent.children.push(child);
}

/** lxml remove(): the element goes, and so does its tail text. */
export function remove(parent, child) {
  const i = parent.children.indexOf(child);
  if (i < 0) return;
  const n = parent.children[i + 1]?.type === "text" ? 2 : 1;
  parent.children.splice(i, n);
  child.parent = null;
}

/** lxml addnext(): the new element goes after the anchor's tail text and gets no tail itself. */
export function addNext(anchor, node) {
  const p = anchor.parent;
  let i = p.children.indexOf(anchor) + 1;
  if (p.children[i]?.type === "text") i++;
  node.parent = p;
  p.children.splice(i, 0, node);
}

/** lxml addprevious(): directly before the anchor. */
export function addPrevious(anchor, node) {
  const p = anchor.parent;
  node.parent = p;
  p.children.splice(p.children.indexOf(anchor), 0, node);
}

/** lxml insert(0, node): before the first non-text child. */
export function insertFirst(parent, node) {
  const i = parent.children.findIndex((c) => c.type !== "text");
  node.parent = parent;
  if (i < 0) parent.children.push(node);
  else parent.children.splice(i, 0, node);
}

/** lxml getnext(): the next sibling that is not text (element, comment or PI). */
export function nextSibling(e) {
  const p = e.parent;
  for (let i = p.children.indexOf(e) + 1; i < p.children.length; i++) {
    if (p.children[i].type !== "text") return p.children[i];
  }
  return null;
}

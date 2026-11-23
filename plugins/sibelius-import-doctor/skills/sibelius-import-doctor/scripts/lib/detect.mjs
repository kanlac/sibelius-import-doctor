// Find what Sibelius is known to mishandle, in terms of parts and bar numbers.

import { analyse, partNames, staffMap } from "./score.mjs";
import { iter, find, findText, attr, text, kids } from "./xml.mjs";
import { HALF_OF } from "./fix.mjs";

const barLabel = (m) => m.number ?? String(m.index);

/** Where each tremolo sits: part id, measure index and number, the note. */
function tremolos(root) {
  const out = [];
  for (const part of kids(root, "part")) {
    kids(part, "measure").forEach((m, k) => {
      for (const tr of iter(m, "tremolo")) {
        out.push({ part: attr(part, "id"), index: k + 1, number: attr(m, "number") ?? String(k + 1), type: attr(tr, "type"), note: tr.parent?.parent?.parent ?? null });
      }
    });
  }
  return out;
}

function isFixablePair(t) {
  if (t.type !== "start" && t.type !== "stop") return false;
  const tm = t.note && find(t.note, "time-modification");
  if (!tm || findText(tm, "actual-notes") !== "2" || findText(tm, "normal-notes") !== "1") return false;
  const ty = find(t.note, "type");
  return !!ty && text(ty) in HALF_OF;
}

/** Group [partId, bar] pairs into [{ part_id, part, bars }]. */
function byPart(pairs, names) {
  const map = new Map();
  for (const [pid, bar] of pairs) {
    if (!map.has(pid)) map.set(pid, []);
    const bars = map.get(pid);
    if (!bars.includes(bar)) bars.push(bar);
  }
  return [...map].map(([pid, bars]) => ({ part_id: pid, part: names[pid] || pid, bars }));
}

/** Counts in the prototype's terms (kept for the JSON report's before/after comparison). */
export function counts(root) {
  const an = analyse(root);
  const parts = partNames(root);
  const trem = {};
  let pairTm = 0;
  for (const t of tremolos(root)) {
    const k = t.type ?? "none";
    trem[k] = (trem[k] ?? 0) + 1;
    if ((t.type === "start" || t.type === "stop") && t.note && find(t.note, "time-modification")) pairTm++;
  }
  const composer = [...iter(root, "creator")].filter((c) => attr(c, "type") === "composer").map((c) => text(c) ?? "");
  let overfull = 0;
  let underfull = 0;
  let restWrong = 0;
  let heads = 0;
  for (const ms of an.values()) {
    for (const m of ms) {
      heads += m.heads;
      if (m.fill.gt(m.expected)) overfull++;
      else if (m.fill.gt(0) && m.fill.lt(m.expected) && !m.implicit) underfull++;
      if (m.heads === 0 && !m.fill.eq(m.expected)) restWrong++;
    }
  }
  return {
    parts: parts.length,
    staves: staffMap(root).length,
    measures: Math.max(0, ...[...an.values()].map((v) => v.length)),
    noteheads: heads,
    overlong_measures: overfull,
    short_measures: underfull,
    rest_only_measures_with_wrong_length: restWrong,
    tremolo: trem,
    tremolo_pair_notes_with_time_modification: pairTm,
    missing_abbreviation: parts.filter((p) => !p.abbr).length,
    composer: composer[0] ?? "",
  };
}

/** The problems a user should hear about, each with the parts and bars it affects. */
export function problems(root) {
  const an = analyse(root);
  const parts = partNames(root);
  const names = Object.fromEntries(parts.map((p) => [p.id, p.name]));
  const out = [];
  const overlong = [];
  const restOnly = [];
  for (const [pid, ms] of an) {
    for (const m of ms) {
      if (!m.fill.gt(m.expected)) continue;
      (m.heads > 0 ? overlong : restOnly).push([pid, barLabel(m)]);
    }
  }
  if (overlong.length) out.push({ kind: "overlong-bar", where: byPart(overlong, names) });
  if (restOnly.length) out.push({ kind: "overlong-rest", where: byPart(restOnly, names) });
  const tr = tremolos(root);
  const pairs = tr.filter(isFixablePair);
  if (pairs.length) out.push({ kind: "two-note-tremolo", notes: pairs.length, where: byPart(pairs.map((t) => [t.part, t.number]), names) });
  const odd = tr.filter((t) => (t.type === "start" || t.type === "stop") && t.note && find(t.note, "time-modification") && !isFixablePair(t));
  if (odd.length) out.push({ kind: "two-note-tremolo-unusual", notes: odd.length, where: byPart(odd.map((t) => [t.part, t.number]), names) });
  const unm = tr.filter((t) => t.type === "unmeasured");
  if (unm.length) out.push({ kind: "unmeasured-tremolo", notes: unm.length, where: byPart(unm.map((t) => [t.part, t.number]), names) });
  const noAbbr = parts.filter((p) => !p.abbr);
  if (noAbbr.length) out.push({ kind: "missing-abbreviation", parts: noAbbr.map((p) => ({ id: p.id, name: p.name })) });
  const composer = [...iter(root, "creator")].find((c) => attr(c, "type") === "composer");
  if (!composer || !(text(composer) ?? "").trim()) out.push({ kind: "missing-composer" });
  return out;
}

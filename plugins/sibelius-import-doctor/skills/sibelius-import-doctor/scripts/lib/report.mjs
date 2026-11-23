// Turn detection results and the fix log into a summary (for the assistant) and a report (for the user).
//
// Every finding gets two machine fields that the assistant and scripts/connect.mjs can share:
//   category: "problem" (Sibelius would get the music wrong) or "note" (a small detail: composer,
//             short instrument names).
//   grade:    "harmless" (changed, nothing to check), "glance" (changed; the user should look at
//             the bars listed) or "unfixed" (left as it was).
// Each change in the log carries a grade too. All text meant for people is plain English with
// part names and bar numbers: no command-line options, no MusicXML element names.

import { analyse } from "./score.mjs";

export const NOTE_KINDS = new Set(["missing-composer", "missing-abbreviation"]);

/** Grade of each kind of change in the log. */
export const CHANGE_GRADES = {
  "measure-rest": "harmless",
  pad: "harmless",
  "pad-empty-measure": "harmless",
  "tremolo-pair": "harmless",
  unmeasured: "harmless",
  abbreviation: "harmless",
  composer: "harmless",
  "trim-delete": "glance",
  "trim-shorten": "glance",
};

const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
const barsText = (bars) => `${bars.length > 1 ? "bars" : "bar"} ${bars.join(", ")}`;
const partsText = (parts) => parts.map((x) => x.name || x.id).join(", ");

/** What each finding means and what was done, in plain words. */
function says(p, mode) {
  if (p.dry) return { what: WHAT[p.kind], done: "Nothing was changed yet." };
  const off = "Left as it was, as requested.";
  switch (p.kind) {
    case "overlong-bar":
      return {
        what: "These bars hold more beats than the time signature allows, so Sibelius would drop the notes at the end of them. Usually one note value in the bar is wrong.",
        done: mode === "pad"
          ? "Every note was kept: rests were added to the other instruments so that all of them last as long as the longest one. These bars are now longer than the time signature."
          : "The music past the bar line was cut off: notes that started after it were removed and notes that crossed it were shortened to end at it.",
      };
    case "overlong-rest":
      return {
        what: "In these bars an instrument has only rests, but the rests are marked as longer than the bar.",
        done: mode === "pad"
          ? "Each of these bars was made as long as its longest instrument, with rests set or added to match. Where the rest itself was the longest thing in the bar, the bar is now longer than the time signature. No notes were touched."
          : "The rests were set to the length of the bar. No notes were touched.",
      };
    case "two-note-tremolo":
      return {
        what: "Sibelius would show these two-note tremolos as double whole notes with a 2 under them.",
        done: p.fixed ? "They were rewritten so Sibelius shows the note values you see in your score. They sound the same." : off,
      };
    case "two-note-tremolo-unusual":
      return { what: "These two-note tremolos are written in an unusual way that has not been tried in Sibelius.", done: "Left as they are. Check how they look in Sibelius." };
    case "unmeasured-tremolo":
      return {
        what: "These notes have an unmeasured (buzz) tremolo, which Sibelius leaves out when it opens the file.",
        done: p.fixed ? "Each now has the usual three-stroke tremolo, which players read the same way." : off,
      };
    case "missing-abbreviation":
      if (p.added?.length && p.fixed) return { what: "Some instruments had no short name, which Sibelius shows at the start of the second and later lines.", done: `Short names added (they can be changed in Sibelius): ${p.added.map((a) => `${a.part || a.id} → ${a.abbreviation}`).join(", ")}` };
      return {
        what: "These instruments have no short name, so Sibelius shows no instrument name at the start of the second and later lines.",
        done: p.added?.length ? `Short names added: ${p.added.map((a) => `${a.part || a.id} → ${a.abbreviation}`).join(", ")}. Still without one: ${partsText(p.remaining ?? [])}.` : "None were added.",
      };
    case "missing-composer":
      return p.fixed
        ? { what: "The file did not name a composer.", done: "The composer was added." }
        : { what: "The file does not name a composer, so none will appear in Sibelius.", done: "Give the composer's name if you want it added." };
    default:
      return { what: "", done: "Left as it was." };
  }
}

const WHAT = {
  "overlong-bar": "These bars hold more beats than the time signature allows, so Sibelius would drop the notes at the end of them.",
  "overlong-rest": "In these bars an instrument has only rests, but the rests are marked as longer than the bar.",
  "two-note-tremolo": "Sibelius would show these two-note tremolos as double whole notes with a 2 under them.",
  "two-note-tremolo-unusual": "These two-note tremolos are written in an unusual way that has not been tried in Sibelius.",
  "unmeasured-tremolo": "These notes have an unmeasured (buzz) tremolo, which Sibelius leaves out when it opens the file.",
  "missing-abbreviation": "These instruments have no short name, so Sibelius shows no instrument name at the start of the second and later lines.",
  "missing-composer": "The file does not name a composer, so none will appear in Sibelius.",
};

function gradeOf(p, mode) {
  if (!p.fixed) return "unfixed";
  if (p.kind === "overlong-bar" || (p.kind === "overlong-rest" && mode === "pad")) return "glance";
  return "harmless";
}

/** Decide, per finding, whether it was fixed, its category, its grade and the plain-words text. */
export function outcome({ before, after, log, mode, options, dryRun }) {
  const afterKinds = new Set(after.map((p) => p.kind));
  const count = (fix) => log.filter((c) => c.fix === fix).length;
  return before.map((p) => {
    const r = { ...p, category: NOTE_KINDS.has(p.kind) ? "note" : "problem", fixed: false };
    if (dryRun) {
      r.dry = true;
    } else {
      switch (p.kind) {
        case "overlong-bar":
        case "overlong-rest":
          r.fixed = mode === "pad" ? true : !afterKinds.has(p.kind);
          break;
        case "two-note-tremolo":
          r.fixed = options.tremolo && count("tremolo-pair") === p.notes;
          break;
        case "unmeasured-tremolo":
          r.fixed = options.unmeasured && !afterKinds.has("unmeasured-tremolo");
          break;
        case "missing-abbreviation": {
          r.added = log.filter((c) => c.fix === "abbreviation").map((c) => ({ id: c.part, part: c.name, abbreviation: c.abbreviation }));
          const left = after.find((a) => a.kind === "missing-abbreviation")?.parts ?? [];
          r.fixed = left.length === 0;
          if (left.length) r.remaining = left;
          break;
        }
        case "missing-composer":
          r.fixed = !afterKinds.has("missing-composer");
          break;
        default:
          break;
      }
    }
    r.grade = dryRun ? "unfixed" : gradeOf(r, mode);
    const s = says(r, mode);
    r.what = s.what;
    r.how = s.done;
    delete r.dry;
    return r;
  });
}

/** Things to look at, or to ask the user about, after the fix. Messages are plain words. */
export function attention({ found, log, mode, root }) {
  const out = [];
  const removed = log.filter((c) => c.fix === "trim-delete");
  if (removed.length) {
    const byPart = new Map();
    for (const c of removed) {
      const k = c.name || c.part;
      if (!byPart.has(k)) byPart.set(k, { part: k, bars: [], notes: 0 });
      const e = byPart.get(k);
      e.bars.push(c.number ?? String(c.measure));
      e.notes += c.deleted_noteheads;
    }
    out.push({ kind: "notes-removed", grade: "glance", message: "Notes that ran past the bar line were removed. Compare these bars with your original.", where: [...byPart.values()] });
  }
  const shortened = log.filter((c) => c.fix === "trim-shorten");
  if (shortened.length) {
    out.push({ kind: "notes-shortened", grade: "glance", message: "Notes that crossed the bar line were shortened to end at it.", where: groupBars(shortened) });
  }
  if (mode === "pad" && root) {
    const an = analyse(root);
    const long = [];
    const firstPart = [...an.values()][0] ?? [];
    for (let i = 0; i < firstPart.length; i++) {
      const fills = [...an.values()].filter((ms) => i < ms.length).map((ms) => ms[i]);
      if (fills.some((m) => m.fill.gt(m.expected))) long.push(firstPart[i].number ?? String(i + 1));
    }
    if (long.length) out.push({ kind: "bars-longer-than-time-signature", grade: "glance", message: "These bars were kept longer than the time signature so that no note is lost. One note value in each is probably wrong; compare them with your original.", bars: long });
  }
  for (const p of found) {
    if (p.kind === "missing-composer" && !p.fixed) out.push({ kind: "composer-unknown", grade: "unfixed", message: "The file does not name a composer. Give the name if you want it added." });
    if (p.kind === "missing-abbreviation" && !p.fixed) out.push({ kind: "short-names-missing", grade: "unfixed", message: "These instruments have no short name.", parts: p.remaining ?? p.parts });
    if (p.kind === "two-note-tremolo-unusual") out.push({ kind: "unusual-tremolo", grade: "unfixed", message: "Two-note tremolos written in an unusual way were left as they are; check how they look in Sibelius.", where: p.where });
  }
  return out;
}

function groupBars(entries) {
  const map = new Map();
  for (const c of entries) {
    const k = c.name || c.part;
    if (!map.has(k)) map.set(k, []);
    const bars = map.get(k);
    const b = c.number ?? String(c.measure);
    if (!bars.includes(b)) bars.push(b);
  }
  return [...map].map(([part, bars]) => ({ part, bars }));
}

export function changeCounts(log) {
  const out = {};
  for (const c of log) out[c.fix] = (out[c.fix] ?? 0) + 1;
  return out;
}

/** Add the grade to each change in the log. */
export function gradeLog(log) {
  return log.map((c) => ({ ...c, grade: CHANGE_GRADES[c.fix] ?? "glance" }));
}

/** One or two plain sentences: the result first. */
export function headline(found, dryRun) {
  const problems = found.filter((p) => p.category === "problem");
  const notes = found.filter((p) => p.category === "note" && !p.fixed);
  const fixed = problems.filter((p) => p.fixed).length;
  let s;
  if (!problems.length) s = "Nothing was found that Sibelius is known to get wrong when it opens this file.";
  else if (dryRun) s = `Found ${plural(problems.length, "kind of problem", "kinds of problem")} that Sibelius would get wrong when it opens this file. Nothing was changed yet.`;
  else if (fixed === problems.length) s = `Found ${plural(problems.length, "kind of problem", "kinds of problem")} that Sibelius would get wrong when it opens this file, and fixed ${problems.length === 1 ? "it" : "all of them"} in the copy.`;
  else s = `Found ${plural(problems.length, "kind of problem", "kinds of problem")} that Sibelius would get wrong when it opens this file; fixed ${fixed}, ${problems.length - fixed} left as ${problems.length - fixed === 1 ? "it was" : "they were"}.`;
  const small = notes.map((p) => (p.kind === "missing-composer" ? "the file names no composer" : `${plural((p.remaining ?? p.parts).length, "instrument has", "instruments have")} no short name`));
  if (small.length) s += ` Small ${small.length === 1 ? "note" : "notes"}: ${small.join("; ")}.`;
  return s;
}

function whereLines(p) {
  const L = [];
  for (const w of p.where ?? []) L.push(`- ${w.part}: ${barsText(w.bars)}`);
  const parts = p.remaining ?? (p.added?.length ? null : p.parts);
  if (parts?.length) L.push(`- ${partsText(parts)}`);
  return L;
}

const TITLE = {
  "overlong-bar": "Bars with too many beats",
  "overlong-rest": "Rests longer than the bar",
  "two-note-tremolo": "Two-note tremolos",
  "two-note-tremolo-unusual": "Unusual two-note tremolos",
  "unmeasured-tremolo": "Unmeasured tremolos",
  "missing-abbreviation": "Short instrument names",
  "missing-composer": "Composer",
};

/** The report for the user, in plain English. */
export function markdown(rep) {
  const L = [];
  L.push(`# Sibelius import check: ${rep.input_name}`, "");
  L.push(headline(rep.found, rep.dry_run), "");
  L.push(`- Your file (not changed): ${rep.input}`);
  if (rep.fixed) L.push(`- Fixed copy: ${rep.fixed}`);
  if (rep.report_md) L.push(`- This report: ${rep.report_md}`);
  L.push("");
  const problems = rep.found.filter((p) => p.category === "problem");
  const notes = rep.found.filter((p) => p.category === "note");
  const section = (title, items) => {
    if (!items.length) return;
    L.push(`## ${title}`, "");
    for (const p of items) {
      L.push(`### ${TITLE[p.kind] ?? p.kind}`, "", p.what, "", ...whereLines(p));
      if (whereLines(p).length) L.push("");
      L.push(p.how, "");
    }
  };
  section(rep.dry_run ? "What would be changed" : "What was changed", problems.filter((p) => p.fixed || rep.dry_run));
  section("Left as it was", problems.filter((p) => !p.fixed && !rep.dry_run));
  section("Small notes", notes);
  const look = rep.needs_attention.filter((a) => a.grade === "glance");
  if (look.length) {
    L.push("## Worth a look", "");
    for (const a of look) {
      L.push(`- ${a.message}`);
      for (const w of a.where ?? []) L.push(`  - ${w.part}: ${barsText(w.bars)}${w.notes ? ` (${plural(w.notes, "note")})` : ""}`);
      if (a.bars) L.push(`  - ${barsText(a.bars).replace(/^b/, "B")}`);
    }
    L.push("");
  }
  if (rep.warnings.length) L.push("## Other remarks", "", ...rep.warnings.map((w) => `- ${w}`), "");
  L.push("## In numbers", "");
  const b = rep.before;
  const a = rep.after;
  L.push(`- Instruments: ${b.parts}; bars: ${b.measures}.`);
  L.push(a ? `- Notes: ${b.noteheads} in your file, ${a.noteheads} in the fixed copy.` : `- Notes: ${b.noteheads}.`);
  if (b.tremolo_pair_notes_with_time_modification) L.push(`- Notes in two-note tremolos that Sibelius would draw wrongly: ${b.tremolo_pair_notes_with_time_modification}${a ? ` before, ${a.tremolo_pair_notes_with_time_modification} after` : ""}.`);
  if (b.tremolo.unmeasured) L.push(`- Unmeasured tremolos Sibelius would leave out: ${b.tremolo.unmeasured}${a ? ` before, ${a.tremolo.unmeasured ?? 0} after` : ""}.`);
  if (b.missing_abbreviation) L.push(`- Instruments without a short name: ${b.missing_abbreviation}${a ? ` before, ${a.missing_abbreviation} after` : ""}.`);
  L.push("", "Only the things above were checked. Pitches and rhythms were not compared bar by bar; opening the fixed copy in Sibelius and comparing it with your original is the final check.", "");
  return L.join("\n");
}

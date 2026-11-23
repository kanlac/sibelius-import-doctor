// Turn detection results and the fix log into a summary (for the assistant) and a report (for the user).

import { analyse } from "./score.mjs";

const WHAT = {
  "overlong-bar": "Bars that hold more music than the time signature allows. Sibelius drops the notes that run past the bar line.",
  "overlong-rest": "Bars where a part has only rests, but the rests add up to more than the time signature allows (usually a whole-bar rest marked with the wrong length).",
  "two-note-tremolo": "Two-note tremolos written with a 2:1 time modification. Sibelius draws them as double whole notes with a \"2\" under them.",
  "two-note-tremolo-unusual": "Two-note tremolos written in a way that has not been tested with Sibelius.",
  "unmeasured-tremolo": "Unmeasured (buzz) tremolos. Sibelius drops them on import.",
  "missing-abbreviation": "Parts without a short name. Sibelius then has no instrument name to show at the start of later systems.",
  "missing-composer": "No composer in the file, so the score has no composer in Sibelius.",
};

const where = (p) => (p.where ?? []).map((w) => `${w.part}: bar${w.bars.length > 1 ? "s" : ""} ${w.bars.join(", ")}`);

/** Decide, per problem found before fixing, whether it was fixed and how. */
export function outcome({ before, after, log, mode, options, dryRun }) {
  const afterKinds = new Set(after.map((p) => p.kind));
  const count = (fix) => log.filter((c) => c.fix === fix).length;
  return before.map((p) => {
    const r = { ...p, fixed: false, how: "" };
    if (dryRun) {
      r.how = "not changed (dry run)";
      return r;
    }
    switch (p.kind) {
      case "overlong-bar":
        if (mode === "pad") {
          r.fixed = true;
          r.how = "every part of each such bar padded with rests to the length of the longest part; the bar stays longer than the time signature";
        } else {
          r.fixed = !afterKinds.has("overlong-bar");
          r.how = "music past the bar line cut off (notes starting after it removed, notes crossing it shortened)";
        }
        break;
      case "overlong-rest":
        if (mode === "pad") {
          r.fixed = true;
          r.how = "whole-bar rests set to the length of the bar; where other parts are longer, the bar stays longer than the time signature";
        } else {
          r.fixed = !afterKinds.has("overlong-rest");
          r.how = "whole-bar rests set to the length of the bar; extra rests past the bar line removed";
        }
        break;
      case "two-note-tremolo":
        r.fixed = options.tremolo && count("tremolo-pair") === p.notes;
        r.how = options.tremolo ? "written note value halved and the 2:1 time modification removed" : "left unchanged (tremolo fix switched off)";
        break;
      case "unmeasured-tremolo":
        r.fixed = options.unmeasured && !afterKinds.has("unmeasured-tremolo");
        r.how = options.unmeasured ? "replaced by an ordinary three-stroke tremolo" : "left unchanged (unmeasured-tremolo fix switched off)";
        break;
      case "missing-abbreviation":
        r.fixed = options.abbreviations && !afterKinds.has("missing-abbreviation");
        r.how = options.abbreviations ? "short names added" : "left unchanged (abbreviation fix switched off)";
        if (options.abbreviations) r.added = log.filter((c) => c.fix === "abbreviation").map((c) => ({ part: c.name, abbreviation: c.abbreviation }));
        break;
      case "missing-composer":
        r.fixed = !afterKinds.has("missing-composer");
        r.how = r.fixed ? `composer set to "${options.composer}"` : "needs the composer's name: run again with --composer";
        break;
      default:
        r.how = "left unchanged; check these bars in Sibelius";
    }
    return r;
  });
}

/** Things the user should look at even after the fix. */
export function attention({ found, log, mode, root, names }) {
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
    out.push({ kind: "notes-removed", message: "Notes that ran past the bar line were removed. Compare these bars with the original.", where: [...byPart.values()] });
  }
  const shortened = log.filter((c) => c.fix === "trim-shorten");
  if (shortened.length) {
    out.push({ kind: "notes-shortened", message: "Notes that crossed the bar line were shortened to end at it.", where: groupBars(shortened) });
  }
  if (mode === "pad" && root) {
    const an = analyse(root);
    const long = [];
    const firstPart = [...an.values()][0] ?? [];
    for (let i = 0; i < firstPart.length; i++) {
      const fills = [...an.values()].filter((ms) => i < ms.length).map((ms) => ms[i]);
      if (fills.some((m) => m.fill.gt(m.expected))) long.push(firstPart[i].number ?? String(i + 1));
    }
    if (long.length) out.push({ kind: "bars-longer-than-time-signature", message: "These bars were kept longer than the time signature so that no note is lost. The music in them probably has a wrong note value somewhere; compare with the original.", bars: long });
  }
  for (const p of found) {
    if (p.kind === "missing-composer" && !p.fixed) out.push({ kind: "composer-unknown", message: "The file has no composer. Ask for the name and run again with --composer \"Name\"." });
    if (p.kind === "two-note-tremolo-unusual") out.push({ kind: "unusual-tremolo", message: "Two-note tremolos written in an untested way were left unchanged.", where: p.where });
  }
  void names;
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

/** The human-readable report, in plain English. */
export function markdown(rep) {
  const L = [];
  const fixedN = rep.found.filter((p) => p.fixed).length;
  L.push(`# Sibelius import check: ${rep.input_name}`, "");
  if (rep.dry_run) L.push(`Found ${rep.found.length} kind(s) of problem. Nothing was changed (dry run).`, "");
  else L.push(`Found ${rep.found.length} kind(s) of problem, fixed ${fixedN}. Fixed copy: \`${rep.fixed_name}\`. The original file was not changed.`, "");
  if (!rep.found.length) L.push("Nothing that Sibelius is known to mishandle was found. This does not mean the file is perfect: only the problems listed in this tool's documentation are checked.", "");
  for (const p of rep.found) {
    L.push(`## ${p.fixed ? "Fixed" : "Not fixed"}: ${p.kind.replace(/-/g, " ")}`, "", WHAT[p.kind] ?? "", "");
    for (const w of where(p)) L.push(`- ${w}`);
    if (p.parts) L.push(`- Parts: ${p.parts.join(", ")}`);
    if (p.added?.length) L.push(`- Added: ${p.added.map((a) => `${a.part} → ${a.abbreviation}`).join(", ")}`);
    L.push("", `What was done: ${p.how}.`, "");
  }
  if (rep.needs_attention.length) {
    L.push("## Worth a look", "");
    for (const a of rep.needs_attention) {
      L.push(`- ${a.message}`);
      for (const w of a.where ?? []) L.push(`  - ${w.part}: bar${w.bars.length > 1 ? "s" : ""} ${w.bars.join(", ")}${w.notes ? ` (${w.notes} note${w.notes > 1 ? "s" : ""})` : ""}`);
      if (a.bars) L.push(`  - Bars ${a.bars.join(", ")}`);
    }
    L.push("");
  }
  if (rep.warnings.length) L.push("## Warnings", "", ...rep.warnings.map((w) => `- ${w}`), "");
  L.push("## Numbers", "", "| | before | after |", "|---|---|---|");
  for (const k of ["parts", "staves", "measures", "noteheads", "tremolo_pair_notes_with_time_modification", "missing_abbreviation"]) {
    L.push(`| ${k.replace(/_/g, " ")} | ${rep.before[k]} | ${rep.after ? rep.after[k] : "-"} |`);
  }
  const tremo = (t) => Object.entries(t).map(([k, v]) => `${k} ${v}`).join(", ") || "none";
  L.push(`| tremolos | ${tremo(rep.before.tremolo)} | ${rep.after ? tremo(rep.after.tremolo) : "-"} |`, "");
  L.push("Only the problems above are checked. Opening the fixed file in Sibelius and comparing it with the original is the final check.", "");
  return L.join("\n");
}

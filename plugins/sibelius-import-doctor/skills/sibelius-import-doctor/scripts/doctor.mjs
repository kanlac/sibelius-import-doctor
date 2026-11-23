#!/usr/bin/env node
// Find and fix what Sibelius mishandles when it imports a MusicXML file.
//
//   node doctor.mjs <score.musicxml|.xml|.mxl> <output-folder> [options]
//
// Writes <name>.fixed.musicxml, <name>.report.md and <name>.report.json into the output folder
// and prints one line of JSON describing what was found and done. Never changes the input file.
// Exit code: 0 done (whether or not problems were found), 2 bad arguments or unreadable input.

import { mkdirSync, readFileSync, realpathSync, writeFileSync, existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { InputError, partNames, readScore } from "./lib/score.mjs";
import { parse, serialize } from "./lib/xml.mjs";
import { Fixer } from "./lib/fix.mjs";
import { counts, problems } from "./lib/detect.mjs";
import { attention, changeCounts, gradeLog, headline, markdown, outcome } from "./lib/report.mjs";

const HELP = `usage: node doctor.mjs <score> <output-folder> [options]

  --mode pad|trim      overlong bars: pad every part to the longest (default, keeps every note)
                       or trim what runs past the bar line (keeps bars regular, removes notes)
  --composer NAME      fill in the composer when the file has none
  --no-tremolo         leave two-note tremolos alone
  --no-unmeasured      leave unmeasured tremolos alone
  --short-name ID=NAME short name for the part with that id, used only if it has none
                       (repeatable; nothing is generated without it)
  --short-names FILE   JSON object of short names by part id, e.g. {"P1": "Vln. 1"}
  --fill-short-bars    also fill bars that end early with rests (Sibelius does not need this)
  --dry-run            only report what would be fixed; write nothing
`;

function stemOf(path) {
  return basename(path).replace(/\.(musicxml|xml|mxl)$/i, "");
}

/** Short names from --short-names FILE, then --short-name ID=NAME (which wins). */
function shortNamesFrom(values) {
  const out = {};
  if (values["short-names"]) {
    let data;
    try {
      data = JSON.parse(readFileSync(resolve(values["short-names"]), "utf8"));
    } catch (e) {
      throw new InputError(`--short-names: cannot read ${values["short-names"]} as JSON (${e.message})`);
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new InputError('--short-names must hold a JSON object such as {"P1": "Vln. 1"}');
    for (const [id, name] of Object.entries(data)) {
      if (typeof name !== "string" || !name.trim()) throw new InputError(`--short-names: the short name for ${id} must be a non-empty string`);
      out[id] = name.trim();
    }
  }
  for (const s of values["short-name"]) {
    const i = s.indexOf("=");
    if (i < 1 || !s.slice(i + 1).trim()) throw new InputError(`--short-name must look like ID=NAME, e.g. "P1=Vln. 1" (got "${s}")`);
    out[s.slice(0, i).trim()] = s.slice(i + 1).trim();
  }
  return out;
}

export function run(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      mode: { type: "string", default: "pad" },
      composer: { type: "string" },
      "no-tremolo": { type: "boolean", default: false },
      "no-unmeasured": { type: "boolean", default: false },
      "short-name": { type: "string", multiple: true, default: [] },
      "short-names": { type: "string" },
      "fill-short-bars": { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) return { help: true };
  if (positionals.length !== 2) throw new InputError("expected two arguments: the score file and an output folder");
  if (!["pad", "trim"].includes(values.mode)) throw new InputError(`--mode must be "pad" or "trim", not "${values.mode}"`);
  const input = resolve(positionals[0]);
  if (!existsSync(input)) throw new InputError(`file not found: ${input}`);
  const outDir = resolve(positionals[1]);
  const options = {
    mode: values.mode,
    tremolo: !values["no-tremolo"],
    unmeasured: !values["no-unmeasured"],
    shortNames: shortNamesFrom(values),
    composer: values.composer?.trim() || null,
    fillShortBars: values["fill-short-bars"],
  };
  const dryRun = values["dry-run"];

  const { doc, kind, inner } = readScore(input);
  const ids = new Set(partNames(doc.root).map((p) => p.id));
  const unknown = Object.keys(options.shortNames).filter((id) => !ids.has(id));
  if (unknown.length) throw new InputError(`short name given for unknown part id(s): ${unknown.join(", ")} (part ids in this file: ${[...ids].join(", ")})`);
  const before = counts(doc.root);
  const found = problems(doc.root);

  const stem = stemOf(input);
  const fixedPath = join(outDir, `${stem}.fixed.musicxml`);
  const mdPath = join(outDir, `${stem}.report.md`);
  const jsonPath = join(outDir, `${stem}.report.json`);

  let log = [];
  let warnings = [];
  let after = null;
  let afterProblems = [];
  let fixedRoot = null;
  if (!dryRun) {
    const fx = new Fixer(doc, options);
    log = fx.run();
    warnings = fx.warnings;
    const xml = serialize(doc);
    fixedRoot = parse(xml).root;
    after = counts(fixedRoot);
    afterProblems = problems(fixedRoot);
    mkdirSync(outDir, { recursive: true });
    const realIn = realpathSync(input);
    for (const p of [fixedPath, mdPath, jsonPath]) {
      if (existsSync(p) && realpathSync(p) === realIn) throw new InputError("the output folder would overwrite the original file");
    }
    writeFileSync(fixedPath, xml, "utf8");
  }

  const res = outcome({ before: found, after: afterProblems, log, mode: options.mode, options, dryRun });
  const needs = attention({ found: res, log, mode: options.mode, root: fixedRoot });
  const changes = changeCounts(log);
  const notesRemoved = log.reduce((s, c) => s + (c.deleted_noteheads ?? 0), 0);
  const rep = {
    input: input,
    input_name: basename(input),
    input_kind: kind,
    ...(inner ? { mxl_entry: inner } : {}),
    dry_run: dryRun,
    mode: options.mode,
    options,
    fixed: dryRun ? null : fixedPath,
    report_md: dryRun ? null : mdPath,
    report_json: dryRun ? null : jsonPath,
    headline: headline(res, dryRun),
    grades: Object.fromEntries(res.map((p) => [p.kind, p.grade])),
    found: res,
    needs_attention: needs,
    changes,
    notes_removed: notesRemoved,
    warnings,
    before,
    after,
    log: gradeLog(log),
  };
  if (!dryRun) {
    writeFileSync(jsonPath, JSON.stringify(rep, null, 1) + "\n", "utf8");
    writeFileSync(mdPath, markdown(rep), "utf8");
  }
  const summary = {
    ok: true,
    input,
    mode: options.mode,
    dry_run: dryRun,
    fixed: dryRun ? null : fixedPath,
    report: dryRun ? null : mdPath,
    report_json: dryRun ? null : jsonPath,
    headline: rep.headline,
    found: res.map((p) => ({ kind: p.kind, category: p.category, grade: p.grade, fixed: p.fixed, ...(p.where ? { where: p.where.map((w) => ({ part: w.part, bars: w.bars })) } : {}), ...(p.parts ? { parts: p.remaining ?? p.parts } : {}) })),
    changes,
    notes_removed: notesRemoved,
    needs_attention: needs.map((a) => a.kind),
    worth_a_look: needs.filter((a) => a.grade === "glance").map((a) => a.message),
    warnings,
  };
  return { summary };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const r = run(process.argv.slice(2));
    if (r.help) process.stdout.write(HELP);
    else process.stdout.write(JSON.stringify(r.summary) + "\n");
  } catch (e) {
    const known = e instanceof InputError || e?.code === "ERR_PARSE_ARGS_UNKNOWN_OPTION" || e?.code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE";
    process.stdout.write(JSON.stringify({ ok: false, error: e.message }) + "\n");
    if (!known) process.stderr.write(`${e.stack}\n`);
    process.exit(known ? 2 : 1);
  }
}

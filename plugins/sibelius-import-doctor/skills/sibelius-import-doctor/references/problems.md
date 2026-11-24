# What Sibelius mishandles on MusicXML import, and how the doctor fixes it

`scripts/doctor.mjs` looks for the problems below, writes a fixed copy and a report, and never changes the original. Each section says what the problem is, what the user sees in Sibelius, how it is fixed, what was measured, and a plain way to say it to the user.

## Running it

```
node scripts/doctor.mjs <score.musicxml|.xml|.mxl> <output folder> [options]
```

| Option | Effect |
|---|---|
| `--mode pad` (default) / `--mode trim` | How to repair bars that hold too much music (see the first problem) |
| `--composer "Name"` | Fill in the composer when the file has none. Only with a name the user gave; never guess |
| `--short-name "P1=Vln. 1"` (repeatable), `--short-names names.json` (`{"P1": "Vln. 1"}`) | Short names for parts that have none, keyed by part id. The assistant chooses them; the doctor never makes any up. `--short-name` wins over the file |
| `--no-tremolo`, `--no-unmeasured` | Leave that kind of problem alone |
| `--fill-short-bars` | Also fill bars that end early with rests. Sibelius does not need this; the original Python prototype always did it |
| `--dry-run` | Only report; write nothing |

Give it the output folder (one folder per score, named after it); every path it prints and writes is absolute. It prints one line of JSON:

- `headline`: the result in one or two plain sentences, for example "Found 2 kinds of problem that Sibelius would get wrong when it opens this file, and fixed all of them in the copy. Small note: the file names no composer."
- `found`: one entry per kind, with `category`, `grade`, `fixed` and, where it applies, `where` (part names and bar numbers) or `parts` (part `id` and `name`).
- `worth_a_look`: plain sentences about bars the user should look at.
- `needs_attention`: machine names of the same things plus what to ask the user (see below).
- `changes` (how many of each repair), `notes_removed` (always 0 in pad mode), `warnings` (plain sentences).
- Paths: `fixed` (`<name>.fixed.musicxml`), `report` (`<name>.report.md`, plain English for the user, with the full paths of the original, the fixed copy and itself) and `report_json` (`<name>.report.json`: everything above plus every change with part, bar and grade; `scripts/connect.mjs check --changes` reads it).

Exit code 0 means it ran (whether or not it found anything); 2 means the file could not be read, with the reason in `error`.

**Category.** `problem`: Sibelius would get the music wrong (every section below except the last two). `note`: a small detail, a missing composer or missing short names. Notes never make a file count as having problems: a file whose only finding is a missing composer reads "Nothing was found that Sibelius is known to get wrong… Small note: the file names no composer."

**Grade**, the same scale for every finding (`found[].grade`, and `grades` by kind in the JSON report) and every change (`log[].grade`), shared with the in-Sibelius check:

| Grade | Meaning | Findings | Changes |
|---|---|---|---|
| `harmless` | Changed, nothing to check | two-note tremolos and unmeasured tremolos rewritten; rest-only bars fixed in trim mode; short names or composer added | whole-bar rests resized, rests added, tremolos rewritten, short names, composer |
| `glance` | Changed; the user should look at the bars listed | overlong bars (pad: kept longer than the time signature; trim: notes removed or shortened); rest-only bars in pad mode (the bar may now be longer) | notes removed or shortened at the bar line |
| `unfixed` | Left as it was | anything not fixed: unusual two-note tremolos, a composer or short names nobody supplied, a fix switched off, everything in a dry run | |

`needs_attention` values, and what to do with them:

- `bars-longer-than-time-signature`: pad mode kept these bars long so no note is lost. The music in them probably has one wrong note value; the user should compare those bars with the original.
- `notes-removed`, `notes-shortened`: trim mode cut music at the bar line; the report lists part, bars and how many notes.
- `composer-unknown`: ask the user for the composer's name and run again with `--composer`.
- `short-names-missing`: parts without a short name (listed with part id and name). Choose names and run again with `--short-name` / `--short-names`.
- `unusual-tremolo`: two-note tremolos written in a way that was not tested; left unchanged.

The report and every text field are written for the user: musical terms, part names and bar numbers, no command-line options or file-format names. Only the options above are for you.

Bar numbers are the numbers printed in the file (`<measure number>`), part names are the names in the file.

## How this was measured

Sibelius 26.11 (build 26.11.0.13211) on macOS. Each file was imported through Sibelius Connect, every note was read back with a plug-in, and Sibelius re-exported the score as MusicXML; the read-back was compared with an independent count of the MusicXML. Two orchestral scores that had been converted from PDF were used (not included in this repository):

- **Score A**: 26 parts, 27 staves, 38 bars, 1491 noteheads, with many overlong bars.
- **Score B**: 28 parts, 29 staves, 124 bars, 5128 noteheads, with tremolos, no short part names and no composer.

The Node scripts here are a port of the Python prototype used in those measurements. On Score A and Score B, and on a third PDF-converted score, the port writes byte-for-byte the same fixed file as the prototype when run as the prototype was (`--fill-short-bars`, both modes). The default leaves short bars alone. A separate live check on Sibelius 26.11 confirmed that the default pad output kept all 1491 notes in Score A with either import layout.

---

## Overlong bars: notes running past the bar line

**What it is.** A bar in one part holds more music than the time signature allows: in 4/4, notes adding up to 4¾ beats. This almost always means one note value was read or written wrong somewhere in the bar (a PDF or scan conversion is the usual cause).

**In Sibelius.** Notes that run past the bar line are silently dropped. Sometimes Sibelius instead makes the whole bar longer than the time signature, for every instrument. Score A: 1491 notes in the file, 1481 in Sibelius (10 dropped, in bars 9, 10, 24 and 27 of four staves), and 15 bars with a length that did not match the time signature.

**The fix: pad (default).** In every bar where some part runs long, every part is filled up with rests to the length of the longest part. Nothing is removed. The bar stays longer than the time signature, consistently across the score. Score A after padding: 1491 in the file, 1491 in Sibelius, nothing dropped; 18 bars longer than the time signature, which are exactly the padded bars.

**The other choice: trim (`--mode trim`).** Music past the bar line is cut: notes and rests that start after it are removed (with their chord notes and grace notes), notes and rests that cross it are shortened to end at it (when the shortened length cannot be written as one note value, the largest value that fits is used and the rest of the bar is filled with rests). Bars stay regular, but notes are lost, and the report lists every one. Score A after trimming: 1485 notes in the file (the trim removed 6), 1485 in Sibelius, nothing further dropped; the only bars whose length differs from the time signature are two bars near the end where every part is equally short (see below). On one staff the trim removed 3 notes where Sibelius had dropped only 2.

**Why pad is the default.** It never loses a note, and it leaves the faulty bars visible so the user can correct the one wrong note value against their original. Offer trim when the user wants regular bars and accepts the removals listed in the report.

**Details that come with this fix (measured together with it on Score A, not one by one):**

- *Whole-bar rests with the wrong length* (`overlong-rest` in the output): a part that only rests in a bar, but whose rests add up to more than the bar. The whole-bar rest is set to the bar's length (in pad mode, the length of its longest part). Score A had 234 such part-bars.
- *Bars where every part is short by the same amount* (for example a final bar after a pickup, or a bar whose time signature change was lost): in trim mode, when every part that has notes agrees on a shorter length, that length is kept rather than the time signature's. On Score A this applied to two bars near the end; Sibelius had made those same two bars short in its own import of the original file.
- *Pickup bars* (`implicit="yes"`) are never stretched to a full bar. (The prototype did stretch them when only one part had notes in the pickup; the port does not.)
- *Bars that only end early* are not changed unless `--fill-short-bars` is given. On Score A, bars that ended early but where no part ran long kept every note in Sibelius, and Sibelius changed their length only where every part was equally short.
- Within a repaired bar, a staff with no music at all gets a whole-bar rest, and each staff's first voice is filled to the bar's length. Other voices are left as they are.

**Say to the user.** "Some bars have more beats than the time signature allows, usually because one note value is wrong. Sibelius would silently drop the notes at the end of those bars. I kept every note by making those bars a little longer in all parts; you may want to compare bars 12 and 30 with your original. If you prefer regular bars, I can cut the extra music instead, which removes these notes: …"

---

## Two-note tremolos drawn as double whole notes

**What it is.** A tremolo that alternates between two notes. MusicXML writes each of the two notes with the value you see (for example two whole notes in a 4/4 bar) plus a 2:1 time modification, because each sounds for half that long. Many programs export it this way.

**In Sibelius.** The notes are kept, but they are drawn as two double whole notes (breves) with a "2" tuplet number under the tremolo strokes, instead of two whole notes.

**The fix.** The written value of each note is halved (whole becomes half) and the 2:1 time modification is removed; the played duration is unchanged. Sibelius then draws the intended whole notes with no "2". Only notes whose written value is breve, whole, half, quarter, eighth or 16th and whose time modification is exactly 2:1 are changed; any other two-note tremolo with a time modification is reported as `two-note-tremolo-unusual` and left alone.

**Measured.** Five ways of writing the same tremolos (three parts of Score B, 252 noteheads, 12 tremolo pairs), each imported into Sibelius:

| How the pair was written | Notes in Sibelius | Drawn |
|---|---|---|
| whole + 2:1 (as in the file) | 252 | breves with "2" |
| whole, no time modification | 240 (12 lost) | |
| **half, no time modification** | **252** | **whole notes, no "2"** |
| half + 2:1 | 252 | still inside a 2:1 tuplet |
| breve + 4:1 (how Sibelius itself exports it) | 252 | still inside a tuplet |

A four-bar cello excerpt was also exported from Sibelius to PDF before and after: breves with "2" before, whole notes without "2" after. Score B (27 pairs, 54 notes): all 5128 notes kept before and after.

**Say to the user.** "Sibelius would draw the two-note tremolos in bars 85 to 100 as double whole notes with a 2 under them. I rewrote them so they come out as you see them in your score."

---

## Unmeasured tremolos dropped

**What it is.** A note marked with an unmeasured tremolo (`<tremolo type="unmeasured">`, the buzz-roll or "as fast as possible" tremolo).

**In Sibelius.** The tremolo is dropped: the note arrives with no tremolo strokes at all. In the excerpt above, 59 unmeasured tremolos became 0 in Sibelius; writing them with the SMuFL buzz-roll symbol instead was dropped too.

**The fix.** Each becomes an ordinary three-stroke tremolo. Three strokes is the standard way to write an unmeasured tremolo (Gould, *Behind Bars*, "Unmeasured tremolos", p. 224), so players read it the same way, though strictly it is no longer marked as unmeasured in the file. Score B: 132 unmeasured tremolos; after the fix Sibelius showed all of them as three-stroke tremolos, and its re-export kept them.

**Say to the user.** "Sibelius would drop the tremolo marks on 132 notes (they are 'unmeasured' tremolos, which it does not import). I changed them to the usual three-stroke tremolo, which players read the same way."

---

## Parts without a short name

A small note (category `note`), not a problem: the music imports correctly either way.

**What it is.** The part has a name but no `<part-abbreviation>`.

**In Sibelius.** The staff's short name is empty, so there is no instrument name to show at the start of later systems. Score B: 28 parts without a short name; in Sibelius 28 of its 29 staves had an empty short name.

**The fix.** The doctor only finds these parts (`missing-abbreviation`, with each part's id and name) and writes the short names it is given; it has no list of instrument names and never invents one. You choose the names: the conventional short form in the score's own language (the language its part names are written in), keeping player numbers ("Violin 2" → "Vln. 2"). Pass them by part id with `--short-name P1="Vln. 1"` or a `--short-names` JSON file. Without them nothing is added and the report says so. Existing short names are never changed. Score B with short names filled in: all 29 staves had a short name in Sibelius, and its re-export kept all 28. Sibelius only shows whether the names arrive, not whether they are good; the report lists every name added, and the user can change any of them in Sibelius.

**Say to the user.** "None of the instruments had a short name, so Sibelius would show no names on the second page onward. I added the usual short names (Vln. 1, Vc., …); you can change them in Sibelius."

---

## No composer

A small note (category `note`), not a problem: the music imports correctly either way.

**What it is.** The file has no composer (`<creator type="composer">` missing or empty).

**In Sibelius.** The score has no composer. With the composer filled in, Score B showed it in Sibelius and its re-export kept it.

**The fix.** Only with a name the user gives: `--composer "Name"`. Without it, it stays a small note (category `note`, grade `unfixed`) and `needs_attention` contains `composer-unknown`. An existing composer is never changed.

**Say to the user.** "The file doesn't say who the composer is. Tell me the name and I'll add it."

---

## What is not checked

Only the problems above. In particular: wrong pitches or rhythms that still add up, ties or slurs attached to notes that were removed, lyrics, chord symbols, repeats, layout, and anything specific to other notation programs. A file with no findings is not proof that it imports perfectly; the in-Sibelius check (`references/connect.md`) is the way to see what Sibelius actually made of it.

The reader accepts score-partwise MusicXML in UTF-8, UTF-16 or a declared single-byte encoding, and compressed `.mxl`. It refuses score-timewise files, files with DTD entity declarations, and note durations that are not whole numbers, with a message saying why. The fixed copy is always an uncompressed `.musicxml` file.

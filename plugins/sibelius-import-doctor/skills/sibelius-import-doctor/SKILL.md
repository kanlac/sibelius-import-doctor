---
name: sibelius-import-doctor
description: Find and fix what Sibelius silently drops or mangles when it imports a MusicXML file (notes missing at the end of an overlong bar, two-note tremolos drawn as double whole notes, tremolos that vanish, missing part abbreviations or composer), and check the result inside Sibelius. Use when the user imported MusicXML into Sibelius and something looks wrong or missing, wants a MusicXML file cleaned up before opening it in Sibelius, or asks to use Sibelius Connect with an AI assistant. If the user only has a PDF, use the sheetmusic-pdf-convert skill first.
---

# Sibelius import doctor

The user has a MusicXML file (or a score that came out of one) and Sibelius did not import it faithfully. Find what is wrong, fix it in a copy, and check the result. Assume the user knows nothing about MusicXML, Node or Sibelius internals: they answer short questions, you do the rest, in plain words about their score and their choices. Do not narrate this skill, its rules or its file names.

## Set up silently

Everything below runs with Node.js 22 or newer (this skill's `scripts/`). If Node is missing, install it yourself with whatever is normal for the user's system; do not ask first. Never edit the user's original file: all work happens on copies in an output folder next to it.

## 1. What did the user give you?

- **MusicXML (`.musicxml`, `.xml`, `.mxl`)**: continue.
- **Only a PDF**: this skill does not read PDFs. Use the `sheetmusic-pdf-convert` skill (https://github.com/kanlac/sheetmusic-pdf-convert); if it is not installed, install it from there, then come back with the MusicXML it produces.
- Ask what looked wrong if the user has not said. Address it after the check.
- **A `.sib` file that already looks wrong**: the damage happened at import time; ask for the original MusicXML.

## 2. Find the problems (no Sibelius needed)

Run `node scripts/doctor.mjs <file> <output folder>` (it never changes the file; `--dry-run` only reports). It reports, in terms of parts and bar numbers, what Sibelius is known to mishandle. `references/problems.md` lists each kind, how it shows up in Sibelius, how it is fixed, and what we measured. Say plainly what was found and what will be changed, then fix. Where a fix involves a choice (for example trimming versus padding an overlong bar), pick the safer default, say which, and offer the other. If later systems need labels, supply conventional short names in the score's language (`--short-name`).

Outputs, always as copies: the fixed MusicXML and a short report of what changed and what did not. Never claim the file is perfect; report only what can be checked.

## 3. Check it inside Sibelius (needs Sibelius Connect)

Do this whenever Sibelius 26.11 or newer is installed; the user should not have to ask. It imports the original and the fixed file, reads every note back, compares them, and saves a `.sib` with short graded comments signed "Doctor" on the bars where music changed, could not be fixed, or still differs from the file. `references/connect.md` has the steps, the events the script prints, and troubleshooting.

- **Version.** Built for Sibelius 26.11 (the November 2026 release, where Connect gained live reading from Sibelius). If the installed version is older, tell the user to update and why, in a sentence, then deliver the step-2 result.
- **One short heads-up before you start, in one or two plain sentences:** Sibelius has to be restarted once the first time (ask them to save open scores first), it will show a box asking to allow the connection (they click Yes), and usually two import boxes (OK). Do not list the plug-in, ports or scripts.
- **Plug-in.** Run `scripts/plugin/install.mjs`; it is read-only inside Sibelius. If it changed, Sibelius must be restarted before the check.
- **The connection box is the user's to answer.** Never click it for them.
- **The import options box.** Ask once, in one line, who clicks OK: the user themselves, or you (that needs the computer-control permission). Store the answer with `scripts/config.mjs` and do not ask again unless they change their mind.
- **Stay until it finishes.** Run the check so you see its events and keep going until it prints `done` or an error; do not end your turn while Sibelius is still waiting for the user. Pass on every prompt it prints (such as needing the user to click OK because the computer cannot be controlled) in plain words at once.
- If Connect cannot be set up, deliver the step-2 result and say the in-Sibelius check was skipped and why.

## 4. Hand back

Lead with the before-and-after and the bars that still need review. Say what was measured: note counts by part and bar, bar lengths, tuplets and tremolos. Use the source score or PDF, if available, to spot-check what matters to the players in the Sibelius copy: entrances and rhythm, written and sounding pitch, markings and readable score and parts. Name any visible discrepancies and what remains unchecked. Give full paths and explain the comments in plain words (red: serious, amber: check, grey-green: changed).

## Don't

- Do not edit the original, or rewrite notes from your own reading of the music: only apply the documented fixes.
- Do not say "perfect" or "all fixed". Say what was checked.
- Do not click permission boxes on the user's behalf unless they chose that in step 3.
- Do not send the user's files anywhere.

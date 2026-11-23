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
- **A `.sib` file that already looks wrong**: the damage happened at import time; ask for the original MusicXML.

## 2. Find the problems (no Sibelius needed)

Run `node scripts/doctor.mjs <file> <output folder>` (it never changes the file; `--dry-run` only reports). It reports, in terms of parts and bar numbers, what Sibelius is known to mishandle. `references/problems.md` lists each kind, how it shows up in Sibelius, how it is fixed, and what we measured. Say plainly what was found and what will be changed, then fix. Where a fix involves a choice (for example trimming versus padding an overlong bar), pick the safer default, say which, and offer the other.

Outputs, always as copies: the fixed MusicXML and a short report of what changed and what did not. Never claim the file is perfect; report only what can be checked.

## 3. Check it inside Sibelius (optional, needs Sibelius Connect)

Only when Sibelius is installed and the user wants the check, or when the result needs to be sure. It imports the original and the fixed file, reads every note back, compares, and leaves a comment in a saved `.sib` on every bar it changed and every bar it could not fix, saying what happened there. `references/connect.md` has the connection steps, the bridge, and troubleshooting.

- **Check the Sibelius version first.** The check is built for Sibelius 26.11 (the November 2026 release), where Connect gained live reading from Sibelius. If the installed version is older, tell the user to update and why, in a sentence, then carry on with step 2 without Connect.
- **Connect approval is the user's to give.** Sibelius shows an approval box for each new connection; ask the user to click Yes. Never click it for them.
- **The MusicXML import options box.** Importing pops a box in Sibelius. The first time it matters, ask once: "Do you want to click OK yourself each time, or let me click it for you? (I would need your permission for the computer to be controlled.)" Store the answer with `scripts/config.mjs` and do not ask again; honour it until the user changes their mind. If they chose "you click", say when to click and wait.
- If Connect cannot be set up, finish with the step-2 result and say that the in-Sibelius check was skipped and why.

## 4. Hand back

One output folder with the fixed MusicXML, the report, and, if step 3 ran, the `.sib` with those comments. Start the reply with the result: how many things were fixed, how many bars still need the user's eyes, and where the files are. Open the fixed file in Sibelius if they want.

## Don't

- Do not edit the original, or rewrite notes from your own reading of the music: only apply the documented fixes.
- Do not say "perfect" or "all fixed". Say what was checked.
- Do not click permission boxes on the user's behalf unless they chose that in step 3.
- Do not send the user's files anywhere.

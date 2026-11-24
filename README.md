# sibelius-import-doctor

Sibelius can silently drop notes or draw tremolos wrong when it imports a MusicXML file. This skill lets your AI assistant find those problems, fix them in a copy of your file, and check the result inside Sibelius.

Not affiliated with Avid. Sibelius is a trademark of Avid Technology.

## One sentence

Paste this into Claude, Codex or another AI assistant that can run commands on your computer:

> Read https://github.com/kanlac/sibelius-import-doctor, set it up for me, then fix my MusicXML file `<path to file>` for Sibelius.

The assistant installs the skill (and what it needs, such as Node.js) and does the rest. You answer a few questions.

## What happens

1. It looks through your MusicXML for things Sibelius is known to mishandle and tells you where they are, in bar numbers.
2. It writes a fixed copy and a short report. Your original is never changed.
3. It compares the original and fixed imports through [Sibelius Connect](https://www.avid.com/sibelius): note counts by part and bar, bar lengths, tuplets and tremolos. It saves a Sibelius score with comments where the music changed or needs review.

The file fix works without Sibelius Connect; the Sibelius step needs Sibelius 26.11 (November 2026) or newer, the release where Connect gained live reading from Sibelius. If yours is older, the assistant will suggest updating.

Only have a PDF? Your assistant will use [sheetmusic-pdf-convert](https://github.com/kanlac/sheetmusic-pdf-convert) to get a MusicXML first.

## Why Sibelius Connect and not computer use?

An assistant with computer use can drive Sibelius by looking at screenshots. This skill reads the score through Sibelius Connect instead:

- **Cheaper and faster.** No screenshots go to the model and nothing waits on the screen: opening both versions and reading them back takes about 10 seconds per score (7 to 56 seconds across the 22 real scores we ran).
- **Exact.** The plug-in reads every note, bar, tuplet and tremolo straight from Sibelius' own data. A score has thousands of notes, and counting those by eye from images is not reliable.
- **Stable and repeatable.** Same file in, same result out. It does not depend on window positions, zoom or what happens to be on screen. Computer use is only an optional helper for clicking Sibelius' import box.

## What to expect

Not every problem can be fixed automatically, and the report says what was checked and what was not. Tested on macOS with Claude Code and Codex; Windows paths are documented but untested.

## Install by hand

Claude Code:

```
claude plugin marketplace add kanlac/sibelius-import-doctor
claude plugin install sibelius-import-doctor@sibelius-import-doctor
```

Codex:

```
codex plugin marketplace add kanlac/sibelius-import-doctor
codex plugin add sibelius-import-doctor@sibelius-import-doctor
```

Then start a new session. Node.js 22 or newer is needed; the assistant installs it if it is missing.

## What it installs

The skill in your assistant's plugin folder, a small read-only plug-in in Sibelius' plug-ins folder (restart Sibelius once after the first install), and a small settings file. To remove them, ask your assistant to uninstall sibelius-import-doctor and delete the plug-in and settings file.

## For AI assistants

You were probably sent here by a user. They are not a developer: install the skill for them without asking about each step, including Node.js if it is missing. Use the Claude Code or Codex commands above; with any other app, copy `plugins/sibelius-import-doctor/skills/sibelius-import-doctor/` into the user-level skills folder it reads. Then read that folder's `SKILL.md` and follow it with the user's file. If the user only has a PDF, use https://github.com/kanlac/sheetmusic-pdf-convert first.

MIT license.

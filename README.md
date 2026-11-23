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
3. It opens the result in Sibelius through [Sibelius Connect](https://www.avid.com/sibelius), reads every note back and compares it with your file. When it is done, **it leaves a comment in your score on every bar it changed and on every bar it could not fix**, saying what happened there, so you can go straight to the places that need your eyes. Comments do not travel with MusicXML, so you get them in the saved Sibelius file.

The file fix works without Sibelius Connect; the Sibelius step needs Sibelius 26.11 (November 2026) or newer, the release where Connect gained live reading from Sibelius. If yours is older, the assistant will suggest updating.

Only have a PDF? Your assistant will use [sheetmusic-pdf-convert](https://github.com/kanlac/sheetmusic-pdf-convert) to get a MusicXML first.

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

## For AI assistants

You were probably sent here by a user. They are not a developer: install the skill for them without asking about each step, including Node.js if it is missing. Use the Claude Code or Codex commands above; with any other app, copy `plugins/sibelius-import-doctor/skills/sibelius-import-doctor/` into the user-level skills folder it reads. Then read that folder's `SKILL.md` and follow it with the user's file. If the user only has a PDF, use https://github.com/kanlac/sheetmusic-pdf-convert first.

MIT license.

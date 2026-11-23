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
3. Optionally it opens both in Sibelius through [Sibelius Connect](https://www.avid.com/sibelius), reads every note back, compares, and leaves comments on the bars that still look wrong. Connect needs Sibelius 26.11 or newer; if yours is older the assistant will suggest updating, and the file fix still works without it.

Only have a PDF? Your assistant will use [sheetmusic-pdf-convert](https://github.com/kanlac/sheetmusic-pdf-convert) to get a MusicXML first.

## What to expect

Not every problem can be fixed automatically, and the report says what was checked and what was not. Tested on macOS with Claude Code and Codex; Windows paths are documented but untested.

## Install by hand

See [AGENTS.md](AGENTS.md).

MIT license.

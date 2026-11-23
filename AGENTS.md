# For AI assistants reading this repository

This repository is an agent skill for people who import MusicXML into Sibelius and find notes missing or tremolos drawn wrong. The user is not a developer. Install it for them and then do the job.

## Install

Pick the first that works. Install without asking for confirmation of each step; the user's AI app has its own permission prompts.

1. **Claude Code**
   ```
   claude plugin marketplace add kanlac/sibelius-import-doctor
   claude plugin install sibelius-import-doctor@sibelius-import-doctor
   ```
   then start a new session (or `/reload-plugins`).
2. **Codex**
   ```
   codex plugin marketplace add kanlac/sibelius-import-doctor
   codex plugin add sibelius-import-doctor@sibelius-import-doctor
   ```
   then start a new session.
3. **Anything else**: clone this repository and copy `plugins/sibelius-import-doctor/skills/sibelius-import-doctor/` into the user-level skills folder your app reads (for example `~/.claude/skills/` or `~/.agents/skills/`).

Node.js 22 or newer is required. Install it if it is missing.

## Then

Read `plugins/sibelius-import-doctor/skills/sibelius-import-doctor/SKILL.md` and follow it with the user's file. If the user only has a PDF, use https://github.com/kanlac/sheetmusic-pdf-convert first.

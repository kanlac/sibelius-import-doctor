# Checking the result inside Sibelius (Sibelius Connect)

This is step 3 of SKILL.md. `scripts/connect.mjs` opens the user's original and fixed MusicXML in Sibelius, reads every note back through a small ManuScript plug-in, compares each bar with the files, and saves a `.sib` with a comment on every bar where music changed or could not be fixed, and on bars where Sibelius still differs from the file. Comments are the point of the step: they let the user jump straight to the bars that need their eyes. Comments do not survive MusicXML export, so the `.sib` is what the user keeps.

## What it needs

- **Sibelius 26.11 (the November 2026 release) or newer.** The check is built for it: 26.11 is the release where Connect started sending information back from Sibelius. If the installed version is older, tell the user to update Sibelius and why, in a sentence, and finish with the step-2 result without Connect.
- **Sibelius Connect switched on.** Sibelius > Preferences > Input Devices > Sibelius Connect: "Allow Sibelius to be remotely controlled by other applications", network port 1898 (the default). If the user changed the port, pass `--port`.
- **The plug-in installed, and Sibelius restarted afterwards.** Sibelius reads plug-ins only when it starts.
- Node.js 22 or newer (global `WebSocket`). macOS for the agent-clicks mode; Windows paths are documented but untested.

## Steps

1. `node scripts/connect.mjs status` prints one JSON line: Sibelius path, `version` (read from the installed app, e.g. `26.11.0.13211`), `release` (`26.11`), `olderThanTested`, whether it is running, whether the Connect port is listening, the plug-in state and the stored import-dialog choice. It never opens a Connect connection, so no box appears in Sibelius.
2. If `olderThanTested` is true: stop here (see above).
3. If `plugin.current` is false: `node scripts/plugin/install.mjs`. If it reports `restartSibelius: true`, ask the user to quit and reopen Sibelius (or, with their agreement, quit it for them; nothing is lost if no score is open). Say why: Sibelius only loads plug-ins when it starts.
4. If `importDialog` is null, ask the user once (wording in SKILL.md) and store the answer: `node scripts/config.mjs set importDialog user-clicks` or `... agent-clicks`. Never ask again unless they change their mind.
5. Tell the user what will happen before you start: Sibelius will ask whether to allow "Sibelius Import Doctor" to connect (they click **Yes**); in user-clicks mode it will also show its import options box twice (once per file) and they click **OK** each time; they should not switch Sibelius windows until it is done.
6. Run the check, in the background if your app allows it so you can relay prompts as they come:

   ```
   node scripts/connect.mjs check --original ORIGINAL.musicxml --fixed NAME.fixed.musicxml \
        --changes NAME.report.json --out OUTPUT_FOLDER
   ```

   `--original` is optional but gives the "still differs from your file" comments and shows what Sibelius would have done to the untouched file. `--changes` is the doctor's `<name>.report.json` (what it changed and what it could not fix; see below). If Sibelius is not running it is started. `--close` closes the checked score at the end; by default it stays open for the user to look at.
7. Read stdout, one JSON object per line:

   | event | meaning |
   |---|---|
   | `starting-sibelius` | Sibelius was not running and is being started |
   | `waiting`, `for: "approval"` | the connection box is up: ask the user to click Yes |
   | `sibelius-has-open-box` | Sibelius shows a box of its own (`boxes`: their titles, e.g. "Missing Fonts"; an empty title is an unnamed box). Pass the `say` sentence on; the script keeps trying and continues once the box is gone |
   | `dismissed-sibelius-box` | agent-clicks only: the script clicked OK on a box it knows is harmless (`box`) |
   | `waiting`, `for: "sibelius-busy"` | Sibelius is busy and no box can be seen (Accessibility not allowed, or not macOS): ask the user to close any open box |
   | `connected` | approved |
   | `waiting`, `for: "import-ok"` | pass on `say`: it names both layout boxes, their requested state and when to click OK |
   | `agent-cannot-click` | `reason` is `accessibility-permission`, `layout-unavailable` (cannot confirm the requested settings), `box-not-found` (nothing found within 30 s; it keeps trying) or `not-macos`. Relay the instructions; a `waiting` / `import-ok` line follows |
   | `done` | finished; exit code 0 |
   | `error` | `code`, `message`, `hint`; exit code 1 |

   Each waiting event carries a `say` sentence you can pass on.
8. The `done` line starts with `headline`, the numbers for your first sentence: `notesLostImportingOriginal` (what Sibelius dropped from the untouched file; null without `--original`), `notesLostAfterFix`, `barsNeedingEyes`, `seriousBars` (level 3) and `barsChangedNothingToDo`. `barsNeedingEyes` (up to 100, most serious first) lists each with part name, bar number, level and the comment text. It also has the `.sib` path, the JSON details path (`<fixed name>.sibelius-check.json`), note totals for the original and the fixed import (`xmlNotes`, `sibeliusNotes`, `lost`, `gained`, and `movedBetweenStaves`, which is informational), `differsFromOriginalBars`, and `comments`: how many bars got a comment, how many per level (`byLevel`), how many were only changed and need nothing from the user (`changedNothingToDo`, level 1), how many need the user's eyes (`needYourEyes`, levels 2 and 3), and how many harmless rest-only changes were left uncommented. Lead with the headline in plain words.

## The connection box (approval)

Each new Connect connection makes Sibelius ask:

> Application "Sibelius Import Doctor" is trying to connect to Sibelius for remote control. Do you want to allow it to invoke commands and ManuScript plug-ins?  [No] [Yes]

This is the user's decision. Ask them to click Yes; never click it for them, in either mode, and never script it. The check waits up to 5 minutes (`SIBELIUS_IMPORT_DOCTOR_APPROVAL_SECONDS` changes that). If the check gives up, **the box stays open in Sibelius** (seen on 26.11): closing the WebSocket does not withdraw it. A connection attempt made while such a box was open got `busyError` in our tests, so before running again ask the user to click No on the old box; the next run then shows a fresh one. While the macOS screen saver is on, Sibelius' boxes are hidden and Accessibility lists no Sibelius windows at all. The screen saver is not a lock screen: a Shift key press (`key code 56` through System Events) wakes it. One run is one connection; a second run asks again. The documented `sessionToken` reconnection did not help in practice: on 26.11 a reconnect with a token from a live session got no answer at all, and after a Sibelius restart the token is rejected (`kClientRejected_ConnectTokenRejected`). So the script never stores tokens.

## The import options box

Opening MusicXML makes Sibelius show "Open MusicXML File" with import options. The plug-in call that opens the file does not return until the box is answered, and `Sibelius.Open(path, True)` (the "quiet" flag) does not suppress it.

`check --import-layout file|house-style` applies to both the original and fixed imports. `file` (the default) checks **Use page and staff size from MusicXML file** and **Use layout and formatting from MusicXML file**. `house-style` clears both boxes to use Sibelius' layout settings. In a live check of Score A on 26.11, both modes gave the same note counts, comments and visible first-page layout, including the overlapping title, names and staves. The option leaves the MusicXML and the comparison rules unchanged.

- **user-clicks**: relay the `waiting` / `import-ok` instructions for each file. The user sets the two boxes and presses OK; the script waits up to 15 minutes per file.
- **agent-clicks** (macOS only): the script searches the “Open MusicXML File” window, including nested groups, for the two named Accessibility buttons or checkboxes. Sibelius 26.11 includes an ampersand for the keyboard shortcut in each Accessibility name. The script clicks only controls in the wrong state and checks their values before pressing OK. If either setting cannot be confirmed, it leaves OK to the user. If the window cannot be found (for example, its title is translated), the script also asks the user after 30 seconds. It may press Shift to wake a screen saver while waiting.
  - The first time, macOS asks: "*<your assistant's app>* would like to control this computer using accessibility features" with Open System Settings / Deny. The user grants it in System Settings > Privacy & Security > Accessibility by switching on the app your assistant runs in (Terminal, iTerm, the Claude or Codex app...). macOS may also ask to let it control "System Events" (Automation). Until then osascript fails with error -25211 ("not allowed assistive access"); the script emits `agent-cannot-click` with reason `accessibility-permission` and waits for the user to click OK instead.
  - On Windows the script always asks the user.

The user always handles the connection approval. In user-clicks mode they also handle each import box.

## What the comments say

Comments go only where the music changed (notes or tremolos), where something could not be fixed, or where Sibelius shows something different from the user's file. Harmless rest-only normalisations (a whole-bar rest set to the length of the bar, rests added so a part fills its bar) are counted but never commented; without that, a 38-bar orchestral score got 299 comments, 253 of them about rest lengths. That rule never hides a bar the doctor tells the user to look at: every bar in the doctor's `needs_attention` list gets a level-2 comment. In pad mode, the bars it kept longer than the time signature (padding the other parts with rests) are commented: `bar longer than the time signature in 5 parts (Clarinet 1, Oboe 2, Harp, +2 more): one note value is probably wrong; compare with the original`. In trim mode, notes it removed past a bar line are level 2 ("compare with the original") instead of a level-1 change.

One comment per staff and bar, signed "Doctor", graded, and as short as it can be while saying what and how much:

| level | meaning | colour | shown | example |
|---|---|---|---|---|
| 1 | changed, nothing to do | grey-green | minimised | `two-note tremolo rewritten: so Sibelius draws it correctly` |
| 2 | please check | amber | minimised | `tuplet lost (1 note), bar lasts 4.17 quarters (file 4): plain notes in Sibelius, rhythm off` |
| 3 | serious: music lost or added that the doctor could not fix | red | open | `1 note missing (file 4, Sibelius 3): lost on import` |

- The same finding (same kind and wording) in the same bar in several parts becomes **one** comment on the topmost of those staves, with the number of parts and the first three names, e.g. `in 5 parts (Clarinet 1, Oboe 2, Harp, +2 more)`. Findings that differ between parts (notes missing with their counts, a lost tuplet, ...) stay on their own staff. Score A in pad mode went from 64 comments (one per overlong part) to 18, one per affected bar. The details JSON keeps every part (`problems`, and `parts` on each comment).
- The comment takes the highest level of its findings; findings are listed highest first, separated by "; ".
- Level 3: notes missing or extra in Sibelius compared with the fixed file, and problems the doctor could not fix that make Sibelius cut music (an overlong bar). Level 2: bars the doctor lists as needing attention (kept longer than the time signature, notes removed past a bar line), still differs from the user's original file, a tuplet lost, a bar of the wrong length, tremolos lost, a two-note tremolo inside a tuplet, a voice running past the bar line, and other problems the doctor left as they were. Level 1: changes the doctor made to notes or tremolos.
- "file" in a count means the fixed file Sibelius imported; "your file" means the user's original. When both counts say the same thing, only the first is kept. "all staves of the part" marks a count over a multi-staff part.
- Inside a part, the first finding of a kind carries its explanation after a colon; later ones of the same kind only say `same: <short form>`.
- The full wording, levels and every finding are in the details JSON (`comments`, `problems`); the comment carries none of the machine details.

### Colour and author: what the plug-in uses

The installed 26.11 *ManuScript Language* guide (p. 54, `Bar.AddCommentWithName`) documents separate colour and `maximized` arguments. Omitting `maximized` opens the comment; `False` minimises it. The plug-in supplies the author “Doctor”, a 24-bit RGB colour, and `False` for levels 1 and 2 or `True` for level 3. The level is not part of the text.

On Sibelius 26.11 for macOS, a reopened `.sib` shows grey-green and amber markers with a “D” for levels 1 and 2. Level 3 stays open with a red background and “Doctor” in its header. The comment body starts with the finding. The JSON also records each numeric grade.

At most 300 comments are added; the JSON details list every bar.

### The `--changes` file

Normally pass the doctor's own `<name>.report.json`: entries of its change log that touch notes or tremolos (notes past the bar line removed or shortened, tremolos rewritten) become level-1 findings, and every problem it reports as not fixed becomes a level-2 or level-3 finding on each bar it lists. Its rest-only fixes (`measure-rest`, `pad`, `pad-empty-measure`) and an unfixed overlong rest are classified as harmless in connect.mjs and get no comment. Score-wide changes (short part names, composer) have no bar and get no comment either.

Any other tool can pass a plain list instead:

```json
{
  "changed": [{ "part": "P1", "measure": "12", "text": "notes past the bar line were trimmed" }],
  "unfixed": [{ "part": "P3", "measure": "40", "staff": 2, "text": "voice 2 is still too long" }]
}
```

`part` is the MusicXML part id (a part name also works), `measure` the measure number as printed in the file, or `measureIndex` (1-based position in the part) instead, `staff` the staff inside the part (default 1), `text` a short plain-words description (it becomes the short form in the comment), `level` (1–3) optionally for an `unfixed` entry (default 2), `harmless: true` for a change that leaves notes and tremolos alone (counted, not commented). Entries that cannot be placed are listed under `doctorChanges.unplaced` in the details and counted in `doctorEntriesNotPlaced`.

### How bars are compared

Notes and tremolos are counted **per part and bar**, summed over the part's staves: chord notes and grace notes count, rests do not, and a tremolo counts once per chord (chord members without a `<voice>` belong to the voice of the chord's first note). Counting per staff gave false alarms on multi-staff parts (piano, harp, accordion): Sibelius sometimes shows a note on another staff of the same part than the file's `<staff>` says (cross-staff notation), and a chord spread over both staves carries its tremolo on one staff only. A real Sibelius 25.7 export with a three-staff accordion part showed 109 notes "lost" and exactly 109 "gained" per staff, all netting to zero within each part. Such moves are now only counted (`movedBetweenStaves` in the totals) and never commented. A real difference inside a multi-staff part is reported on the staff of that part where it shows most, with the counts for the whole part ("across the part's staves"). Two-note tremolos inside a tuplet and voices running past the bar line are Sibelius-side facts and stay per staff.

MusicXML `<staff>` numbers map to the Sibelius staves of the part in order, and bars are matched by position, not by printed number (a pickup is bar 1 in both). Comments and reports name the bar by the number printed in the file. If Sibelius ends up with a different number of staves than the file, only totals and bar lengths are compared. Bar length is checked against what the file asks for: the time signature, or the length of the music when that is longer (an overlong bar the doctor padded) or when the bar is a pickup. Three cases:

- **Tuplet rounding, not reported.** Sibelius measures in whole ticks (256 per quarter), so a triplet eighth is 85.33 ticks and a tuplet group can come out a tick long or short. A difference of at most one tick per tuplet group in the bar (counted from the tuplets Sibelius reports) is ignored and only counted (`barLengthWithinTupletRounding`).
- **Tuplet lost, reported as such.** Notes the file puts in a tuplet (`<time-modification>`) are counted per part and bar and compared with the note-rests Sibelius has inside a tuplet. When Sibelius has fewer, those notes are plain notes in Sibelius and the bar usually grows by the difference: a triplet eighth played as a plain eighth adds 128 - 85.33 = 42.67 ticks, so the bar reads 4.16 or 4.17 quarter notes instead of 4. Rounding cannot produce that, so the comment says the rhythm is off and gives the bar length.
- **Anything else is a bar-length problem**, e.g. the Score A case: notes past the bar line that Sibelius drops or keeps by changing the bar. Those are always reported, on the part that causes them: the part whose music in the file sets the bar's length when that differs from the time signature, else the part whose notes run past the bar line in Sibelius, else the first part with notes in that bar. The comment says what to do, e.g. `bar lasts 1.5 quarters in Sibelius (file 2): Sibelius cut the bar; compare the rhythm with the original`.

For every bar with a bar-length or tuplet problem, the details JSON keeps what Sibelius holds there (`sibeliusEvidence`: the bar length and the raw plug-in rows: staff, bar, position, duration, voice, note count, tuplet left and right, two-note and single tremolo, grace), so a doubtful case can be settled from the data without reopening Sibelius.

## Errors and what to do

| code | what to do |
|---|---|
| `sibelius-too-old` | tell the user to update; hand back the step-2 result |
| `no-sibelius` | Sibelius is not installed; skip step 3 |
| `no-connect` | Sibelius not reachable: is it open and finished starting? Is Connect switched on, on that port? |
| `not-allowed` | Sibelius refused and no box of its own could be seen: the user clicked No, or (when Accessibility cannot read Sibelius' windows) another box was in the way. Ask which; then try again |
| `approval-timeout` | nobody answered; the box is still open. Ask the user to click No on it, then run again and click Yes |
| `sibelius-busy` | a dialog is open in Sibelius, often a leftover connection box; ask the user to close it (No on a leftover connection box) |
| `plugin-missing` / `plugin-outdated` | run `scripts/plugin/install.mjs`, then the user restarts Sibelius (a newer installed plug-in is accepted) |
| `import-failed` | the import box was cancelled, or Sibelius could not read the file |
| `sibelius-closed` | Sibelius quit or crashed during the run; see below |
| `sibelius-timeout` | Sibelius stopped answering; usually a dialog box is waiting in its window |
| `bad-musicxml` / `unsupported-musicxml` | the file could not be parsed (timewise MusicXML is not supported) |

Set `SIBELIUS_IMPORT_DOCTOR_DEBUG=1` to log every Connect frame to stderr.

## The plug-in

`scripts/plugin/SibeliusImportDoctor.plg.txt` is the ManuScript source (UTF-8). `scripts/plugin/install.mjs` writes it as UTF-16LE with a byte-order mark, the encoding Sibelius' own plug-ins use, to:

- macOS: `~/Library/Application Support/Avid/Sibelius/Plugins/Import Doctor/SibeliusImportDoctor.plg`
- Windows (untested): `%APPDATA%\Avid\Sibelius\Plugins\Import Doctor\SibeliusImportDoctor.plg`

`--check` reports without writing (including `installedVersion` and `newerInstalled`), `--remove` uninstalls. The installer only upgrades: if the installed plug-in has the same or a newer version than this copy (for example after the skill was run from an older cached copy), it keeps it, reports `changed: false` and says why in `note`; `--force` replaces it anyway. It appears in Sibelius under the Plug-ins menu as "Sibelius Import Doctor" and does nothing when run by hand. It only reads the score, adds comments (author "Doctor", colour and open or minimised per level), saves a `.sib` copy and closes the scores this check opened: there is deliberately no method that edits notes, because the connection box grants the client whatever the plug-in can do. Its version (`Ping`) must be at least `PLUGIN_VERSION` in `install.mjs`; bump both together for every plug-in change, and remember the user has to restart Sibelius after every plug-in change.

## Learned the hard way

- **Connecting while Sibelius is still starting**: the port may already accept the WebSocket, which then closes at once with no reason. On a cold start the socket can also stay open for several seconds and then close without a reason. Only a close whose reason says rejected (`kClientRejected_*`) is treated as the user's No; any other close before an answer means "not ready yet", and the script retries every 3 seconds, for up to 5 minutes when it launched Sibelius itself and 3 minutes otherwise.
- **`busyError`** ("Sibelius is busy processing a message") answers a connect attempt while a modal dialog is open in Sibelius, including the import box of another client.
- **Sibelius' own boxes at start-up.** Sibelius reopens the previous session's score when it starts and may show a modal box first: "Missing Fonts", or a file-recovery box after a crash. While such a box is open Sibelius closes the Connect socket with a rejection reason, which looks exactly like the user's No. So on every rejection or `busyError` the script reads Sibelius' windows through Accessibility (dialog windows other than Quick Start). If a box is there it emits `sibelius-has-open-box` and keeps retrying every 3 seconds (up to 5 minutes) instead of failing. In agent-clicks mode it clicks OK on boxes it knows are harmless, currently only "Missing Fonts"; it never clicks a box it does not recognise, and never the connection box. Without Accessibility (user-clicks without permission, or Windows) it cannot see boxes, so a rejection ends the run with `not-allowed` and a hint to close any open box. Reading the window list needs the same Accessibility permission as clicking.
- **One message at a time.** Connect processes one request per connection; replies carry no id. The script keeps one request in flight and treats the connection as unusable after any timeout, because a late reply would otherwise be taken as the answer to the next request.
- **The reply field is `returnValue`**, although the ManuScript Language Guide's example says `return_value`. `result: false` means the plug-in or method was not found, which is what happens when the plug-in is not installed, was installed while Sibelius was running, or is not listed in the handshake: the handshake's `plugins` array must name every plug-in (file name without extension) the client will call, and it cannot change for the life of the connection.
- **Crashes.** A large, badly broken MusicXML file crashed Sibelius during import in our tests; the connection then closes with code 1006. When Sibelius is reopened it may offer to recover files; answering No is fine. Then run the check again.
- **Closing scores**: `Sibelius.Close(False)` closes whatever view is active, without asking to save. The plug-in only closes the active score if its staff count and title match the score this check opened, but the user should still not switch windows during a run.
- **Quitting Sibelius from AppleScript** (`tell application "Sibelius" to quit`) reports error -128 "User canceled" even though Sibelius does quit.
- **ManuScript pitfalls** (in the plug-in source): method bodies are double-quoted strings, so strings inside them use single quotes; compare with `=` and `!=`; test a missing object with `not (x = null)` (e.g. `ParentTupletIfAny`); prefer `nr.Highest` / `nr.Lowest` or `for each` over indexing notes in a chord with `nr[k]`, whose base we found inconsistent; sparse arrays and dictionaries come back as JSON arrays and objects, other objects come back as `null`.
- **Sibelius tick values**: a quarter note is 256 ticks. For notes in a tuplet, `Duration` is the written value; the real length is `Duration * Right / Left` of the parent tuplet.
- **Version numbers**: the app's `CFBundleShortVersionString` is `26.11.0.13211` for the November 2026 release (on Windows, the ProductVersion of Sibelius.exe). Inside ManuScript, `Sibelius.ProgramVersion` returns an integer; the check records it in the details as `programVersion`.

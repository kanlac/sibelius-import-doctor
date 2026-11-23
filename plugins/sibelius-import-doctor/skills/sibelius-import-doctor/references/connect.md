# Checking the result inside Sibelius (Sibelius Connect)

This is step 3 of SKILL.md. `scripts/connect.mjs` opens the user's original and fixed MusicXML in Sibelius, reads every note back through a small ManuScript plug-in, compares each bar with the files, and saves a `.sib` with a comment on every bar that was changed, could not be fixed, or still differs. Comments are the point of the step: they let the user jump straight to the bars that need their eyes. Comments do not survive MusicXML export, so the `.sib` is what the user keeps.

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
   | `waiting`, `for: "sibelius-busy"` | Sibelius has a dialog open: ask the user to close it |
   | `connected` | approved |
   | `waiting`, `for: "import-ok"` | the import options box is up: ask the user to click OK |
   | `accessibility-needed` | agent-clicks was chosen but macOS refused; see below. The run continues and waits for the user's OK |
   | `done` | finished; exit code 0 |
   | `error` | `code`, `message`, `hint`; exit code 1 |

   Each waiting event carries a `say` sentence you can pass on.
8. The `done` line has the `.sib` path, the JSON details path (`<fixed name>.sibelius-check.json`), note totals for the original and the fixed import (`xmlNotes`, `sibeliusNotes`, `lost`, `gained`), `differsFromOriginalBars`, and `comments`: how many bars got a comment, how many only say what was fixed (`changedOnly`) and how many need the user's eyes (`needYourEyes`), plus the first of those with part name and bar number. Lead with that in plain words.

## The connection box (approval)

Each new Connect connection makes Sibelius ask:

> Application "Sibelius Import Doctor" is trying to connect to Sibelius for remote control. Do you want to allow it to invoke commands and ManuScript plug-ins?  [No] [Yes]

This is the user's decision. Ask them to click Yes; never click it for them, in either mode, and never script it. The check waits up to 5 minutes (`SIBELIUS_IMPORT_DOCTOR_APPROVAL_SECONDS` changes that). One run is one connection; a second run asks again. The documented `sessionToken` reconnection did not help in practice: on 26.11 a reconnect with a token from a live session got no answer at all, and after a Sibelius restart the token is rejected (`kClientRejected_ConnectTokenRejected`). So the script never stores tokens.

## The import options box

Opening MusicXML makes Sibelius show "Open MusicXML File" with import options. The plug-in call that opens the file does not return until the box is answered, and `Sibelius.Open(path, True)` (the "quiet" flag) does not suppress it.

- **user-clicks**: the script emits `waiting` / `import-ok` and waits (up to 15 minutes per file). Tell the user to click OK.
- **agent-clicks** (macOS only): the script presses OK through macOS Accessibility (`osascript` and System Events), with the box's current options. The checkboxes in that box are not exposed to Accessibility, so whatever the user last chose there is used. If the box is not found within 30 seconds (for example a Sibelius in another language, where the box has another title), it falls back to asking the user.
  - The first time, macOS asks: "*<your assistant's app>* would like to control this computer using accessibility features" with Open System Settings / Deny. The user grants it in System Settings > Privacy & Security > Accessibility by switching on the app your assistant runs in (Terminal, iTerm, the Claude or Codex app...). macOS may also ask to let it control "System Events" (Automation). Until then osascript fails with error -25211 ("not allowed assistive access"); the script emits `accessibility-needed` and waits for the user to click OK instead.
  - On Windows the script always asks the user.

Human clicks per run: user-clicks = 1 approval + 1 OK per imported file (3 with `--original`); agent-clicks = 1 (the approval).

## What the comments say

One comment per staff and bar, signed "Import Doctor", made of the parts that apply:

- `Fixed: notes past the bar line were trimmed.` (from `--changes`, list `changed`)
- `Not fixed: voice 2 is still too long.` (from `--changes`, list `unfixed`)
- `Still differs from your file: 1 note missing (your file has 9, Sibelius shows 8).` (fixed import compared with the original MusicXML; only when both have the same staves and bars)
- `Sibelius did not import this as the fixed file says: ...` followed by one of: notes missing or extra, tremolos missing, a two-note tremolo inside a tuplet (drawn as double whole notes), notes in a voice running past the bar line, or a bar whose length in Sibelius differs from the music in the file.

At most 300 comments are added; the JSON details list every bar.

### The `--changes` file

Normally pass the doctor's own `<name>.report.json`: every bar-level entry of its change log becomes a "Fixed:" comment (rests set to the bar length, rests added, notes past the bar line removed or shortened, tremolos rewritten), and every problem it reports as not fixed becomes a "Not fixed:" comment on each bar it lists. Score-wide changes (short part names, composer) have no bar and get no comment.

Any other tool can pass a plain list instead:

```json
{
  "changed": [{ "part": "P1", "measure": "12", "text": "notes past the bar line were trimmed" }],
  "unfixed": [{ "part": "P3", "measure": "40", "staff": 2, "text": "voice 2 is still too long" }]
}
```

`part` is the MusicXML part id (a part name also works), `measure` the measure number as printed in the file, or `measureIndex` (1-based position in the part) instead, `staff` the staff inside the part (default 1), `text` a short plain-words description that reads well after "Fixed:" or "Not fixed:". Entries that cannot be placed are listed under `doctorChanges.unplaced` in the details and counted in `doctorEntriesNotPlaced`.

### How bars are compared

Notes are counted per staff and bar: chord notes and grace notes count, rests do not, MusicXML `<staff>` numbers map to the Sibelius staves of the part in order, and bars are matched by position, not by printed number (a pickup is bar 1 in both). Comments and reports name the bar by the number printed in the file. If Sibelius ends up with a different number of staves than the file, only totals and bar lengths are compared. Bar length is checked against what the file asks for: the time signature, or the length of the music when that is longer (an overlong bar the doctor padded) or when the bar is a pickup.

## Errors and what to do

| code | what to do |
|---|---|
| `sibelius-too-old` | tell the user to update; hand back the step-2 result |
| `no-sibelius` | Sibelius is not installed; skip step 3 |
| `no-connect` | Sibelius not reachable: is it open and finished starting? Is Connect switched on, on that port? |
| `not-allowed` | No was clicked (or the box was closed). Ask whether to try again |
| `approval-timeout` | nobody answered the box; ask the user to look for it and run again |
| `sibelius-busy` | a dialog is open in Sibelius; ask the user to close it |
| `plugin-missing` / `plugin-outdated` | run `scripts/plugin/install.mjs`, then the user restarts Sibelius |
| `import-failed` | the import box was cancelled, or Sibelius could not read the file |
| `sibelius-closed` | Sibelius quit or crashed during the run; see below |
| `sibelius-timeout` | Sibelius stopped answering; usually a dialog box is waiting in its window |
| `bad-musicxml` / `unsupported-musicxml` | the file could not be parsed (timewise MusicXML is not supported) |

Set `SIBELIUS_IMPORT_DOCTOR_DEBUG=1` to log every Connect frame to stderr.

## The plug-in

`scripts/plugin/SibeliusImportDoctor.plg.txt` is the ManuScript source (UTF-8). `scripts/plugin/install.mjs` writes it as UTF-16LE with a byte-order mark, the encoding Sibelius' own plug-ins use, to:

- macOS: `~/Library/Application Support/Avid/Sibelius/Plugins/Import Doctor/SibeliusImportDoctor.plg`
- Windows (untested): `%APPDATA%\Avid\Sibelius\Plugins\Import Doctor\SibeliusImportDoctor.plg`

`--check` reports without writing, `--remove` uninstalls. It appears in Sibelius under the Plug-ins menu as "Sibelius Import Doctor" and does nothing when run by hand. It only reads the score, adds comments, saves a `.sib` copy and closes the scores this check opened: there is deliberately no method that edits notes, because the connection box grants the client whatever the plug-in can do. Its version (`Ping`) must match `PLUGIN_VERSION` in `install.mjs`; bump both together, and remember the user has to restart Sibelius after every plug-in change.

## Learned the hard way

- **Connecting while Sibelius is still starting**: the port may already accept the WebSocket, which then closes at once with no reason. The script retries every 3 seconds for up to 3 minutes. A close that carries a `kClientRejected_*` reason, or comes after the box has been up for a while, is a refusal and is not retried (retrying would pop the box again).
- **`busyError`** ("Sibelius is busy processing a message") answers a connect attempt while a modal dialog is open in Sibelius, including the import box of another client.
- **One message at a time.** Connect processes one request per connection; replies carry no id. The script keeps one request in flight and treats the connection as unusable after any timeout, because a late reply would otherwise be taken as the answer to the next request.
- **The reply field is `returnValue`**, although the ManuScript Language Guide's example says `return_value`. `result: false` means the plug-in or method was not found, which is what happens when the plug-in is not installed, was installed while Sibelius was running, or is not listed in the handshake: the handshake's `plugins` array must name every plug-in (file name without extension) the client will call, and it cannot change for the life of the connection.
- **Crashes.** A large, badly broken MusicXML file crashed Sibelius during import in our tests; the connection then closes with code 1006. When Sibelius is reopened it may offer to recover files; answering No is fine. Then run the check again.
- **Closing scores**: `Sibelius.Close(False)` closes whatever view is active, without asking to save. The plug-in only closes the active score if its staff count and title match the score this check opened, but the user should still not switch windows during a run.
- **Quitting Sibelius from AppleScript** (`tell application "Sibelius" to quit`) reports error -128 "User canceled" even though Sibelius does quit.
- **ManuScript pitfalls** (in the plug-in source): method bodies are double-quoted strings, so strings inside them use single quotes; compare with `=` and `!=`; test a missing object with `not (x = null)` (e.g. `ParentTupletIfAny`); prefer `nr.Highest` / `nr.Lowest` or `for each` over indexing notes in a chord with `nr[k]`, whose base we found inconsistent; sparse arrays and dictionaries come back as JSON arrays and objects, other objects come back as `null`.
- **Sibelius tick values**: a quarter note is 256 ticks. For notes in a tuplet, `Duration` is the written value; the real length is `Duration * Right / Left` of the parent tuplet.
- **Version numbers**: the app's `CFBundleShortVersionString` is `26.11.0.13211` for the November 2026 release (on Windows, the ProductVersion of Sibelius.exe). Inside ManuScript, `Sibelius.ProgramVersion` returns an integer; the check records it in the details as `programVersion`.

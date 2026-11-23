# Corpus scan, 2026-11-23

`scripts/doctor.mjs --dry-run` (commit 0dd52c8) on every MusicXML file in a private test corpus of real scores: 86 files. The corpus folder also holds 181 PDFs, which were not scanned. The program is the one named in the file's `<encoding><software>`, which is the last program that exported the file, not necessarily the one it was engraved in. Each cell counts files that contain the problem at least once.

| Program (`<software>`) | Files | Overlong bar | Overlong rest | Two-note tremolo (2:1) | Unusual two-note tremolo | Unmeasured tremolo | Missing short names | Missing composer | No findings |
|---|---|---|---|---|---|---|---|---|---|
| MuseScore Studio 4.7.5 | 55 | 0 | 0 | 5 | 0 | 0 | 54 | 0 | 1 |
| Sibelius 25.7.0 ("Direct export, not from Dolet") | 21 | 0 | 0 | 3 | 0 | 0 | 0 | 10 | 11 |
| No `<software>` (hand-written test files) | 7 | 0 | 0 | 0 | 0 | 0 | 7 | 7 | 0 |
| Finale v25 for Mac | 2 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 1 |
| MuseScore 2.3.2 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 |
| **All** | **86** | **0** | **0** | **8** | **0** | **0** | **61** | **18** | **14** |

Totals across all files: 143 bars (counted per part) with a two-note tremolo written with a 2:1 time modification, and 146 parts without a short name. All 86 files were read; nothing crashed or was refused (exit code 0 for every file, at most 0.35 s per file).

**Reading.** These are files exported directly by notation programs, and none of them has the problems that come from PDF conversion: no overlong bars, no overlong rests and no unmeasured tremolos. The finding that matters is the two-note tremolo: 8 files (5 from MuseScore Studio 4.7.5, 3 from Sibelius 25.7) write it as the written value plus a 2:1 time modification, which is the form Sibelius 26.11 draws as double whole notes with a "2". That includes Sibelius's own export (whole notes plus 2:1 in Sibelius 25.7), so the problem can appear even when a file goes from Sibelius back into Sibelius; these particular files were not imported into Sibelius 26.11 to confirm. Missing short names are almost universal in MuseScore Studio exports (54 of 55 files) and absent from Sibelius and Finale exports, so the short-name step will mostly be needed for MuseScore files and for files converted from PDF. A missing composer is common (18 files) but is only fixed when the user supplies the name. Only two Finale files and no Dorico files are in the corpus, so nothing can be said about those programs yet.

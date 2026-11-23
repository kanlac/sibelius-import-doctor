#!/usr/bin/env node
// Installs the Sibelius Import Doctor ManuScript plug-in for the current user.
//
//   node install.mjs            install, or upgrade an older installed version; prints JSON
//   node install.mjs --check    only report what is installed
//   node install.mjs --force    write this copy even over a newer or equal installed version
//   node install.mjs --remove   uninstall
//
// It only upgrades: when the installed plug-in has a newer version than this copy (for example a copy
// of the skill from an older cache), or the same version, it is left alone and the output says so.
//
// The source next to this file is UTF-8; Sibelius gets a UTF-16LE copy with a byte-order mark,
// which is the encoding Sibelius' own plug-ins use.
// Where it goes:
//   macOS    ~/Library/Application Support/Avid/Sibelius/Plugins/Import Doctor/SibeliusImportDoctor.plg
//   Windows  %APPDATA%\Avid\Sibelius\Plugins\Import Doctor\SibeliusImportDoctor.plg   (untested)
// Sibelius reads plug-ins only when it starts: after installing or updating, quit and reopen Sibelius.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

export const PLUGIN_NAME = "SibeliusImportDoctor"; // file name without extension = name used over Connect
export const PLUGIN_VERSION = "0.3.0"; // must match Ping in the .plg source
const CATEGORY = "Import Doctor"; // folder name = Plug-ins menu category
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = path.join(HERE, `${PLUGIN_NAME}.plg.txt`);

export function pluginsDir() {
  if (process.env.SIBELIUS_PLUGINS_DIR) return process.env.SIBELIUS_PLUGINS_DIR;
  const home = os.homedir();
  if (process.platform === "darwin") return path.join(home, "Library", "Application Support", "Avid", "Sibelius", "Plugins");
  if (process.platform === "win32") return path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "Avid", "Sibelius", "Plugins");
  return null;
}

export function pluginPath() {
  const d = pluginsDir();
  return d ? path.join(d, CATEGORY, `${PLUGIN_NAME}.plg`) : null;
}

export function expectedBytes() {
  const text = fs.readFileSync(SOURCE, "utf8").replace(/\r?\n/g, "\r\n");
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
}

export function sibeliusRunning() {
  try {
    if (process.platform === "win32") {
      return execFileSync("tasklist", ["/FI", "IMAGENAME eq Sibelius.exe", "/NH"], { encoding: "utf8" }).includes("Sibelius.exe");
    }
    execFileSync("pgrep", ["-x", "Sibelius"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// Version written in a plug-in file's Ping method, or null.
export function versionOf(buf) {
  const text = buf[0] === 0xff && buf[1] === 0xfe ? buf.subarray(2).toString("utf16le") : buf.toString("utf8");
  const m = /'plugin',\s*'(\d+(?:\.\d+)*)'/.exec(text);
  return m ? m[1] : null;
}

// -1, 0 or 1 comparing dotted version strings numerically.
export function compareVersions(a, b) {
  const pa = String(a).split(".").map(Number), pb = String(b).split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

// current: an installed plug-in at least as new as this copy (connect.mjs accepts newer ones).
export function pluginStatus() {
  const p = pluginPath();
  if (!p) return { supported: false, path: null, installed: false, current: false };
  let installedVersion = null, identical = false, installed = false;
  try {
    const have = fs.readFileSync(p);
    installed = true;
    installedVersion = versionOf(have);
    identical = have.equals(expectedBytes());
  } catch {}
  const cmp = installedVersion ? compareVersions(installedVersion, PLUGIN_VERSION) : -1;
  return { supported: true, path: p, installed, installedVersion, version: PLUGIN_VERSION, identical, newerInstalled: installed && cmp > 0, current: installed && (identical || cmp >= 0) };
}

function main(argv) {
  const st = pluginStatus();
  const running = sibeliusRunning();
  if (!st.supported) return { ok: false, error: "Sibelius runs only on macOS and Windows" };
  if (argv.includes("--check")) return { ok: true, ...st, sibeliusRunning: running };
  if (argv.includes("--remove")) {
    fs.rmSync(st.path, { force: true });
    try { fs.rmdirSync(path.dirname(st.path)); } catch {}
    return { ok: true, removed: st.path, restartSibelius: running };
  }
  if (st.installed && !argv.includes("--force")) {
    if (st.identical) return { ok: true, ...st, changed: false, restartSibelius: false };
    const cmp = st.installedVersion ? compareVersions(st.installedVersion, PLUGIN_VERSION) : -1;
    if (cmp >= 0) {
      return { ok: true, ...st, changed: false, restartSibelius: false, note: `Kept the installed plug-in ${st.installedVersion}: it is ${cmp > 0 ? "newer than" : "the same version as"} this copy (${PLUGIN_VERSION}). Nothing was downgraded; use --force to replace it anyway.` };
    }
  }
  fs.mkdirSync(path.dirname(st.path), { recursive: true });
  fs.writeFileSync(st.path, expectedBytes());
  return {
    ok: true,
    ...pluginStatus(),
    changed: true,
    restartSibelius: running,
    note: running ? "Sibelius is running: quit and reopen it so it loads the new plug-in." : "Sibelius loads it the next time it starts.",
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    process.stdout.write(JSON.stringify(main(process.argv.slice(2))) + "\n");
  } catch (e) {
    process.stdout.write(JSON.stringify({ ok: false, error: e.message }) + "\n");
    process.exit(2);
  }
}

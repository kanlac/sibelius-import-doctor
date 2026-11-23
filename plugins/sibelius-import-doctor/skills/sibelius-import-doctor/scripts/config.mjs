#!/usr/bin/env node
// Per-user settings for sibelius-import-doctor, kept in the OS user config folder.
//
//   node config.mjs                    print every setting and the file path (JSON)
//   node config.mjs get <key>          print {"key", "value"}; value is null when unset
//   node config.mjs set <key> <value>  store a value (validated), print {"key", "value"}
//   node config.mjs unset <key>        remove a value
//   node config.mjs path               print the config file path
//
// Keys:
//   importDialog  "user-clicks" | "agent-clicks"
//                 Who presses OK on Sibelius' MusicXML import options box.
//
// Also importable: getSetting(key), setSetting(key, value), configDir(), configPath().
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const APP = "sibelius-import-doctor";

export const KEYS = {
  importDialog: ["user-clicks", "agent-clicks"],
};

export function configDir() {
  if (process.env.SIBELIUS_IMPORT_DOCTOR_CONFIG_DIR) return process.env.SIBELIUS_IMPORT_DOCTOR_CONFIG_DIR;
  const home = os.homedir();
  if (process.platform === "darwin") return path.join(home, "Library", "Application Support", APP);
  if (process.platform === "win32") return path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), APP);
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), APP);
}

export function configPath() {
  return path.join(configDir(), "config.json");
}

function readAll() {
  try {
    const data = JSON.parse(fs.readFileSync(configPath(), "utf8"));
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

function writeAll(data) {
  fs.mkdirSync(configDir(), { recursive: true });
  const tmp = configPath() + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  fs.renameSync(tmp, configPath());
}

function checkKey(key) {
  if (!Object.hasOwn(KEYS, key)) throw new Error(`unknown key "${key}"; known keys: ${Object.keys(KEYS).join(", ")}`);
}

export function getSetting(key) {
  checkKey(key);
  const v = readAll()[key];
  return KEYS[key].includes(v) ? v : null;
}

export function setSetting(key, value) {
  checkKey(key);
  if (!KEYS[key].includes(value)) throw new Error(`"${value}" is not allowed for ${key}; use one of: ${KEYS[key].join(", ")}`);
  const data = readAll();
  data[key] = value;
  writeAll(data);
  return value;
}

export function unsetSetting(key) {
  checkKey(key);
  const data = readAll();
  delete data[key];
  writeAll(data);
}

function main(argv) {
  const [cmd, key, value] = argv;
  const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
  if (!cmd) {
    const all = {};
    for (const k of Object.keys(KEYS)) all[k] = getSetting(k);
    out({ path: configPath(), settings: all });
  } else if (cmd === "path") out({ path: configPath() });
  else if (cmd === "get") out({ key, value: getSetting(key) });
  else if (cmd === "set") out({ key, value: setSetting(key, value) });
  else if (cmd === "unset") { unsetSetting(key); out({ key, value: null }); }
  else throw new Error(`unknown command "${cmd}"; use get, set, unset or path`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    process.stdout.write(JSON.stringify({ error: e.message }) + "\n");
    process.exit(2);
  }
}

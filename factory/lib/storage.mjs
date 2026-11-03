import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sleepSync } from './util.mjs';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

export const factoryRoot = process.env.FACTORY_ROOT
  ? path.resolve(process.env.FACTORY_ROOT)
  : path.resolve(moduleDir, '../..');

export const dataDir = process.env.FACTORY_DATA_DIR
  ? path.resolve(process.env.FACTORY_DATA_DIR)
  : path.join(factoryRoot, 'factory', 'data');

export const reportsDir = process.env.FACTORY_REPORTS_DIR
  ? path.resolve(process.env.FACTORY_REPORTS_DIR)
  : path.join(factoryRoot, 'reports');

export const ideasFile = process.env.FACTORY_IDEAS_FILE
  ? path.resolve(process.env.FACTORY_IDEAS_FILE)
  : path.join(factoryRoot, 'ideas', 'ideas.json');

export const venturesDir = process.env.FACTORY_VENTURES_DIR
  ? path.resolve(process.env.FACTORY_VENTURES_DIR)
  : path.join(factoryRoot, 'ventures');

export const publicDir = path.join(factoryRoot, 'factory', 'public');

export function ensureDataDirs() {
  for (const directory of [
    dataDir,
    path.join(dataDir, 'events'),
    path.join(dataDir, 'signups'),
    path.join(dataDir, 'outbox'),
    reportsDir,
  ]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
}

export function dataPath(...parts) {
  return path.join(dataDir, ...parts);
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return structuredClone(fallback);
    throw new Error(`Lecture JSON impossible (${file}) : ${error.message}`);
  }
}

export function writeJson(file, value, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode });
  fs.renameSync(temporary, file);
}

export function appendJsonl(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

export function readJsonl(file) {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw new Error(`Lecture JSONL impossible (${file}) : ${error.message}`);
  }
}

function withLock(file, callback) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const lockFile = `${file}.lock`;
  let handle;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      handle = fs.openSync(lockFile, 'wx', 0o600);
      fs.writeSync(handle, String(process.pid));
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const age = Date.now() - fs.statSync(lockFile).mtimeMs;
        if (age > 30_000) {
          fs.unlinkSync(lockFile);
          continue;
        }
      } catch (statError) {
        if (statError.code !== 'ENOENT') throw statError;
      }
      if (attempt === 59) throw new Error(`Verrou occupé : ${lockFile}`);
      sleepSync(25);
    }
  }
  try {
    return callback();
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
    try {
      fs.unlinkSync(lockFile);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

export function updateJson(file, fallback, callback, mode = 0o600) {
  return withLock(file, () => {
    const current = readJson(file, fallback);
    const { value, result } = callback(current);
    writeJson(file, value, mode);
    return result;
  });
}

export function readText(file, fallback = null) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

export function listFiles(directory, suffix = '') {
  try {
    return fs
      .readdirSync(directory)
      .filter((name) => name.endsWith(suffix))
      .sort();
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

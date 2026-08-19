#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = readJson('package.json');
const lock = readJson('package-lock.json');
const versions = {
  'package.json': pkg.version,
  'package-lock.json': lock.version,
  'package-lock.json packages[""]': lock.packages?.['']?.version,
};

function readJson(path) {
  return JSON.parse(readFileSync(resolve(root, path), 'utf8'));
}

function checkVersion({ quiet = false } = {}) {
  const expected = pkg.version;
  const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
  if (!semver.test(expected)) {
    throw new Error(`Invalid SemVer version in package.json: ${expected}`);
  }
  for (const [source, version] of Object.entries(versions)) {
    if (version !== expected) {
      throw new Error(`Version mismatch: ${source} is ${version ?? 'missing'}, expected ${expected}`);
    }
  }
  if (!quiet) console.log(`Version ${expected} is synchronized.`);
}

const command = process.argv[2];
if (command === 'check-version') {
  checkVersion();
} else if (command === 'print-tag') {
  checkVersion({ quiet: true });
  console.log(`v${pkg.version}`);
} else {
  console.error('Usage: node scripts/release.js <check-version|print-tag>');
  process.exitCode = 1;
}

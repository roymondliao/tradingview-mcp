import { readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

export const TEST_TYPES = Object.freeze(['unit', 'integration', 'e2e']);
const supportDirectories = new Set(['support', 'fixtures', 'helpers']);

/** Module/type directories are the inventory; no per-file suite manifest. */
export async function discoverTests(root) {
  const directory = join(root, 'tests');
  const tests = [];
  async function walk(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.isDirectory() && !supportDirectories.has(entry.name)) {
        await walk(join(path, entry.name));
      } else if (entry.isFile() && entry.name.endsWith('.test.js')) {
        const absolute = join(path, entry.name);
        const parts = relative(directory, absolute).split(sep);
        const typeIndexes = parts.slice(0, -1).flatMap((part, index) => TEST_TYPES.includes(part) ? [index] : []);
        if (typeIndexes.length !== 1 || typeIndexes[0] === 0) {
          throw new Error(`Unclassified test: ${relative(root, absolute)}. Use tests/<module>/<unit|integration|e2e>/.`);
        }
        const index = typeIndexes[0];
        tests.push({ file: relative(root, absolute).split(sep).join('/'), module: parts.slice(0, index).join('/'), type: parts[index] });
      }
    }
  }
  await walk(directory);
  return tests.sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0);
}

export function selectTests(tests, { suite = 'local', modules = [] } = {}) {
  if (!['local', ...TEST_TYPES].includes(suite)) throw new Error(`Unknown test suite: ${suite}`);
  const matches = (name, prefix) => name === prefix || name.startsWith(`${prefix}/`);
  for (const module of modules) {
    if (!/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(module) || !tests.some(test => matches(test.module, module))) {
      throw new Error(`Unknown test module: ${module}. Available modules: ${[...new Set(tests.map(test => test.module))].join(', ')}`);
    }
  }
  const selected = tests.filter(test => (suite === 'local' ? test.type !== 'e2e' : test.type === suite)
    && (!modules.length || modules.some(module => matches(test.module, module))));
  if (!selected.length) throw new Error(`No tests selected (suite=${suite}, modules=${modules.join(',') || 'all'}).`);
  return selected;
}

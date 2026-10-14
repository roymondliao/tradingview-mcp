/** Bounded local I/O without imports of Desktop adapters. */
import * as fs from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
export async function readJson(path, maxBytes = 256 * 1024) {
  const handle = await fs.open(path, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw new Error('Invalid or oversized JSON file');
    const data = Buffer.alloc(maxBytes + 1);
    let size = 0;
    while (size < data.length) {
      const { bytesRead } = await handle.read(data, size, data.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > maxBytes) throw new Error('JSON file exceeds size limit');
    return JSON.parse(data.subarray(0, size).toString('utf8'));
  } finally { await handle.close(); }
}
export async function atomicJson(path, value, { replace = true } = {}) {
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.compatibility-${randomUUID()}.tmp`);
  try {
    const handle = await fs.open(temporary, 'wx', 0o600);
    try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); } finally { await handle.close(); }
    if (replace) await fs.rename(temporary, path);
    else await fs.link(temporary, path); // exclusive publication, never overwrite a race winner
  } finally { await fs.rm(temporary, { force: true }); }
}

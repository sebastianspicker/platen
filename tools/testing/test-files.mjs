import { readdirSync } from 'node:fs';
import { join } from 'node:path';

export function discoverTestFiles(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return discoverTestFiles(path);
      return entry.isFile() && entry.name.endsWith('.test.js') ? [path] : [];
    })
    .sort();
}

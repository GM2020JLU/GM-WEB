import { existsSync } from 'node:fs';
import { join } from 'node:path';

export function getBuildOutputDirectory(root = process.cwd()) {
  const adapterClient = join(root, 'dist', 'client');
  return existsSync(adapterClient) ? adapterClient : join(root, 'dist');
}

#!/usr/bin/env node

import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const contentSource = process.env.NAVFOLIO_CONTENT_SOURCE === 'docs' ? 'docs' : 'site';
const cacheDirectory = resolve(
  process.env.ASTRO_CACHE_DIR || `node_modules/.astro-${contentSource}`,
);

await rm(resolve(cacheDirectory, 'data-store.json'), { force: true });

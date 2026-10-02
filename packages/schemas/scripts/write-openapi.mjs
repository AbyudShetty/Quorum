// Writes openapi.v1.json from the built package. Run via `npm run generate` at the repo root.
// test/openapi.test.ts fails if the committed file and the source drift apart.
import { writeFileSync } from 'node:fs';
import { openApiDocument } from '../dist/index.js';

const target = new URL('../openapi.v1.json', import.meta.url);
writeFileSync(target, `${JSON.stringify(openApiDocument, null, 2)}\n`);
console.log(`wrote ${target.pathname}`);

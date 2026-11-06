#!/usr/bin/env node
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(readFileSync(join(here, 'discussion-review.schema.json'), 'utf8'));
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema(schema);
for (const file of readdirSync(join(here, 'golden')).filter(name => name.endsWith('.json'))) {
  const shape = file.split('.')[0];
  const validate = ajv.compile({ $ref: `${schema.$id}#/$defs/${shape}` });
  if (!validate(JSON.parse(readFileSync(join(here, 'golden', file), 'utf8')))) {
    console.error(file, ajv.errorsText(validate.errors));
    process.exit(1);
  }
  console.log(`  ✓ ${file} ≡ ${shape}`);
}

import Ajv2020 from 'ajv/dist/2020.js';
import { readFileSync, readdirSync } from 'node:fs';
const here = new URL('.', import.meta.url);
const schema = JSON.parse(readFileSync(new URL('meeting-state.schema.json', here), 'utf8'));
const ajv = new Ajv2020({ strict: false, allErrors: true });
ajv.addSchema(schema);
for (const file of readdirSync(new URL('golden/', here)).filter(n => n.endsWith('.json'))) {
  const validate = ajv.compile({ $ref: `${schema.$id}#/$defs/${file.split('.')[0]}` });
  if (!validate(JSON.parse(readFileSync(new URL(`golden/${file}`, here), 'utf8')))) throw new Error(ajv.errorsText(validate.errors));
}
console.log('meeting-state.v1 goldens conform');

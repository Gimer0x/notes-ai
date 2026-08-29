const fs = require('fs');
const path = require('path');

const en = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../src/i18n/en.json'), 'utf8'),
);
const es = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../src/i18n/es.json'), 'utf8'),
);
const enKeys = Object.keys(en).sort();
const esKeys = Object.keys(es).sort();
if (JSON.stringify(enKeys) !== JSON.stringify(esKeys)) {
  const missingEs = enKeys.filter((key) => !Object.hasOwn(es, key));
  const missingEn = esKeys.filter((key) => !Object.hasOwn(en, key));
  console.error('frontend i18n key mismatch');
  if (missingEs.length) {
    console.error('missing in es.json:', missingEs.join(', '));
  }
  if (missingEn.length) {
    console.error('missing in en.json:', missingEn.join(', '));
  }
  process.exit(1);
}

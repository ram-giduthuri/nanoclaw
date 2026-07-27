import { initDatabase } from '../src/db.js';
import { buildDigest, getDigestConfig } from '../src/email-digest.js';
initDatabase();
const kind = (process.argv[2] as 'sod' | 'eod') || 'sod';
try {
  const text = await buildDigest(kind, getDigestConfig());
  console.log(`\n----- ${kind.toUpperCase()} DIGEST PREVIEW -----\n${text}\n-----------------------------\n`);
} catch (e) {
  console.error('preview failed:', e);
  process.exit(1);
}

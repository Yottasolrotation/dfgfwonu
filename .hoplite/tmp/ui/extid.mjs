// Prints the extension id Chrome derives from the manifest key.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const { key } = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const hex = createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 32);
console.log([...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join(''));

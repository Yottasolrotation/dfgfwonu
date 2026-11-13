// Reads an agent-browser eval result (a JSON string holding a data URL) on stdin and writes the PNG.
import { writeFileSync } from 'node:fs';

let input = '';
for await (const chunk of process.stdin) input += chunk;
const line = input.split('\n').find((l) => l.includes('data:image/png;base64,'));
const url = JSON.parse(line.trim());
writeFileSync(process.argv[2], Buffer.from(url.split(',')[1], 'base64'));
console.log(process.argv[2], 'written');

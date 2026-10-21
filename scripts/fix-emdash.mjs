// Fix: show '—' in Type column for 'No Gateway Capture' exception rows
import { readFileSync, writeFileSync } from 'fs';

const path = 'src/App.jsx';
let src = readFileSync(path, 'utf8');

// Find what character is currently in the quote after '? '
const marker = "No Gateway Capture' ? '";
const idx = src.indexOf(marker);
if (idx === -1) {
  console.error('Marker not found in file');
  process.exit(1);
}
const charAfter = src[idx + marker.length];
console.log(`Current char after marker: codepoint ${charAfter.codePointAt(0)} (${JSON.stringify(charAfter)})`);

// Replace whatever is there (?, —, em-dash) with the plain ASCII hyphen-minus
// then confirm the logic is correct
const badPattern = /\{ex\.category === 'No Gateway Capture' \? '.' :/g;
const goodReplacement = `{ex.category === 'No Gateway Capture' ? '\u2014' :`;

if (!badPattern.test(src)) {
  console.error('Pattern not found — file may already be correct, or structure changed.');
  // Show context around the marker
  console.log('Context:', src.substring(idx - 20, idx + 80));
  process.exit(1);
}

src = src.replace(
  /\{ex\.category === 'No Gateway Capture' \? '.' :/g,
  `{ex.category === 'No Gateway Capture' ? '\u2014' :`
);

writeFileSync(path, src, 'utf8');
console.log('Done. Verifying...');

// Verify
const final = readFileSync(path, 'utf8');
const idx2 = final.indexOf(marker);
const ch2 = final[idx2 + marker.length];
console.log(`After fix: codepoint ${ch2.codePointAt(0)} (expected 8212 = em-dash \u2014)`);
console.log('Success:', ch2.codePointAt(0) === 8212);

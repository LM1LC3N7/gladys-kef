// -----------------------------------------------------------------------------
// The texts users and contributors read are UTF-8 without BOM, and never
// mojibake: UTF-8 bytes read as Latin-1 / Windows-1252 and saved again ("é"
// becoming "Ã" + "©", the apostrophe "’" becoming "â" + "€" + "™"). And no
// text claims that something is encrypted: the integration keeps no secret,
// and Gladys stores the configuration in clear in its database.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const MOJIBAKE = /[ÂÃ][\u0080-¿€]|â€/;
const ENCRYPTED = /chiffr|crypt|encrypt/i;
const FILES = [
  'gladys-assistant-integration.json',
  'docs/en.md',
  'docs/fr.md',
  'README.md',
  'CHANGELOG.md',
  'CLAUDE.md',
  'TODO.md',
  'THIRD_PARTY_NOTICES.md',
  'SECURITY.md',
  'src/i18n.js',
];

for (const file of FILES) {
  test(`${file}: UTF-8 without BOM, no mojibake`, () => {
    const bytes = readFileSync(new URL(`../${file}`, import.meta.url));
    assert.notDeepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'BOM');
    const text = bytes.toString('utf8');
    assert.ok(!text.includes('�'), 'invalid UTF-8');
    const line = text.split('\n').findIndex((l) => MOJIBAKE.test(l));
    assert.equal(line, -1, `mojibake on line ${line + 1}`);
  });
}

for (const file of ['gladys-assistant-integration.json', 'docs/en.md', 'docs/fr.md', 'README.md']) {
  test(`${file}: never says "encrypted"`, () => {
    const text = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    const line = text.split('\n').findIndex((l) => ENCRYPTED.test(l));
    assert.equal(line, -1, `"encrypted" on line ${line + 1}`);
  });
}

test('the patterns catch what they should', () => {
  assert.match('FranÃ§ais', MOJIBAKE, 'ç read as Latin-1');
  assert.match('Â«', MOJIBAKE, '« read as Latin-1');
  assert.match('lâ€™app', MOJIBAKE, '’ read as Windows-1252');
  assert.match('finâ€¦', MOJIBAKE, '… read as Windows-1252');
  assert.doesNotMatch('Français « Découverte » 800×534 — l’app…', MOJIBAKE);
  assert.match('stocké chiffré', ENCRYPTED);
  assert.match('stored encrypted', ENCRYPTED);
});

test('no control byte in the files of the repository', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const files = readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath ?? entry.path, entry.name)))
    .map((file) => file.split(sep).join('/'))
    .filter(
      (file) => !/^(node_modules|\.git|data)\//.test(file) && !/\.(png|jpg|ico)$/i.test(file),
    );
  assert.ok(files.length > 10, 'the files are listed');
  for (const file of files) {
    let text;
    try {
      text = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    } catch {
      continue; // listed but deleted from the working tree
    }
    // Tab, line feed and carriage return only.
    // eslint-disable-next-line no-control-regex
    const index = text.search(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/);
    assert.equal(index, -1, `${file}: control byte at offset ${index}`);
  }
});

test('LICENSE names nobody', () => {
  const license = readFileSync(new URL('../LICENSE', import.meta.url), 'utf8');
  assert.match(license, /Apache License/);
  assert.match(license, /Copyright \[yyyy\] \[name of copyright owner\]/);
  assert.doesNotMatch(license, /Copyright (?:\(c\) )?\d{4}/i);
});

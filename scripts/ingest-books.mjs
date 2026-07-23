// English Benz — put a book's text into the source repository.
//
// Extracts the text of one or more PDFs and stores each as a `source_documents`
// row of kind 'book'. Nothing is generated here: this only fills the shelf, so
// the admin panel and the pipeline can draw exercises from it later, repeatedly,
// without the file being re-uploaded.
//
//   cd scripts
//   node ingest-books.mjs ~/Downloads/*.pdf
//   node ingest-books.mjs --dry-run book.pdf     # extract and report, store nothing
//
// The stored text is readable only by the service role — `source_documents` has
// row-level security on with no read policy — so an ingested book is never served
// to the app or to any signed-in user. Only short generated exercises are.
//
// Env vars (from .env): SUPABASE_URL, SUPABASE_SERVICE_KEY

import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { dirname, join, basename } from 'node:path';
import { createClient } from '@supabase/supabase-js';

const here = dirname(fileURLToPath(import.meta.url));
try {
  for (const line of readFileSync(join(here, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* rely on real env */ }

const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_KEY. Fill scripts/.env.');
  process.exit(1);
}

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const files = argv.filter((a) => !a.startsWith('--'));
if (!files.length) {
  console.error('Usage: node ingest-books.mjs [--dry-run] <file.pdf> [more.pdf …]');
  process.exit(1);
}

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
const hash = (s) => createHash('sha256').update(s.trim().toLowerCase()).digest('hex');

// pdfjs 3.x ships its legacy build as CommonJS, so reach it through createRequire
// rather than a bare import specifier. The legacy build is the one that runs
// under Node; the default build assumes browser globals.
const require = createRequire(import.meta.url);
const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');

// Join text items into lines using their y positions, then reflow: these books
// are typeset with hard line breaks mid-sentence, and a sentence split across
// two lines is useless as an exercise.
async function extractPdf(path) {
  const data = new Uint8Array(readFileSync(path));
  const doc = await pdfjs.getDocument({ data, useSystemFonts: true, isEvalSupported: false }).promise;
  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const lines = new Map();
    for (const it of content.items) {
      if (!it.str || !it.str.trim()) continue;
      const y = Math.round(it.transform[5]);          // group by baseline
      if (!lines.has(y)) lines.set(y, []);
      lines.get(y).push(it.str);
    }
    const ordered = [...lines.entries()].sort((a, b) => b[0] - a[0]).map(([, parts]) => parts.join('').trim());
    pages.push(ordered.join('\n'));
  }
  await doc.destroy();

  return pages.join('\n\n')
    .replace(/-\n(\w)/g, '$1')            // rejoin words hyphenated across a line break
    .replace(/([^.!?"'\n])\n(?=[a-z(])/g, '$1 ')   // a line ending mid-clause continues
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// "About-a-Boy-by-Nick-Hornby-Book-PDF.pdf" -> "About a Boy by Nick Hornby"
function titleFrom(file) {
  return basename(file, '.pdf')
    .replace(/[-_]+/g, ' ')
    .replace(/\s*\b(book|pdf)\b\s*/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

let stored = 0;
for (const file of files) {
  if (!existsSync(file)) { console.warn(`  ✗ ${file} — not found`); continue; }
  const title = titleFrom(file);
  process.stdout.write(`  ${title} … `);
  let text;
  try { text = await extractPdf(file); }
  catch (e) { console.log(`failed: ${e.message}`); continue; }

  if (text.length < 1000) {
    console.log(`only ${text.length} characters — scanned images rather than text?`);
    continue;
  }

  const words = text.split(/\s+/).length;
  if (DRY_RUN) { console.log(`${text.length} chars, ~${words} words (dry run, not stored)`); continue; }

  const { data, error } = await db
    .from('source_documents')
    .upsert({
      kind: 'book',
      title,
      origin: basename(file),
      content: text,
      content_hash: hash(text),
      char_count: text.length,
      meta: { words, ingested_from: 'ingest-books.mjs' },
    }, { onConflict: 'content_hash', ignoreDuplicates: true })
    .select('id');
  if (error) { console.log(`failed: ${error.message}`); continue; }

  if (data && data.length) { stored++; console.log(`stored ${text.length} chars, ~${words} words`); }
  else console.log(`already on the shelf (${text.length} chars)`);
}

const { count } = await db.from('source_documents').select('*', { count: 'exact', head: true }).eq('kind', 'book');
console.log(`\n${stored} newly stored. The shelf holds ${count} book${count === 1 ? '' : 's'}.`);

// English Benz — reset an app user's password (admin, local only).
//
// Uses the Supabase service_role key from .env to set a new password for an
// existing account, keeping the user's id and therefore all their progress rows.
// The password is read from a hidden prompt: it is never a shell argument, so it
// stays out of your shell history and out of the process list.
//
//   cd scripts
//   node set-app-password.mjs you@example.com
//
// Env vars (from .env): SUPABASE_URL, SUPABASE_SERVICE_KEY

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
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

const email = (process.argv[2] || '').trim();
if (!email) {
  console.error('Usage: node set-app-password.mjs you@example.com');
  process.exit(1);
}

// Read a line from stdin without echoing it to the terminal.
function askHidden(question) {
  return new Promise((resolve, reject) => {
    const { stdin, stdout } = process;
    if (!stdin.isTTY) return reject(new Error('needs an interactive terminal'));
    stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let buf = '';
    const onData = (ch) => {
      if (ch === '\r' || ch === '\n' || ch === '\u0004') {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener('data', onData);
        stdout.write('\n');
        resolve(buf);
      } else if (ch === '\u0003') {          // ctrl-c
        stdin.setRawMode(false);
        stdout.write('\n');
        process.exit(130);
      } else if (ch === '\u007f' || ch === '\b') {
        buf = buf.slice(0, -1);
      } else {
        buf += ch;
      }
    };
    stdin.on('data', onData);
  });
}

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

const { data: list, error: listErr } = await db.auth.admin.listUsers();
if (listErr) { console.error('Could not list users:', listErr.message); process.exit(1); }

const user = list.users.find((u) => (u.email || '').toLowerCase() === email.toLowerCase());
if (!user) {
  console.error(`No account found for ${email}. Existing accounts: ${list.users.map((u) => u.email).join(', ')}`);
  process.exit(1);
}

const pw = await askHidden(`New password for ${user.email}: `);
const again = await askHidden('Repeat it: ');
if (pw !== again) { console.error('Passwords do not match — nothing changed.'); process.exit(1); }
if (pw.length < 6) { console.error('Supabase requires at least 6 characters — nothing changed.'); process.exit(1); }

const { error } = await db.auth.admin.updateUserById(user.id, { password: pw });
if (error) { console.error('Update failed:', error.message); process.exit(1); }

console.log(`\nPassword updated for ${user.email}.`);
console.log('Progress kept — same user id, so your scores and history are untouched.');

// Diagnostic only — lists auth users and their confirmation state.
// Prints no secrets. Run: node check-user.mjs
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
} catch {}

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

const { data, error } = await db.auth.admin.listUsers();
if (error) { console.error('listUsers failed:', error.message); process.exit(1); }

console.log(`users: ${data.users.length}`);
for (const u of data.users) {
  console.log([
    `  email: ${u.email}`,
    `  id: ${u.id}`,
    `  confirmed: ${u.email_confirmed_at ? 'YES (' + u.email_confirmed_at + ')' : 'NO'}`,
    `  created: ${u.created_at}`,
    `  last_sign_in: ${u.last_sign_in_at || 'never'}`,
    `  providers: ${(u.app_metadata?.providers || []).join(',') || 'n/a'}`,
  ].join('\n'));

  // How much progress data would a delete destroy?
  for (const t of ['kv', 'presentations', 'user_stats', 'activity_events']) {
    const { count } = await db.from(t).select('*', { count: 'exact', head: true }).eq('user_id', u.id);
    console.log(`    ${t}: ${count ?? 0} rows`);
  }
}

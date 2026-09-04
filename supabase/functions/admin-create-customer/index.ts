// admin-create-customer — lets an authenticated Admin create (or reset the
// password for) a customer-portal login, the same way admin-create-technician
// does for technicians.
//
// WHY A SEPARATE FUNCTION FROM admin-create-technician
// admin-create-technician's deployed source isn't part of this app codebase
// (only the client-side invoke() calls to it are), so its exact internals —
// error-message wording, validation, whatever else it may already do — can't
// be safely guessed at and extended here. Keeping this as its own function
// means technician account creation is completely untouched by the customer
// portal work: same behavior, same deployed code, zero risk of a regression
// there. If you'd rather fold this logic into admin-create-technician itself
// later, that's a fine thing to do by hand once you have its source open.
//
// CONTRACT (mirrors admin-create-technician's shape)
//   Default (create):
//     body: { name, email, password, customerId }
//     → creates a Supabase Auth user with that email/password, then a
//       `profiles` row {id, name, role:'customer', customer_id: customerId}.
//   Action: 'reset_password'  (parity with admin-create-technician; not yet
//   wired up from the Manage Users UI since customer logins don't appear in
//   that list — see the app's reply for why)
//     body: { action:'reset_password', customerLoginId, password }
//     → updates that auth user's password only.
//   Response: { id, name } on success, or { error: '...' } — never a raw
//   Postgres error, since this is reachable from any authenticated session
//   (the admin check below is what actually gates it).
//
// DEPLOY
//   supabase functions deploy admin-create-customer
// (verify_jwt stays ON — default — unlike list-technicians, because this
// must only ever run for an authenticated admin, checked below.)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Mirrors the ADMIN_EMAIL constant in js/modules-src/service-report.js.
// If you ever change the admin account's email there, change it here too —
// there was no shared/importable place to define this once for both sides.
const ADMIN_EMAIL = 'awes.manila@gmail.com';

const ALLOWED_ORIGINS = [
  'https://awesmanila-rgb.github.io',
  'http://localhost:8000',
  'http://127.0.0.1:8000'
];

function corsHeaders(origin: string | null) {
  const allow = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin'
  };
}

Deno.serve(async (req) => {
  const origin = req.headers.get('origin');
  const cors = corsHeaders(origin);

  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...cors, 'Content-Type': 'application/json' }
    });
  }

  try {
    const authHeader = req.headers.get('authorization') || '';

    // Confirm the CALLER is the admin, using their own JWT against the anon
    // client (never trust a role claimed by the request body).
    const callerClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false } }
    );
    const { data: callerData, error: callerErr } = await callerClient.auth.getUser();
    if (callerErr || !callerData?.user || (callerData.user.email || '').toLowerCase() !== ADMIN_EMAIL.toLowerCase()) {
      return new Response(JSON.stringify({ error: 'Admin only' }), {
        status: 403,
        headers: { ...cors, 'Content-Type': 'application/json' }
      });
    }

    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      { auth: { persistSession: false } }
    );

    const body = await req.json();

    if (body.action === 'reset_password') {
      const { customerLoginId, password } = body;
      if (!customerLoginId || !password || String(password).length < 4) {
        return new Response(JSON.stringify({ error: 'customerLoginId and a password (min 4 chars) are required' }), {
          status: 400, headers: { ...cors, 'Content-Type': 'application/json' }
        });
      }
      const { error: pwErr } = await admin.auth.admin.updateUserById(customerLoginId, { password });
      if (pwErr) throw pwErr;
      return new Response(JSON.stringify({ id: customerLoginId }), {
        headers: { ...cors, 'Content-Type': 'application/json' }
      });
    }

    const { name, email, password, customerId } = body;
    if (!name || !email || !password || !customerId) {
      return new Response(JSON.stringify({ error: 'name, email, password, and customerId are all required' }), {
        status: 400, headers: { ...cors, 'Content-Type': 'application/json' }
      });
    }
    if (String(password).length < 4) {
      return new Response(JSON.stringify({ error: 'Password must be at least 4 characters' }), {
        status: 400, headers: { ...cors, 'Content-Type': 'application/json' }
      });
    }

    // Confirm the linked customer record actually exists before creating a
    // login that would otherwise silently point nowhere.
    const { data: custRow, error: custErr } = await admin
      .from('customers').select('id').eq('id', customerId).maybeSingle();
    if (custErr) throw custErr;
    if (!custRow) {
      return new Response(JSON.stringify({ error: 'That customer record was not found' }), {
        status: 400, headers: { ...cors, 'Content-Type': 'application/json' }
      });
    }

    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email, password, email_confirm: true
    });
    if (createErr) throw createErr;
    const newId = created.user.id;

    const { error: profErr } = await admin.from('profiles').insert({
      id: newId, name, role: 'customer', customer_id: customerId
    });
    if (profErr) {
      // Insert failed (e.g. the profiles_role_check constraint wasn't
      // widened yet — see supabase/migrations/20260904_01_customer_portal.sql)
      // — clean up the orphaned auth user rather than leaving a login with
      // no profile row behind.
      await admin.auth.admin.deleteUser(newId).catch(() => {});
      throw profErr;
    }

    return new Response(JSON.stringify({ id: newId, name }), {
      headers: { ...cors, 'Content-Type': 'application/json' }
    });
  } catch (e) {
    console.error('admin-create-customer failed', e);
    const msg = (e && typeof e === 'object' && 'message' in e) ? String((e as Error).message) : '';
    // Surface duplicate-email specifically since it's the one case an admin
    // can actually act on; keep everything else generic.
    const friendly = /already.*registered|duplicate/i.test(msg)
      ? 'That email is already registered to another account'
      : 'Could not create the customer login';
    return new Response(JSON.stringify({ error: friendly }), {
      status: 500,
      headers: { ...cors, 'Content-Type': 'application/json' }
    });
  }
});

// admin-create-customer — lets an authenticated Admin create (or reset the
// password for, or re-assign the linked customers of) a customer-portal
// login, the same way admin-create-technician does for technicians.
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
//     body: { name, email, password, customerIds: [uuid, ...] }
//     → creates a Supabase Auth user with that email/password, a `profiles`
//       row {id, name, role:'customer'}, and one customer_login_links row
//       per id in customerIds (a login can see more than one customer's
//       equipment/reports — see supabase/migrations/20260905_customer_portal_multi_link.sql).
//       `customerId` (singular) is still accepted for backward compatibility
//       and treated as a one-item customerIds array.
//   Action: 'set_customers'  (re-assign which customers an EXISTING login
//   can see — replaces the full set, doesn't merge)
//     body: { action:'set_customers', customerLoginId, customerIds: [uuid, ...] }
//     → deletes that login's current customer_login_links rows and inserts
//       one per id in customerIds. Requires at least one id.
//   Action: 'reset_password'  (parity with admin-create-technician)
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

    if (body.action === 'set_customers') {
      const { customerLoginId, customerIds } = body;
      const ids: string[] = Array.isArray(customerIds) ? customerIds.filter(Boolean) : [];
      if (!customerLoginId || ids.length === 0) {
        return new Response(JSON.stringify({ error: 'customerLoginId and at least one customerId are required' }), {
          status: 400, headers: { ...cors, 'Content-Type': 'application/json' }
        });
      }
      const { data: foundRows, error: foundErr } = await admin
        .from('customers').select('id').in('id', ids);
      if (foundErr) throw foundErr;
      if (!foundRows || foundRows.length !== ids.length) {
        return new Response(JSON.stringify({ error: 'One or more selected customer records were not found' }), {
          status: 400, headers: { ...cors, 'Content-Type': 'application/json' }
        });
      }
      // Replace wholesale rather than diff/merge — simpler and this is
      // always called with the admin's full intended set from the edit UI.
      const { error: delErr } = await admin
        .from('customer_login_links').delete().eq('profile_id', customerLoginId);
      if (delErr) throw delErr;
      const { error: insErr } = await admin
        .from('customer_login_links')
        .insert(ids.map((id) => ({ profile_id: customerLoginId, customer_id: id })));
      if (insErr) throw insErr;
      return new Response(JSON.stringify({ id: customerLoginId }), {
        headers: { ...cors, 'Content-Type': 'application/json' }
      });
    }

    const { name, email, password } = body;
    const customerIds: string[] = Array.isArray(body.customerIds)
      ? body.customerIds.filter(Boolean)
      : (body.customerId ? [body.customerId] : []); // back-compat, singular
    if (!name || !email || !password || customerIds.length === 0) {
      return new Response(JSON.stringify({ error: 'name, email, password, and at least one linked customer are required' }), {
        status: 400, headers: { ...cors, 'Content-Type': 'application/json' }
      });
    }
    if (String(password).length < 4) {
      return new Response(JSON.stringify({ error: 'Password must be at least 4 characters' }), {
        status: 400, headers: { ...cors, 'Content-Type': 'application/json' }
      });
    }

    // Confirm every linked customer record actually exists before creating
    // a login that would otherwise silently point nowhere (or partly
    // nowhere).
    const { data: custRows, error: custErr } = await admin
      .from('customers').select('id').in('id', customerIds);
    if (custErr) throw custErr;
    if (!custRows || custRows.length !== customerIds.length) {
      return new Response(JSON.stringify({ error: 'One or more selected customer records were not found' }), {
        status: 400, headers: { ...cors, 'Content-Type': 'application/json' }
      });
    }

    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email, password, email_confirm: true
    });
    if (createErr) throw createErr;
    const newId = created.user.id;

    // profiles.customer_id is left null here on purpose — customer_login_links
    // (inserted right below) is the source of truth for a login's customers
    // as of supabase/migrations/20260905_customer_portal_multi_link.sql.
    const { error: profErr } = await admin.from('profiles').insert({
      id: newId, name, role: 'customer'
    });
    if (profErr) {
      // Insert failed (e.g. the profiles_role_check constraint wasn't
      // widened yet — see supabase/migrations/20260904_01_customer_portal.sql)
      // — clean up the orphaned auth user rather than leaving a login with
      // no profile row behind.
      await admin.auth.admin.deleteUser(newId).catch(() => {});
      throw profErr;
    }

    const { error: linkErr } = await admin
      .from('customer_login_links')
      .insert(customerIds.map((id) => ({ profile_id: newId, customer_id: id })));
    if (linkErr) {
      // Same cleanup reasoning as above — don't leave a login behind that
      // can't see any customer at all.
      await admin.from('profiles').delete().eq('id', newId).catch(() => {});
      await admin.auth.admin.deleteUser(newId).catch(() => {});
      throw linkErr;
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

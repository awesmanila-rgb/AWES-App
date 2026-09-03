// list-technicians — public, minimal technician roster for the login screen.
//
// WHY THIS EXISTS
// The login screen needs to show a picker of technician names before anyone has
// signed in. It used to get that list by querying the `profiles` table directly
// with the anon key, which meant `profiles` had to be readable by the anonymous
// role. That exposed every column of every row — including each technician's
// e-mail, role, and the must_change_password flag — to anyone on the internet
// who copied the anon key out of the page source (it is, unavoidably, public).
//
// Now anon SELECT on `profiles` is revoked (see the migration) and this function
// is the only public path to that data. It runs with the service-role key, which
// stays server-side, and it deliberately returns nothing but {id, name} for
// active technicians. No e-mails, no roles, no flags.
//
// DEPLOY
//   supabase functions deploy list-technicians --no-verify-jwt
// (--no-verify-jwt is required: this is called before login, so there is no user
// JWT to verify. The function does its own hard-coded filtering instead.)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const ALLOWED_ORIGINS = [
  // The exact origin(s) the app is served from. Keep this tight: a wildcard
  // would let any site on the internet enumerate the roster from a browser.
  //
  // The app lives at https://awesmanila-rgb.github.io/AWES-App/ — note that the
  // browser sends only the ORIGIN, so the path is not part of this value and
  // cannot be. GitHub Pages therefore means any project on the same
  // awesmanila-rgb.github.io subdomain shares this origin. That is a limitation
  // of Pages hosting, not of this function.
  'https://awesmanila-rgb.github.io',
  'http://localhost:8000',
  'http://127.0.0.1:8000'
];

function corsHeaders(origin: string | null) {
  const allow = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Vary': 'Origin'
  };
}

Deno.serve(async (req) => {
  const origin = req.headers.get('origin');
  const cors = corsHeaders(origin);

  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...cors, 'Content-Type': 'application/json' }
    });
  }

  try {
    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      { auth: { persistSession: false } }
    );

    // Explicit column list, not select('*') — so that adding a sensitive column
    // to `profiles` later cannot silently start leaking it through this endpoint.
    const { data, error } = await admin
      .from('profiles')
      .select('id, name')
      .eq('role', 'technician')
      .eq('active', true)
      .order('name', { ascending: true });

    if (error) throw error;

    const technicians = (data ?? []).map((r) => ({ id: r.id, name: r.name }));

    return new Response(JSON.stringify({ technicians }), {
      headers: {
        ...cors,
        'Content-Type': 'application/json',
        // Short cache: the roster changes rarely, and the login screen also
        // keeps its own local copy for offline use.
        'Cache-Control': 'public, max-age=60'
      }
    });
  } catch (e) {
    console.error('list-technicians failed', e);
    // Never echo the raw database error to an unauthenticated caller; it can
    // reveal table and column names.
    return new Response(JSON.stringify({ error: 'Could not load technicians' }), {
      status: 500,
      headers: { ...cors, 'Content-Type': 'application/json' }
    });
  }
});

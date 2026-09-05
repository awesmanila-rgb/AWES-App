// ---------- customer portal login helpers (table: customer_login_links) ----------
// A customer login can be linked to more than one customers row (an account
// holder managing several sites/branches) — see
// supabase/migrations/20260905_customer_portal_multi_link.sql. These two
// helpers are shared by the login flow below and by session restore.
  async function fetchCustomerLinks(profileId){
    try{
      const { data: links, error } = await db.from('customer_login_links').select('customer_id').eq('profile_id', profileId);
      if(error) throw error;
      const ids = (links||[]).map(l=> l.customer_id);
      if(!ids.length) return [];
      const { data: custs, error: custErr } = await db.from('customers').select('id, name').in('id', ids);
      if(custErr) throw custErr;
      return (custs||[]).slice().sort((a,b)=> (a.name||'').localeCompare(b.name||''));
    }catch(e){ console.error('fetch customer links failed', describeCloudError(e)); return []; }
  }
  // Remembers which of a multi-customer login's customers was last being
  // viewed, per device (see the switcher in customer-portal.js) — falls
  // back to the first customer (alphabetical) if nothing saved, or if the
  // saved id is no longer one this login can see.
  function pickActiveCustomerId(custList, profileId){
    const ids = custList.map(c=> c.id);
    let saved = null;
    try{ saved = localStorage.getItem('cust-active-customer:'+profileId); }catch(e){}
    return (saved && ids.includes(saved)) ? saved : (ids[0] || null);
  }

// ---------- technician user accounts (table: profiles, role='technician') ----------
  // Real account creation/password changes go through the admin-create-technician
  // Edge Function (see cloudSetUser callers) — these functions only manage the
  // non-auth profile fields (name, active, restrictions).
  function profileToUser(row){
    if(!row) return null;
    return {
      id: row.id, name: row.name, active: row.active,
      restrictions: { noHistory: row.no_history, noReport: row.no_report, readOnly: row.read_only },
      mustChangePassword: !!row.must_change_password
    };
  }
  async function localListUsers(){
    try{
      const res = await window.storage.get('local-users', false);
      return res ? JSON.parse(res.value) : [];
    }catch(e){ return []; }
  }
  async function localSaveUsers(users){
    try{ await window.storage.set('local-users', JSON.stringify(users), false); return true; }
    catch(e){ return false; }
  }
  async function cloudListUsers(){
    if(await ensureCloud()){
      try{
        const { data, error } = await db.from('profiles').select('*').eq('role','technician');
        if(error) throw error;
        return (data||[]).map(profileToUser);
      }catch(e){ console.error('list users failed', describeCloudError(e)); }
    }
    return await localListUsers();
  }
  // Customer portal logins (table: profiles, role='customer') — kept
  // separate from cloudListUsers() above rather than folded in, since their
  // shape is different (no restrictions/DTR fields, but a set of linked
  // customer records instead) and mixing the two would make both list
  // renderers messier for no benefit.
  async function cloudListCustomerLogins(){
    if(await ensureCloud()){
      try{
        const { data: profs, error } = await db.from('profiles').select('id, name, active').eq('role','customer');
        if(error) throw error;
        if(!profs || !profs.length) return [];
        if(!customersCache || customersCache.length===0) await loadCustomers();
        const ids = profs.map(p=> p.id);
        const { data: links, error: linkErr } = await db.from('customer_login_links').select('profile_id, customer_id').in('profile_id', ids);
        if(linkErr) throw linkErr;
        const nameOf = (cid)=>{ const c = customersCache.find(x=> String(x.id)===String(cid)); return c ? c.name : '(deleted customer)'; };
        return profs.map(p=>{
          const custIds = (links||[]).filter(l=> l.profile_id===p.id).map(l=> l.customer_id);
          return { id: p.id, name: p.name, active: p.active, customerIds: custIds, customerNames: custIds.map(nameOf) };
        });
      }catch(e){ console.error('list customer logins failed', describeCloudError(e)); }
    }
    return [];
  }
  // The login screen needs a list of technicians BEFORE anyone is signed in.
  // It used to call cloudListUsers() directly, which required the `profiles`
  // table to be readable by the anonymous key — meaning anyone holding the
  // public key shipped in this app could dump every staff row, restrictions and
  // must-change-password flags included. This goes through an Edge Function that
  // returns only {id, name} for active technicians, so anon SELECT on `profiles`
  // can be revoked (see the migration in supabase/ in this package).
  async function publicListTechnicians(){
    const cfg = getCloudConfig();
    if(cfg && navigator.onLine){
      try{
        const res = await fetch(cfg.url.replace(/\/$/,'')+'/functions/v1/list-technicians', {
          method: 'GET',
          headers: { 'Authorization': 'Bearer '+cfg.anonKey, 'apikey': cfg.anonKey }
        });
        if(res.ok){
          const body = await res.json();
          const rows = Array.isArray(body) ? body : (body.technicians || []);
          // Cache so the login screen still works on a phone with no signal.
          try{ await window.storage.set('tech-roster', JSON.stringify(rows), false); }catch(e){}
          return rows.map(r=>({ id: r.id, name: r.name, active: true, restrictions: {}, mustChangePassword: false }));
        }
        console.error('list-technicians failed', res.status);
      }catch(e){ console.error('list-technicians request failed', e); }
    }
    // Offline / function unavailable: fall back to the last roster we saw, then
    // to any locally provisioned users.
    try{
      const cached = await window.storage.get('tech-roster', false);
      if(cached){
        const rows = JSON.parse(cached.value) || [];
        if(rows.length) return rows.map(r=>({ id: r.id, name: r.name, active: true, restrictions: {}, mustChangePassword: false }));
      }
    }catch(e){}
    return await localListUsers();
  }
  async function cloudGetUser(id){
    if(await ensureCloud()){
      try{
        const { data, error } = await db.from('profiles').select('*').eq('id', id).maybeSingle();
        if(error) throw error;
        return profileToUser(data);
      }catch(e){}
    }
    const users = await localListUsers();
    return users.find(u=>u.id===id) || null;
  }
  // Updates name/active/restrictions only — never password (see admin-create-technician).
  async function cloudSetUser(id, data){
    if(await ensureCloud()){
      try{
        const patch = {};
        if('name' in data) patch.name = data.name;
        if('active' in data) patch.active = data.active;
        if(data.restrictions){
          patch.no_history = !!data.restrictions.noHistory;
          patch.no_report = !!data.restrictions.noReport;
          patch.read_only = !!data.restrictions.readOnly;
        }
        const { data: rows, error } = await db.from('profiles').update(patch).eq('id', id).select('id');
        if(error) throw error;
        if(!rows || !rows.length) throw new Error('no profile row was updated');
        return true;
      }catch(e){ console.error('save user failed', describeCloudError(e)); return false; }
    }
    // Admin account changes are NOT written to a local fallback any more. The
    // old code wrote them into this device's `local-users` list and returned
    // success, so deactivating a technician or changing their access looked like
    // it worked while the real account on the server was untouched.
    return false;
  }
  async function cloudDeleteUser(id){
    if(await ensureCloud()){
      try{
        // Deletes the profile row; the Auth account itself is left intact (Postgres
        // has no client-side "delete another user's login" — that would need the
        // same Edge Function pattern as account creation, if fully removing the
        // login is ever needed rather than just deactivating).
        const { error } = await db.from('profiles').delete().eq('id', id);
        if(error) throw error;
        return true;
      }catch(e){ console.error('delete user failed', describeCloudError(e)); return false; }
    }
    // Same reasoning as cloudSetUser: never report a deletion that only
    // happened in this phone's local list.
    return false;
  }
  // Clears the caller's OWN must_change_password flag via a narrow RPC
  // (see clear_my_must_change_password in the schema) — deliberately not a
  // direct table update, so a technician can't rewrite other columns on
  // their own profile row (like role) through the same code path.
  async function cloudClearMustChangePassword(){
    if(!(await ensureCloud())) return false;
    try{
      const { error } = await db.rpc('clear_my_must_change_password');
      if(error) throw error;
      return true;
    }catch(e){ console.error('clear must_change_password failed', describeCloudError(e)); return false; }
  }
  // Shared Change Password screen — used both for the forced first-login
  // change (forced=true, no Cancel, resolves only once actually saved) and
  // the voluntary "Change My Password" homepage tile (forced=false, has
  // Cancel). Returns a Promise resolving true if the password was changed.
  function showChangePasswordScreen(forced){
    return new Promise((resolve)=>{
      $('cpTitle').textContent = forced ? 'Set a New Password' : 'Change Password';
      $('cpMessage').textContent = forced
        ? 'For your security, set your own password before continuing.'
        : '';
      $('cpCancelBtn').style.display = forced ? 'none' : '';
      $('cpNew').value = ''; $('cpConfirm').value = '';
      $('changePasswordOverlay').classList.add('open');
      setTimeout(()=> $('cpNew').focus(), 50);

      $('cpCancelBtn').onclick = ()=>{
        $('changePasswordOverlay').classList.remove('open');
        resolve(false);
      };
      $('cpSaveBtn').onclick = async ()=>{
        const p1 = $('cpNew').value, p2 = $('cpConfirm').value;
        if(!p1 || p1.length < 4){ toast('Password must be at least 4 characters'); return; }
        if(p1 !== p2){ toast('Passwords do not match'); return; }
        if(!(await ensureCloud())){ toast('Not connected to the cloud'); return; }
        $('cpSaveBtn').disabled = true;
        try{
          const { error } = await db.auth.updateUser({ password: p1 });
          if(error){ toast('Could not update password: '+error.message); return; }
          await cloudClearMustChangePassword();
          if(currentUser) currentUser.mustChangePassword = false;
          $('changePasswordOverlay').classList.remove('open');
          toast('Password updated');
          resolve(true);
        } finally { $('cpSaveBtn').disabled = false; }
      };
    });
  }

  let currentUser = null; // {id, name, role: 'tech'|'admin'}

  // ---------- Idle timeout — Admin only, 30 minutes ----------
  // A shared/unattended device left signed in is the risk being guarded
  // against; Admin is the only role with an auto sign-out because of its far
  // more sensitive surface (Manage Users, approvals, password changes,
  // dropdown list editing). Technician and customer sessions no longer
  // auto-expire from inactivity — they only end when the person taps
  // "Logout". Implemented as "last activity timestamp + periodic check"
  // rather than clearTimeout/setTimeout on every event — mousemove alone can
  // fire dozens of times a second, and resetting a real timer that often is
  // wasted work for no behavioral difference.
  //
  // This (and the explicit Logout button) are the ONLY things that sign
  // anyone out. Reloading or refreshing the page never does — see
  // getVerifiedSession/checkLoginGate below, which restore the saved session
  // from cache whenever the cloud can't be reached to re-verify it (e.g. a
  // brief signal drop on a field connection), instead of treating "couldn't
  // check" as "log them out".
  const ADMIN_IDLE_MS = 30 * 60 * 1000;
  const IDLE_CHECK_MS = 15 * 1000;     // how often we check the clock
  let lastActivity = Date.now();
  let idleInterval = null;

  function markActivity(){
    if(currentUser) lastActivity = Date.now();
  }
  ['mousemove','mousedown','keydown','touchstart','scroll','wheel'].forEach(evt=>{
    document.addEventListener(evt, markActivity, {passive:true});
  });

  function startIdleWatch(){
    // Only admin sessions are watched — tech/customer sign out on explicit
    // Logout tap only.
    if(!currentUser || currentUser.role!=='admin'){ stopIdleWatch(); return; }
    lastActivity = Date.now();
    if(idleInterval) clearInterval(idleInterval);
    idleInterval = setInterval(async ()=>{
      if(!currentUser || currentUser.role!=='admin'){ stopIdleWatch(); return; }
      if(Date.now() - lastActivity >= ADMIN_IDLE_MS){
        stopIdleWatch();
        await doLogout();
        toast('Signed out after 30 minutes of inactivity');
      }
    }, IDLE_CHECK_MS);
  }
  function stopIdleWatch(){
    if(idleInterval){ clearInterval(idleInterval); idleInterval = null; }
  }

  function updateUserBadge(){
    const el = $('metaUser');
    if(!el) return;
    if(currentUser && currentUser.role==='admin'){ el.style.display=''; el.textContent = 'Admin'; }
    else if(currentUser && currentUser.role==='customer'){ el.style.display=''; el.textContent = 'Customer: '+currentUser.name; }
    else if(currentUser){ el.style.display=''; el.textContent = 'Tech: '+currentUser.name; }
    else{ el.style.display='none'; }
    const menuLogoutEl = $('menuLogout');
    if(menuLogoutEl) menuLogoutEl.style.display = currentUser ? '' : 'none';
  }

  // Shrinks sidebar row sizing just enough that the whole menu fits within
  // the sidebar's actual available height without needing to scroll — the
  // alternative (leaving rows at full size and letting .admin-sidebar's own
  // overflow-y:auto kick in) buries the account footer behind a scroll the
  // person has no reason to expect. Only the longer list (currently admin's
  // 11 links + 2 section labels) tends to need this; the shorter one
  // (technician's 8 links + 1 label) keeps full-size rows and just leaves
  // extra space at the bottom, which is fine.
  // Continuously shrinks the sidebar nav (via the --nav-scale custom
  // property that css/app.css's .sidebar-nav/.sidebar-link/.sidebar-
  // section-label rules key off of) until every item fits the available
  // height with no scrolling — rather than a binary full/compact toggle,
  // which can't guarantee a fit for every combination of item count and
  // screen height. Only the permanent desktop sidebar needs this (the
  // mobile drawer is a full-height off-canvas panel with room to spare);
  // .sidebar-nav has overflow-y:hidden either way so nothing scrolls.
  function fitSidebarNav(){
    const nav = document.querySelector('.sidebar-nav');
    if(!nav) return;
    const FLOOR = 0.55;
    let scale = 1;
    nav.style.setProperty('--nav-scale', scale);
    // A handful of iterations is enough: each pass measures the real
    // overflow at the current scale and steps down proportionally, so it
    // converges in 2-3 passes rather than needing a fine-grained loop.
    for(let i=0; i<6; i++){
      const overflow = nav.scrollHeight - nav.clientHeight;
      if(overflow <= 1) break;
      // Scale down by roughly the fraction we're overflowing by, with a
      // minimum step so tiny remaining overflows still make progress.
      const ratio = nav.clientHeight / nav.scrollHeight;
      scale = Math.max(FLOOR, scale * Math.min(ratio, 0.97));
      nav.style.setProperty('--nav-scale', scale);
      if(scale <= FLOOR) break;
    }
  }
  window.addEventListener('resize', fitSidebarNav);

  // Applies per-user access restrictions set by the admin. Admins bypass all restrictions.
  function applyUserRestrictions(){
    const r = (currentUser && currentUser.role!=='admin' && currentUser.restrictions) || {};
    const setVis = (id, show)=>{ const el = $(id); if(el) el.style.display = show ? '' : 'none'; };
    const setDisabled = (id, dis)=>{
      const el = $(id); if(!el) return;
      el.disabled = !!dis;
      el.style.opacity = dis ? '0.45' : '';
      el.style.pointerEvents = dis ? 'none' : '';
    };
    // Technician accounts: hide the Menu (admin-only tools live there), and
    // surface Email Setup + Logout directly instead of tucked in the menu.
    // (Was `role!=='admin'` back when only admin/tech existed — tightened to
    // an exact match now that a third role, customer, exists too, so
    // customers don't get treated as technicians below. No behavior change
    // for admin or tech: both still resolve exactly as before.)
    const isTech = !!(currentUser && currentUser.role==='tech');
    const isAdmin = !!(currentUser && currentUser.role==='admin');
    const isCustomer = !!(currentUser && currentUser.role==='customer');
    // Switches on the desktop/tablet sidebar dashboard shell (see the
    // admin-sidebar / dashboard-topbar rules in css/app.css) — off before
    // login, and now shared by all three roles (role-customer mirrors
    // role-admin/role-tech; the shell layout itself is identical, only its
    // contents differ).
    document.body.classList.toggle('role-admin', isAdmin);
    document.body.classList.toggle('role-tech', isTech);
    document.body.classList.toggle('role-customer', isCustomer);
    if(!currentUser) document.body.classList.remove('dashboard-active');
    // Sidebar nav: each role only sees its own group of links (My Work vs.
    // Operations/Management vs. My Account) — see the #sidebarTechGroup /
    // #sidebarAdminGroup / #sidebarCustomerGroup wrappers in index.html.
    setVis('sidebarTechGroup', isTech);
    setVis('sidebarAdminGroup', isAdmin);
    setVis('sidebarCustomerGroup', isCustomer);
    fitSidebarNav();
    if(currentUser){
      const brandNameEl = $('sidebarBrandName'); if(brandNameEl) brandNameEl.textContent = isAdmin ? 'Field Operations Portal' : isCustomer ? 'Customer Portal' : "Technician's Homepage";
      const brandSubEl = $('sidebarBrandSub'); if(brandSubEl) brandSubEl.textContent = isAdmin ? 'Management & Administration' : isCustomer ? 'Your equipment & service history' : 'Field digital form';
      const initial = (currentUser.name||'?').trim().charAt(0).toUpperCase() || '?';
      const avatarEl = $('sidebarAvatar'); if(avatarEl) avatarEl.textContent = initial;
      const acctNameEl = $('sidebarAccountName'); if(acctNameEl) acctNameEl.textContent = currentUser.name || '—';
      const acctRoleEl = $('sidebarAccountRole'); if(acctRoleEl) acctRoleEl.textContent = isAdmin ? 'Super Administrator' : isCustomer ? 'Customer' : 'Technician';
    }
    // "New" (header shortcut for a blank report) and "Create New" (Service
    // Report tab) both start a fresh, blank report. Technicians already
    // never saw the header button; admins can only view/edit existing
    // reports, not author new ones, so neither role gets either control now.
    // (srTabNewBtn was `!isAdmin`, which — now that isTech is an exact
    // match — would incorrectly show for customers too; switched to isTech
    // directly. Admin and tech both still resolve exactly as before.)
    setVis('newBtn', false);
    setVis('srTabNewBtn', isTech);
    // Logout is now a direct, always-visible top-right button for EVERY
    // logged-in role, not just technicians — admin's only path used to be
    // buried inside "☰ Menu", which read as "there's no logout button in
    // the corner" even though one technically existed one tap deeper.
    setVis('userLogoutBtn', !!currentUser);
    setVis('tile_changePassword', isTech);
    applyTechNameDefault();
    // History access
    setVis('menuManageReports', !r.noHistory);
    // Report generation / preview
    setVis('previewBtn', !r.noReport);
    setVis('genPdfBtn', !r.noReport);
    // Read-only: cannot save drafts and cannot generate reports
    if(r.readOnly){
      setDisabled('saveDraftBtn', true);
      setDisabled('genPdfBtn', true);
      setDisabled('previewBtn', true);
      setDisabled('newBtn', true);
    }else{
      setDisabled('saveDraftBtn', false);
      setDisabled('genPdfBtn', false);
      setDisabled('previewBtn', false);
      setDisabled('newBtn', false);
    }
  }

  function enterAdminMode(){
    adminMode = true;
    $('adminBtn').textContent = 'Admin: ON';
    $('adminBtn').classList.add('admin-badge');
    const menuBtnEl = $('menuBtn');
    if(menuBtnEl){ menuBtnEl.textContent = '☰ Menu • Admin ON'; menuBtnEl.classList.add('admin-badge'); }
  }
  function exitAdminModeUI(){
    adminMode = false;
    $('adminBtn').textContent = 'Admin';
    $('adminBtn').classList.remove('admin-badge');
    const menuBtnEl = $('menuBtn');
    if(menuBtnEl){ menuBtnEl.textContent = '☰ Menu'; menuBtnEl.classList.remove('admin-badge'); }
  }

  // The login gate's default screen. Customer sign-in is the primary path —
  // its form renders directly here, front and center, with feature callouts
  // below it. Technician and Admin are still one tap away, but demoted to a
  // small quiet link row up top rather than equal-weight buttons, since the
  // overwhelming majority of people opening this app day-to-day are
  // customers, not staff.
  function showRoleChooser(message){
    const container = $('loginList');
    container.innerHTML = '';

    const staffRow = document.createElement('div');
    staffRow.className = 'login-staff-row';
    const techLink = document.createElement('button');
    techLink.type='button'; techLink.className = 'login-staff-link';
    techLink.textContent = '👷 Technician access';
    techLink.addEventListener('click', async ()=>{
      container.innerHTML = '<div class="empty-state">Loading…</div>';
      const users = await publicListTechnicians();
      renderTechnicianList(users || []);
    });
    const adminLink = document.createElement('button');
    adminLink.type='button'; adminLink.className = 'login-staff-link';
    adminLink.textContent = '🔑 Admin panel';
    adminLink.addEventListener('click', ()=> renderAdminLoginForm());
    staffRow.appendChild(techLink);
    staffRow.appendChild(adminLink);
    container.appendChild(staffRow);

    const divider = document.createElement('div');
    divider.className = 'login-divider';
    container.appendChild(divider);

    if(message){
      const m = document.createElement('div');
      m.style.cssText = 'font-size:13px; color:var(--danger); margin-bottom:10px; text-align:center;';
      m.textContent = message;
      container.appendChild(m);
    }

    const tagline = document.createElement('p');
    tagline.className = 'login-tagline';
    tagline.textContent = 'Track your service history and request support';
    container.appendChild(tagline);

    const emailField = document.createElement('div');
    emailField.className = 'field';
    emailField.innerHTML = '<label>Email</label>';
    const emailInput = document.createElement('input');
    emailInput.type = 'email'; emailInput.id = 'loginCustEmail'; emailInput.placeholder = 'you@example.com';
    emailField.appendChild(emailInput);
    container.appendChild(emailField);

    const pwField = document.createElement('div');
    pwField.className = 'field';
    pwField.innerHTML = '<label>Password</label>';
    const pwInput = document.createElement('input');
    pwInput.type = 'password'; pwInput.id = 'loginCustPw'; pwInput.placeholder = 'Enter your password';
    pwField.appendChild(pwInput);
    container.appendChild(pwField);

    const submit = document.createElement('button');
    submit.type = 'button'; submit.className = 'btn btn-primary';
    submit.style.cssText = 'width:100%; margin-bottom:16px;';
    submit.textContent = 'Sign In to Portal';
    const doSubmit = async ()=>{
      const email = (emailInput.value||'').trim();
      const pw = pwInput.value;
      if(!email || !pw){ toast('Enter your email and password'); return; }
      if(!(await ensureCloud())){ showRoleChooser('Not connected to the cloud — check Shared Cloud Setup.'); return; }
      submit.disabled = true;
      const { data, error } = await db.auth.signInWithPassword({ email, password: pw });
      if(error){ submit.disabled = false; showRoleChooser('Incorrect email or password — try again.'); return; }
      let prof = null;
      try{
        const res = await db.from('profiles').select('role, name, active').eq('id', data.user.id).maybeSingle();
        prof = res.data;
      }catch(e){}
      if(!prof || prof.role !== 'customer'){
        submit.disabled = false;
        await db.auth.signOut();
        showRoleChooser('This account is not set up as a customer portal login.');
        return;
      }
      if(prof.active===false){
        submit.disabled = false;
        await db.auth.signOut();
        showRoleChooser('This account has been deactivated. Contact your service provider.');
        return;
      }
      const custList = await fetchCustomerLinks(data.user.id);
      if(!custList.length){
        submit.disabled = false;
        await db.auth.signOut();
        showRoleChooser('This account is not linked to any customer records yet. Contact your service provider.');
        return;
      }
      const activeId = pickActiveCustomerId(custList, data.user.id);
      submit.disabled = false;
      currentUser = {
        id: data.user.id, name: prof.name || 'there', role:'customer',
        customerId: activeId, customerIds: custList.map(c=> c.id), customerList: custList
      };
      localStorage.setItem('current-user', JSON.stringify(currentUser));
      updateUserBadge();
      applyUserRestrictions();
      $('loginOverlay').classList.remove('open');
      enterApp();
      toast('Welcome, '+currentUser.name);
    };
    submit.addEventListener('click', doSubmit);
    pwInput.addEventListener('keydown', (e)=>{ if(e.key==='Enter') doSubmit(); });
    container.appendChild(submit);

    const features = document.createElement('div');
    features.className = 'login-features';
    features.innerHTML =
      '<div class="login-feature"><span class="lf-icon">📋</span><span class="lf-label">Track Requests</span></div>'
      + '<div class="login-feature"><span class="lf-icon">⚡</span><span class="lf-label">Fast Service</span></div>'
      + '<div class="login-feature"><span class="lf-icon">👤</span><span class="lf-label">Manage Profile</span></div>';
    container.appendChild(features);

    const cloudLink = document.createElement('button');
    cloudLink.type='button';
    cloudLink.className = 'login-cloud-link';
    cloudLink.textContent = cloudReady ? '☁ Connected — Cloud Setup' : '☁ Not connected — tap to set up Shared Cloud';
    cloudLink.addEventListener('click', ()=>{
      const cfg = getCloudConfig();
      if(cfg){ $('cfgSupabaseUrl').value = cfg.url || ''; $('cfgSupabaseKey').value = cfg.anonKey || ''; }
      $('cloudStatusMsg').textContent = cloudReady ? 'Currently connected.' : '';
      $('cloudOverlay').classList.add('open');
    });
    container.appendChild(cloudLink);

    setTimeout(()=> emailInput.focus(), 50);
  }

  function loginBackButton(){
    const back = document.createElement('button');
    back.type='button'; back.className='login-user-btn';
    back.style.cssText = 'background:#EEF1ED; color:var(--text);';
    back.textContent = '← Back';
    back.addEventListener('click', ()=> showRoleChooser());
    return back;
  }

  function renderAdminLoginForm(message){
    const container = $('loginList');
    container.innerHTML = '';
    container.appendChild(loginBackButton());
    if(message){
      const m = document.createElement('div');
      m.style.cssText = 'font-size:13px; color:var(--danger); margin-bottom:10px; text-align:center;';
      m.textContent = message;
      container.appendChild(m);
    }
    const field = document.createElement('div');
    field.className = 'field';
    field.innerHTML = '<label>Admin Password</label>';
    const input = document.createElement('input');
    input.type = 'password'; input.inputMode = 'numeric'; input.id = 'loginAdminPw';
    input.placeholder = 'Enter password';
    field.appendChild(input);
    container.appendChild(field);

    const submit = document.createElement('button');
    submit.type = 'button'; submit.className = 'btn btn-primary'; submit.style.width = '100%';
    submit.textContent = 'Sign In';
    const doSubmit = async ()=>{
      const pw = input.value;
      if(!pw){ toast('Enter the admin password'); return; }
      if(!(await ensureCloud())){ renderAdminLoginForm('Not connected to the cloud — check Shared Cloud Setup.'); return; }
      submit.disabled = true;
      const { data, error } = await db.auth.signInWithPassword({ email: ADMIN_EMAIL, password: pw });
      submit.disabled = false;
      if(error){ renderAdminLoginForm('Incorrect password — try again.'); return; }
      currentUser = {id: data.user.id, name:'Admin', role:'admin'};
      localStorage.setItem('current-user', JSON.stringify(currentUser));
      enterAdminMode();
      updateUserBadge();
      applyUserRestrictions();
      $('loginOverlay').classList.remove('open');
      enterApp();
      toast('Welcome, Admin');
    };
    submit.addEventListener('click', doSubmit);
    input.addEventListener('keydown', (e)=>{ if(e.key==='Enter') doSubmit(); });
    container.appendChild(submit);
    setTimeout(()=> input.focus(), 50);
  }

  function renderTechnicianList(users, message){
    const container = $('loginList');
    container.innerHTML = '';
    container.appendChild(loginBackButton());
    if(message){
      const m = document.createElement('div');
      m.style.cssText = 'font-size:13px; color:var(--danger); margin-bottom:10px; text-align:center;';
      m.textContent = message;
      container.appendChild(m);
    }
    const active = users.filter(u=>u.active!==false);
    if(active.length===0){
      const empty = document.createElement('div');
      empty.className='empty-state';
      empty.textContent = 'No active technician accounts. Ask your admin to add one.';
      container.appendChild(empty);
      return;
    }
    active.forEach(u=>{
      const btn = document.createElement('button');
      btn.type='button';
      btn.className='login-user-btn';
      btn.textContent = u.name;
      btn.addEventListener('click', ()=> renderTechnicianPinForm(u));
      container.appendChild(btn);
    });
  }

  function renderTechnicianPinForm(u, message){
    const container = $('loginList');
    container.innerHTML = '';
    const back = document.createElement('button');
    back.type='button'; back.className='login-user-btn';
    back.style.cssText = 'background:#EEF1ED; color:var(--text);';
    back.textContent = '← Back';
    back.addEventListener('click', async ()=>{
      container.innerHTML = '<div class="empty-state">Loading…</div>';
      const users = await publicListTechnicians();
      renderTechnicianList(users || []);
    });
    container.appendChild(back);
    if(message){
      const m = document.createElement('div');
      m.style.cssText = 'font-size:13px; color:var(--danger); margin-bottom:10px; text-align:center;';
      m.textContent = message;
      container.appendChild(m);
    }
    const field = document.createElement('div');
    field.className = 'field';
    // Technician names are admin-entered free text; escape before injecting.
    field.innerHTML = '<label>Password for '+escapeHtml(u.name)+'</label>';
    const input = document.createElement('input');
    input.type = 'password'; input.id = 'loginTechPin';
    input.placeholder = 'Enter your password';
    field.appendChild(input);
    container.appendChild(field);

    const submit = document.createElement('button');
    submit.type = 'button'; submit.className = 'btn btn-primary'; submit.style.width = '100%';
    submit.textContent = 'Sign In';
    const doSubmit = async ()=>{
      const pin = input.value;
      if(!pin){ toast('Enter your password'); return; }
      if(!(await ensureCloud())){ renderTechnicianPinForm(u, 'Not connected to the cloud — check Shared Cloud Setup.'); return; }
      submit.disabled = true;
      const { data, error } = await db.auth.signInWithPassword({ email: techEmail(u.id), password: pin });
      submit.disabled = false;
      if(error){ renderTechnicianPinForm(u, 'Incorrect password — try again.'); return; }
      currentUser = {id: data.user.id, name:u.name, role:'tech', restrictions: u.restrictions||{}, mustChangePassword: !!u.mustChangePassword};
      localStorage.setItem('current-user', JSON.stringify(currentUser));
      updateUserBadge();
      applyUserRestrictions();
      $('loginOverlay').classList.remove('open');
      if(currentUser.mustChangePassword) await showChangePasswordScreen(true);
      enterApp();
      toast('Welcome, '+u.name);
    };
    submit.addEventListener('click', doSubmit);
    input.addEventListener('keydown', (e)=>{ if(e.key==='Enter') doSubmit(); });
    container.appendChild(submit);
    setTimeout(()=> input.focus(), 50);
  }

  async function showLoginScreen(message){
    $('loginOverlay').classList.add('open');
    showRoleChooser(message);
  }

  // Reads the role from the VERIFIED Supabase session rather than trusting
  // whatever localStorage says.
  //
  // Previously an admin session was restored purely because
  // localStorage['current-user'].role === 'admin' — anyone could open devtools,
  // write that one key, reload, and get the full admin UI (Manage Users,
  // approvals, dropdown-list editing). Now the identity has to come back from
  // Supabase Auth, and "admin" specifically has to match the admin account's
  // email on the server-issued JWT.
  //
  // Returns one of three things, and callers must treat them differently:
  //   {id,email,role}  a verified session was found — trust it fully.
  //   false             the cloud IS reachable and Auth explicitly reports no
  //                     active session (truly signed out, or the token
  //                     expired/was revoked) — any saved local session is
  //                     stale and should be dropped.
  //   null              could NOT be checked right now (cloud unreachable,
  //                     still connecting, or a transient error). This must
  //                     NOT be treated the same as false/"no session" — doing
  //                     so would sign someone out on every ordinary page
  //                     reload/refresh that happens to land during a brief
  //                     signal drop on a field connection.
  async function getVerifiedSession(){
    if(!(await ensureCloud())) return null;
    try{
      const { data, error } = await db.auth.getSession();
      if(error) return null; // couldn't check — unknown, not "none"
      if(!data || !data.session || !data.session.user) return false; // genuinely no session
      const user = data.session.user;
      const email = (user.email||'').toLowerCase();
      if(email === ADMIN_EMAIL.toLowerCase()){
        return { id: user.id, email, role: 'admin' };
      }
      // Not the admin account — could be a technician or a customer portal
      // login. Ask `profiles` rather than assuming 'tech' as before, now
      // that a third role exists (self-select is already allowed by the
      // existing `id = auth.uid()` clause on profiles' select policy, so
      // this works pre-login-restoration same as cloudGetUser does below).
      // Falls back to 'tech' — the old, only behavior — if this lookup
      // fails or the row isn't a customer, so nothing changes for tech.
      try{
        const { data: prof } = await db.from('profiles').select('role, active').eq('id', user.id).maybeSingle();
        if(prof && prof.role === 'customer' && prof.active !== false){
          // Which specific customers this login can see is fetched by the
          // caller (checkLoginGate) once it commits to restoring this as a
          // customer session — no need to duplicate that lookup here.
          return { id: user.id, email, role: 'customer' };
        }
      }catch(e){}
      return { id: user.id, email, role: 'tech' };
    }catch(e){ return null; }
  }

  async function checkLoginGate(){
    let saved = null;
    try{ saved = JSON.parse(localStorage.getItem('current-user')||'null'); }catch(e){}
    const verified = await getVerifiedSession();
    // A stored session that Supabase positively confirms is gone (expired or
    // forged) is stale — drop it. A stored session we simply couldn't check
    // right now (verified===null) is kept as-is; see getVerifiedSession above.
    if(saved && verified===false){
      localStorage.removeItem('current-user');
      currentUser = null;
      saved = null;
    }
    if(verified && verified.role==='admin'){
      currentUser = {id: verified.id, name: 'Admin', role: 'admin'};
      localStorage.setItem('current-user', JSON.stringify(currentUser));
      enterAdminMode();
      updateUserBadge();
      applyUserRestrictions();
      $('loginOverlay').classList.remove('open');
      enterApp();
      return;
    }
    // Claimed admin locally. Admin is the one role that never restores from
    // cache alone — its far more sensitive surface means every reload has to
    // re-confirm identity against the server, network permitting. If we
    // simply couldn't check (offline), ask to sign in again rather than
    // either granting or silently revoking admin access based on a guess.
    if(saved && saved.role==='admin'){
      if(verified===null){
        await showLoginScreen('Reconnecting — please sign in again to continue as Admin.');
      }else{
        localStorage.removeItem('current-user');
        currentUser = null;
        await showLoginScreen('Please sign in again.');
      }
      return;
    }
    // ---- Customer portal session restore ----
    // Mirrors the admin pattern above (verified case, then cached-locally
    // case) rather than falling into the technician branch below — that
    // branch's cloudGetUser()/profileToUser() path doesn't carry a role or
    // customer_id, so a customer session would silently come back as a
    // technician if it fell through. Pure insertion: none of this runs
    // unless currentUser.role is 'customer'.
    if(verified && verified.role==='customer'){
      const custList = await fetchCustomerLinks(verified.id);
      if(!custList.length){
        // Login exists and is active, but isn't linked to any customer
        // record (admin removed the last one, or it was never finished
        // being set up) — same treatment as the login-form's own check.
        localStorage.removeItem('current-user');
        currentUser = null;
        await showLoginScreen('This account is not linked to any customer records yet. Contact your service provider.');
        return;
      }
      let custName = 'there';
      try{
        const { data: prof } = await db.from('profiles').select('name').eq('id', verified.id).maybeSingle();
        if(prof && prof.name) custName = prof.name;
      }catch(e){}
      const activeId = pickActiveCustomerId(custList, verified.id);
      currentUser = {
        id: verified.id, name: custName, role:'customer',
        customerId: activeId, customerIds: custList.map(c=> c.id), customerList: custList
      };
      localStorage.setItem('current-user', JSON.stringify(currentUser));
      updateUserBadge();
      applyUserRestrictions();
      $('loginOverlay').classList.remove('open');
      enterApp();
      return;
    }
    if(saved && saved.role==='customer'){
      if(verified===null){
        // Cloud unreachable — trust the cache rather than forcing a login
        // screen on a plain reload, same leniency as the technician branch.
        currentUser = {
          id:saved.id, name:saved.name, role:'customer', customerId:saved.customerId,
          customerIds:saved.customerIds||[], customerList:saved.customerList||[]
        };
        updateUserBadge();
        applyUserRestrictions();
        $('loginOverlay').classList.remove('open');
        enterApp();
        return;
      }
      // Cloud WAS reachable but didn't confirm this as a live customer
      // session (verified is false, or verified but a different
      // role/identity) — don't guess, ask them to sign in again.
      localStorage.removeItem('current-user');
      currentUser = null;
      await showLoginScreen('Please sign in again.');
      return;
    }
    if(saved && verified && saved.id !== verified.id){
      // Stored identity disagrees with a session we actually verified. Trust the server.
      saved = {id: verified.id};
    }
    if(saved){
      // When the cloud is reachable, refresh this technician's record so
      // admin-side changes (deactivation, restrictions) take effect. When it
      // isn't (verified===null), fall back to the cached copy rather than
      // forcing a login screen on a simple reload/refresh while offline —
      // technicians are exactly the ones most likely to hit a brief signal
      // drop out in the field.
      const fresh = verified ? await cloudGetUser(saved.id) : null;
      if(fresh && fresh.active!==false){
        currentUser = {id:fresh.id, name:fresh.name, role:'tech', restrictions: fresh.restrictions||{}, mustChangePassword: !!fresh.mustChangePassword};
        localStorage.setItem('current-user', JSON.stringify(currentUser));
        updateUserBadge();
        applyUserRestrictions();
        $('loginOverlay').classList.remove('open');
        if(currentUser.mustChangePassword) await showChangePasswordScreen(true);
        enterApp();
        return;
      }
      if(fresh && fresh.active===false){
        localStorage.removeItem('current-user');
        currentUser = null;
        await showLoginScreen('Your access was deactivated. Ask your admin, or sign in as someone else.');
        return;
      }
      if(!verified){
        currentUser = {id:saved.id, name:saved.name, role:'tech', restrictions: saved.restrictions||{}, mustChangePassword: !!saved.mustChangePassword};
        updateUserBadge();
        applyUserRestrictions();
        $('loginOverlay').classList.remove('open');
        enterApp();
        return;
      }
      // Verified fine, but the profile lookup itself failed/returned nothing
      // usable — don't guess, fall through to the login screen.
      localStorage.removeItem('current-user');
      currentUser = null;
    }
    await showLoginScreen();
  }

  // returns false (and re-shows login) if this technician was deactivated mid-session
  async function verifyStillActive(){
    if(!currentUser || currentUser.role==='admin' || currentUser.role==='customer') return true; // admin/customer sessions aren't gated this way
    const fresh = await cloudGetUser(currentUser.id);
    if(fresh && fresh.active===false){
      trackerStopBroadcasting();
      localStorage.removeItem('current-user');
      currentUser = null;
      updateUserBadge();
      applyUserRestrictions();
      await showLoginScreen('Your access was deactivated. Ask your admin, or sign in as someone else.');
      return false;
    }
    if(fresh){
      // refresh restrictions in case admin changed them mid-session
      currentUser.restrictions = fresh.restrictions || {};
      localStorage.setItem('current-user', JSON.stringify(currentUser));
      applyUserRestrictions();
    }
    return true;
  }

  async function doLogout(){
    if(currentUser && currentUser.role==='admin') exitAdminModeUI();
    stopIdleWatch();
    trackerStopBroadcasting();
    trackerAdminTeardown();
    currentUser = null;
    localStorage.removeItem('current-user');
    updateUserBadge();
    // Belt-and-suspenders: the login overlay is meant to cover everything
    // underneath regardless, but explicitly hiding the home screen (map
    // included) here means a signed-out session never depends on stacking
    // order alone to keep the previous account's screen out of view.
    const homeScreenEl = $('homeScreen');
    if(homeScreenEl) homeScreenEl.style.display = 'none';
    await showLoginScreen();
  }

  // Tapping the header cloud chip opens the connection panel, so a technician
  // who sees "Not Connected" has somewhere to go instead of just a dead label.
  const cloudStatusBtn = $('cloudBtn');
  if(cloudStatusBtn) cloudStatusBtn.addEventListener('click', ()=>{
    $('cloudOverlay').classList.add('open');
  });
  $('closeCloud').addEventListener('click', ()=> $('cloudOverlay').classList.remove('open'));
  $('cloudOverlay').addEventListener('click', (e)=>{ if(e.target.id==='cloudOverlay') $('cloudOverlay').classList.remove('open'); });
  $('connectCloudBtn').addEventListener('click', async ()=>{
    const url = $('cfgSupabaseUrl').value.trim();
    const anonKey = $('cfgSupabaseKey').value.trim();
    if(!url || !anonKey){ $('cloudStatusMsg').textContent = 'Enter both the Project URL and the anon public key.'; $('cloudStatusMsg').style.color='var(--danger)'; return; }
    localStorage.setItem('cloud-config', JSON.stringify({url, anonKey}));
    cloudInitPromise = null; cloudReady = false;
    $('cloudStatusMsg').textContent = 'Connecting…'; $('cloudStatusMsg').style.color='var(--text-muted)';
    const ok = await initCloud();
    if(ok){
      $('cloudStatusMsg').textContent = 'Connected! Reloading shared data…'; $('cloudStatusMsg').style.color='var(--green-dark)';
      await loadFieldLists(); await seedDefaultLists(); await loadEmailCfg(); await loadCustomers();
      toast('Connected to shared cloud');
      setTimeout(()=> $('cloudOverlay').classList.remove('open'), 900);
    }else{
      $('cloudStatusMsg').textContent = 'Could not connect — double check the URL and key were copied correctly.';
      $('cloudStatusMsg').style.color='var(--danger)';
    }
  });
  $('disconnectCloudBtn').addEventListener('click', ()=>{
    localStorage.removeItem('cloud-config');
    cloudReady = false; cloudInitPromise = Promise.resolve(false); db = null;
    setCloudStatusUI(false);
    $('cfgSupabaseUrl').value = ''; $('cfgSupabaseKey').value = '';
    toast('Disconnected — this device will use local storage only');
  });
  $('migrateBtn').addEventListener('click', async ()=>{
    if(!(await ensureCloud())){ toast('Connect to the cloud first'); return; }
    $('migrateBtn').textContent = 'Uploading…'; $('migrateBtn').disabled = true;
    try{
      try{
        const res = await window.storage.get('field-lists', false);
        if(res) await cloudSetDoc('settings/fieldLists', {data: JSON.parse(res.value)});
      }catch(e){}
      try{
        const res = await window.storage.list('report:', false);
        for(const key of (res.keys||[])){
          const item = await window.storage.get(key, false);
          const d = JSON.parse(item.value);
          if(d.srNo) await cloudSaveReport(d.srNo, d);
        }
      }catch(e){}
      toast('Local data uploaded to the cloud');
    }catch(e){ toast('Migration ran into an error'); }
    $('migrateBtn').textContent = "Upload this device's saved data to the cloud"; $('migrateBtn').disabled = false;
  });

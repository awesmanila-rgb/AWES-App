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

  // ---------- Admin idle timeout ----------
  // Admin only, by design: a shared/unattended device left signed in as
  // Admin is the risky case (Manage Users, approvals, password changes).
  // Technician sessions are unaffected and keep persisting indefinitely, same
  // as before. Implemented as "last activity timestamp + periodic check"
  // rather than clearTimeout/setTimeout on every event — mousemove alone can
  // fire dozens of times a second, and resetting a real timer that often is
  // wasted work for no behavioral difference.
  const ADMIN_IDLE_MS = 15 * 60 * 1000;      // 15 minutes
  const ADMIN_IDLE_CHECK_MS = 15 * 1000;     // how often we check the clock
  let lastAdminActivity = Date.now();
  let adminIdleInterval = null;

  function markAdminActivity(){
    if(currentUser && currentUser.role==='admin') lastAdminActivity = Date.now();
  }
  ['mousemove','mousedown','keydown','touchstart','scroll','wheel'].forEach(evt=>{
    document.addEventListener(evt, markAdminActivity, {passive:true});
  });

  function startAdminIdleWatch(){
    lastAdminActivity = Date.now();
    if(adminIdleInterval) clearInterval(adminIdleInterval);
    adminIdleInterval = setInterval(async ()=>{
      if(!currentUser || currentUser.role!=='admin'){ stopAdminIdleWatch(); return; }
      if(Date.now() - lastAdminActivity >= ADMIN_IDLE_MS){
        stopAdminIdleWatch();
        await doLogout();
        toast('Signed out after 15 minutes of inactivity');
      }
    }, ADMIN_IDLE_CHECK_MS);
  }
  function stopAdminIdleWatch(){
    if(adminIdleInterval){ clearInterval(adminIdleInterval); adminIdleInterval = null; }
  }

  function updateUserBadge(){
    const el = $('metaUser');
    if(!el) return;
    if(currentUser && currentUser.role==='admin'){ el.style.display=''; el.textContent = 'Admin'; }
    else if(currentUser){ el.style.display=''; el.textContent = 'Tech: '+currentUser.name; }
    else{ el.style.display='none'; }
    const menuLogoutEl = $('menuLogout');
    if(menuLogoutEl) menuLogoutEl.style.display = currentUser ? '' : 'none';
  }

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
    const isTech = !!(currentUser && currentUser.role!=='admin');
    const isAdmin = !!(currentUser && currentUser.role==='admin');
    setVis('menuWrap', !isTech);
    // "New" (header shortcut for a blank report) and "Create New" (Service
    // Report tab) both start a fresh, blank report. Technicians already
    // never saw the header button; admins can only view/edit existing
    // reports, not author new ones, so neither role gets either control now.
    setVis('newBtn', false);
    setVis('srTabNewBtn', !isAdmin);
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

  function showRoleChooser(message){
    const container = $('loginList');
    container.innerHTML = '';
    if(message){
      const m = document.createElement('div');
      m.style.cssText = 'font-size:13px; color:var(--danger); margin-bottom:10px; text-align:center;';
      m.textContent = message;
      container.appendChild(m);
    }
    const techBtn = document.createElement('button');
    techBtn.type='button'; techBtn.className='login-user-btn';
    techBtn.textContent = '👷 Technician';
    techBtn.addEventListener('click', async ()=>{
      container.innerHTML = '<div class="empty-state">Loading…</div>';
      const users = await publicListTechnicians();
      renderTechnicianList(users || []);
    });
    const adminLoginBtn = document.createElement('button');
    adminLoginBtn.type='button'; adminLoginBtn.className='login-user-btn';
    adminLoginBtn.textContent = '🔑 Admin';
    adminLoginBtn.addEventListener('click', ()=> renderAdminLoginForm());
    container.appendChild(techBtn);
    container.appendChild(adminLoginBtn);

    const cloudLink = document.createElement('button');
    cloudLink.type='button';
    cloudLink.style.cssText = 'width:100%; margin-top:14px; background:none; border:none; color:var(--text-muted); font-size:12px; text-decoration:underline; cursor:pointer;';
    cloudLink.textContent = cloudReady ? '☁ Connected — Cloud Setup' : '☁ Not connected — tap to set up Shared Cloud';
    cloudLink.addEventListener('click', ()=>{
      const cfg = getCloudConfig();
      if(cfg){ $('cfgSupabaseUrl').value = cfg.url || ''; $('cfgSupabaseKey').value = cfg.anonKey || ''; }
      $('cloudStatusMsg').textContent = cloudReady ? 'Currently connected.' : '';
      $('cloudOverlay').classList.add('open');
    });
    container.appendChild(cloudLink);
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
  async function getVerifiedSession(){
    if(!(await ensureCloud())) return null;
    try{
      const { data, error } = await db.auth.getSession();
      if(error || !data || !data.session || !data.session.user) return null;
      const user = data.session.user;
      const email = (user.email||'').toLowerCase();
      return {
        id: user.id,
        email,
        role: email === ADMIN_EMAIL.toLowerCase() ? 'admin' : 'tech'
      };
    }catch(e){ return null; }
  }

  async function checkLoginGate(){
    let saved = null;
    try{ saved = JSON.parse(localStorage.getItem('current-user')||'null'); }catch(e){}
    const verified = await getVerifiedSession();
    // A stored session that Supabase no longer recognises is stale (expired or
    // forged). Drop it rather than honouring it.
    if(saved && !verified){
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
    // Claimed admin but the verified session is a technician: refuse the upgrade.
    if(saved && saved.role==='admin'){
      localStorage.removeItem('current-user');
      currentUser = null;
      await showLoginScreen('Please sign in again.');
      return;
    }
    if(saved && verified && saved.id !== verified.id){
      // Stored identity disagrees with the signed-in account. Trust the server.
      saved = {id: verified.id};
    }
    if(saved){
      const fresh = await cloudGetUser(saved.id);
      if(fresh && fresh.active!==false){
        currentUser = {id:fresh.id, name:fresh.name, role:'tech', restrictions: fresh.restrictions||{}, mustChangePassword: !!fresh.mustChangePassword};
        updateUserBadge();
        applyUserRestrictions();
        $('loginOverlay').classList.remove('open');
        if(currentUser.mustChangePassword) await showChangePasswordScreen(true);
      enterApp();
        return;
      }
      localStorage.removeItem('current-user');
      currentUser = null;
      if(fresh && fresh.active===false){
        await showLoginScreen('Your access was deactivated. Ask your admin, or sign in as someone else.');
        return;
      }
    }
    await showLoginScreen();
  }

  // returns false (and re-shows login) if this technician was deactivated mid-session
  async function verifyStillActive(){
    if(!currentUser || currentUser.role==='admin') return true; // admin sessions aren't gated this way
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
    stopAdminIdleWatch();
    trackerStopBroadcasting();
    trackerAdminTeardown();
    currentUser = null;
    localStorage.removeItem('current-user');
    updateUserBadge();
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

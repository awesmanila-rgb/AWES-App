(function(){
  "use strict";

  // ---------- helpers ----------
  const domCache = Object.create(null);
  const $ = (id) => domCache[id] || (domCache[id] = document.getElementById(id));
  const $$ = (selector, root=document) => Array.from(root.querySelectorAll(selector));

  // Shared HTML escaping helper. Keep this in one place so modules do not each
  // maintain their own copy.
  function escapeHtml(s){
    return String(s==null?'':s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }
  function toast(msg){
    const t = $('toast'); t.textContent = msg; t.classList.add('show');
    setTimeout(()=>t.classList.remove('show'), 2200);
  }
  function todayISO(){ return new Date().toISOString().slice(0,10); }
  function fmtDate(iso){
    if(!iso) return '—';
    const d = new Date(iso+'T00:00:00');
    return d.toLocaleDateString('en-PH', {year:'numeric', month:'short', day:'numeric'});
  }

  // ---------- shared cloud (Supabase) ----------
  let cloudReady = false;
  let cloudInitPromise = null;
  let db = null; // Supabase client (supabase-js), was a Firestore ref before

  // The app now connects automatically using AWES's Supabase project — no
  // manual setup needed for day-to-day use. (Recovery path: the "tap to set
  // up Shared Cloud" link on the login screen still opens the config screen,
  // in case this project ever needs to change.)
  const DEFAULT_CLOUD_CONFIG = {
    url: 'https://ugxrrgocjpkzumhghzat.supabase.co',
    anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVneHJyZ29janBrenVtaGdoemF0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY5NjA3NjEsImV4cCI6MjEwMjUzNjc2MX0.y6Q9rCb_pKretcptgHwcGb0-YpUYC3_JQhY2PGJqGWk'
  };
  function getCloudConfig(){
    try{
      const raw = localStorage.getItem('cloud-config');
      if(raw) return JSON.parse(raw); // {url, anonKey}
    }catch(e){}
    return DEFAULT_CLOUD_CONFIG;
  }
  function setCloudStatusUI(connected){
    const btn = $('cloudBtn');
    if(btn){ btn.textContent = connected ? '☁ Connected' : '☁ Not Connected'; btn.classList.toggle('cloud-connected', connected); }
  }
  async function doCloudInit(){
    const cfg = getCloudConfig();
    if(!cfg || !cfg.url || !cfg.anonKey){ setCloudStatusUI(false); return false; }
    if(!window.supabase){
      try{ await loadAwesScript('supabase', awesLibs.supabase); }
      catch(e){ setCloudStatusUI(false); return false; }
    }
    try{
      db = window.supabase.createClient(cfg.url, cfg.anonKey);
      cloudReady = true;
      setCloudStatusUI(true);
      return true;
    }catch(e){
      console.error('Cloud connect failed', describeCloudError(e));
      cloudReady = false;
      setCloudStatusUI(false);
      return false;
    }
  }
  function initCloud(){
    if(!cloudInitPromise) cloudInitPromise = doCloudInit();
    return cloudInitPromise;
  }
  async function ensureCloud(){
    if(cloudReady) return true;
    return await initCloud();
  }

  // Supabase errors (PostgrestError) are plain objects, so console.error(...e)
  // just prints "[object Object]" in some console viewers. Pull out the
  // fields that actually explain what went wrong (message/code/details/hint
  // for Postgrest errors, or message/name for anything else) so failures are
  // debuggable instead of opaque.
  function describeCloudError(e){
    if(!e) return 'unknown error';
    if(e.message || e.code || e.details || e.hint){
      return [e.code, e.message, e.details, e.hint].filter(Boolean).join(' | ');
    }
    try{ return JSON.stringify(e); }catch(_){ return String(e); }
  }

  // ---- Generic settings key-value store (table: app_settings) ----
  // Used for things like field-lists dropdowns and EmailJS config.
  // NOTE: admin password is no longer stored here — see loginAdmin/changeAdminPassword,
  // which now use real Supabase Auth instead of a settings/adminPin document.
  async function cloudGetDoc(key){
    if(!(await ensureCloud())) return null;
    try{
      const { data, error } = await db.from('app_settings').select('value').eq('key', key).maybeSingle();
      if(error) throw error;
      return data ? data.value : null;
    }catch(e){ console.error('cloud get failed', key, describeCloudError(e)); return null; }
  }
  async function cloudSetDoc(key, value){
    if(!(await ensureCloud())) return false;
    try{
      const { error } = await db.from('app_settings').upsert({ key, value }, { onConflict: 'key' });
      if(error) throw error;
      return true;
    }catch(e){ console.error('cloud set failed', key, describeCloudError(e)); return false; }
  }

  // ---- Service Reports (table: service_reports) ----
  // Maps the app's existing camelCase report object <-> the Postgres snake_case columns,
  // so every other part of the app that already builds/reads a report object needs no changes.
  function reportToRow(data){
    return {
      sr_no: data.srNo, technician_id: data.technicianId, date: data.date,
      cust_name: data.custName, cust_address: data.custAddress, contact_no: data.contactNo,
      contact_person: data.contactPerson, cust_email: data.custEmail, equip_type: data.equipType,
      model_cu: data.modelCU, serial_cu: data.serialCU, model_fcu: data.modelFCU, serial_fcu: data.serialFCU,
      cool_cap: data.coolCap, mount_type: data.mountType, brand: data.brand, refrigerant_type: data.refrigerantType,
      compressor_type: data.compressorType, equip_location: data.equipLocation, trouble_call: data.troubleCall,
      findings: data.findings||[], recommendations: data.recommendations||[], materials: data.materials||[],
      services_done: data.servicesDone||[], before_data: data.before||{}, after_data: data.after||{},
      installation: data.installation||{}, time_in: data.timeIn, time_out: data.timeOut, remarks: data.remarks,
      customer_printed_name: data.customerPrintedName, technician_name: data.technicianName,
      customer_signature: data.customerSignature||{}, technician_signature: data.technicianSignature||{},
      completed: !!data.completed
    };
  }
  function rowToReport(row){
    if(!row) return null;
    return {
      srNo: row.sr_no, technicianId: row.technician_id, date: row.date,
      custName: row.cust_name, custAddress: row.cust_address, contactNo: row.contact_no,
      contactPerson: row.contact_person, custEmail: row.cust_email, equipType: row.equip_type,
      modelCU: row.model_cu, serialCU: row.serial_cu, modelFCU: row.model_fcu, serialFCU: row.serial_fcu,
      coolCap: row.cool_cap, mountType: row.mount_type, brand: row.brand, refrigerantType: row.refrigerant_type,
      compressorType: row.compressor_type, equipLocation: row.equip_location, troubleCall: row.trouble_call,
      findings: row.findings||[], recommendations: row.recommendations||[], materials: row.materials||[],
      servicesDone: row.services_done||[], before: row.before_data||{}, after: row.after_data||{},
      installation: row.installation||{}, timeIn: row.time_in, timeOut: row.time_out, remarks: row.remarks,
      customerPrintedName: row.customer_printed_name, technicianName: row.technician_name,
      customerSignature: row.customer_signature||{}, technicianSignature: row.technician_signature||{},
      completed: !!row.completed
    };
  }
  async function cloudSaveReport(srNo, data){
    if(!(await ensureCloud())) return false;
    try{
      data.srNo = srNo;
      const { error } = await db.from('service_reports').upsert(reportToRow(data), { onConflict: 'sr_no' });
      if(error) throw error;
      return true;
    }catch(e){ console.error('cloud save report failed', describeCloudError(e)); return false; }
  }
  async function cloudGetReport(srNo){
    if(!(await ensureCloud())) return null;
    try{
      const { data, error } = await db.from('service_reports').select('*').eq('sr_no', srNo).maybeSingle();
      if(error) throw error;
      return rowToReport(data);
    }catch(e){ return null; }
  }
  async function cloudListReports(){
    if(!(await ensureCloud())) return null;
    try{
      const { data, error } = await db.from('service_reports').select('*').order('date',{ascending:false}).limit(150);
      if(error) throw error;
      return (data||[]).map(rowToReport);
    }catch(e){ console.error('cloud list failed', describeCloudError(e)); return null; }
  }
  async function cloudNextSrNo(dateStr){
    if(!(await ensureCloud())) return null;
    try{
      // dateStr comes in as 'YYYYMMDD'; the Postgres function takes a real date.
      const iso = dateStr.slice(0,4)+'-'+dateStr.slice(4,6)+'-'+dateStr.slice(6,8);
      const { data, error } = await db.rpc('next_sr_no', { p_date: iso });
      if(error) throw error;
      return data;
    }catch(e){ console.error('cloud SR counter failed', describeCloudError(e)); return null; }
  }


// ---------- technician user accounts (table: profiles, role='technician') ----------
  // Real account creation/password changes go through the admin-create-technician
  // Edge Function (see cloudSetUser callers) — these functions only manage the
  // non-auth profile fields (name, active, restrictions).
  function profileToUser(row){
    if(!row) return null;
    return {
      id: row.id, name: row.name, active: row.active,
      restrictions: { noHistory: row.no_history, noReport: row.no_report, readOnly: row.read_only }
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
        const { error } = await db.from('profiles').update(patch).eq('id', id);
        if(error) throw error;
        return true;
      }catch(e){ console.error('save user failed', describeCloudError(e)); }
    }
    const users = await localListUsers();
    const idx = users.findIndex(u=>u.id===id);
    if(idx>=0) users[idx] = Object.assign({}, users[idx], data, {id});
    else users.push(Object.assign({id}, data));
    return await localSaveUsers(users);
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
      }catch(e){}
    }
    const users = (await localListUsers()).filter(u=>u.id!==id);
    return await localSaveUsers(users);
  }

  let currentUser = null; // {id, name, role: 'tech'|'admin'}

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
    // Technician accounts: hide the New button and the Menu (admin-only tools live
    // there), and surface Email Setup + Logout directly instead of tucked in the menu.
    const isTech = !!(currentUser && currentUser.role!=='admin');
    setVis('newBtn', !isTech);
    setVis('menuWrap', !isTech);
    setVis('userLogoutBtn', isTech);
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
      const users = await cloudListUsers();
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
      const users = await cloudListUsers();
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
    field.innerHTML = '<label>Password for '+u.name+'</label>';
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
      currentUser = {id: data.user.id, name:u.name, role:'tech', restrictions: u.restrictions||{}};
      localStorage.setItem('current-user', JSON.stringify(currentUser));
      updateUserBadge();
      applyUserRestrictions();
      $('loginOverlay').classList.remove('open');
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

  async function checkLoginGate(){
    let saved = null;
    try{ saved = JSON.parse(localStorage.getItem('current-user')||'null'); }catch(e){}
    if(saved && saved.role==='admin'){
      currentUser = saved;
      enterAdminMode();
      updateUserBadge();
      applyUserRestrictions();
      $('loginOverlay').classList.remove('open');
      enterApp();
      return;
    }
    if(saved){
      const fresh = await cloudGetUser(saved.id);
      if(fresh && fresh.active!==false){
        currentUser = {id:fresh.id, name:fresh.name, role:'tech', restrictions: fresh.restrictions||{}};
        updateUserBadge();
        applyUserRestrictions();
        $('loginOverlay').classList.remove('open');
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
    currentUser = null;
    localStorage.removeItem('current-user');
    updateUserBadge();
    await showLoginScreen();
  }

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


// ---------- SR number counter (persisted, shared when cloud is connected) ----------
  let currentSrNo = null;
  async function nextSrNo(){
    const dateStr = ($('svcDate').value || todayISO()).replace(/-/g,'');
    if(await ensureCloud()){
      const cloudSr = await cloudNextSrNo(dateStr);
      if(cloudSr) return cloudSr;
    }
    let seq = 1;
    try{
      const res = await window.storage.get('sr-counter:'+dateStr, false);
      seq = res ? (JSON.parse(res.value).seq + 1) : 1;
    }catch(e){ seq = 1; }
    try{ await window.storage.set('sr-counter:'+dateStr, JSON.stringify({seq}), false); }catch(e){}
    return 'SR-'+dateStr+'-'+String(seq).padStart(3,'0');
  }

  // ---------- dynamic list rows (findings / recommendations) ----------
  const LIST_KEY_BY_CONTAINER = {
    findingsList: 'findings',
    recsList: 'recs',
    servicesDoneList: 'servicesDone'
  };
  function addListRow(containerId, value){
    const wrap = document.createElement('div');
    wrap.className = 'itemrow';
    const ta = document.createElement('textarea');
    ta.rows = 1; ta.value = value || '';
    ta.placeholder = 'Describe...';
    const rm = document.createElement('button');
    rm.type = 'button'; rm.className = 'rm-btn'; rm.textContent = '\u2212';
    rm.onclick = () => wrap.remove();
    wrap.appendChild(ta); wrap.appendChild(rm);
    $(containerId).appendChild(wrap);
    attachCombo(ta, LIST_KEY_BY_CONTAINER[containerId] || containerId);
  }
  document.querySelectorAll('.add-row-btn[data-target]').forEach(btn=>{
    btn.addEventListener('click', ()=> addListRow(btn.dataset.target));
  });

  // ---------- materials table ----------
  let materialRowCount = 0;
  function addMaterialRow(data){
    data = data || {};
    const letter = String.fromCharCode(97 + materialRowCount);
    materialRowCount++;
    const tr = document.createElement('tr');
    tr.innerHTML =
      '<td class="letter-cell">'+letter+'.</td>'+
      '<td><input type="text" class="m-details" value="'+escapeHtml(data.details||'')+'"></td>'+
      '<td class="qty-cell"><input type="text" class="m-qty" value="'+escapeHtml(data.qty||'')+'"></td>'+
      '<td><button type="button" class="rm-btn" style="width:32px;height:32px;">\u2212</button></td>';
    tr.querySelector('.rm-btn').onclick = () => { tr.remove(); relabelMaterialRows(); };
    $('materialsBody').appendChild(tr);
    attachCombo(tr.querySelector('.m-details'), 'm_details');
    attachCombo(tr.querySelector('.m-qty'), 'm_qty');
    $('materialsTableWrap').style.display = '';
  }
  function relabelMaterialRows(){
    const rows = $('materialsBody').querySelectorAll('tr');
    materialRowCount = rows.length;
    rows.forEach((tr,i)=>{ tr.querySelector('.letter-cell').textContent = String.fromCharCode(97+i)+'.'; });
    if(rows.length===0) $('materialsTableWrap').style.display = 'none';
  }
  $('addMaterialRow').addEventListener('click', ()=> addMaterialRow());

  // ---------- installation toggle ----------
  $('isInstallToggle').addEventListener('change', function(){
    $('installSection').classList.toggle('open', this.checked);
  });

  // ---------- signature pads (lazy-loaded) ----------
  let sigCustomerPad = null, sigTechPad = null, sigPadsPromise = null;
  function setupSigPad(canvasId, phId){
    const canvas = $(canvasId);
    function resize(){
      const ratio = Math.max(window.devicePixelRatio || 1, 1);
      const rect = canvas.parentElement.getBoundingClientRect();
      canvas.width = rect.width * ratio;
      canvas.height = rect.height * ratio;
      canvas.getContext('2d').scale(ratio, ratio);
      pad.clear();
    }
    const pad = new SignaturePad(canvas, {penColor:'#1C2621', backgroundColor:'rgba(255,255,255,0)'});
    pad.addEventListener('beginStroke', ()=>{ $(phId).style.display='none'; });
    window.addEventListener('resize', resize);
    setTimeout(resize, 50);
    return pad;
  }
  async function ensureSignaturePads(){
    if(sigCustomerPad && sigTechPad) return;
    if(!sigPadsPromise){
      sigPadsPromise = loadAwesScript('signature', awesLibs.signature).then(()=>{
        sigCustomerPad = setupSigPad('sigCustomer','sigCustomerPh');
        sigTechPad = setupSigPad('sigTech','sigTechPh');
      });
    }
    return sigPadsPromise;
  }
  // Load the signature library only when the user first enters either signature area.
  ['sigCustomer','sigTech'].forEach(id=>{
    $(id).addEventListener('pointerdown', ()=>{ ensureSignaturePads().catch(()=>toast('Signature tool could not be loaded')); }, {once:true});
  });
  loadFieldLists().then(async ()=>{ await seedDefaultLists(); await loadCustomers(); attachAllCombos(); checkLoginGate(); });
  document.querySelectorAll('[data-clear]').forEach(btn=>{
    btn.addEventListener('click', async ()=>{
      await ensureSignaturePads();
      const map = {sigCustomer:sigCustomerPad, sigTech:sigTechPad};
      map[btn.dataset.clear].clear();
      $(btn.dataset.clear+'Ph').style.display='flex';
    });
  });

  // ---------- dropdown lists (admin-managed) ----------
  const FIELD_META = {
    custName:{label:"Customer's Name", group:"Customer Info"},
    contactNo:{label:'Contact No.', group:'Customer Info'},
    contactPerson:{label:'Contact Person', group:'Customer Info'},
    custEmail:{label:'Customer Email', group:'Customer Info'},
    equipType:{label:'Equipment Type', group:'Equipment'},
    modelCU:{label:'Model No. (CU)', group:'Equipment'},
    serialCU:{label:'Serial No. (CU)', group:'Equipment'},
    modelFCU:{label:'Model No. (FCU)', group:'Equipment'},
    serialFCU:{label:'Serial No. (FCU)', group:'Equipment'},
    coolCap:{label:'Cooling Capacity', group:'Equipment'},
    mountType:{label:'Mounting Type', group:'Equipment'},
    brand:{label:'Manufacturer / Brand', group:'Equipment'},
    refrigerantType:{label:'Refrigerant Type', group:'Equipment'},
    compressorType:{label:'Compressor Type', group:'Equipment'},
    equipLocation:{label:'Specific Location', group:'Equipment'},
    troubleCall:{label:'Trouble Call / Reason for Service', group:'Report Summary'},
    findings:{label:'Findings / Evaluation', group:'Report Summary'},
    recs:{label:'Recommendation/s', group:'Report Summary'},
    b_amp_l1:{label:'Amperage L1 (Before)', group:'Operating Data'},
    b_amp_l2:{label:'Amperage L2 (Before)', group:'Operating Data'},
    b_amp_l3:{label:'Amperage L3 (Before)', group:'Operating Data'},
    b_volt_l12:{label:'Voltage L12 (Before)', group:'Operating Data'},
    b_volt_l23:{label:'Voltage L23 (Before)', group:'Operating Data'},
    b_volt_l31:{label:'Voltage L31 (Before)', group:'Operating Data'},
    b_press_suction:{label:'Pressure Suction (Before)', group:'Operating Data'},
    b_press_discharge:{label:'Pressure Discharge (Before)', group:'Operating Data'},
    b_temp:{label:'Supply Air Temp (Before)', group:'Operating Data'},
    b_airflow:{label:'Air Volume (Before)', group:'Operating Data'},
    a_amp_l1:{label:'Amperage L1 (After)', group:'Operating Data'},
    a_amp_l2:{label:'Amperage L2 (After)', group:'Operating Data'},
    a_amp_l3:{label:'Amperage L3 (After)', group:'Operating Data'},
    a_volt_l12:{label:'Voltage L12 (After)', group:'Operating Data'},
    a_volt_l23:{label:'Voltage L23 (After)', group:'Operating Data'},
    a_volt_l31:{label:'Voltage L31 (After)', group:'Operating Data'},
    a_press_suction:{label:'Pressure Suction (After)', group:'Operating Data'},
    a_press_discharge:{label:'Pressure Discharge (After)', group:'Operating Data'},
    a_temp:{label:'Supply Air Temp (After)', group:'Operating Data'},
    a_airflow:{label:'Air Volume (After)', group:'Operating Data'},
    pd_suction:{label:'Pipe Diameter — Suction', group:'Installation Data'},
    pd_discharge:{label:'Pipe Diameter — Discharge', group:'Installation Data'},
    pd_drain:{label:'Pipe Diameter — Drain', group:'Installation Data'},
    pl_refline:{label:"Pipe Length — Ref't Line", group:'Installation Data'},
    pl_drain:{label:'Pipe Length — Drain', group:'Installation Data'},
    ws_feeder:{label:'Wire Size — Feeder', group:'Installation Data'},
    ws_control:{label:'Wire Size — Control', group:'Installation Data'},
    circuit_breaker:{label:'Circuit Breaker', group:'Installation Data'},
    pi_refline:{label:"Pipe Insulation — Ref't Line", group:'Installation Data'},
    pi_drain:{label:'Pipe Insulation — Drain', group:'Installation Data'},
    riser_height:{label:'Riser Pipes Height', group:'Installation Data'},
    ptrap:{label:'P-Trap', group:'Installation Data'},
    bracketType:{label:'Accu Bracket Type', group:'Installation Data'},
    m_details:{label:'Materials — Model No. / Details', group:'Materials'},
    m_qty:{label:'Materials — Qty', group:'Materials'},
    servicesDone:{label:'Services Done', group:'Services Done'},
    custPrintedName:{label:'Customer Printed Name', group:'Acknowledgment'},
    techName:{label:'Technician Name', group:'Acknowledgment'}
  };
  const GROUP_ORDER = ['Customer Info','Equipment','Report Summary','Materials','Services Done','Operating Data','Installation Data','Acknowledgment'];

  let fieldLists = {};
  let adminMode = false;
  // Admin credentials now live in real Supabase Auth, not a stored PIN.
  // This synthetic email is the convention used when the admin account was created
  // in Supabase (see setup instructions) — change it here if a different email was used.
  const ADMIN_EMAIL = 'awes.manila@gmail.com';
  function techEmail(technicianId){ return technicianId + '@awes-app.local'; }
  // Re-verifies the admin's password against Supabase Auth without disturbing the
  // current session (signing in again as the same already-logged-in user is safe;
  // it's only creating OTHER accounts that would hijack the session — see addTechnician).
  async function verifyAdminPassword(pw){
    if(!(await ensureCloud())) return false;
    try{
      const { error } = await db.auth.signInWithPassword({ email: ADMIN_EMAIL, password: pw });
      return !error;
    }catch(e){ return false; }
  }

  async function loadFieldLists(){
    if(await ensureCloud()){
      const doc = await cloudGetDoc('settings/fieldLists');
      if(doc){ fieldLists = doc.data || {}; return; }
    }
    try{
      const res = await window.storage.get('field-lists', false);
      fieldLists = res ? JSON.parse(res.value) : {};
    }catch(e){ fieldLists = {}; }
  }
  async function saveFieldLists(){
    if(await ensureCloud()){
      const ok = await cloudSetDoc('settings/fieldLists', {data: fieldLists});
      if(ok) return;
    }
    try{ await window.storage.set('field-lists', JSON.stringify(fieldLists), false); }
    catch(e){ toast('Could not save list'); }
  }
  function ensureList(key){ if(!fieldLists[key]) fieldLists[key] = []; return fieldLists[key]; }

  // Equipment Description fields: unlike other dropdown lists (admin-only add),
  // any logged-in user can add new values here directly while filling out a
  // report — makes sense since technicians encounter new equipment specs in
  // the field constantly. Admin can still add AND edit/rename via Manage
  // Dropdown Lists; this set only affects who can add from the report form.
  const USER_ADDABLE_LIST_KEYS = new Set([
    'equipType','modelCU','serialCU','modelFCU','serialFCU',
    'coolCap','mountType','brand','refrigerantType','compressorType','equipLocation'
  ]);


// ---------- Customer database (table: customers) ----------
  // Powers the Customer's Name autocomplete: picking an existing customer
  // auto-fills address/contact/email; saving a report keeps this list fresh.
  let customersCache = [];
  function customerRowToObj(row){
    return { id: row.id, name: row.name, address: row.address||'', contactNo: row.contact_no||'', contactPerson: row.contact_person||'', email: row.email||'' };
  }
  async function loadCustomers(){
    if(await ensureCloud()){
      try{
        const { data, error } = await db.from('customers').select('*').order('name');
        if(error) throw error;
        customersCache = (data||[]).map(customerRowToObj);
        return;
      }catch(e){ console.error('load customers failed', describeCloudError(e)); }
    }
    try{
      const res = await window.storage.get('customers', false);
      customersCache = res ? JSON.parse(res.value) : [];
    }catch(e){ customersCache = []; }
  }
  async function saveCustomersLocal(){
    try{ await window.storage.set('customers', JSON.stringify(customersCache), false); }catch(e){}
  }
  // Called when a report is saved — creates or updates the customer record
  // so the next report for the same client can auto-fill from it.
  async function cloudUpsertCustomer(c){
    if(!c.name || !c.name.trim()) return;
    const rec = { name: c.name.trim(), address: c.address||'', contact_no: c.contactNo||'', contact_person: c.contactPerson||'', email: c.email||'', updated_at: new Date().toISOString() };
    if(await ensureCloud()){
      try{
        const { error } = await db.from('customers').upsert(rec, { onConflict: 'name' });
        if(error) throw error;
        await loadCustomers();
        return;
      }catch(e){ console.error('upsert customer failed', describeCloudError(e)); }
    }
    const idx = customersCache.findIndex(x=> x.name.toLowerCase() === rec.name.toLowerCase());
    const obj = { id: idx>=0 ? customersCache[idx].id : ('local-'+Date.now()), name: rec.name, address: rec.address, contactNo: rec.contact_no, contactPerson: rec.contact_person, email: rec.email };
    if(idx>=0) customersCache[idx] = obj; else customersCache.push(obj);
    await saveCustomersLocal();
  }
  async function cloudDeleteCustomer(id){
    if(await ensureCloud()){
      try{
        const { error } = await db.from('customers').delete().eq('id', id);
        if(error) throw error;
        await loadCustomers();
        return true;
      }catch(e){ console.error('delete customer failed', describeCloudError(e)); return false; }
    }
    customersCache = customersCache.filter(c=>c.id!==id);
    await saveCustomersLocal();
    return true;
  }

  // ---------- Customer Equipment (table: customer_equipment) ----------
  // Equipment fields all use the normal global dropdown lists for free entry
  // (via the generic combo). The toggle below lets a technician instead pick
  // a whole known unit for the selected customer, filling every field at once.
  const EQUIP_FIELD_KEYS = ['equipType','equipLocation','brand','mountType','coolCap','modelCU','serialCU','modelFCU','serialFCU','refrigerantType','compressorType'];
  const EQUIP_FIELD_TO_COLUMN = {
    equipType:'equip_type', equipLocation:'equip_location', brand:'brand', mountType:'mount_type', coolCap:'cool_cap',
    modelCU:'model_cu', serialCU:'serial_cu', modelFCU:'model_fcu', serialFCU:'serial_fcu',
    refrigerantType:'refrigerant_type', compressorType:'compressor_type'
  };
  let currentCustomerId = null;      // which customer's equipment is currently loaded
  let currentEquipmentCache = [];    // that customer's equipment rows
  function equipRowToObj(row){
    return {
      id: row.id, customerId: row.customer_id, equipType: row.equip_type, equipLocation: row.equip_location,
      brand: row.brand, mountType: row.mount_type, coolCap: row.cool_cap, modelCU: row.model_cu, serialCU: row.serial_cu,
      modelFCU: row.model_fcu, serialFCU: row.serial_fcu, refrigerantType: row.refrigerant_type, compressorType: row.compressor_type
    };
  }
  async function loadCustomerEquipment(customerId){
    currentCustomerId = customerId;
    if(!customerId){ currentEquipmentCache = []; return; }
    if(await ensureCloud()){
      try{
        const { data, error } = await db.from('customer_equipment').select('*').eq('customer_id', customerId);
        if(error) throw error;
        currentEquipmentCache = (data||[]).map(equipRowToObj);
        return;
      }catch(e){ console.error('load customer equipment failed', describeCloudError(e)); }
    }
    try{
      const res = await window.storage.get('cequip:'+customerId, false);
      currentEquipmentCache = res ? JSON.parse(res.value) : [];
    }catch(e){ currentEquipmentCache = []; }
  }
  // Called on report save — if this customer + equipment combo hasn't been
  // seen before, record it so it shows up in future dropdowns for this site.
  async function cloudAddCustomerEquipment(customerId, fields){
    if(!customerId) return;
    const hasAnyValue = EQUIP_FIELD_KEYS.some(k=> (fields[k]||'').trim());
    if(!hasAnyValue) return;
    // Skip if an identical record already exists for this customer.
    const dupe = currentEquipmentCache.find(e=> EQUIP_FIELD_KEYS.every(k=> (e[k]||'') === (fields[k]||'')));
    if(dupe) return;
    const rec = { customer_id: customerId };
    EQUIP_FIELD_KEYS.forEach(k=> rec[EQUIP_FIELD_TO_COLUMN[k]] = fields[k]||'');
    if(await ensureCloud()){
      try{
        const { error } = await db.from('customer_equipment').insert(rec);
        if(error) throw error;
        await loadCustomerEquipment(customerId);
        return;
      }catch(e){ console.error('add customer equipment failed', describeCloudError(e)); }
    }
    const obj = { id:'local-'+Date.now(), customerId }; EQUIP_FIELD_KEYS.forEach(k=> obj[k]=fields[k]||'');
    currentEquipmentCache.push(obj);
    try{ await window.storage.set('cequip:'+customerId, JSON.stringify(currentEquipmentCache), false); }catch(e){}
  }
  async function cloudDeleteCustomerEquipment(id){
    if(await ensureCloud()){
      try{ const { error } = await db.from('customer_equipment').delete().eq('id', id); if(error) throw error; }
      catch(e){ console.error('delete equipment failed', describeCloudError(e)); return false; }
    }
    currentEquipmentCache = currentEquipmentCache.filter(e=>e.id!==id);
    return true;
  }
  // Detail fields (everything except Equipment Type) dynamically decide their
  // own source each time they're opened:
  // Equipment picker toggle: ON shows a list of this customer's known
  // equipment (identified by Type + Brand + Capacity + Location) to pick
  // from as one unit. "Add New" reveals the normal input fields (global
  // dropdown lists, free entry) for equipment not yet on file.
  let currentEquipTab = 'addnew';
  function equipSummaryLine(e){
    return [e.equipType, e.brand, e.coolCap, e.equipLocation].filter(Boolean).join('  ·  ') || '(no details on file)';
  }
  function renderEquipPicker(){
    const list = $('equipPickerList');
    list.innerHTML = '';
    if(!currentCustomerId){
      list.innerHTML = '<div class="combo-empty">Select a customer first (step 1).</div>';
      return;
    }
    if(currentEquipmentCache.length===0){
      list.innerHTML = '<div class="combo-empty">No equipment on file yet for this customer — tap "+ Add New" to add one.</div>';
      return;
    }
    currentEquipmentCache.forEach(e=>{
      const row = document.createElement('div');
      row.className = 'combo-item';
      row.style.cssText = 'border:1px solid var(--border); border-radius:8px; margin-bottom:6px; padding:10px;';
      row.textContent = equipSummaryLine(e);
      row.addEventListener('click', ()=>{
        EQUIP_FIELD_KEYS.forEach(k=>{ const el=$(k); if(el) el.value = e[k]||''; });
        setEquipTab('addnew');
        toast('Loaded equipment: '+equipSummaryLine(e));
      });
      list.appendChild(row);
    });
  }
  function setEquipTab(tab){
    currentEquipTab = tab;
    $('equipTabExisting').classList.toggle('active', tab==='existing');
    $('equipTabAddNew').classList.toggle('active', tab==='addnew');
    if(tab==='existing'){
      if(!currentCustomerId){ toast('Select a customer first (step 1)'); currentEquipTab='addnew'; $('equipTabExisting').classList.remove('active'); $('equipTabAddNew').classList.add('active'); }
      $('equipPickerPanel').style.display = currentEquipTab==='existing' ? '' : 'none';
      $('equipFieldsWrap').style.display = currentEquipTab==='existing' ? 'none' : '';
      if(currentEquipTab==='existing') renderEquipPicker();
    }else if(tab==='addnew'){
      $('equipPickerPanel').style.display = 'none';
      $('equipFieldsWrap').style.display = '';
    }else{
      // Neutral state: nothing picked yet — keep both hidden until the
      // technician taps a tab (or picking a customer auto-picks one).
      $('equipPickerPanel').style.display = 'none';
      $('equipFieldsWrap').style.display = 'none';
    }
  }
  // When a customer is selected, default to whichever tab makes sense:
  // show their equipment list if they have any on file, otherwise go
  // straight to Add New so the technician isn't stuck looking at an empty list.
  function defaultEquipTabForCustomer(){
    // Neutral state: show only the "Select Existing" / "+ Add New" tab
    // buttons, with neither box expanded — the technician taps one to
    // reveal the picker list or the entry fields.
    setEquipTab(null);
  }
  // Dedicated autocomplete for Customer's Name — separate from the generic
  // attachCombo() used elsewhere, because selecting a result here fills
  // FOUR fields (address/contact/person/email) at once, not just one.
  function revealSectionsAfterCustomer(){
    $('custDetailsWrap').style.display = '';
    ['sec2Card','sec3Card','sec4Card','sec5Card','sec6Card','sec7Card','sec8Card'].forEach(id=>{
      const el = $(id); if(el) el.style.display = '';
    });
  }
  // Shared by the customer-picker combo (below) and the "From Job Order"
  // autofill — anywhere a customer record needs to populate section 1.
  function applyCustomerToForm(c){
    $('custName').value = c.name;
    $('custAddress').value = c.address||'';
    $('contactNo').value = c.contactNo||'';
    $('contactPerson').value = c.contactPerson||'';
    $('custEmail').value = c.email||'';
    // Switching customers means switching equipment context — clear the old
    // customer's equipment values so nothing from a different site lingers,
    // then load this customer's own equipment list for the picker.
    EQUIP_FIELD_KEYS.forEach(k=>{ const el=$(k); if(el) el.value=''; });
    loadCustomerEquipment(c.id).then(defaultEquipTabForCustomer);
    revealSectionsAfterCustomer();
  }
  function attachCustomerCombo(input){
    if(input.dataset.comboAttached) return;
    input.dataset.comboAttached = '1';
    const wrap = document.createElement('div');
    wrap.className = 'combo-wrap';
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);
    input.classList.add('combo-input');
    const caret = document.createElement('button');
    caret.type='button'; caret.className='combo-caret'; caret.innerHTML='&#9662;';
    wrap.appendChild(caret);
    const panel = document.createElement('div');
    panel.className = 'combo-panel';
    wrap.appendChild(panel);

    function fillFromCustomer(c){
      applyCustomerToForm(c);
      panel.classList.remove('open');
      input.dispatchEvent(new Event('change'));
    }
    // Selecting from the dropdown calls this directly (fillFromCustomer, above).
    // Typing a brand-new customer name that isn't in the list should reveal
    // the rest of the form too, once the technician moves on from the field —
    // otherwise a new customer would have no way to get past step 1.
    input.addEventListener('blur', ()=>{
      if(input.value.trim()) revealSectionsAfterCustomer();
    });
    function render(filterText){
      const q = (filterText||'').toLowerCase();
      const filtered = customersCache.filter(c=> c.name.toLowerCase().includes(q));
      panel.innerHTML = '';
      if(filtered.length===0){
        const empty = document.createElement('div');
        empty.className = 'combo-empty';
        empty.textContent = customersCache.length===0 ? 'No saved customers yet — fill in details and save a report to add one' : 'No matches — new customer? Just fill in the fields below';
        panel.appendChild(empty);
      }
      filtered.slice(0,25).forEach(c=>{
        const row = document.createElement('div');
        row.className = 'combo-item';
        const span = document.createElement('span');
        span.textContent = c.name + (c.address ? '  —  '+c.address : '');
        row.appendChild(span);
        row.addEventListener('mousedown', (e)=> e.preventDefault());
        row.addEventListener('click', ()=> fillFromCustomer(c));
        panel.appendChild(row);
      });
    }
    function open(){
      closeAllCombos(panel);
      render(input.value);
      panel.classList.add('open');
      panel.style.top=''; panel.style.bottom='';
      const rect = wrap.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      const spaceAbove = rect.top;
      if(spaceBelow < 200 && spaceAbove > spaceBelow){
        panel.style.top='auto'; panel.style.bottom='calc(100% + 4px)';
      }
      setTimeout(()=>{ panel.scrollIntoView({block:'nearest', behavior:'smooth'}); }, 30);
    }
    input.addEventListener('focus', open);
    input.addEventListener('input', ()=> render(input.value));
    caret.addEventListener('click', (e)=>{
      e.preventDefault();
      if(panel.classList.contains('open')){ panel.classList.remove('open'); } else { open(); input.focus(); }
    });
  }

  const DEFAULT_LISTS = {
    troubleCall: [
      'No cooling', 'Weak airflow', 'Water leaking from unit', 'Unit not turning on',
      'Noisy operation', 'Foul odor from unit', 'Preventive maintenance / cleaning',
      'Unit cycling on and off frequently', 'Remote control not responding', 'Ice buildup on coil'
    ],
    findings: [
      'Dirty/clogged air filter', 'Low refrigerant charge / possible leak', 'Dirty condenser coil',
      'Dirty evaporator coil', 'Clogged condensate drain line', 'Faulty capacitor', 'Faulty compressor',
      'Damaged/worn fan motor', 'Loose or damaged electrical wiring', 'Frozen evaporator coil',
      'Thermostat/sensor malfunction', 'Normal wear from lack of maintenance'
    ],
    recs: [
      'Clean or replace air filter', 'Recharge refrigerant to proper level', 'Clean condenser coil',
      'Clean evaporator coil', 'Clear condensate drain line', 'Replace capacitor', 'Replace/repair compressor',
      'Replace fan motor', 'Repair/secure electrical wiring', 'Schedule regular preventive maintenance (every 3–6 months)',
      'Monitor unit performance after repair'
    ],
    servicesDone: [
      'General cleaning (air filter, evaporator coil, condenser coil)',
      'Recharged refrigerant to proper level',
      'Flushed and cleared condensate drain line',
      'Replaced capacitor',
      'Replaced air filter',
      'Checked and tightened electrical connections',
      'Checked and adjusted refrigerant pressure',
      'Repaired refrigerant leak',
      'Replaced fan motor',
      'Performed full preventive maintenance service',
      'Tested unit operation after service — normal cooling confirmed'
    ],
    coolCap: [
      '0.5 HP (5,000 BTU/hr)', '0.75 HP (7,500 BTU/hr)', '1.0 HP (9,000 BTU/hr)',
      '1.5 HP (12,000 BTU/hr)', '2.0 HP (18,000 BTU/hr)', '2.5 HP (21,000 BTU/hr)',
      '3.0 HP (24,000 BTU/hr)', '4.0 HP (36,000 BTU/hr / 3 TR)', '5.0 HP (48,000 BTU/hr / 4 TR)',
      '6.0 HP (56,000 BTU/hr / 5 TR)', '7.5 HP (72,000 BTU/hr / 6 TR)', '10 HP (96,000 BTU/hr / 8 TR)',
      '15 HP (12 TR)', '20 HP (16 TR)', '25 HP (20 TR)', '30 HP (25 TR)'
    ],
    mountType: [
      'Wall Mounted', 'Ceiling Mounted (Cassette)', 'Ceiling Concealed (Ducted)',
      'Floor Standing', 'Window Type', 'Portable', 'Rooftop Package Unit', 'Ceiling Suspended'
    ],
    brand: [
      'Daikin', 'Carrier', 'Panasonic', 'LG', 'Samsung', 'Hitachi', 'Mitsubishi Electric',
      'Mitsubishi Heavy Industries', 'Fujitsu General', 'York', 'Trane', 'McQuay', 'Kolin',
      'Condura', 'Koppel', 'Century', 'TCL', 'Midea', 'Gree', 'Sharp'
    ],
    refrigerantType: [
      'R22', 'R410A', 'R32', 'R404A', 'R134A', 'R407C', 'R290'
    ],
    compressorType: [
      'Inverter', 'Non-Inverter'
    ],
    bracketType: [
      'L-Type Bracket', 'Floor Mounted Type'
    ],
    transportMode: [
      'Jeepney', 'Tricycle', 'Bus', 'Taxi', 'Grab/Ride-hailing', 'Motorcycle', 'Company Vehicle', 'Own Vehicle', 'Van Rental', 'Other'
    ],
    equipType: [
      'Split Type Unit', 'Window Type', 'Chilled Water', 'Water-Cooled Type', 'Refrigerator', 'Freezer/Chiller'
    ]
  };
  async function seedDefaultLists(){
    let changed = false;
    Object.keys(DEFAULT_LISTS).forEach(key=>{
      if(!(key in fieldLists)){ fieldLists[key] = DEFAULT_LISTS[key].slice(); changed = true; }
    });
    if(changed) await saveFieldLists();
  }

  function closeAllCombos(except){
    document.querySelectorAll('.combo-panel.open').forEach(p=>{ if(p!==except) p.classList.remove('open'); });
  }

  function attachCombo(input, keyOverride){
    if(input.dataset.comboAttached) return;
    input.dataset.comboAttached = '1';
    const key = keyOverride || input.id;
    if(!key) return;
    const wrap = document.createElement('div');
    wrap.className = 'combo-wrap';
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);
    input.classList.add('combo-input');
    const caret = document.createElement('button');
    caret.type = 'button'; caret.className = 'combo-caret'; caret.innerHTML = '&#9662;';
    wrap.appendChild(caret);
    const panel = document.createElement('div');
    panel.className = 'combo-panel';
    wrap.appendChild(panel);

    // One delegated handler replaces dozens of per-option listeners created every
    // time the suggestion list is rendered. This is both lighter and easier to maintain.
    panel.addEventListener('mousedown', e=>{
      if(e.target.closest('.combo-item')) e.preventDefault();
    });
    panel.addEventListener('click', async e=>{
      const del = e.target.closest('.combo-del');
      if(del){
        e.stopPropagation();
        const row = del.closest('.combo-item');
        const opt = row && row.dataset.value;
        const idx = ensureList(key).indexOf(opt);
        if(idx>-1){ ensureList(key).splice(idx,1); await saveFieldLists(); render(input.value); }
        return;
      }
      const add = e.target.closest('.combo-additem');
      if(add){
        const value = add.dataset.value || '';
        if(value){ ensureList(key).push(value); await saveFieldLists(); render(value); }
        return;
      }
      const row = e.target.closest('.combo-item');
      if(row && !row.classList.contains('combo-additem')){
        input.value = row.dataset.value || '';
        panel.classList.remove('open');
        input.dispatchEvent(new Event('change'));
      }
    });

    function render(filterText){
      const list = ensureList(key);
      const q = (filterText||'').toLowerCase();
      const filtered = list.filter(o=>o.toLowerCase().includes(q));
      panel.innerHTML = '';
      if(filtered.length===0){
        const empty = document.createElement('div');
        empty.className = 'combo-empty';
        empty.textContent = list.length===0
          ? (USER_ADDABLE_LIST_KEYS.has(key) ? 'No suggestions yet — start typing to add one' : 'No suggestions yet — set up via Admin')
          : 'No matches';
        panel.appendChild(empty);
      }
      filtered.forEach(opt=>{
        const row = document.createElement('div');
        row.className = 'combo-item';
        row.dataset.value = opt;
        const span = document.createElement('span'); span.textContent = opt;
        row.appendChild(span);
        if(adminMode){
          const del = document.createElement('button');
          del.type='button'; del.className='combo-del'; del.textContent='\u2715';
          row.appendChild(del);
        }
        panel.appendChild(row);
      });
      if((adminMode || USER_ADDABLE_LIST_KEYS.has(key)) && filterText && filterText.trim() && !list.includes(filterText.trim())){
        const addRow = document.createElement('div');
        addRow.className = 'combo-item combo-additem';
        addRow.dataset.value = filterText.trim();
        addRow.textContent = '+ Add "'+filterText.trim()+'" to list';
        panel.appendChild(addRow);
      }
    }
    function open(){
      closeAllCombos(panel);
      render(input.value);
      panel.classList.add('open');
      panel.style.top = ''; panel.style.bottom = '';
      const rect = wrap.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      const spaceAbove = rect.top;
      if(spaceBelow < 200 && spaceAbove > spaceBelow){
        panel.style.top = 'auto';
        panel.style.bottom = 'calc(100% + 4px)';
      }
      setTimeout(()=>{ panel.scrollIntoView({block:'nearest', behavior:'smooth'}); }, 30);
    }
    input.addEventListener('focus', open);
    input.addEventListener('input', ()=> render(input.value));
    caret.addEventListener('click', e=>{
      e.preventDefault();
      if(panel.classList.contains('open')) panel.classList.remove('open');
      else { open(); input.focus(); }
    });
  }
  document.addEventListener('click', (e)=>{
    if(!e.target.closest('.combo-wrap')) closeAllCombos(null);
  });
  function attachAllCombos(){
    document.querySelectorAll('input[type=text]').forEach(el=>{
      if(el.id==='custName') return;
      attachCombo(el);
    });
    attachCombo($('troubleCall'), 'troubleCall');
    attachCustomerCombo($('custName'));
    if(!$('equipTabExisting').dataset.hooked){
      $('equipTabExisting').dataset.hooked = '1';
      $('equipTabExisting').addEventListener('click', ()=> setEquipTab('existing'));
      $('equipTabAddNew').addEventListener('click', ()=> setEquipTab('addnew'));
      setEquipTab(null);
    }
    document.querySelectorAll('.collapsible-head').forEach(head=>{
      if(head.dataset.hooked) return;
      head.dataset.hooked = '1';
      head.addEventListener('click', ()=> toggleCollapsibleSection(head));
    });
  }
  // Sections 3–8 (Report Summary through Acknowledgment) show only their
  // title until tapped — tapping the header expands/collapses its body.
  function toggleCollapsibleSection(head, forceOpen){
    const body = head.nextElementSibling;
    if(!body) return;
    const isOpen = forceOpen!==undefined ? forceOpen : body.style.display==='none';
    body.style.display = isOpen ? '' : 'none';
    head.classList.toggle('open', isOpen);
  }
  function collapseAllSections(){
    document.querySelectorAll('.collapsible-head').forEach(head=> toggleCollapsibleSection(head, false));
  }
  function expandAllSections(){
    document.querySelectorAll('.collapsible-head').forEach(head=> toggleCollapsibleSection(head, true));
  }

  function fieldsInGroup(group){
    return Object.keys(FIELD_META).filter(k=>FIELD_META[k].group===group);
  }
  function renderManageLists(){
    const body = $('adminListsBody');
    body.innerHTML = '';
    GROUP_ORDER.forEach(group=>{
      const keys = fieldsInGroup(group);
      if(keys.length===0) return;
      const gDiv = document.createElement('div');
      gDiv.className = 'admin-group';
      const h4 = document.createElement('h4'); h4.textContent = group;
      gDiv.appendChild(h4);
      keys.forEach(key=>{
        const list = ensureList(key);
        const fDiv = document.createElement('div');
        fDiv.className = 'admin-field';
        const lbl = document.createElement('label'); lbl.textContent = FIELD_META[key].label;
        fDiv.appendChild(lbl);
        const chips = document.createElement('div'); chips.className='chips';
        if(list.length===0){
          const em = document.createElement('span'); em.className='chip-empty'; em.textContent='No items yet';
          chips.appendChild(em);
        }
        list.forEach(item=>{
          const chip = document.createElement('div'); chip.className='chip';
          const txt = document.createElement('span'); txt.textContent = item;
          const edit = document.createElement('button'); edit.type='button'; edit.textContent='\u270E';
          edit.title = 'Rename';
          edit.addEventListener('click', async ()=>{
            const idx = list.indexOf(item);
            if(idx===-1) return;
            const next = prompt('Rename "'+item+'" to:', item);
            if(next===null) return;
            const trimmed = next.trim();
            if(!trimmed) return;
            list[idx] = trimmed;
            await saveFieldLists();
            renderManageLists();
          });
          const rm = document.createElement('button'); rm.type='button'; rm.textContent='\u2715';
          rm.title = 'Remove';
          rm.addEventListener('click', async ()=>{
            const idx = list.indexOf(item);
            if(idx>-1){ list.splice(idx,1); await saveFieldLists(); renderManageLists(); }
          });
          chip.appendChild(txt); chip.appendChild(edit); chip.appendChild(rm);
          chips.appendChild(chip);
        });
        fDiv.appendChild(chips);
        const addRow = document.createElement('div'); addRow.className='admin-add-row';
        const inp = document.createElement('input'); inp.type='text'; inp.placeholder='Add new value…';
        const btn = document.createElement('button'); btn.type='button'; btn.textContent='Add';
        async function doAdd(){
          const v = inp.value.trim();
          if(!v) return;
          if(!list.includes(v)) list.push(v);
          inp.value='';
          await saveFieldLists();
          renderManageLists();
        }
        btn.addEventListener('click', doAdd);
        inp.addEventListener('keydown', (e)=>{ if(e.key==='Enter'){ e.preventDefault(); doAdd(); } });
        addRow.appendChild(inp); addRow.appendChild(btn);
        fDiv.appendChild(addRow);
        gDiv.appendChild(fDiv);
      });
      body.appendChild(gDiv);
    });
  }

  $('adminBtn').addEventListener('click', async ()=>{
    if(!adminMode){
      const pin = prompt('Enter Admin Password to manage dropdown lists:');
      if(pin===null) return;
      if(!(await verifyAdminPassword(pin))){ toast('Incorrect password'); return; }
      enterAdminMode();
      toast('Admin mode on — dropdowns are now editable');
    }
    renderManageLists();
    $('adminOverlay').classList.add('open');
  });
  $('closeAdmin').addEventListener('click', ()=> $('adminOverlay').classList.remove('open'));
  $('adminOverlay').addEventListener('click', (e)=>{ if(e.target.id==='adminOverlay') $('adminOverlay').classList.remove('open'); });


// ---------- Manage Users ----------
  function restrictionLabel(r){
    r = r || {};
    const flags = [];
    if(r.noHistory) flags.push('No history');
    if(r.noReport) flags.push('No report generation');
    if(r.readOnly) flags.push('Read-only');
    return flags.length ? flags.join(' · ') : 'No restrictions';
  }

  async function renderUsersList(){
    const body = $('usersList');
    body.innerHTML = '<div class="empty-state">Loading…</div>';
    const cloudOn = await ensureCloud();
    const users = (await cloudListUsers()) || [];
    body.innerHTML = '';
    if(!cloudOn){
      const note = document.createElement('div');
      note.style.cssText = 'font-size:12px; color:var(--amber); margin-bottom:10px;';
      note.textContent = 'Not connected to Shared Cloud — user accounts are saved on this device only.';
      body.appendChild(note);
    }
    if(users.length===0){
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = 'No users added yet.';
      body.appendChild(empty);
      return;
    }
    users.sort((a,b)=> (a.name||'').localeCompare(b.name||'')).forEach(u=>{
      const r = u.restrictions || {};
      const active = u.active!==false;
      const card = document.createElement('div');
      card.className = 'user-card' + (active ? '' : ' inactive');
      card.innerHTML =
        '<div class="user-card-head">'+
          '<div>'+
            '<div class="u-name">'+escapeHtml(u.name)+'</div>'+
            '<div class="u-status '+(active?'':'deact')+'">'+
              (active ? 'Active' : 'Deactivated')+' · '+escapeHtml(restrictionLabel(r))+
            '</div>'+
          '</div>'+
        '</div>'+
        '<div class="user-card-actions">'+
          '<button data-act="edit" class="primary">Edit</button>'+
          '<button data-act="toggle">'+(active ? 'Restrict (Deactivate)' : 'Reactivate')+'</button>'+
          '<button data-act="resetDevice">Reset DTR Device</button>'+
          '<button data-act="remove" class="danger">Remove</button>'+
        '</div>'+
        '<div class="user-edit-panel" data-panel="1">'+
          '<div class="field"><label>Full Name</label><input type="text" data-f="name" value="'+escapeHtml(u.name)+'"></div>'+
          '<div class="field"><label>New Password (leave blank to keep current)</label><input type="password" data-f="pw1" placeholder="Set a new password"></div>'+
          '<div class="field"><label>Confirm New Password</label><input type="password" data-f="pw2" placeholder="Re-enter the new password"></div>'+
          '<div class="restrict-group">'+
            '<h5>Restrictions</h5>'+
            '<label class="restrict-row"><input type="checkbox" data-f="noHistory" '+(r.noHistory?'checked':'')+'>'+
              '<span class="rtxt"><span class="rt-title">Block History access</span><span class="rt-desc">User cannot open the History sheet or view past reports.</span></span></label>'+
            '<label class="restrict-row"><input type="checkbox" data-f="noReport" '+(r.noReport?'checked':'')+'>'+
              '<span class="rtxt"><span class="rt-title">Block report generation</span><span class="rt-desc">User cannot preview, generate, or share PDF reports.</span></span></label>'+
            '<label class="restrict-row"><input type="checkbox" data-f="readOnly" '+(r.readOnly?'checked':'')+'>'+
              '<span class="rtxt"><span class="rt-title">Read-only</span><span class="rt-desc">User cannot save drafts, start new reports, or generate reports.</span></span></label>'+
          '</div>'+
          '<div class="edit-save-row">'+
            '<button class="cancel-btn" data-act="cancel" type="button">Cancel</button>'+
            '<button class="save-btn" data-act="save" type="button">Save Changes</button>'+
          '</div>'+
        '</div>';

      const panel = card.querySelector('[data-panel="1"]');
      card.querySelector('[data-act="edit"]').addEventListener('click', ()=>{
        // close any other open panels
        body.querySelectorAll('.user-edit-panel.open').forEach(p=>{ if(p!==panel) p.classList.remove('open'); });
        panel.classList.toggle('open');
      });
      card.querySelector('[data-act="cancel"]').addEventListener('click', ()=>{
        panel.classList.remove('open');
        // reset fields
        panel.querySelector('[data-f="name"]').value = u.name;
        panel.querySelector('[data-f="pw1"]').value = '';
        panel.querySelector('[data-f="pw2"]').value = '';
        panel.querySelector('[data-f="noHistory"]').checked = !!r.noHistory;
        panel.querySelector('[data-f="noReport"]').checked = !!r.noReport;
        panel.querySelector('[data-f="readOnly"]').checked = !!r.readOnly;
      });
      card.querySelector('[data-act="save"]').addEventListener('click', async ()=>{
        const newName = panel.querySelector('[data-f="name"]').value.trim();
        const pw1 = panel.querySelector('[data-f="pw1"]').value;
        const pw2 = panel.querySelector('[data-f="pw2"]').value;
        if(!newName){ toast('Name cannot be empty'); return; }
        if(pw1 || pw2){
          if(pw1.length < 4){ toast('Password must be at least 4 characters'); return; }
          if(pw1 !== pw2){ toast('Passwords do not match'); return; }
        }
        const restrictions = {
          noHistory: panel.querySelector('[data-f="noHistory"]').checked,
          noReport: panel.querySelector('[data-f="noReport"]').checked,
          readOnly: panel.querySelector('[data-f="readOnly"]').checked
        };
        const ok1 = await cloudSetUser(u.id, { name: newName, restrictions });
        let ok2 = true;
        if(pw1){
          const { data, error } = await db.functions.invoke('admin-create-technician', {
            body: { action:'reset_password', technicianId: u.id, password: pw1 }
          });
          ok2 = !error && !(data && data.error);
        }
        if(ok1 && ok2){
          toast('Saved changes for '+newName);
          renderUsersList();
        }else toast('Could not save all changes');
      });
      card.querySelector('[data-act="toggle"]').addEventListener('click', async ()=>{
        const ok = await cloudSetUser(u.id, {active: active ? false : true});
        if(ok){ toast(active ? 'Restricted '+u.name+' (access revoked)' : 'Reactivated '+u.name); renderUsersList(); }
        else toast('Could not update');
      });
      card.querySelector('[data-act="resetDevice"]').addEventListener('click', async ()=>{
        if(!confirm('Unlock '+u.name+"'s DTR from their current device? Use this if they lost or replaced their phone — the next device they time in from will become the new locked device.")) return;
        const ok = await clearDeviceLock(u.id);
        toast(ok ? "Device lock cleared for "+u.name : 'Could not clear device lock');
      });
      card.querySelector('[data-act="remove"]').addEventListener('click', async ()=>{
        if(!confirm('Remove '+u.name+' completely? Their past reports stay saved, but they will no longer appear anywhere.')) return;
        const ok = await cloudDeleteUser(u.id);
        if(ok){ toast('Removed '+u.name); renderUsersList(); }
        else toast('Could not remove');
      });
      body.appendChild(card);
    });
  }
  $('closeUsers').addEventListener('click', ()=> $('usersOverlay').classList.remove('open'));
  $('usersOverlay').addEventListener('click', (e)=>{ if(e.target.id==='usersOverlay') $('usersOverlay').classList.remove('open'); });

  // ---------- Manage Customers (admin-only) ----------
  async function renderCustomersList(filterText){
    const body = $('customersList');
    body.innerHTML = '<div class="empty-state">Loading…</div>';
    const cloudOn = await ensureCloud();
    await loadCustomers();
    body.innerHTML = '';
    if(!cloudOn){
      const note = document.createElement('div');
      note.style.cssText = 'font-size:12px; color:var(--amber); margin-bottom:10px;';
      note.textContent = 'Not connected to Shared Cloud — customers are saved on this device only.';
      body.appendChild(note);
    }
    const q = (filterText||'').toLowerCase();
    const list = customersCache.filter(c=> c.name.toLowerCase().includes(q)).sort((a,b)=> a.name.localeCompare(b.name));
    if(list.length===0){
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = customersCache.length===0 ? 'No customers added yet.' : 'No matches.';
      body.appendChild(empty);
      return;
    }
    list.forEach(c=>{
      const card = document.createElement('div');
      card.className = 'user-card';
      card.innerHTML =
        '<div class="user-card-head"><div>'+
          '<div class="u-name">'+escapeHtml(c.name)+'</div>'+
          '<div class="u-status">'+escapeHtml(c.address||'No address on file')+'</div>'+
        '</div></div>'+
        '<div class="user-card-actions">'+
          '<button data-act="edit" class="primary">Edit</button>'+
          '<button data-act="remove" class="danger">Remove</button>'+
        '</div>';
      card.querySelector('[data-act="edit"]').addEventListener('click', ()=> startEditCustomer(c));
      card.querySelector('[data-act="remove"]').addEventListener('click', async ()=>{
        if(!confirm('Remove '+c.name+' from the customer list? This does not affect past reports.')) return;
        const ok = await cloudDeleteCustomer(c.id);
        if(ok){ toast('Removed '+c.name); renderCustomersList($('customerSearch').value); }
        else toast('Could not remove');
      });
      body.appendChild(card);
    });
  }
  function startEditCustomer(c){
    $('editCustomerId').value = c.id;
    $('customerFormTitle').textContent = 'Edit customer';
    $('newCustName').value = c.name;
    $('newCustAddress').value = c.address||'';
    $('newCustContactNo').value = c.contactNo||'';
    $('newCustContactPerson').value = c.contactPerson||'';
    $('newCustEmail').value = c.email||'';
    $('cancelEditCustomerBtn').style.display = '';
    $('customerEquipmentSection').style.display = '';
    renderCustomerEquipmentList(c.id);
    $('customersOverlay').querySelector('.sheet').scrollTop = $('customersOverlay').querySelector('.sheet').scrollHeight;
  }
  async function renderCustomerEquipmentList(customerId){
    const body = $('customerEquipmentList');
    body.innerHTML = '<div class="empty-state">Loading…</div>';
    await loadCustomerEquipment(customerId);
    body.innerHTML = '';
    if(currentEquipmentCache.length===0){
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = 'No equipment recorded yet for this customer.';
      body.appendChild(empty);
      return;
    }
    currentEquipmentCache.forEach(e=>{
      const card = document.createElement('div');
      card.className = 'user-card';
      const summary = [e.equipType, e.brand, e.coolCap, e.equipLocation].filter(Boolean).join(' · ') || '(no details)';
      const serials = [e.serialCU && ('CU: '+e.serialCU), e.serialFCU && ('FCU: '+e.serialFCU)].filter(Boolean).join('  ');
      card.innerHTML =
        '<div class="user-card-head"><div>'+
          '<div class="u-name">'+escapeHtml(summary)+'</div>'+
          '<div class="u-status">'+escapeHtml(serials||'No serials on file')+'</div>'+
        '</div></div>'+
        '<div class="user-card-actions">'+
          '<button data-act="remove" class="danger">Remove</button>'+
        '</div>';
      card.querySelector('[data-act="remove"]').addEventListener('click', async ()=>{
        if(!confirm('Remove this equipment record? This does not affect past reports.')) return;
        const ok = await cloudDeleteCustomerEquipment(e.id);
        if(ok){ toast('Removed'); renderCustomerEquipmentList(customerId); }
        else toast('Could not remove');
      });
      body.appendChild(card);
    });
  }
  function resetCustomerForm(){
    $('editCustomerId').value = '';
    $('customerFormTitle').textContent = 'Add a customer';
    $('newCustName').value=''; $('newCustAddress').value=''; $('newCustContactNo').value='';
    $('newCustContactPerson').value=''; $('newCustEmail').value='';
    $('cancelEditCustomerBtn').style.display = 'none';
    $('customerEquipmentSection').style.display = 'none';
  }
  $('cancelEditCustomerBtn').addEventListener('click', resetCustomerForm);
  $('saveCustomerBtn').addEventListener('click', async ()=>{
    const name = $('newCustName').value.trim();
    if(!name){ toast('Enter a customer name'); return; }
    if(!(await ensureCloud())){ toast('Not connected to the cloud'); return; }
    const editingId = $('editCustomerId').value;
    const payload = {
      name, address: $('newCustAddress').value.trim(), contactNo: $('newCustContactNo').value.trim(),
      contactPerson: $('newCustContactPerson').value.trim(), email: $('newCustEmail').value.trim()
    };
    $('saveCustomerBtn').disabled = true;
    try{
      if(editingId){
        const { error } = await db.from('customers').update({
          name: payload.name, address: payload.address, contact_no: payload.contactNo,
          contact_person: payload.contactPerson, email: payload.email, updated_at: new Date().toISOString()
        }).eq('id', editingId);
        if(error){ toast('Could not save: '+error.message); return; }
      }else{
        await cloudUpsertCustomer(payload);
      }
      await loadCustomers();
      resetCustomerForm();
      toast('Saved '+name);
      renderCustomersList($('customerSearch').value);
    } finally { $('saveCustomerBtn').disabled = false; }
  });
  $('customerSearch').addEventListener('input', ()=> renderCustomersList($('customerSearch').value));
  $('closeCustomers').addEventListener('click', ()=> $('customersOverlay').classList.remove('open'));
  $('customersOverlay').addEventListener('click', (e)=>{ if(e.target.id==='customersOverlay') $('customersOverlay').classList.remove('open'); });
  $('menuManageCustomers').addEventListener('click', async ()=>{
    closeMainMenu();
    if(!(await ensureAdminAuthenticated())) return;
    resetCustomerForm();
    $('customersOverlay').classList.add('open');
    renderCustomersList('');
  });

  $('addUserBtn').addEventListener('click', async ()=>{
    const name = $('newUserName').value.trim();
    const pin = $('newUserPin').value;
    const pin2 = $('newUserPin2').value;
    if(!name){ toast('Enter a name'); return; }
    if(!pin || pin.length < 4){ toast('Password must be at least 4 characters'); return; }
    if(pin !== pin2){ toast('Passwords do not match'); return; }
    if(!(await ensureCloud())){ toast('Not connected to the cloud'); return; }
    $('addUserBtn').disabled = true;
    try{
      // Real account creation happens server-side (Edge Function) so it can't
      // hijack the admin's own browser session — see admin-create-technician.
      const { data, error } = await db.functions.invoke('admin-create-technician', {
        body: { name, password: pin }
      });
      if(error || (data && data.error)){
        toast((data && data.error) || 'Could not add user');
      }else{
        $('newUserName').value=''; $('newUserPin').value=''; $('newUserPin2').value='';
        toast('Added '+name);
        renderUsersList();
      }
    }finally{ $('addUserBtn').disabled = false; }
  });

  async function doChangeAdminPin(){
    const cur = prompt('Enter current Admin Password:');
    if(cur===null) return;
    if(!(await verifyAdminPassword(cur))){ toast('Incorrect password'); return; }
    const next = prompt('Enter new Admin Password:');
    if(!next || next.length < 4){ toast('Password must be at least 4 characters'); return; }
    const { error } = await db.auth.updateUser({ password: next });
    if(error){ toast('Could not update password: '+error.message); return; }
    toast('Password updated');
  }


// ---------- EmailJS settings ----------
  let emailCfg = {publicKey:'', serviceId:'', templateId:'', officeEmail:''};
  async function loadEmailCfg(){
    if(await ensureCloud()){
      const doc = await cloudGetDoc('settings/emailjs');
      if(doc){ emailCfg = doc; if(emailCfg.publicKey && window.emailjs){ try{ emailjs.init({publicKey: emailCfg.publicKey}); }catch(e){} } return; }
    }
    try{
      const res = await window.storage.get('settings:emailjs', false);
      if(res) emailCfg = JSON.parse(res.value);
    }catch(e){ /* not set yet */ }
    if(emailCfg.publicKey && window.emailjs){ try{ emailjs.init({publicKey: emailCfg.publicKey}); }catch(e){} }
  }
  loadEmailCfg();

  $('settingsBtn').addEventListener('click', ()=>{
    $('cfgPublicKey').value = emailCfg.publicKey||'';
    $('cfgServiceId').value = emailCfg.serviceId||'';
    $('cfgTemplateId').value = emailCfg.templateId||'';
    $('cfgOfficeEmail').value = emailCfg.officeEmail||'';
    $('settingsOverlay').classList.add('open');
  });
  $('closeSettings').addEventListener('click', ()=> $('settingsOverlay').classList.remove('open'));
  $('settingsOverlay').addEventListener('click', (e)=>{ if(e.target.id==='settingsOverlay') $('settingsOverlay').classList.remove('open'); });
  $('settingsHelpBtn').addEventListener('click', ()=>{
    toast('Ask your Claude chat for the step-by-step EmailJS setup guide');
  });
  $('saveSettingsBtn').addEventListener('click', async ()=>{
    emailCfg = {
      publicKey: $('cfgPublicKey').value.trim(),
      serviceId: $('cfgServiceId').value.trim(),
      templateId: $('cfgTemplateId').value.trim(),
      officeEmail: $('cfgOfficeEmail').value.trim()
    };
    if(emailCfg.publicKey && window.emailjs){ try{ emailjs.init({publicKey: emailCfg.publicKey}); }catch(e){} }
    if(await ensureCloud()){
      const ok = await cloudSetDoc('settings/emailjs', emailCfg);
      if(ok){ toast('Email settings saved for all devices'); $('settingsOverlay').classList.remove('open'); return; }
    }
    try{
      await window.storage.set('settings:emailjs', JSON.stringify(emailCfg), false);
      toast('Email settings saved on this device');
      $('settingsOverlay').classList.remove('open');
    }catch(e){ toast('Could not save settings'); }
  });
  function emailConfigured(){
    return !!(emailCfg.publicKey && emailCfg.serviceId && emailCfg.templateId && (emailCfg.officeEmail));
  }

  // downscale a signature dataURL so PDFs/email attachments stay small
  function downscaleDataUrl(dataUrl, maxWidth){
    return new Promise((resolve)=>{
      const img = new Image();
      img.onload = ()=>{
        const scale = Math.min(1, maxWidth / img.width);
        const c = document.createElement('canvas');
        c.width = img.width*scale; c.height = img.height*scale;
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL('image/png'));
      };
      img.onerror = ()=> resolve(dataUrl);
      img.src = dataUrl;
    });
  }

  // send the generated PDF via EmailJS as a dynamic attachment
  async function sendEmailWithPdf(doc, data, filename){
    await loadAwesScript('emailjs', awesLibs.emailjs);
    if(!emailConfigured()) return {ok:false, reason:'not_configured'};
    try{ emailjs.init({publicKey: emailCfg.publicKey}); }catch(e){}
    const base64 = doc.output('datauristring').split(',')[1];
    // rough size check — most free/personal EmailJS plans cap attachments around 500KB
    const approxBytes = base64.length * 0.75;
    if(approxBytes > 480000){
      return {ok:false, reason:'too_large'};
    }
    const toEmail = (data.custEmail || '').trim();
    const recipients = toEmail ? (toEmail+','+emailCfg.officeEmail) : emailCfg.officeEmail;
    const templateParams = {
      to_email: recipients,
      sr_no: data.srNo || '',
      customer_name: data.custName || '',
      service_date: data.date || '',
      pdf_attachment: base64,
      pdf_filename: filename
    };
    try{
      await emailjs.send(emailCfg.serviceId, emailCfg.templateId, templateParams);
      return {ok:true};
    }catch(err){
      console.error('EmailJS error', err);
      return {ok:false, reason:'send_failed'};
    }
  }


// ---------- meta bar live update ----------
  $('svcDate').addEventListener('change', ()=> $('metaDate').textContent = fmtDate($('svcDate').value));

  // ---------- init defaults ----------
  function resetForm(){
    document.querySelectorAll('input[type=text], input[type=number], textarea').forEach(el=>el.value='');
    document.querySelectorAll('input[type=checkbox]').forEach(el=>{ el.checked=false; el.closest('.chk')?.classList.remove('checked'); });
    $('svcDate').value = todayISO();
    $('timeIn').value=''; $('timeOut').value='';
    $('findingsList').innerHTML=''; $('recsList').innerHTML=''; $('servicesDoneList').innerHTML='';
    addListRow('findingsList'); addListRow('recsList'); addListRow('servicesDoneList');
    $('materialsBody').innerHTML=''; materialRowCount=0;
    $('isInstallToggle').checked=false; $('installSection').classList.remove('open');
    loadCustomerEquipment(null);
    setEquipTab(null);
    $('custDetailsWrap').style.display = 'none';
    ['sec2Card','sec3Card','sec4Card','sec5Card','sec6Card','sec7Card','sec8Card'].forEach(id=>{
      const el = $(id); if(el) el.style.display = 'none';
    });
    $('materialsTableWrap').style.display = 'none';
    collapseAllSections();
    toggleCollapsibleSection($('sec1Head'), true); // keep section 1 (Customer's Info) open — it's the entry point
    if($('srJobOrderHead')) toggleCollapsibleSection($('srJobOrderHead'), true); // keep the Job Order picker open too
    if(sigCustomerPad) sigCustomerPad.clear();
    if(sigTechPad) sigTechPad.clear();
    $('sigCustomerPh').style.display='flex'; $('sigTechPh').style.display='flex';
    $('metaDate').textContent = fmtDate($('svcDate').value);
    $('statusPill').textContent='Draft'; $('statusPill').className='status-pill status-draft';
    currentSrNo = null;
    $('metaSrNo').textContent='—';
    clearInvalid();
    applyTechNameDefault();
  }
  resetForm();
  // Auto-fills the Technician Name field from the logged-in account (still
  // editable, in case a different technician actually performed the work).
  function applyTechNameDefault(){
    if(currentUser && currentUser.name) $('techName').value = currentUser.name;
  }

  // ---------- validation ----------
  function clearInvalid(){
    document.querySelectorAll('.field.invalid').forEach(f=>f.classList.remove('invalid'));
  }
  function validate(){
    clearInvalid();
    let ok = true;
    if(!$('custName').value.trim()){ $('f_custName').classList.add('invalid'); ok=false; }
    if(!$('svcDate').value){ $('f_date').classList.add('invalid'); ok=false; }
    const email = $('custEmail').value.trim();
    if(!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){ $('f_custEmail').classList.add('invalid'); ok=false; }
    return ok;
  }

  // ---------- gather form data ----------
  function gatherData(){
    const findings = Array.from($('findingsList').querySelectorAll('textarea')).map(t=>t.value.trim()).filter(Boolean);
    const recs = Array.from($('recsList').querySelectorAll('textarea')).map(t=>t.value.trim()).filter(Boolean);
    const servicesDone = Array.from($('servicesDoneList').querySelectorAll('textarea')).map(t=>t.value.trim()).filter(Boolean);
    const materials = Array.from($('materialsBody').querySelectorAll('tr')).map(tr=>({
      details: tr.querySelector('.m-details').value.trim(),
      qty: tr.querySelector('.m-qty').value.trim()
    })).filter(r=>r.details||r.qty);

    return {
      srNo: currentSrNo,
      date: $('svcDate').value,
      custName: $('custName').value.trim(),
      custAddress: $('custAddress').value.trim(),
      contactNo: $('contactNo').value.trim(),
      contactPerson: $('contactPerson').value.trim(),
      equipType: $('equipType').value.trim(), modelCU:$('modelCU').value.trim(), serialCU:$('serialCU').value.trim(),
      modelFCU:$('modelFCU').value.trim(), serialFCU:$('serialFCU').value.trim(),
      coolCap:$('coolCap').value.trim(), mountType:$('mountType').value.trim(),
      brand:$('brand').value.trim(), refrigerantType:$('refrigerantType').value.trim(),
      compressorType:$('compressorType').value.trim(), equipLocation:$('equipLocation').value.trim(),
      troubleCall:$('troubleCall').value.trim(), findings, recs, materials, servicesDone,
      before:{
        amp:[$('b_amp_l1').value,$('b_amp_l2').value,$('b_amp_l3').value],
        volt:[$('b_volt_l12').value,$('b_volt_l23').value,$('b_volt_l31').value],
        pressure:[$('b_press_suction').value,$('b_press_discharge').value],
        temp:$('b_temp').value, airflow:$('b_airflow').value
      },
      after:{
        amp:[$('a_amp_l1').value,$('a_amp_l2').value,$('a_amp_l3').value],
        volt:[$('a_volt_l12').value,$('a_volt_l23').value,$('a_volt_l31').value],
        pressure:[$('a_press_suction').value,$('a_press_discharge').value],
        temp:$('a_temp').value, airflow:$('a_airflow').value
      },
      isInstall: $('isInstallToggle').checked,
      install:{
        pd:[$('pd_suction').value,$('pd_discharge').value,$('pd_drain').value],
        pl:[$('pl_refline').value,$('pl_drain').value],
        ws:[$('ws_feeder').value,$('ws_control').value],
        breaker:$('circuit_breaker').value,
        pi:[$('pi_refline').value,$('pi_drain').value],
        riser:$('riser_height').value, ptrap:$('ptrap').value, bracketType:$('bracketType').value
      },
      timeIn:$('timeIn').value, timeOut:$('timeOut').value, remarks:$('remarks').value.trim(),
      custPrintedName:$('custPrintedName').value.trim(), techName:$('techName').value.trim(),
      custEmail: $('custEmail').value.trim(),
      sigCustomerRaw: sigCustomerPad.isEmpty() ? null : sigCustomerPad.toDataURL('image/png'),
      sigTechRaw: sigTechPad.isEmpty() ? null : sigTechPad.toDataURL('image/png')
    };
  }
  async function gatherDataForOutput(){
    await ensureSignaturePads();
    const data = gatherData();
    data.sigCustomer = data.sigCustomerRaw ? await downscaleDataUrl(data.sigCustomerRaw, 400) : null;
    data.sigTech = data.sigTechRaw ? await downscaleDataUrl(data.sigTechRaw, 400) : null;
    return data;
  }

  // ---------- save draft ----------
  async function saveReport(srNo, data){
    let cloudOk = false;
    if(await ensureCloud()) cloudOk = await cloudSaveReport(srNo, data);
    try{ await window.storage.set('report:'+srNo, JSON.stringify(data), false); }catch(e){}
    // Record this equipment against the matching customer, so it shows up
    // in this customer's own equipment dropdowns next time — never mixed
    // in with another customer's equipment.
    const matchedCustomer = customersCache.find(c=> c.name.toLowerCase() === (data.custName||'').trim().toLowerCase());
    if(matchedCustomer) await cloudAddCustomerEquipment(matchedCustomer.id, data);
    return cloudOk;
  }
  $('saveDraftBtn').addEventListener('click', async ()=>{
    if(!$('custName').value.trim()){ toast('Add a customer name before saving'); $('f_custName').classList.add('invalid'); return; }
    if(!currentSrNo){ currentSrNo = await nextSrNo(); $('metaSrNo').textContent = currentSrNo; }
    const data = await gatherDataForOutput();
    const cloudOk = await saveReport(currentSrNo, data);
    toast(cloudOk ? 'Draft saved to shared cloud: '+currentSrNo : 'Draft saved on this device: '+currentSrNo);
    resetForm();
  });


// ---------- build PDF ----------
  const AWES_LOGO_B64 = 'data:image/png;base64,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';

  async function buildPdf(data){
    await loadAwesScript('jspdf', awesLibs.jspdf);
    await loadAwesScript('autotable', awesLibs.autotable);
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF('p','pt','a4');
    const pageW = doc.internal.pageSize.getWidth();
    const margin = 40;
    let y = 44;

    const headerH = 112;
    doc.setFillColor(21,77,52);
    doc.rect(0,0,pageW,headerH,'F');
    try{ doc.addImage(AWES_LOGO_B64,'PNG', margin, 14, 108, 36); }catch(e){}
    doc.setTextColor(255,255,255);
    doc.setFont('helvetica','bold'); doc.setFontSize(13);
    doc.text('SERVICE REPORT', pageW-margin, 28, {align:'right'});
    doc.setFont('helvetica','bold'); doc.setFontSize(10);
    doc.text('SR No: '+(data.srNo||'—'), pageW-margin, 42, {align:'right'});
    doc.setFont('helvetica','normal'); doc.setFontSize(10);
    doc.text('Date: '+(data.date||'—'), pageW-margin, 55, {align:'right'});
    doc.setFont('helvetica','bold'); doc.setFontSize(9);
    doc.text('AW Engineering Services', margin, 64);
    doc.setFont('helvetica','normal'); doc.setFontSize(8);
    doc.text('Air Conditioning & Ventilation System', margin, 75);
    doc.setFontSize(7.5);
    doc.text('3F DJET Commercial Bldg., Imelda Ave., Karangalan Vill., Manggahan, Pasig City', margin, 87);
    doc.text('8441-6497 / 8441-6796   •   awes.manila@gmail.com', margin, 98);
    doc.setTextColor(0,0,0);
    y = headerH + 18;

    function sectionHeader(title){
      doc.setFillColor(31,122,80);
      doc.rect(margin, y, pageW-margin*2, 18, 'F');
      doc.setTextColor(255,255,255); doc.setFont('helvetica','bold'); doc.setFontSize(10);
      doc.text(title.toUpperCase(), margin+6, y+12.5);
      doc.setTextColor(0,0,0);
      y += 26;
    }
    function kv(label, value, xOffset, width){
      doc.setFont('helvetica','bold'); doc.setFontSize(9);
      doc.text(label, margin+xOffset, y);
      doc.setFont('helvetica','normal');
      const lines = doc.splitTextToSize(value || '—', width);
      doc.text(lines, margin+xOffset, y+11);
      return lines.length;
    }
    function checkPageBreak(needed){
      if(y + needed > 790){ doc.addPage(); y = 40; }
    }

    // 1. Customer info
    sectionHeader('1. Customer\'s Information');
    kv('SR NO.', data.srNo, 0, 240); kv('DATE', data.date, 300, 220); y += 22;
    let h1 = kv('CUSTOMER NAME', data.custName, 0, 250);
    kv('CONTACT NO.', data.contactNo, 300, 220);
    y += Math.max(h1,1)*11 + 12;
    let h2 = kv('ADDRESS', data.custAddress, 0, 250);
    kv('CONTACT PERSON', data.contactPerson, 300, 220);
    y += Math.max(h2,1)*11 + 16;

    // 2. Equipment
    checkPageBreak(90);
    sectionHeader('2. Equipment Description');
    kv('EQUIPMENT TYPE', data.equipType || '—', 0, 500); y += 24;
    kv('MODEL NO. (CU)', data.modelCU, 0, 240); kv('SERIAL NO. (CU)', data.serialCU, 300, 220); y += 22;
    kv('MODEL NO. (FCU)', data.modelFCU, 0, 240); kv('SERIAL NO. (FCU)', data.serialFCU, 300, 220); y += 22;
    kv('COOLING CAPACITY', data.coolCap, 0, 240); kv('MOUNTING TYPE', data.mountType, 300, 220); y += 22;
    kv('BRAND / MANUFACTURER', data.brand, 0, 240); kv('REFRIGERANT TYPE', data.refrigerantType, 300, 220); y += 22;
    kv('COMPRESSOR TYPE', data.compressorType, 0, 240); kv('LOCATION', data.equipLocation, 300, 220); y += 26;

    // 3. Report summary
    checkPageBreak(100);
    sectionHeader('3. Report Summary');
    doc.setFont('helvetica','bold'); doc.setFontSize(9); doc.text('TROUBLE CALL / REASON FOR SERVICE', margin, y);
    doc.setFont('helvetica','normal');
    let tc = doc.splitTextToSize(data.troubleCall || '—', pageW-margin*2);
    doc.text(tc, margin, y+11); y += tc.length*11 + 16;

    checkPageBreak(60);
    doc.setFont('helvetica','bold'); doc.setFontSize(9); doc.text('FINDINGS / EVALUATION', margin, y); y+=12;
    doc.setFont('helvetica','normal');
    if(data.findings.length===0){ doc.text('—', margin+8, y); y+=13; }
    data.findings.forEach(f=>{
      checkPageBreak(20);
      const lines = doc.splitTextToSize('• '+f, pageW-margin*2-8);
      doc.text(lines, margin+8, y); y += lines.length*11+3;
    });
    y += 6;

    checkPageBreak(60);
    doc.setFont('helvetica','bold'); doc.setFontSize(9); doc.text('RECOMMENDATION/S', margin, y); y+=12;
    doc.setFont('helvetica','normal');
    if(data.recs.length===0){ doc.text('—', margin+8, y); y+=13; }
    data.recs.forEach(r=>{
      checkPageBreak(20);
      const lines = doc.splitTextToSize('• '+r, pageW-margin*2-8);
      doc.text(lines, margin+8, y); y += lines.length*11+3;
    });
    y += 10;

    // 4. Materials & Spare Parts
    checkPageBreak(60);
    sectionHeader('4. Materials & Spare Parts');
    const rows = (data.materials.length? data.materials : []).map((m,i)=>[
      String.fromCharCode(97+i)+'.', m.details||'—', m.qty||'—'
    ]);
    doc.autoTable({
      startY: y,
      margin:{left:margin, right:margin},
      head:[['Item','Model No. / Details / Capacity','Qty']],
      body: rows.length? rows : [['a.','—','—']],
      styles:{fontSize:8.5, cellPadding:4},
      headStyles:{fillColor:[231,243,236], textColor:[21,77,52], fontStyle:'bold'},
      columnStyles:{0:{cellWidth:24},2:{cellWidth:60}}
    });
    y = doc.lastAutoTable.finalY + 18;

    // 5. Services Done
    checkPageBreak(60);
    sectionHeader('5. Services Done');
    doc.setFont('helvetica','normal'); doc.setFontSize(9);
    if(!data.servicesDone || data.servicesDone.length===0){ doc.text('—', margin+8, y); y+=13; }
    (data.servicesDone||[]).forEach(s=>{
      checkPageBreak(20);
      const lines = doc.splitTextToSize('• '+s, pageW-margin*2-8);
      doc.text(lines, margin+8, y); y += lines.length*11+3;
    });
    y += 6;

    // 6. Operating data
    checkPageBreak(120);
    sectionHeader('6. Operating Data');
    doc.autoTable({
      startY:y, margin:{left:margin,right:margin},
      head:[['','Before Servicing','After Servicing']],
      body:[
        ['Amperage (L1/L2/L3)', data.before.amp.join(' / ')||'—', data.after.amp.join(' / ')||'—'],
        ['Voltage (L12/L23/L31)', data.before.volt.join(' / ')||'—', data.after.volt.join(' / ')||'—'],
        ['Pressure (Suction/Discharge)', data.before.pressure.join(' / ')||'—', data.after.pressure.join(' / ')||'—'],
        ['Supply Air Temp (°C)', data.before.temp||'—', data.after.temp||'—'],
        ['Air Volume Flow Rate (cfm)', data.before.airflow||'—', data.after.airflow||'—']
      ],
      styles:{fontSize:8.5, cellPadding:4},
      headStyles:{fillColor:[231,243,236], textColor:[21,77,52], fontStyle:'bold'}
    });
    y = doc.lastAutoTable.finalY + 18;

    // 7. Installation data
    if(data.isInstall){
      checkPageBreak(100);
      sectionHeader('7. Installation Data');
      doc.autoTable({
        startY:y, margin:{left:margin,right:margin},
        body:[
          ['Pipe Diameter (in) — Suction/Discharge/Drain', data.install.pd.join(' / ')||'—'],
          ['Pipe Length (ft) — Ref\'t Line/Drain', data.install.pl.join(' / ')||'—'],
          ['Wire Size (awg) — Feeder/Control', data.install.ws.join(' / ')||'—'],
          ['Circuit Breaker (amp)', data.install.breaker||'—'],
          ['Pipe Insulation (in) — Ref\'t Line/Drain', data.install.pi.join(' / ')||'—'],
          ['Riser Pipes Height (m)', data.install.riser||'—'],
          ['P-Trap', data.install.ptrap||'—'],
          ['Accu Bracket Type', data.install.bracketType||'—']
        ],
        styles:{fontSize:8.5, cellPadding:4},
        theme:'plain'
      });
      y = doc.lastAutoTable.finalY + 18;
    }

    // 8. Acknowledgment
    checkPageBreak(190);
    sectionHeader('8. Acknowledgment');
    doc.setFont('helvetica','italic'); doc.setFontSize(8.5); doc.setTextColor(70,80,74);
    const ackLines = doc.splitTextToSize(
      'I hereby acknowledge the services / works done on my equipment and agree to the terms & conditions stated herein.',
      pageW-margin*2
    );
    doc.text(ackLines, margin, y);
    doc.setTextColor(0,0,0);
    y += ackLines.length*11 + 12;
    kv('TIME IN', data.timeIn||'—', 0, 150); kv('TIME OUT', data.timeOut||'—', 200, 150); y+=22;
    doc.setFont('helvetica','bold'); doc.setFontSize(9); doc.text('REMARKS', margin, y);
    doc.setFont('helvetica','normal');
    const remLines = doc.splitTextToSize(data.remarks||'—', pageW-margin*2);
    doc.text(remLines, margin, y+11); y += remLines.length*11 + 18;

    checkPageBreak(150);
    const colW = (pageW - margin*2 - 20)/2;
    const sigY = y;
    doc.setDrawColor(220,227,221);
    doc.rect(margin, sigY, colW, 80);
    doc.rect(margin+colW+20, sigY, colW, 80);
    if(data.sigCustomer){ try{ doc.addImage(data.sigCustomer,'PNG', margin+6, sigY+6, colW-12, 55); }catch(e){} }
    if(data.sigTech){ try{ doc.addImage(data.sigTech,'PNG', margin+colW+26, sigY+6, colW-12, 55); }catch(e){} }
    doc.setFontSize(8.5);
    doc.text('Customer — '+(data.custPrintedName||'_______________'), margin+4, sigY+72);
    doc.text('Technician — '+(data.techName||'_______________'), margin+colW+24, sigY+72);
    y = sigY + 96;

    doc.setFontSize(8); doc.setTextColor(120,130,124);
    doc.text('Generated on '+new Date().toLocaleString('en-PH'), margin, 815);

    return doc;
  }

  async function shareOrDownloadPdf(doc, filename){
    const blob = doc.output('blob');
    if(navigator.canShare && navigator.canShare({files:[new File([blob], filename, {type:'application/pdf'})]})){
      try{
        await navigator.share({
          files:[new File([blob], filename, {type:'application/pdf'})],
          title:'AWES Service Report',
          text:'Service report '+filename
        });
        return 'shared';
      }catch(e){ /* user cancelled or unsupported — fall through to download */ }
    }
    doc.save(filename);
    return 'downloaded';
  }

  // Mobile browsers use canvas rendering for reliable PDF preview. PDF.js is lazy-loaded.
  async function ensurePdfJs(){
    await loadAwesScript('pdfjs', awesLibs.pdfjs);
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  }
  let previewRenderToken = 0;
  function closePreview(){
    $('previewOverlay').classList.remove('open');
    previewRenderToken++; // invalidate any in-flight render
    const frame = $('previewFrame');
    frame.innerHTML = '<div class="empty-state" style="display:none;">Rendering preview…</div>';
  }
  async function renderPdfPreview(doc){
    const myToken = ++previewRenderToken;
    const frame = $('previewFrame');
    frame.innerHTML = '';
    const loading = document.createElement('div');
    loading.className = 'empty-state';
    loading.textContent = 'Rendering preview…';
    frame.appendChild(loading);

    await ensurePdfJs();
    const arrayBuffer = doc.output('arraybuffer');
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    if(myToken !== previewRenderToken) return; // overlay was closed / superseded
    frame.innerHTML = '';

    for(let pageNum = 1; pageNum <= pdf.numPages; pageNum++){
      if(myToken !== previewRenderToken) return;
      const page = await pdf.getPage(pageNum);
      const scale = Math.min(2, (frame.clientWidth || 700) / page.getViewport({ scale: 1 }).width);
      const viewport = page.getViewport({ scale: Math.max(scale, 1) });
      const canvas = document.createElement('canvas');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      canvas.style.cssText = 'max-width:100%; height:auto; display:block; margin:0 auto 12px; box-shadow:0 1px 4px rgba(0,0,0,.2); background:#fff;';
      const ctx = canvas.getContext('2d');
      await page.render({ canvasContext: ctx, viewport }).promise;
      if(myToken !== previewRenderToken) return;
      frame.appendChild(canvas);
    }
  }
  $('previewBtn').addEventListener('click', async ()=>{
    if(!validate()){ toast('Please fill required fields before previewing'); return; }
    $('previewBtn').disabled = true; $('previewBtn').textContent = 'Building preview…';
    try{
      const data = await gatherDataForOutput();
      const doc = await buildPdf(data);
      $('previewOverlay').classList.add('open');
      await renderPdfPreview(doc);
    }catch(e){
      console.error(e);
      toast('Could not build preview');
    }finally{
      $('previewBtn').disabled = false; $('previewBtn').textContent = '👁 Preview Report Before Signing';
    }
  });
  $('closePreview').addEventListener('click', closePreview);
  $('previewOkBtn').addEventListener('click', closePreview);

  function showShareSuccess(detail){
    $('shareSuccessDetail').textContent = detail || '';
    $('shareSuccessOverlay').classList.add('open');
  }
  $('shareSuccessHomeBtn').addEventListener('click', ()=>{
    $('shareSuccessOverlay').classList.remove('open');
    resetForm();
    showHome();
  });

  $('genPdfBtn').addEventListener('click', async ()=>{
    if(!validate()){ toast('Please fill required fields'); return; }
    $('genPdfBtn').disabled = true;
    $('genPdfBtn').textContent = 'Building PDF…';
    try{
      if(!currentSrNo){ currentSrNo = await nextSrNo(); $('metaSrNo').textContent = currentSrNo; }
      const data = await gatherDataForOutput();
      Object.assign(data, {completed:true});
      await saveReport(currentSrNo, data);
      $('statusPill').textContent='Completed'; $('statusPill').className='status-pill status-done';
      const doc = await buildPdf(data);
      const filename = (currentSrNo||'service-report')+'.pdf';

      if(emailConfigured()){
        $('genPdfBtn').textContent = 'Sending email…';
        const emailResult = await sendEmailWithPdf(doc, data, filename);
        if(emailResult.ok){
          showShareSuccess('Emailed to the customer and saved to the shared cloud.');
        }else if(emailResult.reason==='too_large'){
          await shareOrDownloadPdf(doc, filename);
          showShareSuccess('PDF was too large to email, so it was shared/downloaded instead.');
        }else{
          await shareOrDownloadPdf(doc, filename);
          showShareSuccess('Auto-email failed, so it was shared/downloaded instead.');
        }
      }else{
        const result = await shareOrDownloadPdf(doc, filename);
        showShareSuccess(result==='shared' ? 'Report '+filename+' was shared.' : 'Report '+filename+' was downloaded to this device.');
      }
    }catch(e){
      console.error(e);
      toast('Something went wrong generating the PDF');
    }finally{
      $('genPdfBtn').disabled = false;
      $('genPdfBtn').textContent = 'Generate & Share Report';
    }
  });

  // ---------- new report ----------
  $('newBtn').addEventListener('click', ()=>{
    if(confirm('Start a new blank report? Unsaved changes will be lost.')) resetForm();
  });


// ---------- history ----------
  async function loadHistory(containerId){
    const list = $(containerId || 'historyList');
    list.innerHTML = '<div class="empty-state">Loading…</div>';
    let reports = null;
    if(await ensureCloud()){
      reports = await cloudListReports();
    }
    if(reports===null){
      reports = [];
      try{
        const res = await window.storage.list('report:', false);
        const keys = (res && res.keys) ? res.keys.slice().reverse() : [];
        for(const key of keys){
          try{ const item = await window.storage.get(key, false); reports.push(JSON.parse(item.value)); }catch(e){}
        }
      }catch(e){}
    }
    if(reports.length===0){ list.innerHTML = '<div class="empty-state">No saved reports yet.</div>'; return; }
    list.innerHTML = '';
    reports.forEach(d=>{
      const row = document.createElement('div');
      row.className = 'hist-item';
      row.innerHTML =
        '<div class="hist-info"><b>'+(d.custName||'Untitled')+'</b>'+
        '<span>'+(d.srNo||'')+' · '+(d.date||'')+' · '+(d.completed?'Completed':'Draft')+'</span></div>'+
        '<div class="hist-actions"><button data-act="open">Open</button><button data-act="pdf">PDF</button></div>';
      row.querySelector('[data-act="open"]').addEventListener('click', (e)=>{ e.stopPropagation(); openReport(d); });
      row.querySelector('[data-act="pdf"]').addEventListener('click', async (e)=>{
        e.stopPropagation();
        const doc = await buildPdf(d);
        shareOrDownloadPdf(doc, (d.srNo||'service-report')+'.pdf');
      });
      list.appendChild(row);
    });
  }
  async function openReport(d){
    resetForm();
    currentSrNo = d.srNo; $('metaSrNo').textContent = d.srNo||'—';
    $('custName').value = d.custName||''; $('svcDate').value = d.date||todayISO();
    $('metaDate').textContent = fmtDate($('svcDate').value);
    $('custAddress').value = d.custAddress||''; $('contactNo').value = d.contactNo||''; $('contactPerson').value = d.contactPerson||'';
    $('custEmail').value = d.custEmail||'';
    // Re-establish equipment context for this report's customer, so its
    // equipment dropdowns work correctly if the technician reopens this field.
    const matchedCustomer = customersCache.find(c=> c.name.toLowerCase() === (d.custName||'').trim().toLowerCase());
    loadCustomerEquipment(matchedCustomer ? matchedCustomer.id : null);
    setEquipTab('addnew');
    $('custDetailsWrap').style.display = '';
    ['sec2Card','sec3Card','sec4Card','sec5Card','sec6Card','sec7Card','sec8Card'].forEach(id=>{
      const el = $(id); if(el) el.style.display = '';
    });
    expandAllSections();
    $('equipType').value = d.equipType || (Array.isArray(d.equipCodes) ? d.equipCodes.join(', ') : '') || '';
    $('modelCU').value=d.modelCU||''; $('serialCU').value=d.serialCU||'';
    $('modelFCU').value=d.modelFCU||''; $('serialFCU').value=d.serialFCU||'';
    $('coolCap').value=d.coolCap||''; $('mountType').value=d.mountType||'';
    $('brand').value=d.brand||''; $('refrigerantType').value=d.refrigerantType||'';
    $('compressorType').value=d.compressorType||''; $('equipLocation').value=d.equipLocation||'';
    $('troubleCall').value=d.troubleCall||'';
    $('findingsList').innerHTML=''; (d.findings&&d.findings.length?d.findings:['']).forEach(f=>addListRow('findingsList',f));
    $('recsList').innerHTML=''; (d.recs&&d.recs.length?d.recs:['']).forEach(r=>addListRow('recsList',r));
    $('servicesDoneList').innerHTML='';
    const svcArr = Array.isArray(d.servicesDone) ? d.servicesDone : (d.servicesDone ? [d.servicesDone] : []);
    (svcArr.length?svcArr:['']).forEach(s=>addListRow('servicesDoneList',s));
    $('materialsBody').innerHTML=''; materialRowCount=0;
    (d.materials&&d.materials.length?d.materials:[{},{},{}]).forEach(m=>addMaterialRow(m));
    if(d.before){
      $('b_amp_l1').value=d.before.amp[0]||''; $('b_amp_l2').value=d.before.amp[1]||''; $('b_amp_l3').value=d.before.amp[2]||'';
      $('b_volt_l12').value=d.before.volt[0]||''; $('b_volt_l23').value=d.before.volt[1]||''; $('b_volt_l31').value=d.before.volt[2]||'';
      $('b_press_suction').value=d.before.pressure[0]||''; $('b_press_discharge').value=d.before.pressure[1]||'';
      $('b_temp').value=d.before.temp||''; $('b_airflow').value=d.before.airflow||'';
    }
    if(d.after){
      $('a_amp_l1').value=d.after.amp[0]||''; $('a_amp_l2').value=d.after.amp[1]||''; $('a_amp_l3').value=d.after.amp[2]||'';
      $('a_volt_l12').value=d.after.volt[0]||''; $('a_volt_l23').value=d.after.volt[1]||''; $('a_volt_l31').value=d.after.volt[2]||'';
      $('a_press_suction').value=d.after.pressure[0]||''; $('a_press_discharge').value=d.after.pressure[1]||'';
      $('a_temp').value=d.after.temp||''; $('a_airflow').value=d.after.airflow||'';
    }
    $('isInstallToggle').checked = !!d.isInstall;
    $('installSection').classList.toggle('open', !!d.isInstall);
    if(d.install){
      $('pd_suction').value=d.install.pd[0]||''; $('pd_discharge').value=d.install.pd[1]||''; $('pd_drain').value=d.install.pd[2]||'';
      $('pl_refline').value=d.install.pl[0]||''; $('pl_drain').value=d.install.pl[1]||'';
      $('ws_feeder').value=d.install.ws[0]||''; $('ws_control').value=d.install.ws[1]||'';
      $('circuit_breaker').value=d.install.breaker||'';
      $('pi_refline').value=d.install.pi[0]||''; $('pi_drain').value=d.install.pi[1]||'';
      $('riser_height').value=d.install.riser||''; $('ptrap').value=d.install.ptrap||'';
      $('bracketType').value=d.install.bracketType||'';
    }
    $('timeIn').value=d.timeIn||''; $('timeOut').value=d.timeOut||''; $('remarks').value=d.remarks||'';
    $('custPrintedName').value=d.custPrintedName||''; $('techName').value=d.techName || (currentUser ? currentUser.name : '') || '';
    if(d.sigCustomer){ await ensureSignaturePads(); sigCustomerPad.fromDataURL(d.sigCustomer); $('sigCustomerPh').style.display='none'; }
    if(d.sigTech){ await ensureSignaturePads(); sigTechPad.fromDataURL(d.sigTech); $('sigTechPh').style.display='none'; }
    $('statusPill').textContent = d.completed ? 'Completed' : 'Draft';
    $('statusPill').className = 'status-pill ' + (d.completed ? 'status-done' : 'status-draft');
    $('historyOverlay').classList.remove('open');
    srShowTab('new');
    window.scrollTo({top:0, behavior:'smooth'});
  }
  $('closeHistory').addEventListener('click', ()=> $('historyOverlay').classList.remove('open'));
  $('historyOverlay').addEventListener('click', (e)=>{ if(e.target.id==='historyOverlay') $('historyOverlay').classList.remove('open'); });

  // ---------- Main Menu (consolidates Admin / History / Email Setup / Logout) ----------
  function closeMainMenu(){ $('menuDropdown').classList.remove('open'); }
  function openMainMenu(){ $('menuDropdown').classList.add('open'); }
  async function ensureAdminAuthenticated(){
    if(adminMode) return true;
    const pin = prompt('Enter Admin Password:');
    if(pin===null) return false;
    if(!(await verifyAdminPassword(pin))){ toast('Incorrect password'); return false; }
    enterAdminMode();
    toast('Admin mode on');
    return true;
  }

  $('menuBtn').addEventListener('click', (e)=>{
    e.stopPropagation();
    $('menuDropdown').classList.toggle('open');
  });
  document.addEventListener('click', (e)=>{
    if(!$('menuDropdown').classList.contains('open')) return;
    if(!$('menuDropdown').contains(e.target) && e.target.id!=='menuBtn') closeMainMenu();
  });

  $('menuManageUsers').addEventListener('click', async ()=>{
    closeMainMenu();
    if(!(await ensureAdminAuthenticated())) return;
    $('usersOverlay').classList.add('open');
    renderUsersList();
  });
  $('menuManageDropdowns').addEventListener('click', async ()=>{
    closeMainMenu();
    if(!(await ensureAdminAuthenticated())) return;
    renderManageLists();
    $('adminOverlay').classList.add('open');
  });
  $('menuChangePin').addEventListener('click', ()=>{
    closeMainMenu();
    doChangeAdminPin();
  });
  $('menuManageReports').addEventListener('click', ()=>{
    closeMainMenu();
    $('historyOverlay').classList.add('open');
    loadHistory();
  });
  $('menuLogout').addEventListener('click', ()=>{
    closeMainMenu();
    doLogout();
  });
  // Technician-facing direct buttons (shown in place of Menu — see applyUserRestrictions)
  $('userLogoutBtn').addEventListener('click', doLogout);

  // ---------- Auto-logout admin when app is closed or minimized ----------
  // Runs fully synchronously (no awaits) so the login screen is guaranteed to be
  // covering the page the instant the app is hidden — mobile OSes can freeze JS
  // mid-way through an async function once backgrounded, which was leaving a stale
  // page visible behind the sign-in sheet until a manual refresh.
  // Any logged-in account (admin or technician) is signed out the moment the
  // window/tab is actually closed — but NOT when it's merely minimized,
  // backgrounded, or switched away from (no visibilitychange listener here).
  // pagehide fires on real close/navigation-away; event.persisted is true
  // when the page is only being cached for back/forward, so we skip clearing
  // in that case since the tab isn't actually gone.
  function clearSessionOnClose(){
    try{ localStorage.removeItem('current-user'); }catch(e){}
  }
  window.addEventListener('pagehide', (e)=>{
    if(e.persisted) return;
    clearSessionOnClose();
  });

  // ============================================================
  // Online DTR (Daily Time Record) — a fully separate module/page.
  // It does not read or write anything from the Service Report; it
  // has its own data store ('dtr' collection / 'dtr:' local keys),
  // its own device-lock store, and its own screen.
  // ============================================================

  // ---- Non-transferable device id ----------------------------------
  // A random id persisted in this device's own localStorage the first
  // time the app runs on it. It identifies *this physical install*,
  // not the logged-in user, so it survives logout/login and is what
  // lets us tell "your phone" apart from "someone else's phone".
  function getDtrDeviceId(){
    let id = null;
    try{ id = localStorage.getItem('device-id'); }catch(e){}
    if(!id){
      id = 'dev-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,10);
      try{ localStorage.setItem('device-id', id); }catch(e){}
    }
    return id;
  }
  const dtrDeviceId = getDtrDeviceId();

  async function dtrGetDeviceLock(userId){
    if(await ensureCloud()){
      try{
        const { data, error } = await db.from('device_locks').select('device_id').eq('technician_id', userId).maybeSingle();
        if(error) throw error;
        return data ? data.device_id : null;
      }catch(e){ console.error('device lock read failed', describeCloudError(e)); }
    }
    try{
      const res = await window.storage.get('device-lock:'+userId, false);
      return res ? JSON.parse(res.value).deviceId : null;
    }catch(e){ return null; }
  }
  async function dtrSetDeviceLock(userId, devId){
    if(await ensureCloud()){
      try{
        const { error } = await db.from('device_locks').upsert(
          { technician_id: userId, device_id: devId }, { onConflict: 'technician_id' }
        );
        if(error) throw error;
        return true;
      }catch(e){ console.error('device lock write failed', describeCloudError(e)); }
    }
    try{ await window.storage.set('device-lock:'+userId, JSON.stringify({deviceId:devId}), false); return true; }
    catch(e){ return false; }
  }
  // Admin-only escape hatch (wired into Manage Users → "Reset DTR Device")
  // for when a technician legitimately gets a new phone.
  async function clearDeviceLock(userId){
    if(await ensureCloud()){
      try{
        const { error } = await db.from('device_locks').delete().eq('technician_id', userId);
        if(error) throw error;
        return true;
      }catch(e){ console.error('device lock clear failed', describeCloudError(e)); }
    }
    try{ await window.storage.delete('device-lock:'+userId, false); return true; }
    catch(e){ return false; }
  }
  // Binds this device to the user the first time they use DTR on it.
  // From then on, only that same device may time this user in/out —
  // this is what stops someone from signing in on a coworker's phone
  // just to punch a time in for them.
  async function dtrEnsureDeviceAllowed(userId){
    const bound = await dtrGetDeviceLock(userId);
    if(!bound){ await dtrSetDeviceLock(userId, dtrDeviceId); return true; }
    return bound === dtrDeviceId;
  }

  // ---- Geolocation ---------------------------------------------------
  async function dtrReverseGeocode(lat, lng){
    try{
      const ctrl = new AbortController();
      const timer = setTimeout(()=> ctrl.abort(), 8000);
      const url = 'https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat='+lat+'&lon='+lng+'&zoom=18&addressdetails=1';
      const res = await fetch(url, {signal: ctrl.signal, headers:{'Accept-Language':'en'}});
      clearTimeout(timer);
      if(!res.ok) return null;
      const data = await res.json();
      return (data && data.display_name) ? data.display_name : null;
    }catch(e){ return null; }
  }
  function dtrGetLocation(){
    return new Promise((resolve)=>{
      if(!navigator.geolocation){ resolve(null); return; }
      navigator.geolocation.getCurrentPosition(
        async (pos)=>{
          const loc = {lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: Math.round(pos.coords.accuracy||0)};
          loc.address = await dtrReverseGeocode(loc.lat, loc.lng);
          resolve(loc);
        },
        ()=> resolve(null),
        {enableHighAccuracy:true, timeout:12000, maximumAge:0}
      );
    });
  }
  function dtrLocLabel(loc){
    if(!loc) return 'Location unavailable';
    if(loc.address) return loc.address;
    return loc.lat.toFixed(5)+', '+loc.lng.toFixed(5)+(loc.accuracy?(' (±'+loc.accuracy+'m)'):'');
  }
  // Tapping a location tag shows the address plus an embedded map pin.
  function dtrOpenLocationOverlay(loc, title){
    if(!loc) return;
    $('dtrLocationTitle').textContent = title || 'Location';
    $('dtrLocationAddress').textContent = loc.address || 'Address unavailable';
    $('dtrLocationCoords').textContent = loc.lat.toFixed(5)+', '+loc.lng.toFixed(5)+(loc.accuracy ? (' (±'+loc.accuracy+'m accuracy)') : '');
    const d = 0.003; // ~300m bounding box half-width around the pin
    const bbox = (loc.lng-d)+','+(loc.lat-d)+','+(loc.lng+d)+','+(loc.lat+d);
    $('dtrLocationIframe').src = 'https://www.openstreetmap.org/export/embed.html?bbox='+bbox+'&layer=mapnik&marker='+loc.lat+','+loc.lng;
    $('dtrLocationExternalLink').href = 'https://www.google.com/maps?q='+loc.lat+','+loc.lng;
    $('dtrLocationOverlay').classList.add('open');
  }
  function dtrCloseLocationOverlay(){
    $('dtrLocationOverlay').classList.remove('open');
    $('dtrLocationIframe').src = '';
  }
  $('closeDtrLocation').addEventListener('click', dtrCloseLocationOverlay);
  $('dtrLocationOverlay').addEventListener('click', (e)=>{ if(e.target.id==='dtrLocationOverlay') dtrCloseLocationOverlay(); });

  // ---- DTR record storage (own 'dtr' collection/keys; one doc per user per day) ----
  async function dtrGetDay(userId, dateISO){
    if(await ensureCloud()){
      try{
        const { data, error } = await db.from('dtr_records').select('data')
          .eq('technician_id', userId).eq('date', dateISO).maybeSingle();
        if(error) throw error;
        return data ? data.data : null;
      }catch(e){ console.error('dtr get failed', describeCloudError(e)); }
    }
    try{ const res = await window.storage.get('dtr:'+userId+':'+dateISO, false); return res ? JSON.parse(res.value) : null; }
    catch(e){ return null; }
  }
  async function dtrSaveDay(userId, dateISO, data){
    if(await ensureCloud()){
      try{
        const { error } = await db.from('dtr_records').upsert(
          { technician_id: userId, date: dateISO, data },
          { onConflict: 'technician_id,date' }
        );
        if(error) throw error;
        return true;
      }catch(e){ console.error('dtr save failed', describeCloudError(e)); }
    }
    try{ await window.storage.set('dtr:'+userId+':'+dateISO, JSON.stringify(data), false); return true; }
    catch(e){ return false; }
  }
  // History is always scoped to one user (per-user DTR) and capped to the last 30 days.
  async function dtrListForUser(userId, sinceISO){
    if(await ensureCloud()){
      try{
        const { data, error } = await db.from('dtr_records').select('data')
          .eq('technician_id', userId).gte('date', sinceISO).order('date',{ascending:false});
        if(error) throw error;
        return (data||[]).map(r=>r.data);
      }catch(e){ console.error('dtr list failed', describeCloudError(e)); }
    }
    try{
      const res = await window.storage.list('dtr:'+userId+':', false);
      const items = [];
      for(const key of (res.keys||[])){
        try{ const item = await window.storage.get(key, false); const d = JSON.parse(item.value); if(d.date>=sinceISO) items.push(d); }catch(e){}
      }
      items.sort((a,b)=> b.date.localeCompare(a.date));
      return items;
    }catch(e){ return []; }
  }

  function dtrFmtTime(iso){
    if(!iso) return '—';
    return new Date(iso).toLocaleTimeString('en-PH', {hour:'2-digit', minute:'2-digit', second:'2-digit'});
  }
  function dtrFmtDateLabel(dateISO){
    const d = new Date(dateISO+'T00:00:00');
    return d.toLocaleDateString('en-PH', {weekday:'short', year:'numeric', month:'short', day:'numeric'});
  }

  // Who the history/status panel currently shows: the logged-in tech
  // themself, or — for admin — whichever technician they picked.
  let dtrViewingUser = null;

  async function dtrRenderTodayStatus(){
    if(!currentUser || currentUser.role==='admin') return;
    const dateISO = todayISO();
    $('dtrTodayDate').textContent = dtrFmtDateLabel(dateISO);
    const rec = await dtrGetDay(currentUser.id, dateISO);
    $('dtrTodayIn').textContent = rec && rec.timeIn ? dtrFmtTime(rec.timeIn) : '—';
    $('dtrTodayOut').textContent = rec && rec.timeOut ? dtrFmtTime(rec.timeOut) : '—';
    $('dtrTimeInBtn').disabled = !!(rec && rec.timeIn);
    $('dtrTimeOutBtn').disabled = !(rec && rec.timeIn) || !!(rec && rec.timeOut);

    $('dtrTodayOtIn').textContent = rec && rec.otTimeIn ? dtrFmtTime(rec.otTimeIn) : '—';
    $('dtrTodayOtOut').textContent = rec && rec.otTimeOut ? dtrFmtTime(rec.otTimeOut) : '—';
    // Overtime is logged after the regular shift ends — OT Time In stays
    // disabled until the regular Time Out is recorded for the day.
    $('dtrOtTimeInBtn').disabled = !(rec && rec.timeOut) || !!(rec && rec.otTimeIn);
    $('dtrOtTimeOutBtn').disabled = !(rec && rec.otTimeIn) || !!(rec && rec.otTimeOut);
  }

  async function dtrRenderDeviceBanner(){
    const banner = $('dtrDeviceBanner');
    if(!currentUser || currentUser.role==='admin'){ banner.style.display='none'; return; }
    const bound = await dtrGetDeviceLock(currentUser.id);
    if(bound && bound !== dtrDeviceId){
      banner.textContent = 'This account is already registered to another device. Time In/Out is blocked on this phone — ask your admin to reset your DTR device if this is now your phone.';
      banner.style.display = '';
    }else{
      banner.style.display = 'none';
    }
  }

  async function dtrRenderHistory(){
    const list = $('dtrHistoryList');
    const target = dtrViewingUser || (currentUser && currentUser.role!=='admin' ? {id:currentUser.id, name:currentUser.name} : null);
    if(!target){ list.innerHTML = '<div class="empty-state">Select a technician to view their DTR.</div>'; return; }
    list.innerHTML = '<div class="empty-state">Loading…</div>';
    const since = new Date(); since.setDate(since.getDate()-30);
    const sinceISO = since.toISOString().slice(0,10);
    const items = await dtrListForUser(target.id, sinceISO);
    if(items.length===0){ list.innerHTML = '<div class="empty-state">No DTR entries in the last 30 days.</div>'; return; }
    list.innerHTML = '';
    items.forEach(d=>{
      const row = document.createElement('div');
      row.className = 'hist-item';
      row.style.cursor = 'default';
      const inTxt = d.timeIn ? dtrFmtTime(d.timeIn) : '—';
      const outTxt = d.timeOut ? dtrFmtTime(d.timeOut) : '—';
      const otInTxt = d.otTimeIn ? dtrFmtTime(d.otTimeIn) : null;
      const otOutTxt = d.otTimeOut ? dtrFmtTime(d.otTimeOut) : null;
      row.innerHTML =
        '<div class="hist-info"><b>'+dtrFmtDateLabel(d.date)+'</b>'+
        '<span>In: '+inTxt+' &nbsp;·&nbsp; Out: '+outTxt+'</span>'+
        ((otInTxt || otOutTxt) ? '<span>OT In: '+(otInTxt||'—')+' &nbsp;·&nbsp; OT Out: '+(otOutTxt||'—')+'</span>' : '')+
        (d.timeInLoc ? '<button type="button" class="dtr-loc-tag" data-kind="in">📍 In: '+escapeHtml(dtrLocLabel(d.timeInLoc))+'</button>' : '')+
        (d.timeOutLoc ? '<button type="button" class="dtr-loc-tag" data-kind="out">📍 Out: '+escapeHtml(dtrLocLabel(d.timeOutLoc))+'</button>' : '')+
        (d.otTimeInLoc ? '<button type="button" class="dtr-loc-tag" data-kind="otin">📍 OT In: '+escapeHtml(dtrLocLabel(d.otTimeInLoc))+'</button>' : '')+
        (d.otTimeOutLoc ? '<button type="button" class="dtr-loc-tag" data-kind="otout">📍 OT Out: '+escapeHtml(dtrLocLabel(d.otTimeOutLoc))+'</button>' : '')+
        '</div>';
      list.appendChild(row);
      const inTag = row.querySelector('[data-kind="in"]');
      if(inTag) inTag.addEventListener('click', ()=> dtrOpenLocationOverlay(d.timeInLoc, dtrFmtDateLabel(d.date)+' — Time In'));
      const outTag = row.querySelector('[data-kind="out"]');
      if(outTag) outTag.addEventListener('click', ()=> dtrOpenLocationOverlay(d.timeOutLoc, dtrFmtDateLabel(d.date)+' — Time Out'));
      const otInTag = row.querySelector('[data-kind="otin"]');
      if(otInTag) otInTag.addEventListener('click', ()=> dtrOpenLocationOverlay(d.otTimeInLoc, dtrFmtDateLabel(d.date)+' — OT Time In'));
      const otOutTag = row.querySelector('[data-kind="otout"]');
      if(otOutTag) otOutTag.addEventListener('click', ()=> dtrOpenLocationOverlay(d.otTimeOutLoc, dtrFmtDateLabel(d.date)+' — OT Time Out'));
    });
  }

  async function dtrDoTimeIn(){
    if(!currentUser || currentUser.role==='admin') return;
    const allowed = await dtrEnsureDeviceAllowed(currentUser.id);
    await dtrRenderDeviceBanner();
    if(!allowed){ toast('This account is registered to another device. Contact your admin.'); return; }
    const dateISO = todayISO();
    const existing = await dtrGetDay(currentUser.id, dateISO);
    if(existing && existing.timeIn){ toast('Already timed in today at '+dtrFmtTime(existing.timeIn)); return; }
    $('dtrTimeInBtn').disabled = true;
    toast('Getting your location…');
    const loc = await dtrGetLocation();
    const now = new Date().toISOString();
    const rec = Object.assign({}, existing, {
      userId: currentUser.id, userName: currentUser.name, date: dateISO,
      timeIn: now, timeInLoc: loc
    });
    const ok = await dtrSaveDay(currentUser.id, dateISO, rec);
    toast(ok ? 'Timed in at '+dtrFmtTime(now) : 'Could not save time in');
    await dtrRenderTodayStatus();
    await dtrRenderHistory();
  }
  async function dtrDoTimeOut(){
    if(!currentUser || currentUser.role==='admin') return;
    const allowed = await dtrEnsureDeviceAllowed(currentUser.id);
    await dtrRenderDeviceBanner();
    if(!allowed){ toast('This account is registered to another device. Contact your admin.'); return; }
    const dateISO = todayISO();
    const existing = await dtrGetDay(currentUser.id, dateISO);
    if(!existing || !existing.timeIn){ toast('Time in first before timing out'); return; }
    if(existing.timeOut){ toast('Already timed out today at '+dtrFmtTime(existing.timeOut)); return; }
    $('dtrTimeOutBtn').disabled = true;
    toast('Getting your location…');
    const loc = await dtrGetLocation();
    const now = new Date().toISOString();
    const rec = Object.assign({}, existing, { timeOut: now, timeOutLoc: loc });
    const ok = await dtrSaveDay(currentUser.id, dateISO, rec);
    toast(ok ? 'Timed out at '+dtrFmtTime(now) : 'Could not save time out');
    await dtrRenderTodayStatus();
    await dtrRenderHistory();
  }
  $('dtrTimeInBtn').addEventListener('click', dtrDoTimeIn);
  $('dtrTimeOutBtn').addEventListener('click', dtrDoTimeOut);

  async function dtrDoOtTimeIn(){
    if(!currentUser || currentUser.role==='admin') return;
    const allowed = await dtrEnsureDeviceAllowed(currentUser.id);
    await dtrRenderDeviceBanner();
    if(!allowed){ toast('This account is registered to another device. Contact your admin.'); return; }
    const dateISO = todayISO();
    const existing = await dtrGetDay(currentUser.id, dateISO);
    if(!existing || !existing.timeOut){ toast('Time out from your regular shift first before starting overtime'); return; }
    if(existing.otTimeIn){ toast('Overtime already started today at '+dtrFmtTime(existing.otTimeIn)); return; }
    $('dtrOtTimeInBtn').disabled = true;
    toast('Getting your location…');
    const loc = await dtrGetLocation();
    const now = new Date().toISOString();
    const rec = Object.assign({}, existing, { otTimeIn: now, otTimeInLoc: loc });
    const ok = await dtrSaveDay(currentUser.id, dateISO, rec);
    toast(ok ? 'Overtime timed in at '+dtrFmtTime(now) : 'Could not save overtime time in');
    await dtrRenderTodayStatus();
    await dtrRenderHistory();
  }
  async function dtrDoOtTimeOut(){
    if(!currentUser || currentUser.role==='admin') return;
    const allowed = await dtrEnsureDeviceAllowed(currentUser.id);
    await dtrRenderDeviceBanner();
    if(!allowed){ toast('This account is registered to another device. Contact your admin.'); return; }
    const dateISO = todayISO();
    const existing = await dtrGetDay(currentUser.id, dateISO);
    if(!existing || !existing.otTimeIn){ toast('Start overtime time in first before timing out'); return; }
    if(existing.otTimeOut){ toast('Already timed out from overtime today at '+dtrFmtTime(existing.otTimeOut)); return; }
    $('dtrOtTimeOutBtn').disabled = true;
    toast('Getting your location…');
    const loc = await dtrGetLocation();
    const now = new Date().toISOString();
    const rec = Object.assign({}, existing, { otTimeOut: now, otTimeOutLoc: loc });
    const ok = await dtrSaveDay(currentUser.id, dateISO, rec);
    toast(ok ? 'Overtime timed out at '+dtrFmtTime(now) : 'Could not save overtime time out');
    await dtrRenderTodayStatus();
    await dtrRenderHistory();
  }
  $('dtrOtTimeInBtn').addEventListener('click', dtrDoOtTimeIn);
  $('dtrOtTimeOutBtn').addEventListener('click', dtrDoOtTimeOut);

  // ---- Admin: DTR is per-user, so admin must pick whose to view ----
  async function dtrOpenAdminPicker(){
    const list = $('dtrUserPickerList');
    list.innerHTML = '<div class="empty-state">Loading…</div>';
    $('dtrUserPickerOverlay').classList.add('open');
    const users = (await cloudListUsers()) || [];
    const active = users.filter(u=>u.active!==false);
    if(active.length===0){ list.innerHTML = '<div class="empty-state">No technician accounts yet.</div>'; return; }
    list.innerHTML = '';
    active.sort((a,b)=> (a.name||'').localeCompare(b.name||'')).forEach(u=>{
      const btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'dtr-picker-btn';
      btn.textContent = u.name;
      btn.addEventListener('click', ()=>{
        dtrViewingUser = {id:u.id, name:u.name};
        $('dtrUserPickerOverlay').classList.remove('open');
        $('dtrAdminViewingName').textContent = u.name;
        dtrRenderHistory();
      });
      list.appendChild(btn);
    });
  }
  $('closeDtrUserPicker').addEventListener('click', ()=> $('dtrUserPickerOverlay').classList.remove('open'));
  $('dtrUserPickerOverlay').addEventListener('click', (e)=>{ if(e.target.id==='dtrUserPickerOverlay') $('dtrUserPickerOverlay').classList.remove('open'); });
  $('dtrSwitchUserBtn').addEventListener('click', dtrOpenAdminPicker);


// ---------- Leave Form (table: leave_requests; id/status/technician_id are real columns, rest in data) ----------
  function leaveGenId(userId){ return userId+'_'+Date.now(); }

  async function leaveSaveRequest(id, data){
    if(await ensureCloud()){
      try{
        const { error } = await db.from('leave_requests').upsert({
          id, technician_id: data.userId, status: data.status || 'pending',
          submitted_at: data.submittedAt || new Date().toISOString(), data
        });
        if(error) throw error;
        return true;
      }catch(e){ console.error('leave save failed', describeCloudError(e)); }
    }
    try{ await window.storage.set('leave:'+id, JSON.stringify(data), false); return true; }
    catch(e){ return false; }
  }
  async function leaveListAll(){
    if(await ensureCloud()){
      try{
        const { data, error } = await db.from('leave_requests').select('data').order('submitted_at',{ascending:false}).limit(200);
        if(error) throw error;
        return (data||[]).map(r=>r.data);
      }catch(e){ console.error('leave list failed', describeCloudError(e)); }
    }
    try{
      const res = await window.storage.list('leave:', false);
      const items = [];
      for(const key of (res.keys||[])){
        try{ const item = await window.storage.get(key, false); items.push(JSON.parse(item.value)); }catch(e){}
      }
      items.sort((a,b)=> (b.submittedAt||'').localeCompare(a.submittedAt||''));
      return items;
    }catch(e){ return []; }
  }
  async function leaveListForUser(userId){
    const all = await leaveListAll();
    return all.filter(r=> r.userId===userId);
  }

  function leaveFmtDate(iso){
    if(!iso) return '—';
    return new Date(iso+'T00:00:00').toLocaleDateString('en-PH', {year:'numeric', month:'short', day:'numeric'});
  }
  function leaveFmtWhen(iso){
    if(!iso) return '—';
    return new Date(iso).toLocaleString('en-PH', {year:'numeric', month:'short', day:'numeric', hour:'2-digit', minute:'2-digit'});
  }
  function leaveStatusPill(status){
    if(status==='approved') return '<span class="status-pill status-done">Approved</span>';
    if(status==='disapproved') return '<span class="status-pill status-rejected">Disapproved</span>';
    return '<span class="status-pill status-draft">Pending</span>';
  }
  function leaveCalcDays(){
    const from = $('leaveDateFrom').value, to = $('leaveDateTo').value;
    if(!from || !to){ $('leaveDaysDisplay').value = ''; return; }
    const d1 = new Date(from+'T00:00:00'), d2 = new Date(to+'T00:00:00');
    const diff = Math.round((d2-d1)/86400000)+1;
    $('leaveDaysDisplay').value = diff>0 ? diff+(diff===1?' day':' days') : 'Invalid range';
  }
  $('leaveDateFrom').addEventListener('change', leaveCalcDays);
  $('leaveDateTo').addEventListener('change', leaveCalcDays);

  function leaveResetForm(){
    $('leaveType').value = '';
    $('leaveDateFrom').value = '';
    $('leaveDateTo').value = '';
    $('leaveDaysDisplay').value = '';
    $('leaveReason').value = '';
    $('leaveContact').value = '';
  }

  async function leaveSubmit(){
    if(!currentUser || currentUser.role==='admin') return;
    const leaveType = $('leaveType').value;
    const dateFrom = $('leaveDateFrom').value;
    const dateTo = $('leaveDateTo').value;
    const reason = $('leaveReason').value.trim();
    const contact = $('leaveContact').value.trim();
    if(!leaveType){ toast('Select a leave type'); return; }
    if(!dateFrom || !dateTo){ toast('Set the date range'); return; }
    if(dateTo < dateFrom){ toast('"Date To" cannot be before "Date From"'); return; }
    if(!reason){ toast('Enter a reason for the leave'); return; }
    const days = Math.round((new Date(dateTo+'T00:00:00') - new Date(dateFrom+'T00:00:00'))/86400000)+1;
    const id = leaveGenId(currentUser.id);
    const data = {
      id, userId: currentUser.id, userName: currentUser.name,
      leaveType, dateFrom, dateTo, days, reason, contact,
      status: 'pending', comment: '',
      submittedAt: new Date().toISOString(),
      decidedAt: null, decidedBy: null
    };
    $('leaveSubmitBtn').disabled = true;
    const ok = await leaveSaveRequest(id, data);
    $('leaveSubmitBtn').disabled = false;
    if(ok){
      toast('Leave request submitted for approval');
      leaveResetForm();
      leaveShowTab('history');
    }else toast('Could not submit — check your connection');
  }
  $('leaveSubmitBtn').addEventListener('click', leaveSubmit);

  async function leaveRenderHistory(){
    const list = $('leaveHistoryList');
    if(!currentUser || currentUser.role==='admin') return;
    list.innerHTML = '<div class="empty-state">Loading…</div>';
    const items = await leaveListForUser(currentUser.id);
    if(items.length===0){ list.innerHTML = '<div class="empty-state">No leave requests yet.</div>'; return; }
    list.innerHTML = '';
    items.forEach(r=>{
      const row = document.createElement('div');
      row.className = 'hist-item';
      row.style.cssText = 'cursor:default; flex-direction:column; align-items:stretch;';
      row.innerHTML =
        '<div style="display:flex; justify-content:space-between; align-items:center; gap:10px;">'+
          '<div class="hist-info"><b>'+escapeHtml(r.leaveType)+'</b>'+
            '<span>'+leaveFmtDate(r.dateFrom)+' – '+leaveFmtDate(r.dateTo)+' ('+r.days+(r.days===1?' day':' days')+')</span>'+
          '</div>'+
          leaveStatusPill(r.status)+
        '</div>'+
        (r.comment ? '<div class="leave-comment"><b>Admin comment</b>'+escapeHtml(r.comment)+'</div>' : '');
      list.appendChild(row);
    });
  }

  function leaveShowTab(which){
    $('leaveTabNew').classList.toggle('active', which==='new');
    $('leaveTabHistory').classList.toggle('active', which==='history');
    $('leaveFormCard').style.display = which==='new' ? '' : 'none';
    $('leaveHistoryCard').style.display = which==='history' ? '' : 'none';
    if(which==='history') leaveRenderHistory();
  }
  $('leaveTabNew').addEventListener('click', ()=> leaveShowTab('new'));
  $('leaveTabHistory').addEventListener('click', ()=> leaveShowTab('history'));

  // ---- Admin: review all technicians' requests ----
  let leaveAdminFilter = 'pending';
  async function leaveRenderAdminList(){
    const list = $('leaveAdminList');
    list.innerHTML = '<div class="empty-state">Loading…</div>';
    const all = await leaveListAll();
    const items = leaveAdminFilter==='all' ? all : all.filter(r=> r.status===leaveAdminFilter);
    if(items.length===0){ list.innerHTML = '<div class="empty-state">No '+(leaveAdminFilter==='all'?'':leaveAdminFilter+' ')+'leave requests.</div>'; return; }
    list.innerHTML = '';
    items.forEach(r=>{
      const card = document.createElement('div');
      card.className = 'user-card';
      card.innerHTML =
        '<div class="user-card-head">'+
          '<div>'+
            '<div class="u-name">'+escapeHtml(r.userName)+' — '+escapeHtml(r.leaveType)+'</div>'+
            '<div class="u-status">'+leaveFmtDate(r.dateFrom)+' – '+leaveFmtDate(r.dateTo)+' ('+r.days+(r.days===1?' day':' days')+') · Filed '+leaveFmtWhen(r.submittedAt)+'</div>'+
          '</div>'+
          leaveStatusPill(r.status)+
        '</div>'+
        '<div class="leave-comment" style="margin-top:8px;"><b>Reason</b>'+escapeHtml(r.reason)+'</div>'+
        (r.contact ? '<div class="leave-comment"><b>Contact while on leave</b>'+escapeHtml(r.contact)+'</div>' : '')+
        (r.comment ? '<div class="leave-comment"><b>Admin comment</b>'+escapeHtml(r.comment)+'</div>' : '')+
        '<div class="user-card-actions">'+
          '<button data-act="review" class="primary">'+(r.status==='pending' ? 'Review' : 'Change Decision')+'</button>'+
        '</div>'+
        '<div class="user-edit-panel" data-panel="1">'+
          '<div class="field"><label>Comment (visible to the technician)</label><textarea data-f="comment" rows="2" placeholder="Optional for approval, recommended for disapproval">'+escapeHtml(r.comment||'')+'</textarea></div>'+
          '<div class="edit-save-row">'+
            '<button class="cancel-btn" data-act="disapprove" type="button" style="color:var(--danger); border-color:#F1C4BC;">Disapprove</button>'+
            '<button class="save-btn" data-act="approve" type="button">Approve</button>'+
          '</div>'+
        '</div>';
      const panel = card.querySelector('[data-panel="1"]');
      card.querySelector('[data-act="review"]').addEventListener('click', ()=>{
        list.querySelectorAll('.user-edit-panel.open').forEach(p=>{ if(p!==panel) p.classList.remove('open'); });
        panel.classList.toggle('open');
      });
      card.querySelector('[data-act="approve"]').addEventListener('click', ()=> leaveDecide(r.id, 'approved', panel.querySelector('[data-f="comment"]').value.trim()));
      card.querySelector('[data-act="disapprove"]').addEventListener('click', ()=> leaveDecide(r.id, 'disapproved', panel.querySelector('[data-f="comment"]').value.trim()));
      list.appendChild(card);
    });
  }
  async function leaveDecide(id, status, comment){
    if(status==='disapproved' && !comment){
      if(!confirm('Disapprove without a comment? The technician won\'t know why.')) return;
    }
    const all = await leaveListAll();
    const rec = all.find(r=> r.id===id);
    if(!rec){ toast('Request not found'); return; }
    const updated = Object.assign({}, rec, {
      status, comment,
      decidedAt: new Date().toISOString(),
      decidedBy: currentUser ? currentUser.name : 'Admin'
    });
    const ok = await leaveSaveRequest(id, updated);
    toast(ok ? ('Request '+status) : 'Could not save decision');
    leaveRenderAdminList();
  }
  document.querySelectorAll('#leaveAdminFilterRow button').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      document.querySelectorAll('#leaveAdminFilterRow button').forEach(b=> b.classList.remove('active'));
      btn.classList.add('active');
      leaveAdminFilter = btn.dataset.filter;
      leaveRenderAdminList();
    });
  });


// ---------- Service Dispatch Ticket (table: dispatch_tickets) ----------
  // Admin-created and assigned to one or more technicians; those technicians
  // then acknowledge and later mark it completed. This is the reverse
  // direction from Leave/Cash Advance (which are technician-filed, admin-
  // reviewed) — here admin files, technician actions it.
  function dtGenLocalId(){ return 'JO-'+todayISO().replace(/-/g,'')+'-'+Date.now(); }
  async function dtNextJobOrderNo(){
    const dateStr = todayISO().replace(/-/g,'');
    if(await ensureCloud()){
      try{
        const { data, error } = await db.rpc('next_jo_no', { p_date: todayISO() });
        if(!error && data) return data;
      }catch(e){ console.error('cloud JO counter failed', e); }
    }
    let seq = 1;
    try{
      const res = await window.storage.get('jo-counter:'+dateStr, false);
      seq = res ? (JSON.parse(res.value).seq + 1) : 1;
    }catch(e){ seq = 1; }
    try{ await window.storage.set('jo-counter:'+dateStr, JSON.stringify({seq}), false); }catch(e){}
    return 'JO-'+dateStr+'-'+String(seq).padStart(3,'0');
  }
  async function dtSaveTicket(id, data){
    if(await ensureCloud()){
      try{
        const { error } = await db.from('dispatch_tickets').upsert({
          id, status: data.status||'open',
          created_at: data.createdAt || new Date().toISOString(), data
        });
        if(error) throw error;
        return true;
      }catch(e){ console.error('dispatch save failed', e); }
    }
    try{ await window.storage.set('dispatch:'+id, JSON.stringify(data), false); return true; }
    catch(e){ return false; }
  }
  async function dtListAll(){
    if(await ensureCloud()){
      try{
        const { data, error } = await db.from('dispatch_tickets').select('data').order('created_at',{ascending:false}).limit(300);
        if(error) throw error;
        return (data||[]).map(r=>r.data);
      }catch(e){ console.error('dispatch list failed', e); }
    }
    try{
      const res = await window.storage.list('dispatch:', false);
      const items = [];
      for(const key of (res.keys||[])){
        try{ const item = await window.storage.get(key, false); items.push(JSON.parse(item.value)); }catch(e){}
      }
      items.sort((a,b)=> (b.createdAt||'').localeCompare(a.createdAt||''));
      return items;
    }catch(e){ return []; }
  }
  async function dtListForWorker(workerId){
    const all = await dtListAll();
    return all.filter(t=> (t.assignedWorkerIds||[]).includes(workerId));
  }

  // ---------- Service Report: "From Job Order" picker ----------
  // Shows the technician's own not-yet-completed Job Order tickets at the
  // top of a new report, so tapping one fills in the customer/site/equipment
  // fields captured on the dispatch ticket instead of retyping them.
  async function srRenderJobOrderPicker(){
    const card = $('srJobOrderCard');
    const list = $('srJobOrderList');
    if(!currentUser || currentUser.role==='admin'){ card.style.display = 'none'; return; }
    card.style.display = '';
    list.innerHTML = '<div class="empty-state">Loading…</div>';
    const mine = await dtListForWorker(currentUser.id);
    const openOnes = mine.filter(r=> r.status!=='completed');
    if(openOnes.length===0){
      list.innerHTML = '<div class="empty-state">No Job Order tickets assigned to you right now.</div>';
      return;
    }
    list.innerHTML = '';
    openOnes.forEach(r=>{
      const row = document.createElement('div');
      row.className = 'user-card';
      row.style.cursor = 'pointer';
      row.innerHTML = '<div class="user-card-head">'+
          '<div>'+
            '<div class="u-name">'+escapeHtml(r.jobOrderNo)+' — '+escapeHtml(r.custName)+'</div>'+
            '<div class="u-status">'+leaveFmtDate(r.date)+(r.expectedTime ? (' at '+r.expectedTime) : '')+
              (r.siteAddress ? (' · '+escapeHtml(r.siteAddress)) : '')+'</div>'+
          '</div>'+
          dtStatusPill(r.status)+
        '</div>';
      row.addEventListener('click', ()=> srApplyJobOrder(r));
      list.appendChild(row);
    });
  }
  function srApplyJobOrder(ticket){
    resetForm();
    // Prefer a saved customer record when the name matches — it may have an
    // email on file (dispatch tickets don't capture one), which the report
    // needs for auto-send. Job-order-specific site/contact details still win.
    const matched = customersCache.find(c=> c.name.toLowerCase() === (ticket.custName||'').trim().toLowerCase());
    if(matched){ applyCustomerToForm(matched); }
    else{ $('custName').value = ticket.custName||''; revealSectionsAfterCustomer(); }
    if(ticket.siteAddress) $('custAddress').value = ticket.siteAddress;
    if(ticket.contactName) $('contactPerson').value = ticket.contactName;
    if(ticket.contactNo) $('contactNo').value = ticket.contactNo;
    if(ticket.equipment && ticket.equipment.length){
      $('equipType').value = ticket.equipment.join('; ');
      setEquipTab('addnew');
    }
    if(ticket.scope && ticket.scope.length){
      $('troubleCall').value = ticket.scope.join('; ');
    }
    toast('Job Order '+ticket.jobOrderNo+' applied — check the fields below');
    $('sec1Head').scrollIntoView({behavior:'smooth', block:'start'});
  }

  // ---- simple repeatable-textarea list (equipment / scope items) ----
  function dtAddSimpleRow(containerId, value){
    const wrap = document.createElement('div');
    wrap.className = 'itemrow';
    const ta = document.createElement('textarea');
    ta.rows = 1; ta.value = value || '';
    ta.placeholder = containerId==='dtEquipList' ? 'e.g. Split Type Unit — Living Room' : 'e.g. Clean coils, check refrigerant, test operation';
    const rm = document.createElement('button');
    rm.type = 'button'; rm.className = 'rm-btn'; rm.textContent = '\u2212';
    rm.onclick = () => wrap.remove();
    wrap.appendChild(ta); wrap.appendChild(rm);
    $(containerId).appendChild(wrap);
  }
  document.querySelectorAll('#dtNewCard .add-row-btn[data-target]').forEach(btn=>{
    btn.addEventListener('click', ()=> dtAddSimpleRow(btn.dataset.target));
  });
  function dtCollectSimpleList(containerId){
    return Array.from($(containerId).querySelectorAll('textarea')).map(t=>t.value.trim()).filter(Boolean);
  }

  $('dtReqOthers').addEventListener('change', function(){
    $('dtReqOthersDetailWrap').style.display = this.checked ? '' : 'none';
  });

  // ---- lightweight customer autocomplete scoped to this form's own fields ----
  function dtSetupCustomerCombo(){
    const input = $('dtCustName');
    if(input.dataset.comboAttached) return;
    input.dataset.comboAttached = '1';
    const wrap = $('dtCustNameWrap');
    wrap.style.position = 'relative';
    const panel = document.createElement('div');
    panel.className = 'combo-panel';
    wrap.appendChild(panel);
    function fillFrom(c){
      input.value = c.name;
      $('dtSiteAddress').value = c.address||'';
      $('dtContactName').value = c.contactPerson||'';
      $('dtContactNo').value = c.contactNo||'';
      panel.classList.remove('open');
    }
    function render(filterText){
      const q = (filterText||'').toLowerCase();
      const filtered = customersCache.filter(c=> c.name.toLowerCase().includes(q));
      panel.innerHTML = '';
      if(filtered.length===0){
        const empty = document.createElement('div');
        empty.className = 'combo-empty';
        empty.textContent = customersCache.length===0 ? 'No saved customers yet — just type the name' : 'No matches — new customer? Just fill in the fields below';
        panel.appendChild(empty);
      }
      filtered.slice(0,25).forEach(c=>{
        const row = document.createElement('div');
        row.className = 'combo-item';
        const span = document.createElement('span');
        span.textContent = c.name + (c.address ? '  —  '+c.address : '');
        row.appendChild(span);
        row.addEventListener('mousedown', (e)=> e.preventDefault());
        row.addEventListener('click', ()=> fillFrom(c));
        panel.appendChild(row);
      });
      panel.classList.add('open');
    }
    input.addEventListener('focus', ()=> render(input.value));
    input.addEventListener('input', ()=> render(input.value));
    document.addEventListener('click', (e)=>{ if(!wrap.contains(e.target)) panel.classList.remove('open'); });
  }

  async function dtRenderWorkerChecklist(){
    const box = $('dtWorkerChecklist');
    box.innerHTML = '<div class="empty-state">Loading technicians…</div>';
    const users = (await cloudListUsers()) || [];
    const active = users.filter(u=> u.active!==false);
    if(active.length===0){ box.innerHTML = '<div class="empty-state">No active technicians — add one under Manage Users.</div>'; return; }
    box.innerHTML = '';
    active.sort((a,b)=> a.name.localeCompare(b.name)).forEach(u=>{
      const lbl = document.createElement('label');
      lbl.className = 'chk';
      lbl.innerHTML = '<input type="checkbox" value="'+u.id+'" data-name="'+escapeHtml(u.name)+'"><span>'+escapeHtml(u.name)+'</span>';
      box.appendChild(lbl);
    });
  }

  function dtResetForm(){
    $('dtJobOrderNo').value = '—';
    $('dtDate').value = todayISO();
    $('dtExpectedTime').value = '';
    $('dtCustName').value = ''; $('dtSiteAddress').value = '';
    $('dtContactName').value = ''; $('dtContactNo').value = '';
    $('dtEquipList').innerHTML=''; dtAddSimpleRow('dtEquipList');
    $('dtScopeList').innerHTML=''; dtAddSimpleRow('dtScopeList');
    $('dtRemarks').value = '';
    ['dtReqWorkPermit','dtReqGatePass','dtReqSafety','dtReqOthers'].forEach(id=> $(id).checked=false);
    $('dtReqOthersDetail').value = '';
    $('dtReqOthersDetailWrap').style.display = 'none';
    dtRenderWorkerChecklist();
  }

  async function dtCreateTicket(){
    const workers = Array.from($('dtWorkerChecklist').querySelectorAll('input:checked'))
      .map(el=>({id: el.value, name: el.dataset.name}));
    const custName = $('dtCustName').value.trim();
    if(workers.length===0){ toast('Assign at least one worker'); return; }
    if(!custName){ toast('Enter the customer\'s name'); return; }
    if(!$('dtDate').value){ toast('Set the date'); return; }
    $('dtCreateBtn').disabled = true; $('dtCreateBtn').textContent = 'Creating…';
    const jobOrderNo = await dtNextJobOrderNo();
    const id = jobOrderNo || dtGenLocalId();
    const data = {
      id, jobOrderNo: id, status: 'open',
      date: $('dtDate').value, expectedTime: $('dtExpectedTime').value,
      assignedWorkerIds: workers.map(w=>w.id), assignedWorkerNames: workers.map(w=>w.name),
      custName, siteAddress: $('dtSiteAddress').value.trim(),
      contactName: $('dtContactName').value.trim(), contactNo: $('dtContactNo').value.trim(),
      equipment: dtCollectSimpleList('dtEquipList'), scope: dtCollectSimpleList('dtScopeList'),
      remarks: $('dtRemarks').value.trim(),
      requirements: {
        workPermit: $('dtReqWorkPermit').checked, gatePass: $('dtReqGatePass').checked,
        safety: $('dtReqSafety').checked, others: $('dtReqOthers').checked,
        othersDetail: $('dtReqOthersDetail').value.trim()
      },
      createdAt: new Date().toISOString(),
      createdBy: currentUser ? currentUser.name : 'Admin',
      acknowledgedBy: [], completedAt: null
    };
    const ok = await dtSaveTicket(id, data);
    $('dtCreateBtn').disabled = false; $('dtCreateBtn').textContent = 'Create Dispatch Ticket';
    if(!ok){ toast('Could not create ticket — check your connection'); return; }
    toast('Dispatch ticket '+id+' created');
    dtResetForm();
    $('dtJobOrderNo').value = '—';
  }
  $('dtCreateBtn').addEventListener('click', dtCreateTicket);

  function dtReqSummary(r){
    const items = [];
    if(r.requirements){
      if(r.requirements.workPermit) items.push('Work Permit');
      if(r.requirements.gatePass) items.push('Gate Pass');
      if(r.requirements.safety) items.push('Safety');
      if(r.requirements.others) items.push('Others'+(r.requirements.othersDetail ? (' ('+escapeHtml(r.requirements.othersDetail)+')') : ''));
    }
    return items.length ? items.join(', ') : 'None specified';
  }
  function dtStatusPill(status){
    if(status==='completed') return leaveStatusPill('approved');
    if(status==='acknowledged') return '<span class="status-pill" style="background:#DCEAE0; color:var(--green-dark);">Acknowledged</span>';
    return '<span class="status-pill status-draft">Open</span>';
  }
  function dtCardHtml(r, forAdmin){
    return '<div class="user-card-head">'+
        '<div>'+
          '<div class="u-name">'+escapeHtml(r.jobOrderNo)+' — '+escapeHtml(r.custName)+'</div>'+
          '<div class="u-status">'+leaveFmtDate(r.date)+(r.expectedTime ? (' at '+r.expectedTime) : '')+' · '+escapeHtml((r.assignedWorkerNames||[]).join(', '))+'</div>'+
        '</div>'+
        dtStatusPill(r.status)+
      '</div>'+
      (r.siteAddress ? '<div class="leave-comment"><b>Site Address</b>'+escapeHtml(r.siteAddress)+'</div>' : '')+
      (r.contactName ? '<div class="leave-comment"><b>Contact at Site</b>'+escapeHtml(r.contactName)+(r.contactNo?(' · '+escapeHtml(r.contactNo)):'')+'</div>' : '')+
      (r.equipment && r.equipment.length ? '<div class="leave-comment"><b>Equipment</b>'+r.equipment.map(escapeHtml).join('; ')+'</div>' : '')+
      (r.scope && r.scope.length ? '<div class="leave-comment"><b>Scope of Works</b>'+r.scope.map(escapeHtml).join('; ')+'</div>' : '')+
      (r.remarks ? '<div class="leave-comment"><b>Special Instructions</b>'+escapeHtml(r.remarks)+'</div>' : '')+
      '<div class="leave-comment"><b>Requirements</b>'+dtReqSummary(r)+'</div>'+
      (forAdmin ? '<div class="leave-comment"><b>Created by</b>'+escapeHtml(r.createdBy||'Admin')+'</div>' : '');
  }

  let dtAdminFilter = 'open';
  async function dtRenderAdminList(){
    const list = $('dtAdminList');
    list.innerHTML = '<div class="empty-state">Loading…</div>';
    const all = await dtListAll();
    const items = dtAdminFilter==='all' ? all : all.filter(r=> r.status===dtAdminFilter);
    if(items.length===0){ list.innerHTML = '<div class="empty-state">No '+(dtAdminFilter==='all'?'':dtAdminFilter+' ')+'dispatch tickets.</div>'; return; }
    list.innerHTML = '';
    items.forEach(r=>{
      const card = document.createElement('div');
      card.className = 'user-card';
      card.innerHTML = dtCardHtml(r, true);
      list.appendChild(card);
    });
  }
  document.querySelectorAll('#dtAdminFilterRow button').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      document.querySelectorAll('#dtAdminFilterRow button').forEach(b=> b.classList.remove('active'));
      btn.classList.add('active');
      dtAdminFilter = btn.dataset.filter;
      dtRenderAdminList();
    });
  });
  function dtShowAdminTab(which){
    $('dtTabNew').classList.toggle('active', which==='new');
    $('dtTabAll').classList.toggle('active', which==='all');
    $('dtNewCard').style.display = which==='new' ? '' : 'none';
    $('dtAllCard').style.display = which==='all' ? '' : 'none';
    if(which==='new') dtResetForm(); else dtRenderAdminList();
  }
  $('dtTabNew').addEventListener('click', ()=> dtShowAdminTab('new'));
  $('dtTabAll').addEventListener('click', ()=> dtShowAdminTab('all'));

  let dtTechFilter = 'open';
  async function dtRenderTechList(){
    const list = $('dtTechList');
    if(!currentUser || currentUser.role==='admin') return;
    list.innerHTML = '<div class="empty-state">Loading…</div>';
    const mine = await dtListForWorker(currentUser.id);
    const items = dtTechFilter==='all' ? mine : mine.filter(r=> r.status===dtTechFilter);
    if(items.length===0){ list.innerHTML = '<div class="empty-state">No '+(dtTechFilter==='all'?'':dtTechFilter+' ')+'dispatch tickets assigned to you.</div>'; return; }
    list.innerHTML = '';
    items.forEach(r=>{
      const card = document.createElement('div');
      card.className = 'user-card';
      const alreadyAck = (r.acknowledgedBy||[]).includes(currentUser.id);
      card.innerHTML = dtCardHtml(r, false) +
        '<div class="user-card-actions">'+
          (r.status==='open' && !alreadyAck ? '<button data-act="ack" class="primary">Acknowledge</button>' : '')+
          (r.status==='acknowledged' ? '<button data-act="complete" class="primary">Mark Completed</button>' : '')+
        '</div>';
      const ackBtn = card.querySelector('[data-act="ack"]');
      if(ackBtn) ackBtn.addEventListener('click', ()=> dtAcknowledge(r.id));
      const compBtn = card.querySelector('[data-act="complete"]');
      if(compBtn) compBtn.addEventListener('click', ()=> dtComplete(r.id));
      list.appendChild(card);
    });
  }
  document.querySelectorAll('#dtTechFilterRow button').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      document.querySelectorAll('#dtTechFilterRow button').forEach(b=> b.classList.remove('active'));
      btn.classList.add('active');
      dtTechFilter = btn.dataset.filter;
      dtRenderTechList();
    });
  });
  async function dtAcknowledge(id){
    const all = await dtListAll();
    const rec = all.find(r=> r.id===id);
    if(!rec){ toast('Ticket not found'); return; }
    const ackBy = new Set(rec.acknowledgedBy||[]); ackBy.add(currentUser.id);
    const updated = Object.assign({}, rec, { status: 'acknowledged', acknowledgedBy: Array.from(ackBy) });
    const ok = await dtSaveTicket(id, updated);
    toast(ok ? 'Acknowledged' : 'Could not save');
    dtRenderTechList();
  }
  async function dtComplete(id){
    const all = await dtListAll();
    const rec = all.find(r=> r.id===id);
    if(!rec){ toast('Ticket not found'); return; }
    const updated = Object.assign({}, rec, { status: 'completed', completedAt: new Date().toISOString() });
    const ok = await dtSaveTicket(id, updated);
    toast(ok ? 'Marked completed' : 'Could not save');
    dtRenderTechList();
  }

  async function showDispatchView(){
    $('homeScreen').style.display = 'none';
    $('serviceReportView').style.display = 'none';
    $('dtrView').style.display = 'none';
    $('leaveView').style.display = 'none';
    $('cashAdvanceView').style.display = 'none';
    $('dispatchView').style.display = '';
    $('footerBar').style.display = 'none';
    $('metaBar').style.display = 'none';
    $('homeBtn').style.display = '';
    setHeaderTitle(
      (currentUser && currentUser.role==='admin') ? 'Service Dispatch Ticket' : 'My Job Order',
      'Assign and track field jobs'
    );
    window.scrollTo({top:0});
    dtSetupCustomerCombo();
    if(currentUser && currentUser.role==='admin'){
      $('dispatchTechArea').style.display = 'none';
      $('dispatchAdminArea').style.display = '';
      dtShowAdminTab('new');
    }else{
      $('dispatchAdminArea').style.display = 'none';
      $('dispatchTechArea').style.display = '';
      dtRenderTechList();
    }
  }

  async function showLeaveView(){
    $('homeScreen').style.display = 'none';
    $('serviceReportView').style.display = 'none';
    $('dtrView').style.display = 'none';
    $('cashAdvanceView').style.display = 'none';
    $('dispatchView').style.display = 'none';
    $('leaveView').style.display = '';
    $('footerBar').style.display = 'none';
    $('metaBar').style.display = 'none';
    $('homeBtn').style.display = '';
    setHeaderTitle('Leave Form', 'File and track leave requests');
    window.scrollTo({top:0});
    if(currentUser && currentUser.role==='admin'){
      $('leaveTechArea').style.display = 'none';
      $('leaveAdminArea').style.display = '';
      leaveRenderAdminList();
    }else{
      $('leaveTechArea').style.display = '';
      $('leaveAdminArea').style.display = 'none';
      leaveShowTab('new');
    }
  }


// ---------- Cash Advance Form (table: cash_advance_requests) ----------
  function caGenId(userId){ return userId+'_'+Date.now(); }

  async function caSaveRequest(id, data){
    if(await ensureCloud()){
      try{
        const { error } = await db.from('cash_advance_requests').upsert({
          id, technician_id: data.userId, status: data.status || 'pending',
          submitted_at: data.submittedAt || new Date().toISOString(), data
        });
        if(error) throw error;
        return true;
      }catch(e){ console.error('cash advance save failed', describeCloudError(e)); }
    }
    try{ await window.storage.set('cash:'+id, JSON.stringify(data), false); return true; }
    catch(e){ return false; }
  }
  async function caListAll(){
    if(await ensureCloud()){
      try{
        const { data, error } = await db.from('cash_advance_requests').select('data').order('submitted_at',{ascending:false}).limit(200);
        if(error) throw error;
        return (data||[]).map(r=>r.data);
      }catch(e){ console.error('cash advance list failed', describeCloudError(e)); }
    }
    try{
      const res = await window.storage.list('cash:', false);
      const items = [];
      for(const key of (res.keys||[])){
        try{ const item = await window.storage.get(key, false); items.push(JSON.parse(item.value)); }catch(e){}
      }
      items.sort((a,b)=> (b.submittedAt||'').localeCompare(a.submittedAt||''));
      return items;
    }catch(e){ return []; }
  }
  async function caListForUser(userId){
    const all = await caListAll();
    return all.filter(r=> r.userId===userId);
  }
  function caFmtPeso(n){
    const v = Number(n)||0;
    return '₱'+v.toLocaleString('en-PH', {minimumFractionDigits:2, maximumFractionDigits:2});
  }

  function caResetForm(){
    $('caAmount').value = '';
    $('caPurpose').value = '';
    $('caProject').value = '';
    $('caDateNeeded').value = '';
    $('caLiquidationDate').value = '';
    $('caPaymentMode').value = '';
  }

  // A cash advance still needs liquidation once it's been given, until its
  // liquidation has been submitted AND approved by admin. Disapproved or
  // never-submitted liquidations still count as outstanding.
  function caNeedsLiquidation(r){
    return !!(r.disbursed && (!r.liquidation || r.liquidation.status !== 'approved'));
  }
  async function caFindActiveLiquidationRecord(userId){
    const all = await caListForUser(userId);
    const outstanding = all.filter(caNeedsLiquidation);
    outstanding.sort((a,b)=> (b.disbursedAt||'').localeCompare(a.disbursedAt||''));
    return outstanding[0] || null;
  }

  // Toggles the New Request form vs. the "please liquidate first" reminder.
  // Called whenever the Cash Advance page is opened and whenever the New
  // Request tab is shown, so the block can never be bypassed by navigating
  // away and back.
  async function caCheckBlockedState(){
    if(!currentUser || currentUser.role==='admin') return null;
    const active = await caFindActiveLiquidationRecord(currentUser.id);
    const dot = $('caLiqTabDot');
    if(active){
      $('caFormCard').style.display = 'none';
      $('caBlockedCard').style.display = '';
      const needsSubmit = !active.liquidation || active.liquidation.status==='disapproved';
      $('caBlockedSummary').innerHTML =
        '<div class="leave-comment"><b>'+(needsSubmit ? 'Needs liquidation' : 'Awaiting admin approval')+'</b>'+
        caFmtPeso(active.amountGiven)+' given on '+leaveFmtDate(active.dateGiven)+' — '+escapeHtml(active.purpose)+'</div>'+
        (active.liquidation && active.liquidation.status==='disapproved' && active.liquidation.comment
          ? '<div class="leave-comment"><b>Admin comment</b>'+escapeHtml(active.liquidation.comment)+'</div>' : '');
      $('caGoLiquidateBtn').style.display = needsSubmit ? '' : 'none';
      if(dot) dot.style.display = needsSubmit ? '' : 'none';
    }else{
      $('caFormCard').style.display = '';
      $('caBlockedCard').style.display = 'none';
      if(dot) dot.style.display = 'none';
    }
    return active;
  }
  $('caGoLiquidateBtn').addEventListener('click', ()=> caShowTab('liquidate'));

  async function caSubmit(){
    if(!currentUser || currentUser.role==='admin') return;
    // Re-check right before submitting — the reminder card should already
    // prevent this, but this guards against stale UI state.
    const active = await caFindActiveLiquidationRecord(currentUser.id);
    if(active){ toast('Liquidate your existing cash advance first'); caCheckBlockedState(); return; }
    const amount = parseFloat($('caAmount').value);
    const purpose = $('caPurpose').value.trim();
    const project = $('caProject').value.trim();
    const dateNeeded = $('caDateNeeded').value;
    const liquidationDate = $('caLiquidationDate').value;
    const paymentMode = $('caPaymentMode').value;
    if(!amount || amount<=0){ toast('Enter a valid amount'); return; }
    if(!purpose){ toast('Enter the purpose of the cash advance'); return; }
    if(!dateNeeded){ toast('Set the date needed'); return; }
    if(liquidationDate && liquidationDate < dateNeeded){ toast('Liquidation date cannot be before the date needed'); return; }
    const id = caGenId(currentUser.id);
    const data = {
      id, userId: currentUser.id, userName: currentUser.name,
      amount, purpose, project, dateNeeded, liquidationDate, paymentMode,
      status: 'pending', comment: '',
      submittedAt: new Date().toISOString(),
      decidedAt: null, decidedBy: null,
      disbursed: false, dateGiven: null, amountGiven: null, disbursedAt: null, disbursedBy: null,
      liquidation: null
    };
    $('caSubmitBtn').disabled = true;
    const ok = await caSaveRequest(id, data);
    $('caSubmitBtn').disabled = false;
    if(ok){
      toast('Cash advance request submitted for approval');
      caResetForm();
      caShowTab('history');
    }else toast('Could not submit — check your connection');
  }
  $('caSubmitBtn').addEventListener('click', caSubmit);

  function caLiquidationStatusPill(liq){
    if(!liq) return '<span class="status-pill status-draft">Not Submitted</span>';
    if(liq.status==='approved') return '<span class="status-pill status-done">Liquidated</span>';
    if(liq.status==='disapproved') return '<span class="status-pill status-rejected">Needs Revision</span>';
    return '<span class="status-pill status-draft">Pending Review</span>';
  }

  async function caRenderHistory(){
    const list = $('caHistoryList');
    if(!currentUser || currentUser.role==='admin') return;
    list.innerHTML = '<div class="empty-state">Loading…</div>';
    const items = await caListForUser(currentUser.id);
    if(items.length===0){ list.innerHTML = '<div class="empty-state">No cash advance requests yet.</div>'; return; }
    list.innerHTML = '';
    items.forEach(r=>{
      const row = document.createElement('div');
      row.className = 'hist-item';
      row.style.cssText = 'cursor:default; flex-direction:column; align-items:stretch;';
      let disbursementLine = '';
      if(r.status==='approved'){
        disbursementLine = r.disbursed
          ? '<div class="leave-comment"><b>Cash given</b>'+caFmtPeso(r.amountGiven)+' on '+leaveFmtDate(r.dateGiven)+'</div>'
          : '<div class="leave-comment"><b>Cash given</b>Not yet released</div>';
      }
      const liqLine = r.disbursed
        ? '<div class="leave-comment"><b>Liquidation</b>'+caLiquidationStatusPill(r.liquidation)+
          (r.liquidation && r.liquidation.status==='disapproved' && r.liquidation.comment ? '<div style="margin-top:4px;">'+escapeHtml(r.liquidation.comment)+'</div>' : '')+
          '</div>'
        : '';
      row.innerHTML =
        '<div style="display:flex; justify-content:space-between; align-items:center; gap:10px;">'+
          '<div class="hist-info"><b>'+caFmtPeso(r.amount)+'</b>'+
            '<span>Needed '+leaveFmtDate(r.dateNeeded)+(r.project ? (' · '+escapeHtml(r.project)) : '')+'</span>'+
          '</div>'+
          (r.status==='approved' && r.disbursed ? '<span class="status-pill status-given">Given</span>' : leaveStatusPill(r.status))+
        '</div>'+
        '<div class="leave-comment"><b>Purpose</b>'+escapeHtml(r.purpose)+'</div>'+
        disbursementLine+
        liqLine+
        (r.comment ? '<div class="leave-comment"><b>Admin comment</b>'+escapeHtml(r.comment)+'</div>' : '');
      list.appendChild(row);
    });
  }

  function caShowTab(which){
    $('caTabNew').classList.toggle('active', which==='new');
    $('caTabLiquidate').classList.toggle('active', which==='liquidate');
    $('caTabHistory').classList.toggle('active', which==='history');
    $('caFormCard').style.display = 'none';
    $('caBlockedCard').style.display = 'none';
    $('caLiquidateCard').style.display = which==='liquidate' ? '' : 'none';
    $('caHistoryCard').style.display = which==='history' ? '' : 'none';
    if(which==='new') caCheckBlockedState();
    if(which==='liquidate') caShowLiqTab();
    if(which==='history') caRenderHistory();
  }
  $('caTabNew').addEventListener('click', ()=> caShowTab('new'));
  $('caTabLiquidate').addEventListener('click', ()=> caShowTab('liquidate'));
  $('caTabHistory').addEventListener('click', ()=> caShowTab('history'));

  // ================= Liquidation (technician side) =================
  let caLiqActiveRecord = null;   // the cash-advance record currently being liquidated
  let caLiqItems = [];            // in-progress itemized list {id, type, description, amount, attachmentName, attachmentData, attachmentMime, transportRows}
  let caTransportRows = [];       // in-progress transportation sub-form rows

  function caLiqItemId(){ return 'li_'+Date.now()+'_'+Math.floor(Math.random()*10000); }

  // Downscales & compresses an image file before storing it as base64, to
  // keep receipt photos from a phone camera small enough to save reliably.
  function compressImageToDataURL(file, maxDim, quality){
    maxDim = maxDim || 1000; quality = quality || 0.6;
    return new Promise((resolve, reject)=>{
      const reader = new FileReader();
      reader.onerror = ()=> reject(new Error('read failed'));
      reader.onload = ()=>{
        const img = new Image();
        img.onerror = ()=> reject(new Error('image decode failed'));
        img.onload = ()=>{
          let w = img.width, h = img.height;
          if(w > maxDim || h > maxDim){
            const scale = maxDim / Math.max(w, h);
            w = Math.round(w*scale); h = Math.round(h*scale);
          }
          const canvas = document.createElement('canvas');
          canvas.width = w; canvas.height = h;
          canvas.getContext('2d').drawImage(img, 0, 0, w, h);
          resolve(canvas.toDataURL('image/jpeg', quality));
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  function caLiqRenderItems(){
    const wrap = $('caLiqItemsList');
    wrap.innerHTML = '';
    if(caLiqItems.length===0){
      wrap.innerHTML = '<div class="empty-state">No items yet — add an expense or a transportation entry below.</div>';
    }
    caLiqItems.forEach((item)=>{
      const row = document.createElement('div');
      row.className = 'card';
      row.style.cssText = 'margin-bottom:10px; box-shadow:none; border:1px solid var(--border);';
      if(item.type==='transport'){
        row.innerHTML =
          '<div class="card-body" style="padding:12px;">'+
            '<div style="display:flex; justify-content:space-between; align-items:center; gap:10px;">'+
              '<div><b>🚕 '+escapeHtml(item.description)+'</b><div class="leave-note">'+item.transportRows.length+' trip(s)</div></div>'+
              '<div style="text-align:right;"><div style="font-weight:700;">'+caFmtPeso(item.amount)+'</div></div>'+
            '</div>'+
            '<div style="display:flex; gap:8px; margin-top:8px;">'+
              '<button type="button" class="btn btn-secondary" data-act="view" style="flex:1;">View Trips</button>'+
              '<button type="button" class="btn btn-secondary" data-act="remove" style="flex:1; color:var(--danger);">Remove</button>'+
            '</div>'+
          '</div>';
      }else{
        const hasAttachment = !!item.attachmentData;
        row.innerHTML =
          '<div class="card-body" style="padding:12px;">'+
            '<div class="field" style="margin-bottom:8px;"><label>Description <span class="req">*</span></label>'+
              '<input type="text" data-f="description" placeholder="e.g. Materials receipt, meals, lodging" value="'+escapeHtml(item.description||'')+'"></div>'+
            '<div class="field" style="margin-bottom:8px;"><label>Amount (₱) <span class="req">*</span></label>'+
              '<input type="number" min="0" step="0.01" data-f="amount" value="'+(item.amount||'')+'"></div>'+
            '<div style="display:flex; gap:8px; align-items:center;">'+
              '<input type="file" accept="image/*,application/pdf" capture="environment" data-f="file" style="display:none;">'+
              '<button type="button" class="btn btn-secondary" data-act="attach" style="flex:1;">📎 '+(hasAttachment ? 'Replace File' : 'Attach File')+'</button>'+
              '<button type="button" class="btn btn-secondary" data-act="remove" style="color:var(--danger);">Remove</button>'+
            '</div>'+
            (hasAttachment
              ? '<div style="display:flex; justify-content:space-between; align-items:center; margin-top:8px;"><span class="leave-note">📄 '+escapeHtml(item.attachmentName||'Attached')+'</span><button type="button" class="btn btn-secondary" data-act="view" style="padding:4px 10px; font-size:11px;">View</button></div>'
              : '<div class="leave-note" style="margin-top:8px; color:var(--danger);">Required — attach a receipt photo or file</div>')+
          '</div>';
      }
      wrap.appendChild(row);

      if(item.type==='transport'){
        row.querySelector('[data-act="view"]').addEventListener('click', ()=> openLiquidationAttachment(item));
        row.querySelector('[data-act="remove"]').addEventListener('click', ()=>{
          caLiqItems = caLiqItems.filter(i=> i.id!==item.id);
          caLiqRenderItems(); caLiqUpdateTotals();
        });
      }else{
        row.querySelector('[data-f="description"]').addEventListener('input', (e)=>{ item.description = e.target.value; });
        row.querySelector('[data-f="amount"]').addEventListener('input', (e)=>{ item.amount = parseFloat(e.target.value)||0; caLiqUpdateTotals(); });
        const fileInput = row.querySelector('[data-f="file"]');
        row.querySelector('[data-act="attach"]').addEventListener('click', ()=> fileInput.click());
        fileInput.addEventListener('change', async ()=>{
          const file = fileInput.files[0];
          if(!file) return;
          try{
            if(file.type.startsWith('image/')){
              item.attachmentData = await compressImageToDataURL(file, 1000, 0.6);
              item.attachmentMime = 'image/jpeg';
            }else{
              // Non-image files (e.g. PDF) are stored as-is; keep these small.
              const dataUrl = await new Promise((resolve, reject)=>{
                const r = new FileReader();
                r.onload = ()=> resolve(r.result);
                r.onerror = ()=> reject(new Error('read failed'));
                r.readAsDataURL(file);
              });
              item.attachmentData = dataUrl;
              item.attachmentMime = file.type || 'application/octet-stream';
            }
            item.attachmentName = file.name;
            toast('File attached');
            caLiqRenderItems();
          }catch(e){ toast('Could not attach that file'); }
        });
        if(hasAttachment){
          row.querySelector('[data-act="view"]').addEventListener('click', ()=> openLiquidationAttachment(item));
        }
      }
    });
  }
  $('caLiqAddItemBtn').addEventListener('click', ()=>{
    caLiqItems.push({id: caLiqItemId(), type:'item', description:'', amount:0, attachmentName:null, attachmentData:null, attachmentMime:null});
    caLiqRenderItems();
  });

  function caLiqUpdateTotals(){
    const total = caLiqItems.reduce((s,i)=> s + (Number(i.amount)||0), 0);
    $('caLiqTotalDisplay').textContent = caFmtPeso(total);
    if(caLiqActiveRecord){
      const given = Number(caLiqActiveRecord.amountGiven)||0;
      const diff = given - total;
      const diffEl = $('caLiqDiffDisplay');
      if(Math.abs(diff) < 0.005){
        diffEl.textContent = 'Fully accounted for.';
        diffEl.style.color = '';
      }else if(diff > 0){
        diffEl.textContent = caFmtPeso(diff)+' unspent — you may need to return this amount.';
        diffEl.style.color = 'var(--amber, #B8860B)';
      }else{
        diffEl.textContent = caFmtPeso(Math.abs(diff))+' over the amount given — note the reason above.';
        diffEl.style.color = 'var(--danger)';
      }
    }
    return total;
  }

  // ---- Transportation sub-form ----
  function caTransportRowTemplate(){
    return {date: todayISO(), mode:'', from:'', to:'', amount:0, purpose:''};
  }
  function caTransportRenderRows(){
    const wrap = $('caTransportRowsList');
    wrap.innerHTML = '';
    caTransportRows.forEach((row, idx)=>{
      const el = document.createElement('div');
      el.className = 'card';
      el.style.cssText = 'margin-bottom:10px; box-shadow:none; border:1px solid var(--border);';
      el.innerHTML =
        '<div class="card-body" style="padding:12px;">'+
          '<div class="grid2">'+
            '<div class="field"><label>Date</label><input type="date" data-f="date" value="'+escapeHtml(row.date||'')+'"></div>'+
            '<div class="field"><label>Mode of Transportation</label><input type="text" data-f="mode" placeholder="e.g. Bus" value="'+escapeHtml(row.mode||'')+'"></div>'+
          '</div>'+
          '<div class="grid2">'+
            '<div class="field"><label>From</label><input type="text" data-f="from" value="'+escapeHtml(row.from||'')+'"></div>'+
            '<div class="field"><label>To</label><input type="text" data-f="to" value="'+escapeHtml(row.to||'')+'"></div>'+
          '</div>'+
          '<div class="grid2">'+
            '<div class="field"><label>Amount (₱)</label><input type="number" min="0" step="0.01" data-f="amount" value="'+(row.amount||'')+'"></div>'+
            '<div class="field"><label>Purpose</label><input type="text" data-f="purpose" value="'+escapeHtml(row.purpose||'')+'"></div>'+
          '</div>'+
          (caTransportRows.length>1 ? '<button type="button" class="btn btn-secondary" data-act="remove-row" style="width:100%; color:var(--danger);">Remove This Trip</button>' : '')+
        '</div>';
      wrap.appendChild(el);
      el.querySelector('[data-f="date"]').addEventListener('input', (e)=>{ row.date = e.target.value; });
      const modeInput = el.querySelector('[data-f="mode"]');
      attachCombo(modeInput, 'transportMode');
      modeInput.addEventListener('input', (e)=>{ row.mode = e.target.value; });
      el.querySelector('[data-f="from"]').addEventListener('input', (e)=>{ row.from = e.target.value; });
      el.querySelector('[data-f="to"]').addEventListener('input', (e)=>{ row.to = e.target.value; });
      el.querySelector('[data-f="amount"]').addEventListener('input', (e)=>{ row.amount = parseFloat(e.target.value)||0; caTransportUpdateTotal(); });
      el.querySelector('[data-f="purpose"]').addEventListener('input', (e)=>{ row.purpose = e.target.value; });
      const rmBtn = el.querySelector('[data-act="remove-row"]');
      if(rmBtn) rmBtn.addEventListener('click', ()=>{ caTransportRows.splice(idx,1); caTransportRenderRows(); caTransportUpdateTotal(); });
    });
  }
  function caTransportUpdateTotal(){
    const total = caTransportRows.reduce((s,r)=> s + (Number(r.amount)||0), 0);
    $('caTransportTotalDisplay').textContent = caFmtPeso(total);
    return total;
  }
  $('caTransportAddRowBtn').addEventListener('click', ()=>{
    caTransportRows.push(caTransportRowTemplate());
    caTransportRenderRows();
  });
  $('caTransportAddToLiqBtn').addEventListener('click', ()=>{
    const valid = caTransportRows.filter(r=> r.date && r.mode && r.from && r.to && r.amount>0);
    if(valid.length===0){ toast('Fill in at least one complete trip (date, mode, from, to, amount)'); return; }
    const total = valid.reduce((s,r)=> s + (Number(r.amount)||0), 0);
    caLiqItems.push({
      id: caLiqItemId(), type:'transport',
      description: 'Transportation Expenses ('+valid.length+' trip'+(valid.length>1?'s':'')+')',
      amount: total, transportRows: valid
    });
    caTransportRows = [caTransportRowTemplate()];
    caTransportRenderRows(); caTransportUpdateTotal();
    caLiqRenderItems(); caLiqUpdateTotals();
    toast('Added to liquidation');
  });

  function openLiquidationAttachment(item){
    if(item.type==='transport'){
      $('liqAttachmentTitle').textContent = item.description;
      $('liqAttachmentImageWrap').style.display = 'none';
      $('liqAttachmentTransportWrap').style.display = '';
      const body = $('liqAttachmentTransportBody');
      body.innerHTML = '';
      item.transportRows.forEach(r=>{
        const tr = document.createElement('tr');
        tr.style.borderBottom = '1px solid var(--border)';
        tr.innerHTML =
          '<td style="padding:6px 4px;">'+leaveFmtDate(r.date)+'</td>'+
          '<td style="padding:6px 4px;">'+escapeHtml(r.mode)+'</td>'+
          '<td style="padding:6px 4px;">'+escapeHtml(r.from)+'</td>'+
          '<td style="padding:6px 4px;">'+escapeHtml(r.to)+'</td>'+
          '<td style="padding:6px 4px; text-align:right;">'+caFmtPeso(r.amount)+'</td>'+
          '<td style="padding:6px 4px;">'+escapeHtml(r.purpose||'')+'</td>';
        body.appendChild(tr);
      });
    }else{
      $('liqAttachmentTitle').textContent = item.description || 'Attachment';
      $('liqAttachmentTransportWrap').style.display = 'none';
      if(item.attachmentMime && item.attachmentMime.startsWith('image/')){
        $('liqAttachmentImageWrap').style.display = '';
        $('liqAttachmentImg').src = item.attachmentData;
      }else{
        // Non-image (e.g. PDF) — open it directly rather than trying to
        // render it inline.
        window.open(item.attachmentData, '_blank');
      }
    }
    $('liqAttachmentOverlay').classList.add('open');
  }
  $('closeLiqAttachment').addEventListener('click', ()=> $('liqAttachmentOverlay').classList.remove('open'));
  $('liqAttachmentOverlay').addEventListener('click', (e)=>{ if(e.target.id==='liqAttachmentOverlay') $('liqAttachmentOverlay').classList.remove('open'); });

  function caLiqRenderReadonly(record){
    const wrap = $('caLiqReadonlyItems');
    const liq = record.liquidation;
    let html = '<div class="leave-comment" style="margin-bottom:10px;">'+caLiquidationStatusPill(liq)+
      '<div style="margin-top:6px;">Total liquidated: <b>'+caFmtPeso(liq.totalAmount)+'</b> of '+caFmtPeso(record.amountGiven)+' given</div>'+
      (liq.comment ? '<div style="margin-top:6px;"><b>Notes</b> '+escapeHtml(liq.comment)+'</div>' : '')+
      '</div>';
    liq.items.forEach(item=>{
      html += '<div class="hist-item" style="cursor:pointer;" data-view-item="'+item.id+'">'+
        '<div class="hist-info"><b>'+(item.type==='transport'?'🚕 ':'📄 ')+escapeHtml(item.description)+'</b>'+
        '<span>'+caFmtPeso(item.amount)+'</span></div></div>';
    });
    wrap.innerHTML = html;
    liq.items.forEach(item=>{
      const el = wrap.querySelector('[data-view-item="'+item.id+'"]');
      if(el) el.addEventListener('click', ()=> openLiquidationAttachment(item));
    });
  }

  async function caShowLiqTab(){
    if(!currentUser || currentUser.role==='admin') return;
    const active = await caFindActiveLiquidationRecord(currentUser.id);
    caLiqActiveRecord = active;
    if(!active){
      $('caLiquidateEmpty').style.display = '';
      $('caLiquidateActive').style.display = 'none';
      return;
    }
    $('caLiquidateEmpty').style.display = 'none';
    $('caLiquidateActive').style.display = '';
    $('caLiquidateSummary').innerHTML =
      '<div class="leave-comment"><b>Cash Advance</b>'+caFmtPeso(active.amountGiven)+' given on '+leaveFmtDate(active.dateGiven)+
      ' — '+escapeHtml(active.purpose)+(active.project ? ' ('+escapeHtml(active.project)+')' : '')+'</div>';

    const needsForm = !active.liquidation || active.liquidation.status==='disapproved';
    $('caLiqEditView').style.display = needsForm ? '' : 'none';
    $('caLiqReadonlyView').style.display = needsForm ? 'none' : '';

    if(needsForm){
      if(active.liquidation && active.liquidation.status==='disapproved'){
        // Reload previous items so the technician can fix and resubmit
        // rather than starting from scratch.
        caLiqItems = (active.liquidation.items||[]).map(i=> Object.assign({}, i));
        $('caLiqNotes').value = active.liquidation.comment && active.liquidation.userNotes ? active.liquidation.userNotes : '';
        const banner = document.createElement('div');
        banner.className = 'dtr-banner dtr-banner-warn';
        banner.style.display = 'block';
        banner.style.marginBottom = '12px';
        banner.textContent = 'Disapproved — '+(active.liquidation.comment || 'please review and resubmit.');
        $('caLiqEditView').prepend(banner);
      }else{
        caLiqItems = [];
        $('caLiqNotes').value = '';
      }
      caTransportRows = [caTransportRowTemplate()];
      caLiqRenderItems();
      caTransportRenderRows(); caTransportUpdateTotal();
      caLiqUpdateTotals();
    }else{
      caLiqRenderReadonly(active);
    }
  }

  async function caSubmitLiquidation(){
    if(!caLiqActiveRecord) return;
    if(caLiqItems.length===0){ toast('Add at least one item'); return; }
    for(const item of caLiqItems){
      if(item.type==='transport') continue;
      if(!item.description || !item.description.trim()){ toast('Every item needs a description'); return; }
      if(!item.amount || item.amount<=0){ toast('Every item needs a valid amount'); return; }
      if(!item.attachmentData){ toast('Attach a file for every item — "'+item.description+'" is missing one'); return; }
    }
    const totalAmount = caLiqUpdateTotals();
    const notes = $('caLiqNotes').value.trim();
    const all = await caListAll();
    const rec = all.find(r=> r.id===caLiqActiveRecord.id);
    if(!rec){ toast('Cash advance record not found'); return; }
    const updated = Object.assign({}, rec, {
      liquidation: {
        status: 'pending',
        items: caLiqItems,
        totalAmount,
        comment: notes, userNotes: notes,
        submittedAt: new Date().toISOString(),
        decidedAt: null, decidedBy: null
      }
    });
    $('caLiqSubmitBtn').disabled = true;
    const ok = await caSaveRequest(rec.id, updated);
    $('caLiqSubmitBtn').disabled = false;
    if(ok){
      toast('Liquidation submitted for approval');
      caShowTab('history');
    }else toast('Could not submit — check your connection');
  }
  $('caLiqSubmitBtn').addEventListener('click', caSubmitLiquidation);

  // ================= Admin: review requests, disbursement, liquidation =================
  let caAdminFilter = 'pending';
  async function caRenderAdminList(){
    const list = $('caAdminList');
    list.innerHTML = '<div class="empty-state">Loading…</div>';
    const all = await caListAll();
    let items;
    if(caAdminFilter==='all') items = all;
    else if(caAdminFilter==='given') items = all.filter(r=> r.disbursed);
    else if(caAdminFilter==='toReviewLiq') items = all.filter(r=> r.liquidation && r.liquidation.status==='pending');
    else items = all.filter(r=> r.status===caAdminFilter);
    if(items.length===0){ list.innerHTML = '<div class="empty-state">No '+(caAdminFilter==='all'?'':caAdminFilter+' ')+'cash advance requests.</div>'; return; }
    list.innerHTML = '';
    items.forEach(r=>{
      const card = document.createElement('div');
      card.className = 'user-card';
      const disbursedSummary = r.disbursed
        ? '<div class="leave-comment" style="background:#EAF5FC; border-color:#C6E2F2;"><b>Cash given</b>'+caFmtPeso(r.amountGiven)+' on '+leaveFmtDate(r.dateGiven)+(r.disbursedBy ? (' · recorded by '+escapeHtml(r.disbursedBy)) : '')+'</div>'
        : '';
      let liqSummary = '';
      if(r.disbursed){
        if(!r.liquidation){
          liqSummary = '<div class="leave-comment"><b>Liquidation</b> ⏳ Not yet submitted</div>';
        }else{
          liqSummary = '<div class="leave-comment"><b>Liquidation</b> '+caLiquidationStatusPill(r.liquidation)+
            ' — '+caFmtPeso(r.liquidation.totalAmount)+' across '+r.liquidation.items.length+' item(s)'+
            (r.liquidation.comment ? '<div style="margin-top:4px;">'+escapeHtml(r.liquidation.comment)+'</div>' : '')+
            '</div>';
        }
      }
      card.innerHTML =
        '<div class="user-card-head">'+
          '<div>'+
            '<div class="u-name">'+escapeHtml(r.userName)+' — '+caFmtPeso(r.amount)+'</div>'+
            '<div class="u-status">Needed '+leaveFmtDate(r.dateNeeded)+(r.project ? (' · '+escapeHtml(r.project)) : '')+' · Filed '+leaveFmtWhen(r.submittedAt)+'</div>'+
          '</div>'+
          (r.status==='approved' && r.disbursed ? '<span class="status-pill status-given">Given</span>' : leaveStatusPill(r.status))+
        '</div>'+
        '<div class="leave-comment" style="margin-top:8px;"><b>Purpose</b>'+escapeHtml(r.purpose)+'</div>'+
        (r.liquidationDate ? '<div class="leave-comment"><b>Expected liquidation</b>'+leaveFmtDate(r.liquidationDate)+'</div>' : '')+
        (r.paymentMode ? '<div class="leave-comment"><b>Preferred payment mode</b>'+escapeHtml(r.paymentMode)+'</div>' : '')+
        (r.comment ? '<div class="leave-comment"><b>Admin comment</b>'+escapeHtml(r.comment)+'</div>' : '')+
        disbursedSummary+
        liqSummary+
        '<div class="user-card-actions">'+
          '<button data-act="review" class="primary">'+(r.status==='pending' ? 'Review' : 'Change Decision')+'</button>'+
          (r.status==='approved' ? '<button data-act="disburse-toggle">'+(r.disbursed ? 'Edit Disbursement' : 'Record Disbursement')+'</button>' : '')+
          (r.liquidation ? '<button data-act="liq-toggle">'+(r.liquidation.status==='pending' ? 'Review Liquidation' : 'View Liquidation')+'</button>' : '')+
        '</div>'+
        '<div class="user-edit-panel" data-panel="decision">'+
          '<div class="field"><label>Comment (visible to the technician)</label><textarea data-f="comment" rows="2" placeholder="Optional for approval, recommended for disapproval">'+escapeHtml(r.comment||'')+'</textarea></div>'+
          '<div class="edit-save-row">'+
            '<button class="cancel-btn" data-act="disapprove" type="button" style="color:var(--danger); border-color:#F1C4BC;">Disapprove</button>'+
            '<button class="save-btn" data-act="approve" type="button">Approve</button>'+
          '</div>'+
        '</div>'+
        (r.status==='approved' ?
          '<div class="user-edit-panel" data-panel="disbursement">'+
            '<div class="grid2">'+
              '<div class="field"><label>Date Given</label><input type="date" data-f="dateGiven" value="'+escapeHtml(r.dateGiven || todayISO())+'"></div>'+
              '<div class="field"><label>Amount Given (₱)</label><input type="number" min="0" step="0.01" data-f="amountGiven" value="'+(r.amountGiven != null ? r.amountGiven : r.amount)+'"></div>'+
            '</div>'+
            '<div class="edit-save-row">'+
              '<button class="save-btn" data-act="confirm-disburse" type="button">Confirm Given</button>'+
            '</div>'+
          '</div>' : '')+
        (r.liquidation ?
          '<div class="user-edit-panel" data-panel="liquidation" id="liqPanel_'+r.id+'"></div>' : '');
      const decisionPanel = card.querySelector('[data-panel="decision"]');
      const disbursePanel = card.querySelector('[data-panel="disbursement"]');
      const liqPanel = card.querySelector('[data-panel="liquidation"]');
      const allPanels = [decisionPanel, disbursePanel, liqPanel].filter(Boolean);
      card.querySelector('[data-act="review"]').addEventListener('click', ()=>{
        allPanels.forEach(p=>{ if(p!==decisionPanel) p.classList.remove('open'); });
        decisionPanel.classList.toggle('open');
      });
      card.querySelector('[data-act="approve"]').addEventListener('click', ()=> caDecide(r.id, 'approved', decisionPanel.querySelector('[data-f="comment"]').value.trim()));
      card.querySelector('[data-act="disapprove"]').addEventListener('click', ()=> caDecide(r.id, 'disapproved', decisionPanel.querySelector('[data-f="comment"]').value.trim()));
      const disburseToggleBtn = card.querySelector('[data-act="disburse-toggle"]');
      if(disburseToggleBtn){
        disburseToggleBtn.addEventListener('click', ()=>{
          allPanels.forEach(p=>{ if(p!==disbursePanel) p.classList.remove('open'); });
          disbursePanel.classList.toggle('open');
        });
      }
      const confirmDisburseBtn = card.querySelector('[data-act="confirm-disburse"]');
      if(confirmDisburseBtn){
        confirmDisburseBtn.addEventListener('click', ()=>{
          const dateGiven = disbursePanel.querySelector('[data-f="dateGiven"]').value;
          const amountGiven = parseFloat(disbursePanel.querySelector('[data-f="amountGiven"]').value);
          caRecordDisbursement(r.id, dateGiven, amountGiven);
        });
      }
      const liqToggleBtn = card.querySelector('[data-act="liq-toggle"]');
      if(liqToggleBtn && liqPanel){
        liqToggleBtn.addEventListener('click', ()=>{
          allPanels.forEach(p=>{ if(p!==liqPanel) p.classList.remove('open'); });
          const opening = !liqPanel.classList.contains('open');
          liqPanel.classList.toggle('open');
          if(opening) caRenderLiqAdminPanel(r, liqPanel);
        });
      }
      list.appendChild(card);
    });
  }

  function caRenderLiqAdminPanel(r, panel){
    const liq = r.liquidation;
    let html = '<div class="field"><label>Items</label></div>';
    liq.items.forEach(item=>{
      html += '<div class="hist-item" style="cursor:pointer;" data-view-item="'+item.id+'">'+
        '<div class="hist-info"><b>'+(item.type==='transport'?'🚕 ':'📄 ')+escapeHtml(item.description)+'</b>'+
        '<span>'+caFmtPeso(item.amount)+'</span></div></div>';
    });
    html += '<div style="display:flex; justify-content:space-between; font-weight:700; margin:8px 0;"><span>Total</span><span>'+caFmtPeso(liq.totalAmount)+' of '+caFmtPeso(r.amountGiven)+' given</span></div>';
    if(liq.userNotes) html += '<div class="leave-comment"><b>Technician notes</b>'+escapeHtml(liq.userNotes)+'</div>';
    if(liq.status==='pending'){
      html +=
        '<div class="field"><label>Comment (visible to the technician)</label><textarea data-f="liqComment" rows="2" placeholder="Optional for approval, recommended for disapproval"></textarea></div>'+
        '<div class="edit-save-row">'+
          '<button class="cancel-btn" data-act="liq-disapprove" type="button" style="color:var(--danger); border-color:#F1C4BC;">Disapprove</button>'+
          '<button class="save-btn" data-act="liq-approve" type="button">Approve Liquidation</button>'+
        '</div>';
    }else{
      html += '<div class="leave-comment">'+caLiquidationStatusPill(liq)+
        (liq.decidedBy ? ' · decided by '+escapeHtml(liq.decidedBy) : '')+
        (liq.comment ? '<div style="margin-top:4px;">'+escapeHtml(liq.comment)+'</div>' : '')+'</div>';
    }
    panel.innerHTML = html;
    liq.items.forEach(item=>{
      const el = panel.querySelector('[data-view-item="'+item.id+'"]');
      if(el) el.addEventListener('click', ()=> openLiquidationAttachment(item));
    });
    const approveBtn = panel.querySelector('[data-act="liq-approve"]');
    const disapproveBtn = panel.querySelector('[data-act="liq-disapprove"]');
    if(approveBtn) approveBtn.addEventListener('click', ()=> caDecideLiquidation(r.id, 'approved', panel.querySelector('[data-f="liqComment"]').value.trim()));
    if(disapproveBtn) disapproveBtn.addEventListener('click', ()=> caDecideLiquidation(r.id, 'disapproved', panel.querySelector('[data-f="liqComment"]').value.trim()));
  }

  async function caDecideLiquidation(id, status, comment){
    if(status==='disapproved' && !comment){
      if(!confirm('Disapprove without a comment? The technician won\'t know why.')) return;
    }
    const all = await caListAll();
    const rec = all.find(r=> r.id===id);
    if(!rec || !rec.liquidation){ toast('Liquidation not found'); return; }
    const updated = Object.assign({}, rec, {
      liquidation: Object.assign({}, rec.liquidation, {
        status, comment,
        decidedAt: new Date().toISOString(),
        decidedBy: currentUser ? currentUser.name : 'Admin'
      })
    });
    const ok = await caSaveRequest(id, updated);
    toast(ok ? ('Liquidation '+status) : 'Could not save decision');
    caRenderAdminList();
  }

  async function caDecide(id, status, comment){
    if(status==='disapproved' && !comment){
      if(!confirm('Disapprove without a comment? The technician won\'t know why.')) return;
    }
    const all = await caListAll();
    const rec = all.find(r=> r.id===id);
    if(!rec){ toast('Request not found'); return; }
    const updated = Object.assign({}, rec, {
      status, comment,
      decidedAt: new Date().toISOString(),
      decidedBy: currentUser ? currentUser.name : 'Admin'
    });
    const ok = await caSaveRequest(id, updated);
    toast(ok ? ('Request '+status) : 'Could not save decision');
    caRenderAdminList();
  }
  // Monitoring: records that the requested cash was actually handed over, with
  // the date and amount actually given (which can differ from what was requested).
  async function caRecordDisbursement(id, dateGiven, amountGiven){
    if(!dateGiven){ toast('Set the date the cash was given'); return; }
    if(!amountGiven || amountGiven<=0){ toast('Enter a valid amount given'); return; }
    const all = await caListAll();
    const rec = all.find(r=> r.id===id);
    if(!rec){ toast('Request not found'); return; }
    const updated = Object.assign({}, rec, {
      disbursed: true, dateGiven, amountGiven,
      disbursedAt: new Date().toISOString(),
      disbursedBy: currentUser ? currentUser.name : 'Admin'
    });
    const ok = await caSaveRequest(id, updated);
    toast(ok ? 'Disbursement recorded' : 'Could not save disbursement');
    caRenderAdminList();
  }
  document.querySelectorAll('#caAdminFilterRow button').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      document.querySelectorAll('#caAdminFilterRow button').forEach(b=> b.classList.remove('active'));
      btn.classList.add('active');
      caAdminFilter = btn.dataset.filter;
      caRenderAdminList();
    });
  });

  async function showCashAdvanceView(){
    $('homeScreen').style.display = 'none';
    $('serviceReportView').style.display = 'none';
    $('dtrView').style.display = 'none';
    $('leaveView').style.display = 'none';
    $('cashAdvanceView').style.display = '';
    $('footerBar').style.display = 'none';
    $('metaBar').style.display = 'none';
    $('homeBtn').style.display = '';
    setHeaderTitle('Cash Advance Form', 'Request and track cash advances');
    window.scrollTo({top:0});
    if(currentUser && currentUser.role==='admin'){
      $('caTechArea').style.display = 'none';
      $('caAdminArea').style.display = '';
      caRenderAdminList();
    }else{
      $('caTechArea').style.display = '';
      $('caAdminArea').style.display = 'none';
      caShowTab('new');
    }
  }


// ---------- Header title (changes per feature page) ----------
  function setHeaderTitle(title, sub){
    $('brandName').textContent = title;
    $('brandSub').textContent = sub || '';
  }

  async function showDtrView(){
    $('homeScreen').style.display = 'none';
    $('serviceReportView').style.display = 'none';
    $('leaveView').style.display = 'none';
    $('cashAdvanceView').style.display = 'none';
    $('dispatchView').style.display = 'none';
    $('dtrView').style.display = '';
    $('footerBar').style.display = 'none';
    $('metaBar').style.display = 'none';
    $('homeBtn').style.display = '';
    setHeaderTitle('Online DTR', 'Daily Time Record');
    window.scrollTo({top:0});
    if(currentUser && currentUser.role==='admin'){
      // Admin has no DTR of their own — DTR is per-technician, so ask which one.
      $('dtrTechCard').style.display = 'none';
      $('dtrAdminViewingCard').style.display = '';
      dtrViewingUser = null;
      $('dtrHistoryList').innerHTML = '<div class="empty-state">Select a technician to view their DTR.</div>';
      dtrOpenAdminPicker();
    }else if(currentUser){
      $('dtrTechCard').style.display = '';
      $('dtrAdminViewingCard').style.display = 'none';
      $('dtrTechName').textContent = currentUser.name;
      dtrViewingUser = null;
      await dtrRenderDeviceBanner();
      await dtrRenderTodayStatus();
      await dtrRenderHistory();
    }
  }

  // ---------- Home screen (feature tiles) ----------
  function showHome(){
    $('homeScreen').style.display = '';
    $('serviceReportView').style.display = 'none';
    $('dtrView').style.display = 'none';
    $('leaveView').style.display = 'none';
    $('cashAdvanceView').style.display = 'none';
    $('dispatchView').style.display = 'none';
    $('footerBar').style.display = 'none';
    $('metaBar').style.display = 'none';
    $('homeBtn').style.display = 'none';
    setHeaderTitle("Technician's Homepage", 'Field digital form');
    $('tile_dispatch_label').textContent = (currentUser && currentUser.role==='admin') ? 'Service Dispatch Ticket' : 'My Job Order';
    window.scrollTo({top:0});
  }
  // ---------- Service Report: Create New / View History tabs ----------
  function srShowTab(which){
    $('srTabNewBtn').classList.toggle('active', which==='new');
    $('srTabHistoryBtn').classList.toggle('active', which==='history');
    $('srNewPanel').style.display = which==='new' ? '' : 'none';
    $('srHistoryPanel').style.display = which==='history' ? '' : 'none';
    // The footer (Save Draft / Generate Report) and the SR-No./status meta
    // bar only make sense while actively filling out a report.
    $('footerBar').style.display = which==='new' ? 'flex' : 'none';
    $('metaBar').style.display = which==='new' ? '' : 'none';
    if(which==='new') srRenderJobOrderPicker();
    if(which==='history') loadHistory('srHistoryList');
  }
  $('srTabNewBtn').addEventListener('click', ()=> srShowTab('new'));
  $('srTabHistoryBtn').addEventListener('click', ()=> srShowTab('history'));

  function showServiceReport(){
    $('homeScreen').style.display = 'none';
    $('dtrView').style.display = 'none';
    $('leaveView').style.display = 'none';
    $('cashAdvanceView').style.display = 'none';
    $('dispatchView').style.display = 'none';
    $('serviceReportView').style.display = '';
    $('homeBtn').style.display = '';
    setHeaderTitle('Service Report', 'Field digital form');
    srShowTab('new');
    window.scrollTo({top:0});
  }
  function enterApp(){
    showHome();
  }
  $('tile_serviceReport').addEventListener('click', showServiceReport);
  $('tile_dtr').addEventListener('click', showDtrView);
  // Coming-soon tiles don't navigate to a real page yet, so the header title
  // change is shown briefly alongside the toast, then reverts to the home
  // title once the toast fades (avoids leaving a mismatched header behind
  // on a screen that's still showing the home tile grid).
  function flashComingSoonHeader(title, message){
    setHeaderTitle(title, 'Field digital form');
    toast(message);
    setTimeout(()=>{ if($('homeScreen').style.display !== 'none') setHeaderTitle("Technician's Homepage", 'Field digital form'); }, 2200);
  }
  $('tile_cashAdvance').addEventListener('click', showCashAdvanceView);
  $('tile_dispatch').addEventListener('click', showDispatchView);
  $('tile_leave').addEventListener('click', showLeaveView);
  $('tile_materialRequest').addEventListener('click', ()=> flashComingSoonHeader('Material Request Form', 'Material Request Form — coming soon'));
  $('homeBtn').addEventListener('click', showHome);

})();

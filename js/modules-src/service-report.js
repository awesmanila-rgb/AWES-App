// ---------- SR number counter (persisted, shared when cloud is connected) ----------
  let currentSrNo = null;
  // Tracks which technician a report belongs to across edits. Set when a
  // report is freshly created (the logged-in user) or reopened from history
  // (the report's original technician) — NOT reset to "whoever is currently
  // editing" on every save, since an admin reviewing/fixing someone else's
  // report shouldn't reassign it to themselves.
  let currentTechnicianId = null;
  async function nextSrNo(){
    const dateStr = ($('svcDate').value || todayISO()).replace(/-/g,'');
    if(await ensureCloud()){
      const cloudSr = await cloudNextSrNo(dateStr);
      if(cloudSr) return cloudSr;
    }
    // Offline fallback. The old code produced a plain 'SR-YYYYMMDD-001' from a
    // per-device counter, so two technicians working offline on the same day
    // both generated SR-...-001 and whichever synced second silently
    // overwrote the other's report (sr_no is the conflict key). Offline numbers
    // are now clearly provisional and carry a device tag so they can never
    // collide; the real sequential number is assigned when the report uploads.
    let seq = 1;
    try{
      const res = await window.storage.get('sr-counter:'+dateStr, false);
      seq = res ? (JSON.parse(res.value).seq + 1) : 1;
    }catch(e){ seq = 1; }
    try{ await window.storage.set('sr-counter:'+dateStr, JSON.stringify({seq}), false); }catch(e){}
    const tag = String(getDtrDeviceId()).replace(/[^a-z0-9]/gi,'').slice(-4).toUpperCase() || 'LOCL';
    return 'SR-'+dateStr+'-P'+tag+'-'+String(seq).padStart(3,'0');
  }
  // Provisional numbers are the ones minted offline by the branch above.
  function isProvisionalSrNo(srNo){ return /-P[A-Z0-9]{2,6}-\d+$/.test(srNo||''); }

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

  // ---------- components / parts table ----------
  let materialRowCount = 0;
  function addMaterialRow(data){
    data = data || {};
    materialRowCount++;
    const itemNo = materialRowCount;
    const tr = document.createElement('tr');
    tr.innerHTML =
      '<td class="letter-cell">'+itemNo+'.</td>'+
      '<td><input type="text" class="m-desc" value="'+escapeHtml(data.description||data.details||'')+'"></td>'+
      '<td class="qty-cell"><input type="text" class="m-qty" value="'+escapeHtml(data.qty||'')+'"></td>'+
      '<td class="unit-cell"><input type="text" class="m-unit" value="'+escapeHtml(data.unit||'')+'"></td>'+
      '<td><button type="button" class="rm-btn" style="width:32px;height:32px;">\u2212</button></td>';
    tr.querySelector('.rm-btn').onclick = () => { tr.remove(); relabelMaterialRows(); };
    $('materialsBody').appendChild(tr);
    attachCombo(tr.querySelector('.m-desc'), 'm_desc');
    attachCombo(tr.querySelector('.m-qty'), 'm_qty');
    attachCombo(tr.querySelector('.m-unit'), 'm_unit');
    $('materialsTableWrap').style.display = '';
  }
  function relabelMaterialRows(){
    const rows = $('materialsBody').querySelectorAll('tr');
    materialRowCount = rows.length;
    rows.forEach((tr,i)=>{ tr.querySelector('.letter-cell').textContent = (i+1)+'.'; });
    if(rows.length===0) $('materialsTableWrap').style.display = 'none';
  }
  $('addMaterialRow').addEventListener('click', ()=> addMaterialRow());

  // ---------- installation toggle ----------
  $('isInstallToggle').addEventListener('change', function(){
    $('installSection').classList.toggle('open', this.checked);
  });

  // ---------- signature pads (lazy-loaded) ----------
  let sigCustomerPad = null, sigTechPad = null, sigPadsPromise = null;
  // Whether each pad currently holds a "finalized" signature. Locking a pad
  // stops it from accepting new strokes (via pad.off()) until it's cleared,
  // so a signed signature can't accidentally get drawn over or altered.
  const sigLocked = {sigCustomer:false, sigTech:false};
  const sigPadById = () => ({sigCustomer:sigCustomerPad, sigTech:sigTechPad});
  function lockSignature(padId){
    const pad = sigPadById()[padId];
    if(!pad || pad.isEmpty()) return;
    sigLocked[padId] = true;
    pad.off();
    const box = $(padId).closest('.sig-box');
    if(box) box.classList.add('locked');
  }
  function unlockSignature(padId){
    const pad = sigPadById()[padId];
    if(pad) pad.on();
    sigLocked[padId] = false;
    const box = $(padId).closest('.sig-box');
    if(box) box.classList.remove('locked');
  }
  function setupSigPad(canvasId, phId){
    const canvas = $(canvasId);
    // Preserves the drawn strokes across a canvas resize. Resizing a canvas
    // element (setting .width/.height) always blanks it in the browser, and
    // this resize handler runs on every 'resize' event — including the ones
    // mobile browsers fire when the on-screen keyboard opens or closes while
    // the technician is typing into an unrelated field further down the
    // form. That used to wipe out an already-drawn signature; now the pad's
    // stroke data is captured beforehand and redrawn after resizing.
    function resize(){
      const ratio = Math.max(window.devicePixelRatio || 1, 1);
      const rect = canvas.parentElement.getBoundingClientRect();
      const data = (pad && !pad.isEmpty()) ? pad.toData() : null;
      canvas.width = rect.width * ratio;
      canvas.height = rect.height * ratio;
      canvas.getContext('2d').scale(ratio, ratio);
      pad.clear();
      if(data) pad.fromData(data);
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
  loadFieldLists().then(async ()=>{
    await seedDefaultLists();
    await loadCustomers();
    attachAllCombos();
    checkLoginGate();
    // Try to push anything stranded from a previous offline session. The banner
    // itself is shown much earlier (see core.js) — it must not wait on this
    // chain, which can sit for up to 12s behind the CDN load timeout.
    if(navigator.onLine) outboxFlush({quiet:true});
  });
  // "Confirm Signature" is the explicit action that locks a pad — drawing a
  // stroke no longer locks it by itself, so the technician/customer can
  // redo strokes freely and only locks it in once they're happy with it.
  document.querySelectorAll('[data-confirm]').forEach(btn=>{
    btn.addEventListener('click', async ()=>{
      await ensureSignaturePads();
      const padId = btn.dataset.confirm;
      const pad = sigPadById()[padId];
      if(!pad || pad.isEmpty()){ toast('Please sign before confirming'); return; }
      lockSignature(padId);
    });
  });
  document.querySelectorAll('[data-clear]').forEach(btn=>{
    btn.addEventListener('click', async ()=>{
      await ensureSignaturePads();
      const padId = btn.dataset.clear;
      const map = {sigCustomer:sigCustomerPad, sigTech:sigTechPad};
      map[padId].clear();
      unlockSignature(padId); // clearing always re-opens the pad for a fresh signature
      $(padId+'Ph').style.display='flex';
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
    m_desc:{label:'Components — Item Description', group:'Components'},
    m_qty:{label:'Components — Qty', group:'Components'},
    m_unit:{label:'Components — Unit', group:'Components'},
    servicesDone:{label:'Services Done', group:'Services Done'},
    custPrintedName:{label:'Customer Printed Name', group:'Acknowledgment'},
    techName:{label:'Technician Name', group:'Acknowledgment'}
  };
  const GROUP_ORDER = ['Customer Info','Equipment','Report Summary','Components','Services Done','Operating Data','Installation Data','Acknowledgment'];

  let fieldLists = {};
  let adminMode = false;
  // Admin credentials now live in real Supabase Auth, not a stored PIN.
  // This synthetic email is the convention used when the admin account was created
  // in Supabase (see setup instructions) — change it here if a different email was used.
  const ADMIN_EMAIL = 'awes.manila@gmail.com';
  function techEmail(technicianId){ return technicianId + '@awes-app.local'; }
  // Re-verifies the admin's password against Supabase Auth.
  //
  // This used to call db.auth.signInWithPassword() on the SHARED client, which
  // silently replaced whatever session was active. A technician who typed the
  // admin password into the prompt was logged in AS THE ADMIN for the rest of
  // the visit, with the admin's real Supabase JWT persisted in local storage —
  // full privilege escalation, and it also stranded the technician's own
  // identity for report attribution. The old comment claiming this was "safe
  // because it's the same already-logged-in user" was simply wrong: the caller
  // is usually NOT the admin.
  //
  // The fix is a throwaway client with persistSession:false and its own
  // storageKey, so the sign-in attempt validates the password and then
  // evaporates without touching the live session.
  let verifyClientPromise = null;
  async function getVerifyClient(){
    if(!verifyClientPromise){
      verifyClientPromise = (async ()=>{
        if(!(await ensureCloud())) return null;
        const cfg = getCloudConfig();
        if(!cfg || !cfg.url || !cfg.anonKey) return null;
        if(!window.supabase || !window.supabase.createClient) return null;
        return window.supabase.createClient(cfg.url, cfg.anonKey, {
          auth: {
            persistSession: false,
            autoRefreshToken: false,
            detectSessionInUrl: false,
            storageKey: 'awes-verify-only'
          }
        });
      })().catch(()=>null);
    }
    return verifyClientPromise;
  }
  async function verifyAdminPassword(pw){
    if(!pw) return false;
    const client = await getVerifyClient();
    if(!client) return false;
    try{
      const { data, error } = await client.auth.signInWithPassword({ email: ADMIN_EMAIL, password: pw });
      // Always tear the throwaway session down, whatever the outcome.
      try{ await client.auth.signOut(); }catch(e){}
      return !error && !!(data && data.user);
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

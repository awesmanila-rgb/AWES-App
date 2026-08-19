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

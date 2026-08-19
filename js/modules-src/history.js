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

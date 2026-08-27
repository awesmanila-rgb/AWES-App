// ---------- history ----------
  async function loadHistory(containerId, filter){
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
    if(filter==='draft') reports = reports.filter(d=> !d.completed);
    else if(filter==='completed') reports = reports.filter(d=> d.completed);
    // filter==='all' (or omitted) keeps everything, unfiltered.
    if(reports.length===0){
      const emptyMsg = filter==='draft' ? 'No draft reports yet.'
        : filter==='completed' ? 'No completed reports yet.'
        : 'No saved reports yet.';
      list.innerHTML = '<div class="empty-state">'+emptyMsg+'</div>';
      return;
    }
    list.innerHTML = '';
    reports.forEach(d=>{
      const row = document.createElement('div');
      row.className = 'hist-item';
      // Customer names are free text typed by technicians, so they must be
      // escaped before being injected as HTML.
      // Drafts aren't finished yet, so they get actions for finishing/removing
      // the draft rather than the open/PDF actions that make sense once a
      // report is completed. This is keyed off the report's own completed
      // state (not the current tab) so it's also correct on the "All" tab,
      // which mixes drafts and completed reports in one list.
      const isDraft = !d.completed;
      row.innerHTML =
        '<div class="hist-info"><b>'+escapeHtml(d.custName||'Untitled')+'</b>'+
        '<span>'+escapeHtml(d.srNo||'')+' · '+escapeHtml(d.date||'')+' · '+(d.completed?'Completed':'Draft')+'</span></div>'+
        (isDraft
          ? '<div class="hist-actions"><button data-act="continue">Continue</button><button data-act="delete" class="danger">Delete</button></div>'
          : '<div class="hist-actions"><button data-act="open">Open</button><button data-act="pdf">PDF</button></div>');
      if(isDraft){
        // "Continue" reopens the draft in the form so the technician can
        // finish filling it out and submit it — same underlying action as
        // opening a report, just labeled for what a draft actually needs next.
        row.querySelector('[data-act="continue"]').addEventListener('click', async (e)=>{
          e.stopPropagation();
          try{ await openReport(d); }
          catch(err){ console.error('openReport failed', err); toast('Could not open this draft'); }
        });
        row.querySelector('[data-act="delete"]').addEventListener('click', async (e)=>{
          e.stopPropagation();
          if(!confirm('Delete this draft? "'+(d.custName||'Untitled')+'" ('+(d.srNo||'')+') cannot be recovered.')) return;
          try{
            let ok = false;
            if(await ensureCloud()) ok = await cloudDeleteReport(d.srNo);
            try{ await window.storage.delete('report:'+d.srNo, false); ok = true; }catch(e){}
            if(ok){ toast('Draft deleted'); row.remove(); }
            else toast('Could not delete this draft');
          }catch(err){ console.error('delete draft failed', err); toast('Could not delete this draft'); }
        });
      }else{
        row.querySelector('[data-act="open"]').addEventListener('click', async (e)=>{
          e.stopPropagation();
          try{ await openReport(d); }
          catch(err){ console.error('openReport failed', err); toast('Could not open this report'); }
        });
        // This handler used to be un-caught: any error inside buildPdf (and there
        // was one for every cloud-loaded report) rejected silently and the button
        // simply appeared to do nothing.
        row.querySelector('[data-act="pdf"]').addEventListener('click', async (e)=>{
          e.stopPropagation();
          try{
            const doc = await buildPdf(d);
            await shareOrDownloadPdf(doc, (d.srNo||'service-report')+'.pdf');
          }catch(err){
            console.error('PDF generation failed', err);
            toast('Could not generate PDF for this report');
          }
        });
      }
      list.appendChild(row);
    });
  }
  async function openReport(d){
    resetForm();
    currentSrNo = d.srNo; $('metaSrNo').textContent = d.srNo||'—';
    currentTechnicianId = d.technicianId || (currentUser ? currentUser.id : null);
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
    $('sec1Card').style.display = '';
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
    // Legacy/cloud rows can carry partial objects (e.g. {} or a missing `amp`
    // array), which used to throw on `d.before.amp[0]`. Normalise first.
    {
      const before = normalizeOperatingData(d.before);
      $('b_amp_l1').value=before.amp[0]||''; $('b_amp_l2').value=before.amp[1]||''; $('b_amp_l3').value=before.amp[2]||'';
      $('b_volt_l12').value=before.volt[0]||''; $('b_volt_l23').value=before.volt[1]||''; $('b_volt_l31').value=before.volt[2]||'';
      $('b_press_suction').value=before.pressure[0]||''; $('b_press_discharge').value=before.pressure[1]||'';
      $('b_temp').value=before.temp||''; $('b_airflow').value=before.airflow||'';
      const after = normalizeOperatingData(d.after);
      $('a_amp_l1').value=after.amp[0]||''; $('a_amp_l2').value=after.amp[1]||''; $('a_amp_l3').value=after.amp[2]||'';
      $('a_volt_l12').value=after.volt[0]||''; $('a_volt_l23').value=after.volt[1]||''; $('a_volt_l31').value=after.volt[2]||'';
      $('a_press_suction').value=after.pressure[0]||''; $('a_press_discharge').value=after.pressure[1]||'';
      $('a_temp').value=after.temp||''; $('a_airflow').value=after.airflow||'';
    }
    $('isInstallToggle').checked = !!d.isInstall;
    $('installSection').classList.toggle('open', !!d.isInstall);
    {
      const inst = normalizeInstallData(d.install);
      $('pd_suction').value=inst.pd[0]||''; $('pd_discharge').value=inst.pd[1]||''; $('pd_drain').value=inst.pd[2]||'';
      $('pl_refline').value=inst.pl[0]||''; $('pl_drain').value=inst.pl[1]||'';
      $('ws_feeder').value=inst.ws[0]||''; $('ws_control').value=inst.ws[1]||'';
      $('circuit_breaker').value=inst.breaker||'';
      $('pi_refline').value=inst.pi[0]||''; $('pi_drain').value=inst.pi[1]||'';
      $('riser_height').value=inst.riser||''; $('ptrap').value=inst.ptrap||'';
      $('bracketType').value=inst.bracketType||'';
    }
    $('timeIn').value=d.timeIn||''; $('timeOut').value=d.timeOut||''; $('remarks').value=d.remarks||'';
    $('custPrintedName').value=d.custPrintedName||''; $('techName').value=d.techName || (currentUser ? currentUser.name : '') || '';
    const sigCust = asSignature(d.sigCustomer), sigTech = asSignature(d.sigTech);
    if(sigCust){ await ensureSignaturePads(); sigCustomerPad.fromDataURL(sigCust); $('sigCustomerPh').style.display='none'; }
    if(sigTech){ await ensureSignaturePads(); sigTechPad.fromDataURL(sigTech); $('sigTechPh').style.display='none'; }
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
    const pin = await askPassword({ label: 'Enter the Admin Password to continue' });
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
  // Nominatim is a free, donation-funded service with a strict usage policy:
  // one request per second, and it blocks clients that don't identify
  // themselves. Every time-in, time-out, OT-in and OT-out was firing an
  // un-identified request, which is exactly the pattern that gets an app's
  // traffic blocked outright — at which point every punch would silently record
  // bare coordinates instead of an address.
  //
  // Two mitigations: identify the app via the Referer the browser already sends
  // plus an explicit contact e-mail parameter (the policy's documented method,
  // since browsers forbid setting User-Agent from JS), and cache results so
  // repeated punches from the same spot cost zero requests.
  const GEO_CONTACT = 'awes.manila@gmail.com';
  const GEO_CACHE_KEY = 'geocode-cache';
  const GEO_CACHE_MAX = 200;
  const GEO_TTL_MS = 30 * 24 * 60 * 60 * 1000; // addresses don't move
  let geoCache = null;

  async function geoCacheLoad(){
    if(geoCache) return geoCache;
    try{
      const rec = await storage.get(GEO_CACHE_KEY);
      geoCache = rec && rec.value ? JSON.parse(rec.value) : {};
    }catch(e){ geoCache = {}; }
    return geoCache;
  }
  async function geoCacheSave(){
    try{
      const keys = Object.keys(geoCache);
      if(keys.length > GEO_CACHE_MAX){
        // Drop the oldest entries so this can never grow without bound.
        keys.sort((a,b)=> (geoCache[a].t||0) - (geoCache[b].t||0))
            .slice(0, keys.length - GEO_CACHE_MAX)
            .forEach(k=> delete geoCache[k]);
      }
      await storage.set(GEO_CACHE_KEY, JSON.stringify(geoCache));
    }catch(e){ /* cache is an optimisation only */ }
  }

  async function dtrReverseGeocode(lat, lng){
    // ~5 decimal places is roughly a metre, which is finer than phone GPS
    // accuracy, so rounding to 4 (~11m) makes repeat punches at the same site
    // land on the same cache key.
    const key = Number(lat).toFixed(4)+','+Number(lng).toFixed(4);
    const cache = await geoCacheLoad();
    const hit = cache[key];
    if(hit && (Date.now() - (hit.t||0)) < GEO_TTL_MS) return hit.a || null;

    try{
      const ctrl = new AbortController();
      const timer = setTimeout(()=> ctrl.abort(), 8000);
      const url = 'https://nominatim.openstreetmap.org/reverse?format=jsonv2'
        + '&lat='+encodeURIComponent(lat)
        + '&lon='+encodeURIComponent(lng)
        + '&zoom=18&addressdetails=1'
        + '&email='+encodeURIComponent(GEO_CONTACT);
      const res = await fetch(url, {signal: ctrl.signal, headers:{'Accept-Language':'en'}});
      clearTimeout(timer);
      if(!res.ok){
        console.warn('reverse geocode rejected', res.status);
        return hit ? (hit.a || null) : null;   // stale beats nothing
      }
      const data = await res.json();
      const addr = (data && data.display_name) ? data.display_name : null;
      cache[key] = {a: addr, t: Date.now()};
      await geoCacheSave();
      return addr;
    }catch(e){
      return hit ? (hit.a || null) : null;
    }
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
        return SAVE_CLOUD;
      }catch(e){ console.error('dtr save failed', describeCloudError(e)); }
    }
    try{
      await window.storage.set('dtr:'+userId+':'+dateISO, JSON.stringify(data), false);
      // Queued so a time-in recorded in a basement or a client site with no
      // signal still reaches the shared record instead of staying on the phone.
      return (await outboxQueue('dtr', userId+'|'+dateISO, data)) ? SAVE_QUEUED : SAVE_FAILED;
    }catch(e){ return SAVE_FAILED; }
  }
  registerOutboxHandler('dtr', async (key, payload)=>{
    const sep = key.lastIndexOf('|');
    const userId = key.slice(0, sep), dateISO = key.slice(sep+1);
    const { error } = await db.from('dtr_records').upsert(
      { technician_id: userId, date: dateISO, data: payload },
      { onConflict: 'technician_id,date' }
    );
    if(error) throw error;
  });
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

  // Accepts an optional preloadedRec (the record we JUST saved) to avoid
  // re-querying the server immediately after a write — a fresh read right
  // after a save was intermittently returning the pre-save state (likely a
  // browser HTTP cache serving the identical GET request URL), leaving the
  // screen showing blank/old times until the technician navigated away and
  // back, even though the save itself had already succeeded.
  async function dtrRenderTodayStatus(preloadedRec){
    if(!currentUser || currentUser.role==='admin') return;
    const dateISO = todayISO();
    $('dtrTodayDate').textContent = dtrFmtDateLabel(dateISO);
    const rec = preloadedRec !== undefined ? preloadedRec : await dtrGetDay(currentUser.id, dateISO);
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
    const sinceY = since.getFullYear(), sinceM = String(since.getMonth()+1).padStart(2,'0'), sinceD = String(since.getDate()).padStart(2,'0');
    const sinceISO = sinceY+'-'+sinceM+'-'+sinceD;
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
        '<div class="hist-info"><b>'+escapeHtml(dtrFmtDateLabel(d.date))+'</b>'+
        '<span>In: '+escapeHtml(inTxt)+' &nbsp;·&nbsp; Out: '+escapeHtml(outTxt)+'</span>'+
        ((otInTxt || otOutTxt) ? '<span>OT In: '+escapeHtml(otInTxt||'—')+' &nbsp;·&nbsp; OT Out: '+escapeHtml(otOutTxt||'—')+'</span>' : '')+
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

  // Turns a tri-state save result into an honest message. The old code treated
  // any truthy return as success, so a device-only save was reported exactly
  // like a cloud save and a total failure was reported as success too.
  function dtrSaveToast(res, label){
    if(res===SAVE_CLOUD) return label;
    if(res===SAVE_QUEUED) return label+' (saved on this device \u2014 it will sync when you are online)';
    return 'Could not save \u2014 please try again';
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
    const res = await dtrSaveDay(currentUser.id, dateISO, rec);
    toast(dtrSaveToast(res, 'Timed in at '+dtrFmtTime(now)));
    await dtrRenderTodayStatus(res===SAVE_FAILED ? undefined : rec);
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
    const res = await dtrSaveDay(currentUser.id, dateISO, rec);
    toast(dtrSaveToast(res, 'Timed out at '+dtrFmtTime(now)));
    await dtrRenderTodayStatus(res===SAVE_FAILED ? undefined : rec);
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
    const res = await dtrSaveDay(currentUser.id, dateISO, rec);
    toast(dtrSaveToast(res, 'Overtime timed in at '+dtrFmtTime(now)));
    await dtrRenderTodayStatus(res===SAVE_FAILED ? undefined : rec);
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
    const res = await dtrSaveDay(currentUser.id, dateISO, rec);
    toast(dtrSaveToast(res, 'Overtime timed out at '+dtrFmtTime(now)));
    await dtrRenderTodayStatus(res===SAVE_FAILED ? undefined : rec);
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


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
  // IMPORTANT: must return the device's LOCAL calendar date, not UTC.
  // toISOString() always converts to UTC first — for Philippine time (UTC+8),
  // that meant anyone clocking in before 8:00 AM local time got their DTR
  // entry filed under YESTERDAY's date, while clocking out later the same
  // local day (after the UTC rollover) looked up TODAY's date instead and
  // found no matching record — blocking Time Out or creating a duplicate,
  // separate entry. Using local getters instead avoids this entirely.
  function todayISO(){
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth()+1).padStart(2,'0');
    const day = String(d.getDate()).padStart(2,'0');
    return y+'-'+m+'-'+day;
  }
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
    }catch(e){
      // A corrupt override used to fail completely silently, so the app would
      // quietly fall back to the built-in project with no clue why the custom
      // one was ignored. Log it and clear the bad value so it stops happening.
      console.warn('Ignoring unreadable cloud-config override, using defaults', e);
      try{ localStorage.removeItem('cloud-config'); }catch(_){}
    }
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
      // A custom fetch that forces cache:'no-store' on every request the
      // Supabase client makes. Without this, the browser's own HTTP cache
      // can serve an identical earlier GET request's response instead of
      // hitting the network fresh — which was causing screens (Today's DTR
      // status, History, etc.) to intermittently show stale data right
      // after a save, until the user navigated away and back.
      const noCacheFetch = (url, options) => fetch(url, { ...options, cache: 'no-store' });
      db = window.supabase.createClient(cfg.url, cfg.anonKey, { global: { fetch: noCacheFetch } });
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
    if(!cloudInitPromise){
      // If this attempt fails (e.g. a brief signal drop while the Supabase
      // library was loading), don't permanently cache the failure — clear
      // the promise so the NEXT call retries fresh instead of silently
      // falling back to this device's local-only data for the rest of the
      // session (which is how technicians ended up seeing an incomplete
      // list, or just themselves, on flaky field connections).
      cloudInitPromise = doCloudInit().then(ok=>{
        if(!ok) cloudInitPromise = null;
        return ok;
      });
    }
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
  // Maps the report object built by gatherData() <-> the Postgres snake_case
  // columns.
  //
  // IMPORTANT: the key names below MUST match what gatherData() in ui.js
  // actually produces, and what pdf.js / history.js actually read back. They
  // previously did not: reportToRow looked for data.recommendations,
  // data.installation, data.customerSignature, data.customerPrintedName and
  // data.technicianName, while gatherData emits recs, install, sigCustomer,
  // custPrintedName and techName. The result was that on EVERY cloud save the
  // recommendations, both signatures, both printed names and all installation
  // data were written as empty and permanently lost — invisible on the
  // technician's own phone because the local copy keeps the correct shape.
  // Do not "tidy" these names without changing gatherData/pdf.js to match.
  const REPORT_STRING_FIELDS = [
    ['sr_no','srNo'], ['technician_id','technicianId'], ['date','date'],
    ['cust_name','custName'], ['cust_address','custAddress'], ['contact_no','contactNo'],
    ['contact_person','contactPerson'], ['cust_email','custEmail'], ['equip_type','equipType'],
    ['model_cu','modelCU'], ['serial_cu','serialCU'], ['model_fcu','modelFCU'], ['serial_fcu','serialFCU'],
    ['cool_cap','coolCap'], ['mount_type','mountType'], ['brand','brand'], ['refrigerant_type','refrigerantType'],
    ['compressor_type','compressorType'], ['equip_location','equipLocation'], ['trouble_call','troubleCall'],
    ['time_in','timeIn'], ['time_out','timeOut'], ['remarks','remarks'],
    ['customer_printed_name','custPrintedName'], ['technician_name','techName']
  ];
  function reportToRow(data){
    const row = {};
    REPORT_STRING_FIELDS.forEach(([col, key])=>{ row[col] = data[key] != null ? data[key] : null; });
    row.findings      = data.findings || [];
    row.recommendations = data.recs || [];
    row.materials     = data.materials || [];
    row.services_done = data.servicesDone || [];
    row.before_data   = data.before || {};
    row.after_data    = data.after || {};
    row.is_install    = !!data.isInstall;
    row.installation  = data.install || {};
    // Signatures are PNG data-URL strings. Default to null, never {} — an
    // empty object is indistinguishable from "signature was lost in transit".
    row.customer_signature   = data.sigCustomer || null;
    row.technician_signature = data.sigTech || null;
    row.completed = !!data.completed;
    return row;
  }
  function rowToReport(row){
    if(!row) return null;
    const data = {};
    REPORT_STRING_FIELDS.forEach(([col, key])=>{ data[key] = row[col]; });
    data.findings     = row.findings || [];
    data.recs         = row.recommendations || [];
    data.materials    = row.materials || [];
    data.servicesDone = row.services_done || [];
    data.before       = normalizeOperatingData(row.before_data);
    data.after        = normalizeOperatingData(row.after_data);
    data.isInstall    = !!row.is_install;
    data.install      = normalizeInstallData(row.installation);
    data.sigCustomer  = asSignature(row.customer_signature);
    data.sigTech      = asSignature(row.technician_signature);
    data.completed    = !!row.completed;
    return data;
  }
  // Legacy rows may hold {} (or a stray object) where a data-URL string was
  // expected, because of the field-name bug described above. Treat anything
  // that is not a data URL as "no signature" rather than handing jsPDF a
  // value it will throw on.
  function asSignature(v){
    return (typeof v === 'string' && v.indexOf('data:image') === 0) ? v : null;
  }
  // pdf.js calls .join() on these arrays, so guarantee their shape even for
  // rows written by older versions of the app.
  function normalizeOperatingData(d){
    d = d || {};
    return {
      amp:      Array.isArray(d.amp) ? d.amp : ['','',''],
      volt:     Array.isArray(d.volt) ? d.volt : ['','',''],
      pressure: Array.isArray(d.pressure) ? d.pressure : ['',''],
      temp:     d.temp || '',
      airflow:  d.airflow || ''
    };
  }
  function normalizeInstallData(d){
    d = d || {};
    return {
      pd: Array.isArray(d.pd) ? d.pd : ['','',''],
      pl: Array.isArray(d.pl) ? d.pl : ['',''],
      ws: Array.isArray(d.ws) ? d.ws : ['',''],
      pi: Array.isArray(d.pi) ? d.pi : ['',''],
      breaker: d.breaker || '', riser: d.riser || '',
      ptrap: d.ptrap || '', bracketType: d.bracketType || ''
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
  // Reports store the customer's name as free text captured at filing time,
  // not a reference to the customers row — so renaming a customer in Manage
  // Customers leaves every past report under the old name, and they silently
  // drop out of that customer's History tab (its equipment-history match is
  // keyed on name). Called from the customer-edit save handler whenever the
  // name actually changes, so renames stay self-healing instead of quietly
  // orphaning history. Matches case/whitespace-insensitively client-side
  // (rather than via .ilike, which would misfire on names containing SQL
  // wildcard characters like % or _) and returns how many rows were updated.
  async function cloudRenameReportsCustomer(oldName, newName){
    if(!(await ensureCloud())) return 0;
    const target = (oldName||'').trim().toLowerCase();
    if(!target) return 0;
    try{
      const { data, error } = await db.from('service_reports').select('sr_no, cust_name');
      if(error) throw error;
      const srNos = (data||[])
        .filter(r=> (r.cust_name||'').trim().toLowerCase() === target)
        .map(r=> r.sr_no);
      if(srNos.length===0) return 0;
      const { error: updErr } = await db.from('service_reports').update({ cust_name: newName }).in('sr_no', srNos);
      if(updErr) throw updErr;
      return srNos.length;
    }catch(e){ console.error('rename reports customer failed', describeCloudError(e)); return 0; }
  }
  async function cloudDeleteReport(srNo){
    if(!(await ensureCloud())) return false;
    try{
      // .select() makes Postgrest return the rows it actually deleted. Without
      // it, a delete blocked by RLS (or a srNo that doesn't exist) comes back
      // with no error and looks identical to a real delete — the row silently
      // survives and reappears the next time the list reloads from the cloud.
      const { data, error } = await db.from('service_reports').delete().eq('sr_no', srNo).select('sr_no');
      if(error) throw error;
      return !!(data && data.length > 0);
    }catch(e){ console.error('cloud delete report failed', srNo, describeCloudError(e)); return false; }
  }
  async function cloudGetReport(srNo){
    if(!(await ensureCloud())) return null;
    try{
      const { data, error } = await db.from('service_reports').select('*').eq('sr_no', srNo).maybeSingle();
      if(error) throw error;
      return rowToReport(data);
    }catch(e){ console.error('cloud get report failed', srNo, describeCloudError(e)); return null; }
  }
  // History used to be hard-capped at the newest 150 reports with no indication
  // that anything had been cut off, so older jobs simply became invisible in the
  // app even though they were sitting in the database. Page through instead.
  const REPORT_PAGE = 200;      // Supabase caps a single response at 1000 rows
  const REPORT_MAX_ROWS = 5000; // hard stop so a huge table can't exhaust memory
  async function cloudListReports(){
    if(!(await ensureCloud())) return null;
    try{
      const rows = [];
      for(let from = 0; from < REPORT_MAX_ROWS; from += REPORT_PAGE){
        const { data, error } = await db.from('service_reports')
          .select('*')
          .order('date',{ascending:false})
          .order('sr_no',{ascending:false})   // stable tiebreak: without it, rows
                                              // sharing a date can repeat or be
                                              // skipped across page boundaries
          .range(from, from + REPORT_PAGE - 1);
        if(error) throw error;
        const batch = data || [];
        rows.push(...batch);
        if(batch.length < REPORT_PAGE) break;
      }
      return rows.map(rowToReport);
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

  // ---------- password prompt ----------
  // window.prompt() was used for every admin-password gate. On iOS Safari that
  // dialog shows the typed password in clear text (and in screenshots), it can't
  // be styled to match the app, and several in-app browsers (Facebook, Messenger,
  // Gmail) block it outright — in which case prompt() returns null and the admin
  // could never get past the gate. This overlay is a proper masked input.
  function askPassword(opts){
    opts = opts || {};
    const overlay = $('adminPwOverlay');
    if(!overlay){
      // Extremely defensive: if the markup is missing, fall back rather than
      // leaving the caller hanging on a promise that never settles.
      return Promise.resolve(window.prompt(opts.label || 'Enter Admin Password') || null);
    }
    const input = $('adminPwInput'), msg = $('adminPwMsg');
    $('adminPwTitle').textContent = opts.title || 'Admin Password';
    $('adminPwLabel').textContent = opts.label || 'Enter Admin Password';
    input.placeholder = opts.placeholder || 'Password';
    input.value = '';
    msg.textContent = opts.message || '';
    overlay.classList.add('open');
    setTimeout(()=>{ try{ input.focus(); }catch(e){} }, 60);

    return new Promise(resolve=>{
      let done = false;
      function finish(value){
        if(done) return;
        done = true;
        overlay.classList.remove('open');
        input.value = '';   // never leave the password sitting in the DOM
        msg.textContent = '';
        cleanup();
        resolve(value);
      }
      const onOk = ()=> finish(input.value ? input.value : null);
      const onCancel = ()=> finish(null);
      const onKey = (e)=>{
        if(e.key==='Enter'){ e.preventDefault(); onOk(); }
        else if(e.key==='Escape'){ e.preventDefault(); onCancel(); }
      };
      const onBackdrop = (e)=>{ if(e.target===overlay) onCancel(); };
      function cleanup(){
        $('adminPwOk').removeEventListener('click', onOk);
        $('adminPwCancel').removeEventListener('click', onCancel);
        $('adminPwCancel2').removeEventListener('click', onCancel);
        input.removeEventListener('keydown', onKey);
        overlay.removeEventListener('click', onBackdrop);
      }
      $('adminPwOk').addEventListener('click', onOk);
      $('adminPwCancel').addEventListener('click', onCancel);
      $('adminPwCancel2').addEventListener('click', onCancel);
      input.addEventListener('keydown', onKey);
      overlay.addEventListener('click', onBackdrop);
    });
  }

  // ---------- outbox: pending cloud writes ----------
  // Anything saved while the phone has no usable connection used to be written
  // to local storage only and then forgotten: History falls back to local data
  // ONLY while still offline, so as soon as signal returned the offline work
  // became invisible and was never uploaded. The only recovery was the manual
  // "upload this device's data" button, which covered reports and field lists
  // but not DTR, customers, leave, cash advances or dispatch tickets.
  //
  // Every save helper now queues a pending operation instead, and the outbox is
  // flushed on app start, whenever the browser fires 'online', and after any
  // successful cloud call.
  const OUTBOX_PREFIX = 'outbox:';
  const SAVE_CLOUD  = 'cloud';   // written straight to the shared cloud
  const SAVE_QUEUED = 'queued';  // saved on this device, queued for upload
  const SAVE_FAILED = 'failed';  // could not be stored at all
  const outboxHandlers = Object.create(null);

  // Each module registers how to replay its own kind of pending write.
  // handler(id, payload) must throw if the cloud rejected the write; returning
  // normally is treated as success.
  function registerOutboxHandler(kind, handler){ outboxHandlers[kind] = handler; }

  function outboxKey(kind, id){
    // ':' is used as the separator, so keep ids from splitting the key.
    return OUTBOX_PREFIX + kind + ':' + String(id).replace(/:/g, '_');
  }
  async function outboxQueue(kind, id, payload){
    try{
      await window.storage.set(outboxKey(kind, id), JSON.stringify({
        kind, id, payload, queuedAt: new Date().toISOString()
      }), false);
      updateOutboxBadge();
      return true;
    }catch(e){ console.error('could not queue pending write', kind, id, describeCloudError(e)); return false; }
  }
  async function outboxList(){
    try{
      const res = await window.storage.list(OUTBOX_PREFIX, false);
      const items = [];
      for(const key of (res.keys||[])){
        try{
          const item = await window.storage.get(key, false);
          if(item) items.push(Object.assign(JSON.parse(item.value), {storageKey: key}));
        }catch(e){ /* skip an unreadable entry rather than stalling the queue */ }
      }
      // Oldest first, so work reaches the cloud in the order it was done.
      // String() matters: an entry written by an older build (or hand-edited)
      // could carry a numeric timestamp, and calling localeCompare on a number
      // throws — which the catch below would turn into an empty queue, hiding
      // the pending-sync banner and silently abandoning the user's offline work.
      items.sort((a,b)=> String(a.queuedAt||'').localeCompare(String(b.queuedAt||'')));
      return items;
    }catch(e){
      console.error('could not read the pending-sync queue', e);
      return [];
    }
  }
  async function outboxCount(){ return (await outboxList()).length; }

  let outboxFlushing = false;
  async function outboxFlush(opts){
    opts = opts || {};
    if(outboxFlushing) return {sent:0, left:0};
    if(!(await ensureCloud())) return {sent:0, left:await outboxCount()};
    outboxFlushing = true;
    let sent = 0, left = 0, lastError = null;
    try{
      const items = await outboxList();
      for(const item of items){
        const handler = outboxHandlers[item.kind];
        if(!handler){ left++; continue; }
        let ok = false, errMsg = null;
        try{ await handler(item.id, item.payload); ok = true; }
        catch(e){ errMsg = describeCloudError(e); console.error('outbox replay failed', item.kind, item.id, errMsg); }
        if(ok){
          sent++;
          try{ await window.storage.delete(item.storageKey); }catch(e){}
        }else{
          left++;
          lastError = errMsg;
          // Record the failure reason on the item itself (surfaced in the
          // "View" list) instead of only logging it to the console, since a
          // technician in the field has no way to open devtools. Previously
          // this loop also stopped at the very first failure on the
          // assumption that any failure meant the connection had dropped —
          // but a failure can just as easily be that ONE item's data being
          // rejected (e.g. a validation or permissions error on the server),
          // which used to permanently block every other, perfectly fine,
          // item queued behind it. Now every item gets its own attempt.
          try{
            await window.storage.set(item.storageKey, JSON.stringify(Object.assign(
              {}, item, {lastError: errMsg, lastTriedAt: new Date().toISOString()}
            )), false);
          }catch(e){}
        }
      }
    }finally{
      outboxFlushing = false;
    }
    if(sent && !opts.quiet) toast('Uploaded '+sent+' pending item'+(sent===1?'':'s')+' to the shared cloud');
    updateOutboxBadge();
    return {sent, left, lastError};
  }
  async function updateOutboxBadge(){
    const el = $('pendingSyncBanner');
    if(!el) return;
    const n = await outboxCount();
    el.style.display = n ? 'flex' : 'none';
    const label = $('pendingSyncText');
    if(label) label.textContent = n+' item'+(n===1?'':'s')+' saved on this device only — waiting for a connection';
  }
  window.addEventListener('online', ()=>{ outboxFlush(); });
  // Also retry when the app is brought back to the foreground, since phones
  // often reconnect while the screen is off and never fire 'online' again.
  document.addEventListener('visibilitychange', ()=>{
    if(document.visibilityState==='visible') outboxFlush({quiet:true});
  });
  // Safety net: the 'online' event is not reliable on mobile — a phone can
  // reconnect to wifi (especially waking from sleep, or switching between
  // wifi and cellular) without the browser ever firing it, which is what
  // made syncing look like it depended on manually tapping "Sync now".
  // Retry quietly in the background on a timer whenever something is
  // actually pending, so a restored connection gets picked up on its own.
  setInterval(()=>{
    outboxCount().then(n=>{ if(n) outboxFlush({quiet:true}); });
  }, 30000);
  // Reveal stranded offline work as soon as the bundle runs. This deliberately
  // does NOT wait for the startup data load: that chain can block for up to 12
  // seconds behind the CDN script timeout, and a technician who opens the app to
  // check whether yesterday's report went through should not stare at a screen
  // that says nothing for 12 seconds.
  updateOutboxBadge();

  const pendingSyncBtn = $('pendingSyncBtn');
  if(pendingSyncBtn) pendingSyncBtn.addEventListener('click', async ()=>{
    const res = await outboxFlush();
    if(!res.sent) toast(res.left ? (res.lastError ? 'Upload failed: '+res.lastError : 'Still no connection — will keep trying') : 'Nothing pending');
  });

  // Human-readable labels for each outbox "kind" — used only in the list below.
  const OUTBOX_KIND_LABELS = {
    'report': 'Service Report', 'dtr': 'DTR', 'leave': 'Leave Request',
    'cash-advance': 'Cash Advance', 'dispatch': 'Dispatch Ticket',
    'geo': 'Location Point'
  };
  async function renderPendingSyncList(){
    const listEl = $('pendingSyncList');
    if(!listEl) return;
    const items = await outboxList();
    if(!items.length){
      listEl.innerHTML = '<div class="empty-state">Nothing pending — everything on this device has synced.</div>';
      $('pendingSyncClearAllBtn').style.display = 'none';
      return;
    }
    $('pendingSyncClearAllBtn').style.display = '';
    listEl.innerHTML = items.map(item=>{
      const label = OUTBOX_KIND_LABELS[item.kind] || item.kind;
      const when = item.queuedAt ? new Date(item.queuedAt).toLocaleString() : '';
      const errorLine = item.lastError
        ? '<div style="font-size:12px; color:var(--danger); margin-top:2px;">Last try failed: '+escapeHtml(item.lastError)+'</div>'
        : '';
      return '<div style="display:flex; align-items:flex-start; justify-content:space-between; gap:10px; padding:10px 0; border-bottom:1px solid var(--border);">'
        + '<div><div style="font-weight:700; font-size:13.5px;">'+escapeHtml(label)+'</div>'
        + '<div style="font-size:12px; color:var(--text-muted);">'+escapeHtml(String(item.id))+(when?' · '+escapeHtml(when):'')+'</div>'
        + errorLine + '</div>'
        + '<button type="button" class="btn pendingSyncDeleteBtn" data-key="'+escapeHtml(item.storageKey)+'" style="flex:0 0 auto; padding:6px 10px; font-size:12.5px; background:#fdeceb; color:var(--danger);">Discard</button>'
        + '</div>';
    }).join('');
  }
  const pendingSyncViewBtn = $('pendingSyncViewBtn');
  if(pendingSyncViewBtn) pendingSyncViewBtn.addEventListener('click', async ()=>{
    await renderPendingSyncList();
    $('pendingSyncOverlay').classList.add('open');
  });
  const closePendingSyncBtn = $('closePendingSync');
  if(closePendingSyncBtn) closePendingSyncBtn.addEventListener('click', ()=> $('pendingSyncOverlay').classList.remove('open'));
  const pendingSyncOverlayEl = $('pendingSyncOverlay');
  if(pendingSyncOverlayEl) pendingSyncOverlayEl.addEventListener('click', (e)=>{
    if(e.target.id==='pendingSyncOverlay') pendingSyncOverlayEl.classList.remove('open');
  });
  const pendingSyncListEl = $('pendingSyncList');
  if(pendingSyncListEl) pendingSyncListEl.addEventListener('click', async (e)=>{
    const btn = e.target.closest('.pendingSyncDeleteBtn');
    if(!btn) return;
    if(!confirm('Discard this item? It will NOT be uploaded and cannot be recovered.')) return;
    try{ await window.storage.delete(btn.dataset.key); }catch(err){}
    await renderPendingSyncList();
    updateOutboxBadge();
  });
  const pendingSyncClearAllBtn = $('pendingSyncClearAllBtn');
  if(pendingSyncClearAllBtn) pendingSyncClearAllBtn.addEventListener('click', async ()=>{
    const items = await outboxList();
    if(!items.length) return;
    if(!confirm('Discard all '+items.length+' pending item'+(items.length===1?'':'s')+'? None of it will be uploaded, and this cannot be undone.')) return;
    for(const item of items){ try{ await window.storage.delete(item.storageKey); }catch(err){} }
    await renderPendingSyncList();
    updateOutboxBadge();
  });

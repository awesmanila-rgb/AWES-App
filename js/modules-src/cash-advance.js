// ---------- Cash Advance Form (table: cash_advance_requests) ----------
  // Fallback UUID v4 generator for browsers without crypto.randomUUID — the
  // id column requires a real UUID shape, not just any unique-looking string.
  function genUUIDv4Fallback(){
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c=>{
      const r = Math.random()*16|0;
      return (c==='x' ? r : (r&0x3|0x8)).toString(16);
    });
  }
  function caGenId(userId){
    // This is a real UUID column in Postgres — it must be a single valid UUID,
    // not the technician's id glued onto a random one (that combined string
    // fails Postgres's uuid type check on every insert, with no online/offline
    // difference: it never goes through regardless of connection). The
    // technician is already recorded separately via technician_id.
    return (window.crypto && window.crypto.randomUUID)
      ? window.crypto.randomUUID()
      : genUUIDv4Fallback();
  }

  // Receipt images live inside the JSONB row as base64 data URLs. That keeps the
  // app dependency-free but means a row can be megabytes, so cap it: an
  // oversized row is rejected outright by Postgres/PostgREST and the old code
  // just showed "could not submit" with no explanation.
  const CA_ATTACHMENT_MAX_BYTES = 1_500_000; // ~1.5 MB per receipt, post-compression
  const CA_RECORD_MAX_BYTES = 6_000_000;     // ~6 MB for the whole liquidation
  function caAttachmentSize(dataUrl){
    if(!dataUrl) return 0;
    const comma = dataUrl.indexOf(',');
    const b64 = comma>=0 ? dataUrl.slice(comma+1) : dataUrl;
    return Math.floor(b64.length * 3 / 4);
  }

  async function caSaveRequest(id, data){
    const payload = {
      id, technician_id: data.userId, status: data.status || 'pending',
      submitted_at: data.submittedAt || new Date().toISOString(), data
    };
    if(await ensureCloud()){
      try{
        const { error } = await db.from('cash_advance_requests').upsert(payload);
        if(error) throw error;
        return SAVE_CLOUD;
      }catch(e){ console.error('cash advance save failed', describeCloudError(e)); }
    }
    try{ await window.storage.set('cash:'+id, JSON.stringify(data), false); }
    catch(e){ return SAVE_FAILED; }
    return (await outboxQueue('cash-advance', id, payload)) ? SAVE_QUEUED : SAVE_FAILED;
  }
  registerOutboxHandler('cash-advance', async (id, payload)=>{
    const { error } = await db.from('cash_advance_requests').upsert(payload);
    if(error) throw error;
  });

  const CA_PAGE = 200;
  async function caFetchPaged(applyFilter){
    const out = [];
    for(let from = 0; ; from += CA_PAGE){
      let q = db.from('cash_advance_requests').select('data').order('submitted_at',{ascending:false}).range(from, from+CA_PAGE-1);
      if(applyFilter) q = applyFilter(q);
      const { data, error } = await q;
      if(error) throw error;
      const batch = data || [];
      batch.forEach(r=> out.push(r.data));
      if(batch.length < CA_PAGE) break;
      if(out.length >= 5000) break;
    }
    return out;
  }
  async function caLocalList(userId){
    try{
      const res = await window.storage.list('cash:', false);
      const items = [];
      for(const key of (res.keys||[])){
        try{ const item = await window.storage.get(key, false); items.push(JSON.parse(item.value)); }catch(e){}
      }
      const filtered = userId ? items.filter(r=> r && r.userId===userId) : items;
      filtered.sort((a,b)=> (b.submittedAt||'').localeCompare(a.submittedAt||''));
      return filtered;
    }catch(e){ return []; }
  }
  // Strips receipt payloads for list views. Rendering a summary list does not
  // need every technician's base64 receipt images — downloading all of them was
  // the single most expensive thing the admin screens did, on a mobile
  // connection, every time the tab was opened.
  function caStripAttachments(rec){
    if(!rec || !rec.liquidation || !Array.isArray(rec.liquidation.items)) return rec;
    return Object.assign({}, rec, {
      liquidation: Object.assign({}, rec.liquidation, {
        items: rec.liquidation.items.map(i=> i && i.attachmentData
          ? Object.assign({}, i, {attachmentData: null, attachmentTruncated: true})
          : i)
      })
    });
  }
  async function caListAll(opts){
    const summary = !(opts && opts.full);
    if(await ensureCloud()){
      try{
        const rows = await caFetchPaged(null);
        return summary ? rows.map(caStripAttachments) : rows;
      }catch(e){ console.error('cash advance list failed', describeCloudError(e)); }
    }
    return await caLocalList(null);
  }
  // Server-side filter: a technician's client no longer downloads every
  // colleague's cash advances (amounts, purposes and receipts) just to hide them
  // in JavaScript.
  async function caListForUser(userId, opts){
    if(!userId) return [];
    const summary = !(opts && opts.full);
    if(await ensureCloud()){
      try{
        const rows = await caFetchPaged(q=> q.eq('technician_id', userId));
        return summary ? rows.map(caStripAttachments) : rows;
      }catch(e){ console.error('cash advance list (user) failed', describeCloudError(e)); }
    }
    return await caLocalList(userId);
  }
  // Fetches ONE record complete with attachment data, for the detail/attachment
  // views that actually need it.
  async function caGetRequest(id){
    if(await ensureCloud()){
      try{
        const { data, error } = await db.from('cash_advance_requests').select('data').eq('id', id).maybeSingle();
        if(error) throw error;
        return data ? data.data : null;
      }catch(e){ console.error('cash advance get failed', describeCloudError(e)); }
    }
    try{
      const item = await window.storage.get('cash:'+id, false);
      return item ? JSON.parse(item.value) : null;
    }catch(e){ return null; }
  }
  function caFmtPeso(n){
    const v = Number(n)||0;
    return '₱'+v.toLocaleString('en-PH', {minimumFractionDigits:2, maximumFractionDigits:2});
  }
  // jsPDF's built-in fonts (Helvetica etc.) only cover Latin-1 — the actual
  // ₱ glyph isn't in that character set, so text containing it renders as a
  // blank box or breaks the layout entirely. Every amount printed to PDF
  // uses this "PHP " prefix instead of caFmtPeso's ₱ symbol.
  function caFmtPesoPdf(n){
    const v = Number(n)||0;
    return 'PHP '+v.toLocaleString('en-PH', {minimumFractionDigits:2, maximumFractionDigits:2});
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
    // Needs the full record: a disapproved liquidation is reloaded into the form
    // so the technician can fix it, receipts included.
    const all = await caListForUser(userId, {full:true});
    const outstanding = all.filter(caNeedsLiquidation);
    outstanding.sort((a,b)=> (b.disbursedAt||'').localeCompare(a.disbursedAt||''));
    return outstanding[0] || null;
  }
  // A request the technician filed that admin hasn't decided on yet. While one
  // of these exists, a second "New Request" would let a technician stack up
  // multiple asks before admin even sees the first one.
  async function caFindPendingRequest(userId){
    const all = await caListForUser(userId, {full:true});
    const pending = all.filter(r=> r.status==='pending');
    pending.sort((a,b)=> (b.submittedAt||'').localeCompare(a.submittedAt||''));
    return pending[0] || null;
  }

  // Tracks whichever record is currently shown in the blocked card, so the
  // Cancel Request button knows what to cancel without a second lookup.
  let caBlockedPendingRecord = null;
  let caActiveTab = 'new'; // tracks which of New/Liquidate/History is showing, so an
                           // in-flight caCheckBlockedState() call (a network round trip)
                           // that resolves after the technician has already switched
                           // tabs can tell it's stale and skip touching the DOM instead
                           // of re-showing the reminder card on top of whatever's there.

  // Toggles the New Request form vs. the blocked-state reminder. Called
  // whenever the Cash Advance page is opened and whenever the New Request tab
  // is shown, so the block can never be bypassed by navigating away and back.
  async function caCheckBlockedState(){
    if(!currentUser || currentUser.role==='admin') return null;
    const dot = $('caLiqTabDot');
    caBlockedPendingRecord = null;

    // A disbursed-but-unliquidated advance takes priority: it's further along
    // than a pending request can ever be (pending requests are never disbursed).
    const activeLiq = await caFindActiveLiquidationRecord(currentUser.id);
    // The technician may have already switched to another tab while that
    // network round trip was in flight. Only the dot indicator (small,
    // tab-independent) is safe to update from a stale call — the reminder
    // card itself must not reappear on top of whatever tab is now showing.
    const stillOnNewTab = caActiveTab==='new';
    if(activeLiq){
      const needsSubmit = !activeLiq.liquidation || activeLiq.liquidation.status==='disapproved';
      if(dot) dot.style.display = needsSubmit ? '' : 'none';
      if(stillOnNewTab){
        $('caFormCard').style.display = 'none';
        $('caBlockedCard').style.display = '';
        $('caBlockedBanner').textContent = needsSubmit
          ? 'Your cash advance request was approved. Submit your liquidation before submitting a new cash advance request.'
          : 'Liquidation has been submitted for review and approval.';
        $('caBlockedSummary').innerHTML =
          '<div class="leave-comment"><b>You Cannot Request a New Cash Advance at the Moment</b>'+
          (needsSubmit ? 'Needs liquidation — ' : 'Liquidation submitted for review and approval — ')+
          caFmtPeso(activeLiq.amountGiven)+' given on '+leaveFmtDate(activeLiq.dateGiven)+' — '+escapeHtml(activeLiq.purpose)+'</div>'+
          (activeLiq.liquidation && activeLiq.liquidation.status==='disapproved' && activeLiq.liquidation.comment
            ? '<div class="leave-comment"><b>Admin comment</b>'+escapeHtml(activeLiq.liquidation.comment)+'</div>' : '');
        $('caGoLiquidateBtn').style.display = needsSubmit ? '' : 'none';
        $('caCancelRequestBtn').style.display = 'none';
      }
      return activeLiq;
    }

    const pending = await caFindPendingRequest(currentUser.id);
    const stillOnNewTab2 = caActiveTab==='new';
    if(pending){
      caBlockedPendingRecord = pending;
      if(dot) dot.style.display = 'none';
      if(stillOnNewTab2){
        $('caFormCard').style.display = 'none';
        $('caBlockedCard').style.display = '';
        $('caBlockedBanner').textContent = 'You have a cash advance request awaiting admin approval. Wait for approval, or cancel the request to submit a new one.';
        $('caBlockedSummary').innerHTML =
          '<div class="leave-comment"><b>Awaiting Admin Approval</b>'+
          caFmtPeso(pending.amount)+' requested on '+leaveFmtWhen(pending.submittedAt)+' — '+escapeHtml(pending.purpose)+'</div>';
        $('caGoLiquidateBtn').style.display = 'none';
        $('caCancelRequestBtn').style.display = '';
      }
      return pending;
    }

    if(dot) dot.style.display = 'none';
    if(!stillOnNewTab2) return null;
    $('caFormCard').style.display = '';
    $('caBlockedCard').style.display = 'none';
    return null;
  }
  $('caGoLiquidateBtn').addEventListener('click', ()=> caShowTab('liquidate'));

  // Lets a technician withdraw their own request while it's still awaiting a
  // decision. Once admin approves or disapproves it, this is no longer an
  // option — the guarded update below (status='pending') is what actually
  // enforces that, not just the UI.
  async function caCancelRequest(id){
    if(!currentUser || currentUser.role==='admin') return;
    if(!confirm('Cancel this cash advance request? This cannot be undone.')) return;
    const btn = $('caCancelRequestBtn');
    if(btn) btn.disabled = true;
    if(!(await ensureCloud())){
      toast('This needs a connection — try again when online');
      if(btn) btn.disabled = false;
      return;
    }
    try{
      const rec = await caGetRequest(id);
      if(!rec || rec.userId !== currentUser.id){ toast('Request not found'); return; }
      if(rec.status !== 'pending'){
        toast(rec.status==='approved'
          ? 'This was already approved — it can no longer be cancelled'
          : 'This request was already decided');
        return;
      }
      const merged = Object.assign({}, rec, {
        status: 'cancelled',
        decidedAt: new Date().toISOString(),
        decidedBy: currentUser.name ? (currentUser.name+' (cancelled)') : 'Cancelled by technician'
      });
      const { data: rows, error } = await db.from('cash_advance_requests')
        .update({ status: 'cancelled', data: merged })
        .eq('id', id).eq('status', 'pending')
        .select('id');
      if(error) throw error;
      if(!rows || !rows.length){
        toast('This request was just decided by admin — refreshing');
      }else{
        toast('Request cancelled');
      }
    }catch(e){
      console.error('cash advance cancel failed', describeCloudError(e));
      toast('Could not cancel — please try again');
    }finally{
      if(btn) btn.disabled = false;
      caCheckBlockedState();
      caRenderHistory();
    }
  }
  $('caCancelRequestBtn').addEventListener('click', ()=>{
    if(caBlockedPendingRecord) caCancelRequest(caBlockedPendingRecord.id);
  });

  async function caSubmit(){
    if(!currentUser || currentUser.role==='admin') return;
    // Re-check right before submitting — the reminder card should already
    // prevent this, but this guards against stale UI state.
    const active = await caFindActiveLiquidationRecord(currentUser.id);
    if(active){ toast('Liquidate your existing cash advance first'); caCheckBlockedState(); return; }
    const pending = await caFindPendingRequest(currentUser.id);
    if(pending){ toast('You already have a cash advance request awaiting approval'); caCheckBlockedState(); return; }
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
    const res = await caSaveRequest(id, data);
    $('caSubmitBtn').disabled = false;
    if(res===SAVE_FAILED){ toast('Could not submit — check your connection'); return; }
    toast(res===SAVE_CLOUD
      ? 'Cash advance request submitted for approval'
      : 'Saved on this device — it will be submitted once you have a connection');
    caResetForm();
    caShowTab('history');
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
      // The four milestones requested at a glance: Requested / Approved / Given / Liquidated.
      // Each shows "—" until that milestone has actually happened.
      const datesLine =
        '<div class="leave-comment" style="display:grid; grid-template-columns:1fr 1fr; gap:4px 10px;">'+
          '<div><b>Date Requested</b>'+leaveFmtWhen(r.submittedAt)+'</div>'+
          '<div><b>Date Approved</b>'+(r.status==='approved' ? leaveFmtWhen(r.decidedAt) : '—')+'</div>'+
          '<div><b>Date Given</b>'+(r.disbursed ? leaveFmtDate(r.dateGiven) : '—')+'</div>'+
          '<div><b>Date Liquidated</b>'+(r.liquidation && r.liquidation.status==='approved' ? leaveFmtWhen(r.liquidation.decidedAt) : '—')+'</div>'+
        '</div>';
      row.innerHTML =
        '<div style="display:flex; justify-content:space-between; align-items:center; gap:10px;">'+
          '<div class="hist-info"><b>'+caFmtPeso(r.amount)+'</b>'+
            '<span>Needed '+leaveFmtDate(r.dateNeeded)+(r.project ? (' · '+escapeHtml(r.project)) : '')+'</span>'+
          '</div>'+
          (r.status==='approved' && r.disbursed ? '<span class="status-pill status-given">Given</span>' : leaveStatusPill(r.status))+
        '</div>'+
        datesLine+
        '<div class="leave-comment"><b>Purpose</b>'+escapeHtml(r.purpose)+'</div>'+
        disbursementLine+
        liqLine+
        (r.comment ? '<div class="leave-comment"><b>Admin comment</b>'+escapeHtml(r.comment)+'</div>' : '');
      list.appendChild(row);
    });
  }

  function caShowTab(which){
    caActiveTab = which;
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

  // ---- Local draft auto-save ----
  // Everything the technician builds up (items, receipt photos, notes) used
  // to live only in the caLiqItems variable above — nothing was persisted
  // until the final Submit tap. A killed/backgrounded PWA tab, an accidental
  // navigation, or a connectivity blip before that tap lost the whole
  // in-progress liquidation with no warning and no way to recover it. This
  // mirrors it to on-device storage as the technician works, so it survives
  // all of that and can be restored the next time they open this tab.
  function caLiqDraftKey(recordId){
    return 'caLiqDraft:'+((currentUser && currentUser.id) || 'anon')+':'+recordId;
  }
  let caLiqDraftSaveTimer = null;
  function caLiqSaveDraft(){
    if(!caLiqActiveRecord) return;
    // Debounced so fast typing in the notes field doesn't hammer storage.
    clearTimeout(caLiqDraftSaveTimer);
    const recordId = caLiqActiveRecord.id;
    caLiqDraftSaveTimer = setTimeout(async ()=>{
      try{
        const notesEl = $('caLiqNotes');
        const draft = {items: caLiqItems, notes: notesEl ? notesEl.value : '', savedAt: new Date().toISOString()};
        await window.storage.set(caLiqDraftKey(recordId), JSON.stringify(draft), false);
      }catch(e){
        // Best-effort only — e.g. device storage full. Don't block the
        // technician's editing over it, but don't stay silent either.
        console.error('liquidation draft save failed', e);
      }
    }, 300);
  }
  async function caLiqLoadDraft(recordId){
    try{
      const res = await window.storage.get(caLiqDraftKey(recordId), false);
      if(!res || !res.value) return null;
      const draft = JSON.parse(res.value);
      return (draft && Array.isArray(draft.items)) ? draft : null;
    }catch(e){ return null; }
  }
  async function caLiqClearDraft(recordId){
    try{ await window.storage.delete(caLiqDraftKey(recordId), false); }catch(e){ /* nothing to clean up */ }
  }

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

  // ================= Add Item modal flow =================
  // Items only ever enter caLiqItems through one of the two form modals
  // below, opened from the chooser modal. Nothing on the Liquidate tab
  // itself is an editable inline form anymore.

  function caLiqOpenAddItemModal(){ $('liqAddItemModal').classList.add('open'); }
  function caLiqCloseAddItemModal(){ $('liqAddItemModal').classList.remove('open'); }
  $('closeLiqAddItemModal').addEventListener('click', caLiqCloseAddItemModal);
  $('liqAddItemModal').addEventListener('click', (e)=>{ if(e.target.id==='liqAddItemModal') caLiqCloseAddItemModal(); });
  $('caLiqAddItemBtn').addEventListener('click', caLiqOpenAddItemModal);
  $('caLiqStartBtn').addEventListener('click', caLiqOpenAddItemModal);

  // ---- "Others" item form (a single receipt) ----
  function caLiqOpenOthersModal(){
    $('liqOthersDate').value = todayISO();
    $('liqOthersParticular').value = '';
    $('liqOthersQty').value = '1';
    $('liqOthersAmount').value = '';
    caLiqOthersAttachment = null;
    $('liqOthersFileStatus').textContent = '';
    caLiqCloseAddItemModal();
    $('liqOthersModal').classList.add('open');
  }
  function caLiqCloseOthersModal(){ $('liqOthersModal').classList.remove('open'); }
  $('liqAddItemTabOthers').addEventListener('click', caLiqOpenOthersModal);
  $('closeLiqOthersModal').addEventListener('click', caLiqCloseOthersModal);
  $('liqOthersModal').addEventListener('click', (e)=>{ if(e.target.id==='liqOthersModal') caLiqCloseOthersModal(); });

  let caLiqOthersAttachment = null; // {data, mime, name} for the item currently being built
  $('liqOthersAttachBtn').addEventListener('click', ()=> $('liqOthersFile').click());
  $('liqOthersFile').addEventListener('change', async ()=>{
    const file = $('liqOthersFile').files[0];
    if(!file) return;
    try{
      let dataUrl, mime;
      if(file.type.startsWith('image/')){
        dataUrl = await compressImageToDataURL(file, 1000, 0.6);
        mime = 'image/jpeg';
      }else{
        dataUrl = await new Promise((resolve, reject)=>{
          const r = new FileReader();
          r.onload = ()=> resolve(r.result);
          r.onerror = ()=> reject(new Error('read failed'));
          r.readAsDataURL(file);
        });
        mime = file.type || 'application/octet-stream';
      }
      if(caAttachmentSize(dataUrl) > CA_ATTACHMENT_MAX_BYTES){
        toast('That file is too large — take a photo instead of attaching a full-size file');
        return;
      }
      caLiqOthersAttachment = {data: dataUrl, mime, name: file.name};
      $('liqOthersFileStatus').textContent = '📄 '+file.name;
    }catch(e){ toast('Could not attach that file'); }
  });
  $('liqOthersAddItemBtn').addEventListener('click', ()=>{
    const date = $('liqOthersDate').value;
    const description = $('liqOthersParticular').value.trim();
    const qty = parseInt($('liqOthersQty').value, 10) || 1;
    const amount = parseFloat($('liqOthersAmount').value) || 0;
    if(!date){ toast('Set the date'); return; }
    if(!description){ toast('Enter the particular'); return; }
    if(qty<1){ toast('Qty must be at least 1'); return; }
    if(!amount || amount<=0){ toast('Enter a valid amount'); return; }
    if(!caLiqOthersAttachment){ toast('Attach a receipt photo or file'); return; }
    const newItemId = caLiqItemId();
    caLiqItems.push({
      id: newItemId, type:'item', date, description, qty, amount,
      attachmentName: caLiqOthersAttachment.name,
      attachmentData: caLiqOthersAttachment.data,
      attachmentMime: caLiqOthersAttachment.mime
    });
    caLiqCloseOthersModal();
    caLiqRenderForm();
    caLiqSaveDraft();
    toast('Item added');
    caLiqFlashItem(newItemId);
  });

  // ---- Transportation item form (one or more trip legs, added as a
  // single liquidation item) ----
  function caLiqOpenTransportModal(){
    caTransportRows = [caTransportRowTemplate()];
    caTransportRenderRows(); caTransportUpdateTotal();
    caLiqCloseAddItemModal();
    $('liqTransportModal').classList.add('open');
  }
  function caLiqCloseTransportModal(){ $('liqTransportModal').classList.remove('open'); }
  $('liqAddItemTabTransport').addEventListener('click', caLiqOpenTransportModal);
  $('closeLiqTransportModal').addEventListener('click', caLiqCloseTransportModal);
  $('liqTransportModal').addEventListener('click', (e)=>{ if(e.target.id==='liqTransportModal') caLiqCloseTransportModal(); });

  // The item list this scrolls to sits above the modal trigger, off-screen
  // from wherever the technician just was. Without this, adding an item just
  // closes the modal with no visible change nearby — reads as "nothing
  // happened, my data disappeared" — even though the list above did update.
  // Scroll to the new row and flash it so there's a clear, visible
  // confirmation right where it's easy to miss otherwise.
  function caLiqFlashItem(itemId){
    const row = $('caLiqFormTable').querySelector('[data-item-id="'+itemId+'"]');
    if(!row) return;
    row.scrollIntoView({behavior:'smooth', block:'center'});
    row.style.transition = 'background-color 0.3s';
    row.style.backgroundColor = '#DFF3E3';
    setTimeout(()=>{ row.style.backgroundColor = ''; }, 1400);
  }

  // Computes the running totals shown on the Liquidation Form: the sum of
  // all items, and — once we know the amount given — whether the technician
  // owes money back (Unreturned Excess C.A.) or is owed money (Accounts
  // Receivable), plus that same figure phrased as an action.
  function caLiqComputeTotals(){
    const total = caLiqItems.reduce((s,i)=> s + (Number(i.amount)||0), 0);
    const given = caLiqActiveRecord ? (Number(caLiqActiveRecord.amountGiven)||0) : 0;
    const diff = given - total; // positive: unspent cash advance; negative: technician spent more than given
    return { total, given, diff };
  }

  // Particular text for an item, folding in Qty when it's more than 1 so the
  // Liquidation Form's single "Particular" column still carries it.
  function caLiqItemParticular(item){
    if(item.type==='transport') return item.description;
    return item.qty && item.qty>1 ? item.description+' (Qty: '+item.qty+')' : item.description;
  }

  // First date associated with an item, for the Liquidation Form's Date
  // column — a transportation item can cover several legs on different
  // dates, so fall back to a range indicator when they differ.
  function caLiqItemDate(item){
    if(item.type==='transport'){
      const dates = Array.from(new Set((item.transportRows||[]).map(r=> r.date).filter(Boolean)));
      if(dates.length===0) return '—';
      if(dates.length===1) return leaveFmtDate(dates[0]);
      dates.sort();
      return 'Multiple';
    }
    return item.date ? leaveFmtDate(item.date) : '—';
  }

  function caLiqFormRowsHtml(editable){
    let html = '<div style="font-size:12px; color:var(--text-muted); display:flex; padding:0 4px 6px; font-weight:700; text-transform:uppercase; letter-spacing:.3px;">'+
      '<span style="width:28px;">No.</span><span style="flex:1;">Date</span><span style="flex:2;">Particular</span><span style="text-align:right; min-width:70px;">Amount</span></div>';
    caLiqItems.forEach((item, idx)=>{
      html += '<div class="hist-item" data-item-id="'+item.id+'" data-view-item="'+item.id+'" style="align-items:flex-start;">'+
        '<div style="display:flex; flex:1; gap:8px; align-items:center; min-width:0;">'+
          '<span style="width:28px; color:var(--text-muted);">'+(idx+1)+'</span>'+
          '<span style="flex:1; font-size:12px; color:var(--text-muted);">'+caLiqItemDate(item)+'</span>'+
          '<span style="flex:2;"><b>'+(item.type==='transport'?'🚕 ':'📄 ')+escapeHtml(caLiqItemParticular(item))+'</b></span>'+
        '</div>'+
        '<div style="text-align:right; font-weight:700; white-space:nowrap; min-width:70px;">'+caFmtPeso(item.amount)+'</div>'+
        (editable ? '<button type="button" class="btn btn-secondary" data-act="remove" data-item-id="'+item.id+'" style="flex:0 0 auto; width:auto; margin-left:8px; color:var(--danger); padding:4px 10px; font-size:11px;">✕</button>' : '')+
      '</div>';
    });
    return html;
  }

  function caLiqTotalsHtml(){
    const {total, given, diff} = caLiqComputeTotals();
    const excessLabel = diff >= 0 ? 'Unreturned Excess C.A.' : 'Accounts Receivable';
    const excessAmount = caFmtPeso(Math.abs(diff));
    const balanceLabel = diff >= 0 ? 'Balance to be Returned' : 'Balance to be Reimbursed';
    return (
      '<div style="display:flex; justify-content:space-between; padding:8px 4px; border-top:1px solid var(--border); font-weight:700;">'+
        '<span>Total Expenses</span><span>'+caFmtPeso(total)+'</span></div>'+
      '<div style="display:flex; justify-content:space-between; padding:8px 4px; font-size:13px; color:var(--text-muted);">'+
        '<span>'+excessLabel+'</span><span>'+excessAmount+'</span></div>'+
      '<div style="display:flex; justify-content:space-between; padding:8px 4px; border-top:1px dashed var(--border); font-weight:700; font-size:15px;">'+
        '<span>'+balanceLabel+'</span><span>'+excessAmount+'</span></div>'+
      (given ? '<div class="leave-note" style="padding:0 4px;">Cash advance given: '+caFmtPeso(given)+'</div>' : '')
    );
  }

  function caLiqRenderForm(){
    const hasItems = caLiqItems.length>0;
    $('caLiqStartPrompt').style.display = hasItems ? 'none' : '';
    $('caLiqFormBuilt').style.display = hasItems ? '' : 'none';
    if(!hasItems) return;
    const wrap = $('caLiqFormTable');
    wrap.innerHTML = caLiqFormRowsHtml(true) + caLiqTotalsHtml();
    caLiqItems.forEach(item=>{
      const row = wrap.querySelector('[data-view-item="'+CSS.escape(String(item.id))+'"]');
      if(row){
        row.addEventListener('click', (e)=>{
          if(e.target.closest('[data-act="remove"]')) return;
          openLiquidationAttachment(item);
        });
      }
      const rmBtn = wrap.querySelector('[data-act="remove"][data-item-id="'+CSS.escape(String(item.id))+'"]');
      if(rmBtn){
        rmBtn.addEventListener('click', (e)=>{
          e.stopPropagation();
          caLiqItems = caLiqItems.filter(i=> i.id!==item.id);
          caLiqRenderForm();
          caLiqSaveDraft();
        });
      }
    });
  }

  // ---- Transportation sub-form (rendered inside liqTransportModal) ----
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
      // The combo suggestion panel fills the input by setting .value directly
      // and firing 'change' (see attachCombo in customers.js) — it does NOT
      // fire 'input'. Syncing on 'input' alone left row.mode empty whenever a
      // suggestion was picked by click: the field looked filled in, but
      // "Add Item" validation (which reads row.mode, not the DOM) silently
      // rejected the trip as incomplete. Listen for both so typed text and
      // picked suggestions are captured the same way.
      const syncMode = (e)=>{ row.mode = e.target.value; };
      modeInput.addEventListener('input', syncMode);
      modeInput.addEventListener('change', syncMode);
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
    const newItemId = caLiqItemId();
    caLiqItems.push({
      id: newItemId, type:'transport',
      description: 'Transportation Expenses ('+valid.length+' trip'+(valid.length>1?'s':'')+')',
      amount: total, transportRows: valid
    });
    caLiqCloseTransportModal();
    caLiqRenderForm();
    caLiqSaveDraft();
    toast('Item added');
    caLiqFlashItem(newItemId);
  });

  // ---- View Liquidation Form (read-only preview of the form above) ----
  // A dedicated renderer (rather than reusing caLiqFormRowsHtml/caLiqTotalsHtml,
  // which the editable in-page form also depends on) so this can look like an
  // actual voucher/receipt document — proper table, header block, boxed
  // totals — without touching the editable form's layout.
  function caLiqPreviewHtml(){
    const {total, given, diff} = caLiqComputeTotals();
    const excessLabel = diff >= 0 ? 'Unreturned Excess C.A.' : 'Accounts Receivable';
    const excessAmount = caFmtPeso(Math.abs(diff));
    const balanceLabel = diff >= 0 ? 'Balance to be Returned' : 'Balance to be Reimbursed';
    let rows = '';
    caLiqItems.forEach((item, idx)=>{
      // Transportation items cover one or more trip legs that don't fit this
      // table's single Particular column — link the label to the same
      // trip-leg summary the editable form and admin review already show,
      // instead of leaving the technician no way to double-check it here.
      const particular = item.type==='transport'
        ? '🚕 <a href="#" class="ca-liq-preview-link" data-view-item="'+escapeHtml(String(item.id))+'" style="color:var(--green-dark); font-weight:700; text-decoration:underline;">'+escapeHtml(caLiqItemParticular(item))+'</a>'
        : '<b>📄 '+escapeHtml(caLiqItemParticular(item))+'</b>';
      rows +=
        '<tr>'+
          '<td class="num">'+(idx+1)+'</td>'+
          '<td class="date">'+caLiqItemDate(item)+'</td>'+
          '<td class="particular">'+particular+'</td>'+
          '<td class="amt">'+caFmtPeso(item.amount)+'</td>'+
        '</tr>';
    });
    return (
      (caLiqActiveRecord ?
        '<div class="ca-liq-preview-head">'+
          '<div class="ca-liq-preview-eyebrow">Cash Advance</div>'+
          '<div class="ca-liq-preview-amount"><b>'+caFmtPeso(caLiqActiveRecord.amountGiven)+'</b> given on '+leaveFmtDate(caLiqActiveRecord.dateGiven)+'</div>'+
        '</div>'
        : '')+
      '<table class="ca-liq-preview-table">'+
        '<thead><tr><th class="num">No.</th><th>Date</th><th>Particular</th><th class="amt">Amount</th></tr></thead>'+
        '<tbody>'+rows+'</tbody>'+
      '</table>'+
      '<div class="ca-liq-preview-totals">'+
        '<div class="row subtotal"><span>Total Expenses</span><span>'+caFmtPeso(total)+'</span></div>'+
        '<div class="row muted"><span>'+excessLabel+'</span><span>'+excessAmount+'</span></div>'+
        '<div class="row balance"><span>'+balanceLabel+'</span><span>'+excessAmount+'</span></div>'+
      '</div>'+
      (given ? '<div class="ca-liq-preview-footnote">Cash advance given: '+caFmtPeso(given)+'</div>' : '')
    );
  }
  function caLiqOpenFormPreview(){
    $('liqFormPreviewBody').innerHTML =
      caLiqPreviewHtml()+
      '<button type="button" class="btn btn-primary" id="liqFormPreviewSubmitBtn" style="width:100%; margin-top:14px;">Submit</button>';
    $('liqFormPreviewOverlay').classList.add('open');
    // Wire up the transportation summary link(s) added above — this preview
    // used to render items as static text with no way to see a
    // transportation item's trip-leg breakdown before submitting, unlike
    // every other place items are shown in this feature.
    $('liqFormPreviewBody').querySelectorAll('[data-view-item]').forEach(el=>{
      el.addEventListener('click', (e)=>{
        e.preventDefault();
        const item = caLiqItems.find(i=> String(i.id)===el.dataset.viewItem);
        if(item) openLiquidationAttachment(item);
      });
    });
    $('liqFormPreviewSubmitBtn').addEventListener('click', ()=>{
      $('liqFormPreviewOverlay').classList.remove('open');
      caSubmitLiquidation();
    });
  }
  $('caLiqViewFormBtn').addEventListener('click', caLiqOpenFormPreview);
  $('closeLiqFormPreview').addEventListener('click', ()=> $('liqFormPreviewOverlay').classList.remove('open'));
  $('liqFormPreviewOverlay').addEventListener('click', (e)=>{ if(e.target.id==='liqFormPreviewOverlay') $('liqFormPreviewOverlay').classList.remove('open'); });

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
      if(!item.attachmentData){
        // List views deliberately fetch records without receipt payloads.
        $('liqAttachmentImageWrap').style.display = 'none';
        toast('Opening receipt…');
        caLoadAttachmentThenOpen(item);
        return;
      }
      if(item.attachmentMime && item.attachmentMime.startsWith('image/')){
        $('liqAttachmentImageWrap').style.display = '';
        $('liqAttachmentImg').src = item.attachmentData;
      }else{
        // Non-image (e.g. PDF): window.open() on a data: URL is blocked outright
        // by Chrome and Safari (top-frame navigation to data: URLs), so this
        // silently did nothing. Convert to a Blob and open an object URL, which
        // is allowed — and revoke it afterwards so it doesn't leak.
        try{
          const blob = caDataUrlToBlob(item.attachmentData, item.attachmentMime);
          const url = URL.createObjectURL(blob);
          const win = window.open(url, '_blank');
          if(!win){
            // Pop-up blocked: fall back to a same-gesture download.
            const a = document.createElement('a');
            a.href = url; a.download = item.attachmentName || 'receipt';
            document.body.appendChild(a); a.click(); a.remove();
          }
          setTimeout(()=> URL.revokeObjectURL(url), 60000);
        }catch(e){
          console.error('could not open attachment', e);
          toast('Could not open that file');
        }
      }
    }
    $('liqAttachmentOverlay').classList.add('open');
  }
  function caDataUrlToBlob(dataUrl, fallbackMime){
    const match = /^data:([^;,]+)?(;base64)?,(.*)$/.exec(dataUrl || '');
    if(!match) throw new Error('not a data URL');
    const mime = match[1] || fallbackMime || 'application/octet-stream';
    const body = match[3];
    if(match[2]){
      const bin = atob(body);
      const bytes = new Uint8Array(bin.length);
      for(let i=0;i<bin.length;i++) bytes[i] = bin.charCodeAt(i);
      return new Blob([bytes], {type: mime});
    }
    return new Blob([decodeURIComponent(body)], {type: mime});
  }
  // Re-fetches the owning record so a summary-loaded item can still show its
  // receipt on demand.
  async function caLoadAttachmentThenOpen(item){
    const recordId = item.__recordId;
    if(!recordId){ toast('Receipt not available'); return; }
    const full = await caGetRequest(recordId);
    const match = full && full.liquidation && (full.liquidation.items||[]).find(i=> i.id===item.id);
    if(!match || !match.attachmentData){ toast('Receipt not available'); return; }
    openLiquidationAttachment(Object.assign({}, match, {__recordId: recordId}));
  }
  $('closeLiqAttachment').addEventListener('click', ()=> $('liqAttachmentOverlay').classList.remove('open'));
  $('liqAttachmentOverlay').addEventListener('click', (e)=>{ if(e.target.id==='liqAttachmentOverlay') $('liqAttachmentOverlay').classList.remove('open'); });

  function caLiqRenderReadonly(record){
    const wrap = $('caLiqReadonlyItems');
    const liq = record.liquidation;
    const given = Number(record.amountGiven)||0;
    const total = Number(liq.totalAmount)||0;
    const diff = given - total;
    const excessLabel = diff >= 0 ? 'Unreturned Excess C.A.' : 'Accounts Receivable';
    const balanceLabel = diff >= 0 ? 'Balance to be Returned' : 'Balance to be Reimbursed';
    let html = '<div class="leave-comment" style="margin-bottom:10px;">'+caLiquidationStatusPill(liq)+
      (liq.comment ? '<div style="margin-top:6px;"><b>Notes</b> '+escapeHtml(liq.comment)+'</div>' : '')+
      '</div>'+
      '<div style="font-size:12px; color:var(--text-muted); display:flex; padding:0 4px 6px; font-weight:700; text-transform:uppercase; letter-spacing:.3px;">'+
        '<span style="width:28px;">No.</span><span style="flex:1;">Date</span><span style="flex:2;">Particular</span><span style="text-align:right;">Amount</span></div>';
    (liq.items||[]).forEach((item, idx)=>{
      html += '<div class="hist-item" style="cursor:pointer;" data-view-item="'+escapeHtml(item.id)+'">'+
        '<div style="display:flex; flex:1; gap:8px; align-items:center;">'+
          '<span style="width:28px; color:var(--text-muted);">'+(idx+1)+'</span>'+
          '<span style="flex:1; font-size:12px; color:var(--text-muted);">'+caLiqItemDate(item)+'</span>'+
          '<span style="flex:2;"><b>'+(item.type==='transport'?'🚕 ':'📄 ')+escapeHtml(caLiqItemParticular(item))+'</b></span>'+
        '</div>'+
        '<span style="font-weight:700; white-space:nowrap;">'+caFmtPeso(item.amount)+'</span></div>';
    });
    html +=
      '<div style="display:flex; justify-content:space-between; padding:8px 4px; border-top:1px solid var(--border); font-weight:700;">'+
        '<span>Total Expenses</span><span>'+caFmtPeso(total)+'</span></div>'+
      '<div style="display:flex; justify-content:space-between; padding:8px 4px; font-size:13px; color:var(--text-muted);">'+
        '<span>'+excessLabel+'</span><span>'+caFmtPeso(Math.abs(diff))+'</span></div>'+
      '<div style="display:flex; justify-content:space-between; padding:8px 4px; border-top:1px dashed var(--border); font-weight:700; font-size:15px;">'+
        '<span>'+balanceLabel+'</span><span>'+caFmtPeso(Math.abs(diff))+'</span></div>'+
      '<div class="leave-note" style="padding:0 4px;">Cash advance given: '+caFmtPeso(given)+'</div>';
    wrap.innerHTML = html;
    (liq.items||[]).forEach(item=>{
      const el = wrap.querySelector('[data-view-item="'+CSS.escape(String(item.id))+'"]');
      if(el) el.addEventListener('click', ()=> openLiquidationAttachment(Object.assign({}, item, {__recordId: record.id})));
    });

    const dlBtn = $('caLiqDownloadPdfBtn');
    if(liq.status==='approved'){
      dlBtn.style.display = '';
      dlBtn.onclick = ()=> caDownloadLiquidationPdf(record);
      // Auto-save a PDF copy the first time the technician sees the approval,
      // so they end up with a record of it without having to remember to tap
      // the button. Guarded per-record so it only fires once.
      caMaybeAutoSaveLiquidationPdf(record);
    }else{
      dlBtn.style.display = 'none';
      dlBtn.onclick = null;
    }
  }

  // ---- Liquidation PDF (approved copy — informational, not re-editable) ----
  async function caBuildLiquidationPdf(record){
    const liq = record.liquidation;
    await loadAwesScript('jspdf', awesLibs.jspdf);
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF('p','pt','a4');
    const pageW = doc.internal.pageSize.getWidth();
    const margin = 40;
    let y = 44;
    const headerH = 90;
    doc.setFillColor(21,77,52);
    doc.rect(0,0,pageW,headerH,'F');
    try{ doc.addImage(AWES_LOGO_B64,'PNG', margin, 14, 108, 36); }catch(e){}
    doc.setTextColor(255,255,255);
    doc.setFont('helvetica','bold'); doc.setFontSize(13);
    doc.text('LIQUIDATION FORM', pageW-margin, 32, {align:'right'});
    doc.setFont('helvetica','normal'); doc.setFontSize(9);
    doc.text('Approved '+(liq.decidedAt ? leaveFmtWhen(liq.decidedAt) : ''), pageW-margin, 46, {align:'right'});
    doc.setTextColor(0,0,0);
    y = headerH + 24;
    doc.setFont('helvetica','bold'); doc.setFontSize(10);
    doc.text('Technician: '+(record.userName||'—'), margin, y); y += 14;
    doc.text('Cash Advance: '+caFmtPesoPdf(record.amountGiven)+' given on '+(leaveFmtDate(record.dateGiven)||'—'), margin, y); y += 14;
    doc.setFont('helvetica','normal'); doc.setFontSize(9);
    const purposeLines = doc.splitTextToSize('Purpose: '+(record.purpose||'—'), pageW-margin*2);
    doc.text(purposeLines, margin, y); y += purposeLines.length*11 + 10;

    const rows = (liq.items||[]).map((item, idx)=> [String(idx+1), caLiqItemDate(item), caLiqItemParticular(item), caFmtPesoPdf(item.amount)]);
    await loadAwesScript('autotable', awesLibs.autotable);
    doc.autoTable({
      startY: y,
      head: [['Item No.','Date','Particular','Amount']],
      body: rows,
      margin: {left: margin, right: margin},
      styles: {fontSize: 9},
      headStyles: {fillColor:[31,122,80]},
      columnStyles: {0:{cellWidth:40}, 3:{halign:'right', cellWidth:80}}
    });
    y = doc.lastAutoTable.finalY + 16;

    const given = Number(record.amountGiven)||0;
    const total = Number(liq.totalAmount)||0;
    const diff = given - total;
    const excessLabel = diff >= 0 ? 'Unreturned Excess C.A.' : 'Accounts Receivable';
    const balanceLabel = diff >= 0 ? 'Balance to be Returned' : 'Balance to be Reimbursed';
    doc.setFont('helvetica','bold'); doc.setFontSize(10);
    doc.text('Total Expenses', margin, y); doc.text(caFmtPesoPdf(total), pageW-margin, y, {align:'right'}); y+=16;
    doc.setFont('helvetica','normal');
    doc.text(excessLabel, margin, y); doc.text(caFmtPesoPdf(Math.abs(diff)), pageW-margin, y, {align:'right'}); y+=16;
    doc.setFont('helvetica','bold');
    doc.text(balanceLabel, margin, y); doc.text(caFmtPesoPdf(Math.abs(diff)), pageW-margin, y, {align:'right'}); y+=20;

    if(liq.comment){
      doc.setFont('helvetica','bold'); doc.setFontSize(9); doc.text('Notes', margin, y); y+=12;
      doc.setFont('helvetica','normal');
      const noteLines = doc.splitTextToSize(liq.comment, pageW-margin*2);
      doc.text(noteLines, margin, y); y += noteLines.length*11 + 8;
    }

    doc.setFont('helvetica','italic'); doc.setFontSize(8); doc.setTextColor(120,120,120);
    doc.text('System-generated copy — this document cannot be edited.', margin, 800);
    return doc;
  }
  async function caDownloadLiquidationPdf(record){
    try{
      const doc = await caBuildLiquidationPdf(record);
      await shareOrDownloadPdf(doc, 'Liquidation-'+(record.id||'form')+'.pdf');
    }catch(e){ console.error('liquidation pdf failed', e); toast('Could not generate the PDF'); }
  }
  async function caMaybeAutoSaveLiquidationPdf(record){
    const flagKey = 'liqpdf:'+record.id;
    try{
      const existing = await window.storage.get(flagKey, false);
      if(existing) return; // already saved once
    }catch(e){ /* treat a lookup error the same as "not set yet" */ }
    try{
      await caDownloadLiquidationPdf(record);
      await window.storage.set(flagKey, '1', false);
    }catch(e){ console.error('auto-save liquidation pdf failed', e); }
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

    // A liquidation that's never been started yet duplicates the reminder
    // card the technician just came from (same amount/date/purpose) — skip
    // repeating it here. Once there's something to show (a disapproval to
    // fix, or a submission to review) the summary earns its place again.
    const isFreshStart = !active.liquidation;
    $('caLiquidateSummary').style.display = isFreshStart ? 'none' : '';
    $('caLiquidateSummary').innerHTML = isFreshStart ? '' :
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
        // Remove any banner from a previous visit to this tab: the old code
        // prepend()ed a new one every single time, so the disapproval message
        // stacked up copy after copy.
        $('caLiqEditView').querySelectorAll('.ca-liq-disapproval-banner').forEach(el=> el.remove());
        const banner = document.createElement('div');
        banner.className = 'dtr-banner dtr-banner-warn ca-liq-disapproval-banner';
        banner.style.display = 'block';
        banner.style.marginBottom = '12px';
        banner.textContent = 'Disapproved — '+(active.liquidation.comment || 'please review and resubmit.');
        $('caLiqEditView').prepend(banner);
      }else{
        // Before starting blank, check for a local draft from an interrupted
        // previous attempt (tab killed, app backgrounded, lost connection
        // right before Submit, etc.) and offer it back instead of losing it.
        const draft = await caLiqLoadDraft(active.id);
        if(draft && draft.items.length>0){
          caLiqItems = draft.items.map(i=> Object.assign({}, i));
          $('caLiqNotes').value = draft.notes || '';
          toast('Restored your in-progress liquidation draft');
        }else{
          caLiqItems = [];
          $('caLiqNotes').value = '';
        }
      }
      caLiqRenderForm();
    }else{
      caLiqRenderReadonly(active);
      // A liquidation now exists on the server for this record, so any local
      // draft left over from building it is stale — clear it so it doesn't
      // resurface on a future disapproval/resubmit cycle for this record.
      caLiqClearDraft(active.id);
    }
  }

  async function caSubmitLiquidation(){
    if(!caLiqActiveRecord) return;
    if(caLiqItems.length===0){ toast('Add at least one item'); return; }
    for(const item of caLiqItems){
      if(item.type==='transport') continue;
      if(!item.date){ toast('Every item needs a date'); return; }
      if(!item.description || !item.description.trim()){ toast('Every item needs a description'); return; }
      if(!item.amount || item.amount<=0){ toast('Every item needs a valid amount'); return; }
      if(!item.attachmentData){ toast('Attach a file for every item — "'+item.description+'" is missing one'); return; }
    }
    // Reject oversized receipts up front, with a message that says what to do,
    // instead of letting the whole submission fail opaquely at the database.
    let totalBytes = 0;
    for(const item of caLiqItems){
      const size = caAttachmentSize(item.attachmentData);
      if(size > CA_ATTACHMENT_MAX_BYTES){
        toast('"'+(item.description||'An item')+'" attachment is too large — retake the photo or use a smaller file');
        return;
      }
      totalBytes += size;
    }
    if(totalBytes > CA_RECORD_MAX_BYTES){
      toast('These receipts total too much data — remove or retake a few and submit again');
      return;
    }
    const totalAmount = caLiqComputeTotals().total;
    const notes = $('caLiqNotes').value.trim();
    // Fetch just this one record rather than pulling the entire table down.
    const rec = await caGetRequest(caLiqActiveRecord.id);
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
    try{
      const res = await caSaveRequest(rec.id, updated);
      if(res===SAVE_FAILED){ toast('Could not submit — check your connection'); return; }
      toast(res===SAVE_CLOUD
        ? 'Liquidation submitted for approval'
        : 'Saved on this device — it will be submitted once you have a connection');
      // Both SAVE_CLOUD and SAVE_QUEUED mean the liquidation is now recorded
      // (cloud, or the outbox which retries on its own) — the local editing
      // draft has served its purpose and would only cause confusion if it
      // resurfaced later, so clear it.
      await caLiqClearDraft(rec.id);
      // Land back on the Liquidate tab (not History) so the technician sees
      // the readonly confirmation — Pending pill, full itemized form, totals —
      // right away. Jumping to History instead only shows a small status pill
      // with no items, which reads as "it just disappeared" even though the
      // submission went through.
      caShowTab('liquidate');
    }catch(e){
      // Anything unexpected here (a thrown error rather than a handled
      // SAVE_FAILED) used to fail silently with the button stuck disabled
      // and nothing saved. The draft above still has everything, so this is
      // now a "try again" rather than a lost liquidation.
      console.error('liquidation submit threw', e);
      toast('Something went wrong submitting — your items are saved as a draft, please try again');
    }finally{
      $('caLiqSubmitBtn').disabled = false;
    }
  }
  $('caLiqSubmitBtn').addEventListener('click', caSubmitLiquidation);
  $('caLiqNotes').addEventListener('input', caLiqSaveDraft);

  // ================= Admin: review requests, disbursement, liquidation =================
  let caAdminFilter = 'pending';
  async function caRenderAdminList(){
    const list = $('caAdminList');
    list.innerHTML = '<div class="empty-state">Loading…</div>';
    const all = await caListAll();
    // Surface this count regardless of which filter tab is currently active —
    // liquidations pending review sit behind a separate tab from the default
    // "Pending" (request-approval) view, so without a badge they're easy for
    // admin to miss entirely.
    const toReviewCount = all.filter(r=> r.liquidation && r.liquidation.status==='pending').length;
    const badge = $('caToReviewLiqBadge');
    badge.textContent = String(toReviewCount);
    badge.style.display = toReviewCount>0 ? '' : 'none';
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
          (r.status==='cancelled' ? '' : '<button data-act="review" class="primary">'+(r.status==='pending' ? 'Review' : 'Change Decision')+'</button>')+
          (r.status==='approved' ? '<button data-act="disburse-toggle">'+(r.disbursed ? 'Edit Disbursement' : 'Record Disbursement')+'</button>' : '')+
          (r.liquidation ? '<button data-act="liq-toggle">'+(r.liquidation.status==='pending' ? 'Review Liquidation' : 'View Liquidation')+'</button>' : '')+
        '</div>'+
        (r.status==='cancelled' ? '' :
        '<div class="user-edit-panel" data-panel="decision">'+
          '<div class="field"><label>Comment (visible to the technician)</label><textarea data-f="comment" rows="2" placeholder="Optional for approval, recommended for disapproval">'+escapeHtml(r.comment||'')+'</textarea></div>'+
          '<div class="edit-save-row">'+
            '<button class="cancel-btn" data-act="disapprove" type="button" style="color:var(--danger); border-color:#F1C4BC;">Disapprove</button>'+
            '<button class="save-btn" data-act="approve" type="button">Approve</button>'+
          '</div>'+
        '</div>')+
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
      const reviewBtn = card.querySelector('[data-act="review"]');
      if(reviewBtn && decisionPanel){
        reviewBtn.addEventListener('click', ()=>{
          allPanels.forEach(p=>{ if(p!==decisionPanel) p.classList.remove('open'); });
          decisionPanel.classList.toggle('open');
        });
        card.querySelector('[data-act="approve"]').addEventListener('click', ()=> caDecide(r.id, 'approved', decisionPanel.querySelector('[data-f="comment"]').value.trim()));
        card.querySelector('[data-act="disapprove"]').addEventListener('click', ()=> caDecide(r.id, 'disapproved', decisionPanel.querySelector('[data-f="comment"]').value.trim()));
      }
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
        '<div class="hist-info"><b>'+(item.type==='transport'?'🚕 ':'📄 ')+escapeHtml(caLiqItemParticular(item))+'</b>'+
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
    (liq.items||[]).forEach(item=>{
      const el = panel.querySelector('[data-view-item="'+CSS.escape(String(item.id))+'"]');
      // Pass the owning record id so the viewer can fetch the receipt on demand
      // (admin lists are loaded without attachment payloads).
      if(el) el.addEventListener('click', ()=> openLiquidationAttachment(Object.assign({}, item, {__recordId: r.id})));
    });
    const approveBtn = panel.querySelector('[data-act="liq-approve"]');
    const disapproveBtn = panel.querySelector('[data-act="liq-disapprove"]');
    if(approveBtn) approveBtn.addEventListener('click', ()=> caDecideLiquidation(r.id, 'approved', panel.querySelector('[data-f="liqComment"]').value.trim()));
    if(disapproveBtn) disapproveBtn.addEventListener('click', ()=> caDecideLiquidation(r.id, 'disapproved', panel.querySelector('[data-f="liqComment"]').value.trim()));
  }

  // All three admin actions below now:
  //   * require a live connection (a decision queued on one phone and replayed
  //     later would silently clobber whatever happened in between),
  //   * fetch only the one record they are changing,
  //   * write a targeted .update() rather than upserting the technician's whole
  //     record back, and
  //   * guard against acting twice on the same record.
  function caAdminGuard(){
    if(!currentUser || currentUser.role!=='admin'){ toast('Admin only'); return false; }
    return true;
  }
  async function caApplyAdminChange(id, mutate, okMsg){
    if(!(await ensureCloud())){ toast('This needs a connection — try again when online'); return false; }
    try{
      const rec = await caGetRequest(id);
      if(!rec){ toast('Request not found'); return false; }
      const change = mutate(rec);
      if(!change) return false;
      const merged = Object.assign({}, rec, change.data);
      let q = db.from('cash_advance_requests').update(
        change.status ? { status: change.status, data: merged } : { data: merged }
      ).eq('id', id);
      if(change.expectStatus) q = q.eq('status', change.expectStatus);
      const { data: rows, error } = await q.select('id');
      if(error) throw error;
      if(!rows || !rows.length){
        toast('This request changed on another device — refreshing');
        return false;
      }
      if(okMsg) toast(okMsg);
      return true;
    }catch(e){
      console.error('cash advance admin update failed', describeCloudError(e));
      toast('Could not save — please try again');
      return false;
    }
  }

  async function caDecideLiquidation(id, status, comment){
    if(!caAdminGuard()) return;
    if(status==='disapproved' && !comment){
      if(!confirm('Disapprove without a comment? The technician won\'t know why.')) return;
    }
    await caApplyAdminChange(id, (rec)=>{
      if(!rec.liquidation){ toast('Liquidation not found'); return null; }
      if(rec.liquidation.status===status){ toast('Already '+status); return null; }
      return { data: { liquidation: Object.assign({}, rec.liquidation, {
        status, comment: comment || '',
        decidedAt: new Date().toISOString(),
        decidedBy: currentUser.name || 'Admin'
      }) } };
    }, 'Liquidation '+status);
    caRenderAdminList();
  }

  async function caDecide(id, status, comment){
    if(!caAdminGuard()) return;
    if(status==='disapproved' && !comment){
      if(!confirm('Disapprove without a comment? The technician won\'t know why.')) return;
    }
    await caApplyAdminChange(id, ()=>({
      status,
      expectStatus: 'pending',
      data: {
        status, comment: comment || '',
        decidedAt: new Date().toISOString(),
        decidedBy: currentUser.name || 'Admin'
      }
    }), 'Request '+status);
    caRenderAdminList();
  }
  // Monitoring: records that the requested cash was actually handed over, with
  // the date and amount actually given (which can differ from what was requested).
  async function caRecordDisbursement(id, dateGiven, amountGiven){
    if(!caAdminGuard()) return;
    if(!dateGiven){ toast('Set the date the cash was given'); return; }
    if(!amountGiven || amountGiven<=0){ toast('Enter a valid amount given'); return; }
    await caApplyAdminChange(id, (rec)=>{
      if(rec.status!=='approved'){ toast('Approve the request before recording disbursement'); return null; }
      if(rec.disbursed){ toast('Already recorded as disbursed'); return null; }
      return { data: {
        disbursed: true, dateGiven, amountGiven,
        disbursedAt: new Date().toISOString(),
        disbursedBy: currentUser.name || 'Admin'
      } };
    }, 'Disbursement recorded');
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
    document.body.classList.remove('dashboard-active');
    $('homeScreen').style.display = 'none';
    $('serviceReportView').style.display = 'none';
    $('dtrView').style.display = 'none';
    $('leaveView').style.display = 'none';
    $('dispatchView').style.display = 'none';
    $('equipmentManagerView').style.display = 'none';
    $('customersManagerView').style.display = 'none';
    $('serviceReportsManagerView').style.display = 'none';
    $('messagesView').style.display = 'none';
    $('documentsView').style.display = 'none';
    $('customerHistoryView').style.display = 'none';
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

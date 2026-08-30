// ---------- Cash Advance Form (table: cash_advance_requests) ----------
  function caGenId(userId){
    const rand = (window.crypto && window.crypto.randomUUID)
      ? window.crypto.randomUUID()
      : (Date.now()+'_'+Math.random().toString(36).slice(2,10));
    return userId+'_'+rand;
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
        '<div class="leave-comment"><b>You Cannot Request a New Cash Advance at the Moment</b>'+
        (needsSubmit ? 'Needs liquidation — ' : 'Awaiting admin approval — ')+
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
            if(caAttachmentSize(item.attachmentData) > CA_ATTACHMENT_MAX_BYTES){
              item.attachmentData = null; item.attachmentMime = null;
              toast('That file is too large — take a photo instead of attaching a full-size file');
              caLiqRenderItems();
              return;
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
    let html = '<div class="leave-comment" style="margin-bottom:10px;">'+caLiquidationStatusPill(liq)+
      '<div style="margin-top:6px;">Total liquidated: <b>'+caFmtPeso(liq.totalAmount)+'</b> of '+caFmtPeso(record.amountGiven)+' given</div>'+
      (liq.comment ? '<div style="margin-top:6px;"><b>Notes</b> '+escapeHtml(liq.comment)+'</div>' : '')+
      '</div>';
    (liq.items||[]).forEach(item=>{
      html += '<div class="hist-item" style="cursor:pointer;" data-view-item="'+escapeHtml(item.id)+'">'+
        '<div class="hist-info"><b>'+(item.type==='transport'?'🚕 ':'📄 ')+escapeHtml(item.description)+'</b>'+
        '<span>'+caFmtPeso(item.amount)+'</span></div></div>';
    });
    wrap.innerHTML = html;
    (liq.items||[]).forEach(item=>{
      const el = wrap.querySelector('[data-view-item="'+CSS.escape(String(item.id))+'"]');
      if(el) el.addEventListener('click', ()=> openLiquidationAttachment(Object.assign({}, item, {__recordId: record.id})));
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
    const totalAmount = caLiqUpdateTotals();
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
    const res = await caSaveRequest(rec.id, updated);
    $('caLiqSubmitBtn').disabled = false;
    if(res===SAVE_FAILED){ toast('Could not submit — check your connection'); return; }
    toast(res===SAVE_CLOUD
      ? 'Liquidation submitted for approval'
      : 'Saved on this device — it will be submitted once you have a connection');
    caShowTab('history');
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

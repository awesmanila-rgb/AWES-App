// ---------- Leave Form (table: leave_requests; id/status/technician_id are real columns, rest in data) ----------
  // Fallback UUID v4 generator for browsers without crypto.randomUUID — the
  // id column requires a real UUID shape, not just any unique-looking string.
  function leaveGenUUIDv4Fallback(){
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c=>{
      const r = Math.random()*16|0;
      return (c==='x' ? r : (r&0x3|0x8)).toString(16);
    });
  }
  function leaveGenId(userId){
    // id is a real UUID column in Postgres — it must be a single valid UUID,
    // not the technician's id glued onto a random one with '_' (that combined
    // string fails Postgres's uuid type check on every insert, online or not).
    // The technician is already recorded separately via technician_id.
    return (window.crypto && window.crypto.randomUUID)
      ? window.crypto.randomUUID()
      : leaveGenUUIDv4Fallback();
  }

  // A technician submitting or editing their OWN request. Note this deliberately
  // never writes the decision fields — see leaveDecide.
  async function leaveSaveRequest(id, data){
    const payload = {
      id,
      technician_id: data.userId,
      status: data.status || 'pending',
      submitted_at: data.submittedAt || new Date().toISOString(),
      data
    };
    if(await ensureCloud()){
      try{
        const { error } = await db.from('leave_requests').upsert(payload);
        if(error) throw error;
        return SAVE_CLOUD;
      }catch(e){ console.error('leave save failed', describeCloudError(e)); }
    }
    // Offline (or the write was rejected): keep a local copy AND queue it, so it
    // actually reaches the cloud once there is a connection instead of being
    // silently stranded on the phone.
    try{ await window.storage.set('leave:'+id, JSON.stringify(data), false); }
    catch(e){ return SAVE_FAILED; }
    return (await outboxQueue('leave', id, payload)) ? SAVE_QUEUED : SAVE_FAILED;
  }
  registerOutboxHandler('leave', async (id, payload)=>{
    const { error } = await db.from('leave_requests').upsert(payload);
    if(error) throw error;
  });

  // Cloud reads are paginated. The old `.limit(200)` silently truncated the list
  // with no indication, so once the company passed 200 requests the oldest ones
  // just vanished from every screen.
  const LEAVE_PAGE = 200;
  async function leaveFetchPaged(applyFilter){
    const out = [];
    for(let from = 0; ; from += LEAVE_PAGE){
      let q = db.from('leave_requests').select('data').order('submitted_at',{ascending:false}).range(from, from+LEAVE_PAGE-1);
      if(applyFilter) q = applyFilter(q);
      const { data, error } = await q;
      if(error) throw error;
      const batch = data || [];
      batch.forEach(r=> out.push(r.data));
      if(batch.length < LEAVE_PAGE) break;
      if(out.length >= 5000) break; // hard stop; nothing sane reaches this
    }
    return out;
  }
  async function leaveLocalList(userId){
    try{
      const res = await window.storage.list('leave:', false);
      const items = [];
      for(const key of (res.keys||[])){
        try{ const item = await window.storage.get(key, false); items.push(JSON.parse(item.value)); }catch(e){}
      }
      const filtered = userId ? items.filter(r=> r && r.userId===userId) : items;
      filtered.sort((a,b)=> (b.submittedAt||'').localeCompare(a.submittedAt||''));
      return filtered;
    }catch(e){ return []; }
  }
  async function leaveListAll(){
    if(await ensureCloud()){
      try{ return await leaveFetchPaged(null); }
      catch(e){ console.error('leave list failed', describeCloudError(e)); }
    }
    return await leaveLocalList(null);
  }
  // Filters on the SERVER. Previously this downloaded every technician's leave
  // requests to the phone and filtered in JavaScript, which both leaked
  // co-workers' personal leave reasons to anyone who opened devtools and wasted
  // mobile data.
  async function leaveListForUser(userId){
    if(!userId) return [];
    if(await ensureCloud()){
      try{ return await leaveFetchPaged(q=> q.eq('technician_id', userId)); }
      catch(e){ console.error('leave list (user) failed', describeCloudError(e)); }
    }
    return await leaveLocalList(userId);
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
    const res = await leaveSaveRequest(id, data);
    $('leaveSubmitBtn').disabled = false;
    if(res===SAVE_FAILED){ toast('Could not submit — check your connection'); return; }
    // Be honest about which of the two happened: "submitted" used to be shown
    // even when the request never left the phone.
    toast(res===SAVE_CLOUD
      ? 'Leave request submitted for approval'
      : 'Saved on this device — it will be submitted once you have a connection');
    leaveResetForm();
    leaveShowTab('history');
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
    if(!currentUser || currentUser.role!=='admin'){ toast('Admin only'); return; }
    if(!(await ensureCloud())){ toast('Decisions need a connection — try again when online'); return; }
    // Targeted update rather than re-uploading the whole record. The old
    // read-modify-write raced with the technician editing their request (either
    // side could silently clobber the other) and it also meant the decision
    // travelled inside the same blob the technician is allowed to write.
    const decision = {
      status, comment: comment || '',
      decidedAt: new Date().toISOString(),
      decidedBy: currentUser.name || 'Admin'
    };
    try{
      const { data: rows, error: readErr } = await db.from('leave_requests')
        .select('data').eq('id', id).maybeSingle();
      if(readErr) throw readErr;
      if(!rows){ toast('Request not found'); return; }
      const merged = Object.assign({}, rows.data || {}, decision);
      const { data: updated, error } = await db.from('leave_requests')
        .update({ status, data: merged })
        .eq('id', id)
        .eq('status', 'pending')   // optimistic guard: don't overwrite a decision
        .select('id');
      if(error) throw error;
      if(!updated || !updated.length){
        toast('This request was already decided — refreshing');
      }else{
        toast('Request '+status);
      }
    }catch(e){
      console.error('leave decide failed', describeCloudError(e));
      toast('Could not save decision');
    }
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

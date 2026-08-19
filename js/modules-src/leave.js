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

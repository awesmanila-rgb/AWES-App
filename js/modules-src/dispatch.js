// ---------- Service Dispatch Ticket (table: dispatch_tickets) ----------
  // Admin-created and assigned to one or more technicians; those technicians
  // then acknowledge and later mark it completed. This is the reverse
  // direction from Leave/Cash Advance (which are technician-filed, admin-
  // reviewed) — here admin files, technician actions it.
  function dtGenLocalId(){ return 'JO-'+todayISO().replace(/-/g,'')+'-'+Date.now(); }
  // Old tickets only ever had a single equipmentDetails object + one shared
  // scope list. Wrap those into the new equipmentList shape on read so
  // nothing written before this change breaks.
  function dtNormalizeTicket(rec){
    if(!rec) return rec;
    if(!rec.equipmentList){
      if(rec.equipmentDetails && Object.values(rec.equipmentDetails).some(v=>v)){
        rec.equipmentList = [Object.assign({id:'legacy-1'}, rec.equipmentDetails, {
          scope: rec.scope||[], reportSrNo: rec.status==='completed' ? 'legacy' : null
        })];
      }else{
        rec.equipmentList = [];
      }
    }
    return rec;
  }
  const DT_PAGE = 200;
  const DT_MAX_ROWS = 5000;
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
  // Returns a tri-state result so callers can tell "saved to the server" from
  // "only saved on this phone" instead of showing a success message either way.
  async function dtSaveTicket(id, data){
    if(await ensureCloud()){
      try{
        const { error } = await db.from('dispatch_tickets').upsert({
          id, status: data.status||'open',
          created_at: data.createdAt || new Date().toISOString(), data
        });
        if(error) throw error;
        return SAVE_CLOUD;
      }catch(e){ console.error('dispatch save failed', describeCloudError(e)); }
    }
    try{
      await window.storage.set('dispatch:'+id, JSON.stringify(data), false);
      return (await outboxQueue('dispatch', id, data)) ? SAVE_QUEUED : SAVE_FAILED;
    }catch(e){ return SAVE_FAILED; }
  }
  registerOutboxHandler('dispatch', async (id, payload)=>{
    const { error } = await db.from('dispatch_tickets').upsert({
      id, status: payload.status||'open',
      created_at: payload.createdAt || new Date().toISOString(), data: payload
    });
    if(error) throw error;
  });

  async function dtLocalList(){
    try{
      const res = await window.storage.list('dispatch:', false);
      const items = [];
      for(const key of (res.keys||[])){
        try{ const item = await window.storage.get(key, false); items.push(dtNormalizeTicket(JSON.parse(item.value))); }catch(e){}
      }
      items.sort((a,b)=> (b.createdAt||'').localeCompare(a.createdAt||''));
      return items;
    }catch(e){ return []; }
  }
  // Pages through results instead of silently stopping at 300 rows, which used
  // to make older tickets vanish from the admin list with no warning.
  async function dtFetchPaged(applyFilter){
    const out = [];
    for(let from=0; from<DT_MAX_ROWS; from+=DT_PAGE){
      let q = db.from('dispatch_tickets').select('data')
        .order('created_at',{ascending:false}).range(from, from+DT_PAGE-1);
      if(applyFilter) q = applyFilter(q);
      const { data, error } = await q;
      if(error) throw error;
      const rows = data || [];
      rows.forEach(r=> out.push(dtNormalizeTicket(r.data)));
      if(rows.length < DT_PAGE) break;
    }
    return out;
  }
  async function dtListAll(){
    if(await ensureCloud()){
      try{ return await dtFetchPaged(null); }
      catch(e){ console.error('dispatch list failed', describeCloudError(e)); }
    }
    return dtLocalList();
  }
  // Filters on the server (`assigned_worker_ids @> [workerId]`) rather than
  // downloading every technician's tickets and filtering in JavaScript.
  async function dtListForWorker(workerId){
    if(!workerId) return [];
    if(await ensureCloud()){
      try{
        return await dtFetchPaged(q=> q.contains('data->assignedWorkerIds', JSON.stringify([workerId])));
      }catch(e){ console.error('dispatch worker list failed', describeCloudError(e)); }
    }
    return (await dtLocalList()).filter(t=> (t.assignedWorkerIds||[]).includes(workerId));
  }
  // Being ASSIGNED to a ticket and being ALLOWED to file its Service Report
  // are two different things — admin explicitly picks which assigned
  // worker(s) may create the report, so not everyone on the ticket can.
  // This powers the "From Job Order" picker specifically; dtListForWorker
  // above still governs general ticket visibility (the My Job Order tab).
  async function dtListForReporter(workerId){
    if(!workerId) return [];
    if(await ensureCloud()){
      try{
        return await dtFetchPaged(q=> q.contains('data->reportAllowedWorkerIds', JSON.stringify([workerId])));
      }catch(e){ console.error('dispatch reporter list failed', describeCloudError(e)); }
    }
    return (await dtLocalList()).filter(t=> (t.reportAllowedWorkerIds||[]).includes(workerId));
  }

  // ---------- Service Report: "From Job Order" picker ----------
  // Shows the technician's own Job Order tickets that still have equipment
  // needing a report. Tapping a ticket expands its pending equipment as a
  // checklist; tapping one piece of equipment fills the form with THAT
  // unit's details/scope and files one report just for it — one dispatch
  // ticket can cover many units, but each still gets its own report.
  // srCurrentTicketId / srCurrentEquipId (which ticket + equipment item the
  // report currently being filed is tied to) are declared in ui.js, not
  // here — resetForm() runs once at load time before this module's code
  // executes, and clears them, so they must already be initialized by then.
  async function srRenderJobOrderPicker(){
    const card = $('srJobOrderCard');
    const list = $('srJobOrderList');
    if(!currentUser || currentUser.role==='admin'){
      card.style.display = 'none';
      // Admin has no Job Order gate — Customer's Info is always visible.
      $('sec1Card').style.display = '';
      return;
    }
    card.style.display = '';
    list.innerHTML = '<div class="empty-state">Loading…</div>';
    const mine = await dtListForReporter(currentUser.id);
    const openOnes = mine.filter(r=> (r.equipmentList||[]).some(it=> !it.reportSrNo));
    if(openOnes.length===0){
      list.innerHTML = '<div class="empty-state">No Job Order tickets with equipment still needing a report.</div>';
      return;
    }
    list.innerHTML = '';
    openOnes.forEach(r=>{
      const items = r.equipmentList||[];
      const pending = items.filter(it=>!it.reportSrNo);
      const row = document.createElement('div');
      row.className = 'user-card';
      row.innerHTML = '<div class="user-card-head" style="cursor:pointer;">'+
          '<div>'+
            '<div class="u-name">'+escapeHtml(r.jobOrderNo)+' — '+escapeHtml(r.custName)+'</div>'+
            '<div class="u-status">'+leaveFmtDate(r.date)+(r.expectedTime ? (' at '+r.expectedTime) : '')+
              (r.siteAddress ? (' · '+escapeHtml(r.siteAddress)) : '')+'</div>'+
            '<div class="u-status">'+(items.length-pending.length)+' of '+items.length+' equipment reported</div>'+
          '</div>'+
          dtStatusPill(r)+
        '</div>'+
        '<div class="dt-equip-pending" style="display:none; margin-top:8px;"></div>';
      const head = row.querySelector('.user-card-head');
      const pendingWrap = row.querySelector('.dt-equip-pending');
      head.addEventListener('click', ()=>{
        const isOpen = pendingWrap.style.display !== 'none';
        pendingWrap.style.display = isOpen ? 'none' : '';
        if(!isOpen && pendingWrap.childElementCount===0){
          if(pending.length===0){
            pendingWrap.innerHTML = '<div class="empty-state">All equipment on this ticket already has a report.</div>';
          }
          pending.forEach(it=>{
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'combo-item';
            btn.style.cssText = 'display:flex; align-items:center; justify-content:space-between; gap:8px; width:100%; text-align:left; border:1px solid var(--border); border-radius:8px; margin-bottom:6px; padding:10px; background:none;';
            // A pending item with a draftSrNo already has a Service Report
            // started for it (just not completed yet). Flag it clearly so a
            // technician re-opening this ticket doesn't start a second,
            // duplicate report for the same unit — tapping it below resumes
            // the existing draft instead of blanking the form.
            btn.innerHTML = '<span>'+escapeHtml(dtEquipSummaryLine(it))+'</span>'+
              (it.draftSrNo ? '<span class="status-pill status-draft" style="flex-shrink:0;">Draft Saved</span>' : '');
            btn.addEventListener('click', (e)=>{
              e.stopPropagation();
              if(it.draftSrNo) srResumeDraft(r, it);
              else srApplyJobOrder(r, it);
            });
            pendingWrap.appendChild(btn);
          });
        }
      });
      list.appendChild(row);
    });
  }
  // Was calling applyCustomerToForm(matched), which kicks off
  // loadCustomerEquipment(...).then(defaultEquipTabForCustomer) without
  // waiting for it — that promise settled AFTER this function had already
  // filled in the equipment fields and switched to the "addnew" tab to show
  // them, and its resolution (defaultEquipTabForCustomer -> setEquipTab(null))
  // immediately hid that same section again. The fields were technically
  // populated, but invisible, so a technician tapping a unit from the Job
  // Order picker had to switch tabs by hand to actually see the autofill —
  // exactly the redundant re-selecting this picker exists to avoid. Awaiting
  // the equipment load here, then applying the equipment fields and calling
  // setEquipTab('addnew') last, guarantees nothing can hide the section
  // afterward.
  async function srApplyJobOrder(ticket, equipItem){
    resetForm();
    // A Job Order was actually picked — Customer's Info (and everything
    // after it) can now be shown, since a technician's report must be tied
    // to an authorized ticket rather than a freely-typed customer.
    $('sec1Card').style.display = '';
    // Prefer a saved customer record when the name matches — it may have an
    // email on file (dispatch tickets don't capture one), which the report
    // needs for auto-send. Job-order-specific site/contact details still win.
    const matched = customersCache.find(c=> c.name.toLowerCase() === (ticket.custName||'').trim().toLowerCase());
    if(matched){
      $('custName').value = matched.name;
      $('custAddress').value = matched.address||'';
      $('contactNo').value = matched.contactNo||'';
      $('contactPerson').value = matched.contactPerson||'';
      $('custEmail').value = matched.email||'';
      await loadCustomerEquipment(matched.id);
      revealSectionsAfterCustomer();
    }else{
      $('custName').value = ticket.custName||'';
      revealSectionsAfterCustomer();
    }
    if(ticket.siteAddress) $('custAddress').value = ticket.siteAddress;
    if(ticket.contactName) $('contactPerson').value = ticket.contactName;
    if(ticket.contactNo) $('contactNo').value = ticket.contactNo;
    if(equipItem){
      EQUIP_FIELD_KEYS.forEach(k=>{ const el=$(k); if(el) el.value = equipItem[k]||''; });
      setEquipTab('addnew'); // last, so nothing queued above can re-hide these fields
      if(equipItem.scope && equipItem.scope.length) $('troubleCall').value = equipItem.scope.join('; ');
    }
    srCurrentTicketId = ticket.id;
    srCurrentEquipId = equipItem ? equipItem.id : null;
    toast('Job Order '+ticket.jobOrderNo+' applied — check the fields below');
    $('sec1Head').scrollIntoView({behavior:'smooth', block:'start'});
  }

  // Re-opens an equipment item that already has a draft Service Report
  // (equipItem.draftSrNo) instead of starting a blank one — that avoids
  // filing a second report for the same unit. Pulls the full previously-
  // saved report (not just the customer/equipment fields srApplyJobOrder
  // fills in) via the normal report loader, then re-attaches the Job Order
  // linkage from this click's context, since the saved report row itself
  // doesn't carry ticketId/equipId.
  async function srResumeDraft(ticket, equipItem){
    const srNo = equipItem.draftSrNo;
    let data = null;
    if(await ensureCloud()) data = await cloudGetReport(srNo);
    if(!data){
      try{ const item = await window.storage.get('report:'+srNo, false); data = item ? JSON.parse(item.value) : null; }
      catch(e){ data = null; }
    }
    if(!data){
      toast('Could not load the saved draft for this unit — starting a new report instead');
      srApplyJobOrder(ticket, equipItem);
      return;
    }
    await openReport(data);
    srCurrentTicketId = ticket.id;
    srCurrentEquipId = equipItem.id;
    toast('Continuing draft '+srNo);
  }

  // ---- simple repeatable-textarea list (scope items) ----
  function dtAddSimpleRow(containerId, value){
    const wrap = document.createElement('div');
    wrap.className = 'itemrow';
    const ta = document.createElement('textarea');
    ta.rows = 1; ta.value = value || '';
    ta.placeholder = 'e.g. Clean coils, check refrigerant, test operation';
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
  // ---------- Equipment picker for Dispatch Ticket ----------
  // Deliberately independent state from Service Report's equipment picker
  // (not sharing currentCustomerId/currentEquipmentCache) — Dispatch and
  // Service Report can each have their own form mid-edit, and sharing that
  // global state would let one screen's customer selection silently
  // overwrite the other's equipment list. Both read/write the same
  // customer_equipment table underneath, so equipment entered on a dispatch
  // ticket shows up for technicians on Service Report later, and vice versa.
  let dtCurrentCustomerId = null;
  let dtCurrentEquipmentCache = [];
  let dtCurrentEquipTab = null;
  // Multi-equipment draft state for the ticket currently being built — each
  // item becomes its own Service Report later, so each carries its own scope
  // (seeded from the Default Scope list at the moment it's added, then
  // independently editable per unit).
  let dtDraftEquipItems = [];
  function dtGenEquipId(){ return 'de-'+Date.now()+'-'+Math.random().toString(36).slice(2,7); }
  function dtPickEquipFields(e){ const out={}; EQUIP_FIELD_KEYS.forEach(k=> out[k]=e[k]||''); return out; }
  function dtEquipKey(fields){ return EQUIP_FIELD_KEYS.map(k=>(fields[k]||'').trim()).join('|'); }
  async function dtLoadCustomerEquipment(customerId){
    dtCurrentCustomerId = customerId;
    if(!customerId){ dtCurrentEquipmentCache = []; return; }
    if(await ensureCloud()){
      try{
        const { data, error } = await db.from('customer_equipment').select('*').eq('customer_id', customerId);
        if(error) throw error;
        dtCurrentEquipmentCache = (data||[]).map(equipRowToObj);
        return;
      }catch(e){ console.error('load dispatch equipment failed', describeCloudError(e)); }
    }
    dtCurrentEquipmentCache = [];
  }
  function dtEquipSummaryLine(e){
    return [e.equipType, e.brand, e.coolCap, e.mountType, e.equipLocation].filter(Boolean).join('  ·  ') || '(no details on file)';
  }
  // Checkbox multi-select — lets an admin add several (or all) of a
  // customer's known units to this ticket in one pass instead of loading
  // them into the single-equipment fields one at a time.
  function dtRenderEquipPicker(){
    const list = $('dtEquipPickerList');
    list.innerHTML = '';
    if(!dtCurrentCustomerId){
      list.innerHTML = '<div class="combo-empty">Select a customer first.</div>';
      return;
    }
    if(dtCurrentEquipmentCache.length===0){
      list.innerHTML = '<div class="combo-empty">No equipment on file yet for this customer — tap "+ Add New" to add one.</div>';
      return;
    }
    const addedKeys = new Set(dtDraftEquipItems.map(it=> dtEquipKey(it)));
    dtCurrentEquipmentCache.forEach(e=>{
      const already = addedKeys.has(dtEquipKey(e));
      const row = document.createElement('label');
      row.className = 'chk';
      row.style.cssText = 'display:flex; border:1px solid var(--border); border-radius:8px; margin-bottom:6px; padding:10px;'+(already?' opacity:.6;':'');
      row.innerHTML = '<input type="checkbox" value="'+e.id+'"'+(already?' disabled checked':'')+'><span>'+escapeHtml(dtEquipSummaryLine(e))+(already?' (already added)':'')+'</span>';
      list.appendChild(row);
    });
  }
  function dtEquipCountLabel(){
    $('dtEquipCount').textContent = dtDraftEquipItems.length===0
      ? 'No equipment added yet'
      : (dtDraftEquipItems.length+' equipment added to this ticket');
  }
  // Appends one equipment line item as its own card with an independent,
  // always-editable Scope of Service list — seeded from the Default Scope
  // list at the moment of adding. Appending (never re-rendering the whole
  // list) means adding/removing one item never wipes another item's
  // in-progress scope edits.
  function dtAppendEquipItemCard(item){
    const wrap = $('dtEquipItemsList');
    const empty = wrap.querySelector('.empty-state');
    if(empty) empty.remove();
    const scopeId = 'dtEquipScope-'+item.id;
    const card = document.createElement('div');
    card.className = 'user-card';
    card.style.marginBottom = '8px';
    card.dataset.equipId = item.id;
    card.innerHTML = '<div class="user-card-head"><div><div class="u-name">'+escapeHtml(dtEquipSummaryLine(item))+'</div></div></div>'+
      '<div class="field" style="margin-top:6px; margin-bottom:6px;">'+
        '<label style="font-size:12px;">Scope of Service for this unit</label>'+
        '<div id="'+scopeId+'"></div>'+
      '</div>';
    const rmBtn = document.createElement('button');
    rmBtn.type = 'button'; rmBtn.className = 'rm-btn'; rmBtn.textContent = 'Remove';
    rmBtn.style.cssText = 'width:auto; padding:4px 10px;';
    rmBtn.addEventListener('click', ()=>{
      dtDraftEquipItems = dtDraftEquipItems.filter(x=> x.id!==item.id);
      card.remove();
      dtEquipCountLabel();
      if(dtDraftEquipItems.length===0) wrap.innerHTML = '<div class="empty-state">No equipment added yet.</div>';
      dtRenderEquipPicker();
    });
    card.querySelector('.user-card-head').appendChild(rmBtn);
    const scopeBtn = document.createElement('button');
    scopeBtn.type = 'button'; scopeBtn.className = 'add-row-btn'; scopeBtn.textContent = '+ Add scope item';
    scopeBtn.addEventListener('click', ()=> dtAddSimpleRow(scopeId));
    card.querySelector('.field').appendChild(scopeBtn);
    wrap.appendChild(card);
    const defaults = dtCollectSimpleList('dtDefaultScopeList');
    if(defaults.length) defaults.forEach(v=> dtAddSimpleRow(scopeId, v));
    else dtAddSimpleRow(scopeId);
    dtEquipCountLabel();
  }
  function dtAddEquipItemFromFields(){
    const fields = dtCollectEquipmentFields();
    if(!EQUIP_FIELD_KEYS.some(k=>fields[k])){ toast('Enter at least one equipment detail'); return; }
    const item = Object.assign({id: dtGenEquipId()}, fields);
    dtDraftEquipItems.push(item);
    dtAppendEquipItemCard(item);
    if(dtCurrentCustomerId) dtAddCustomerEquipmentIfNew(dtCurrentCustomerId, fields);
    dtResetEquipmentFields();
    toast('Equipment added to ticket');
  }
  function dtAddSelectedExistingEquip(){
    const checked = Array.from($('dtEquipPickerList').querySelectorAll('input:checked:not(:disabled)'));
    if(checked.length===0){ toast('Select at least one'); return; }
    checked.forEach(cb=>{
      const e = dtCurrentEquipmentCache.find(x=> x.id===cb.value);
      if(!e) return;
      const item = Object.assign({id: dtGenEquipId()}, dtPickEquipFields(e));
      dtDraftEquipItems.push(item);
      dtAppendEquipItemCard(item);
    });
    dtRenderEquipPicker();
    toast(checked.length+' equipment added');
  }
  function dtAddAllExistingEquip(){
    const addedKeys = new Set(dtDraftEquipItems.map(it=> dtEquipKey(it)));
    let count = 0;
    dtCurrentEquipmentCache.forEach(e=>{
      const key = dtEquipKey(e);
      if(addedKeys.has(key)) return;
      const item = Object.assign({id: dtGenEquipId()}, dtPickEquipFields(e));
      dtDraftEquipItems.push(item);
      dtAppendEquipItemCard(item);
      addedKeys.add(key);
      count++;
    });
    dtRenderEquipPicker();
    toast(count>0 ? ('Added '+count+' equipment from file') : 'All equipment on file is already added');
  }
  $('dtAddEquipItemBtn').addEventListener('click', dtAddEquipItemFromFields);
  $('dtAddSelectedEquipBtn').addEventListener('click', dtAddSelectedExistingEquip);
  $('dtAddAllEquipBtn').addEventListener('click', dtAddAllExistingEquip);
  function dtSetEquipTab(tab){
    dtCurrentEquipTab = tab;
    $('dtEquipTabExisting').classList.toggle('active', tab==='existing');
    $('dtEquipTabAddNew').classList.toggle('active', tab==='addnew');
    if(tab==='existing'){
      if(!dtCurrentCustomerId){ toast('Select a customer first'); dtCurrentEquipTab='addnew'; $('dtEquipTabExisting').classList.remove('active'); $('dtEquipTabAddNew').classList.add('active'); }
      $('dtEquipPickerPanel').style.display = dtCurrentEquipTab==='existing' ? '' : 'none';
      $('dtEquipFieldsWrap').style.display = dtCurrentEquipTab==='existing' ? 'none' : '';
      if(dtCurrentEquipTab==='existing') dtRenderEquipPicker();
    }else if(tab==='addnew'){
      $('dtEquipPickerPanel').style.display = 'none';
      $('dtEquipFieldsWrap').style.display = '';
    }else{
      $('dtEquipPickerPanel').style.display = 'none';
      $('dtEquipFieldsWrap').style.display = 'none';
    }
  }
  function dtDefaultEquipTabForCustomer(){
    dtSetEquipTab(dtCurrentEquipmentCache.length>0 ? 'existing' : 'addnew');
  }
  function dtCollectEquipmentFields(){
    const fields = {};
    EQUIP_FIELD_KEYS.forEach(k=>{ const el=$('dt'+k.charAt(0).toUpperCase()+k.slice(1)); fields[k] = el ? el.value.trim() : ''; });
    return fields;
  }
  function dtResetEquipmentFields(){
    EQUIP_FIELD_KEYS.forEach(k=>{ const el=$('dt'+k.charAt(0).toUpperCase()+k.slice(1)); if(el) el.value=''; });
  }
  // Records new equipment against the customer, deduping against THIS
  // dedicated cache (not the shared one Service Report uses).
  async function dtAddCustomerEquipmentIfNew(customerId, fields){
    if(!customerId) return;
    const hasAnyValue = EQUIP_FIELD_KEYS.some(k=> (fields[k]||'').trim());
    if(!hasAnyValue) return;
    const dupe = dtCurrentEquipmentCache.find(e=> EQUIP_FIELD_KEYS.every(k=> (e[k]||'') === (fields[k]||'')));
    if(dupe) return;
    if(!(await ensureCloud())) return;
    try{
      const rec = { customer_id: customerId };
      EQUIP_FIELD_KEYS.forEach(k=> rec[EQUIP_FIELD_TO_COLUMN[k]] = fields[k]||'');
      const { error } = await db.from('customer_equipment').insert(rec);
      if(error) throw error;
    }catch(e){ console.error('add dispatch equipment failed', describeCloudError(e)); }
  }

  function dtSetupCustomerCombo(){
    const input = $('dtCustName');
    if(input.dataset.comboAttached) return;
    input.dataset.comboAttached = '1';
    const wrap = $('dtCustNameWrap');
    wrap.style.position = 'relative';
    input.classList.add('combo-input');
    const caret = document.createElement('button');
    caret.type = 'button'; caret.className = 'combo-caret'; caret.innerHTML = '&#9662;';
    wrap.appendChild(caret);
    const panel = document.createElement('div');
    panel.className = 'combo-panel';
    wrap.appendChild(panel);
    function fillFrom(c){
      input.value = c.name;
      input.dataset.customerId = c.id;
      $('dtSiteAddress').value = c.address||'';
      $('dtContactName').value = c.contactPerson||'';
      $('dtContactNo').value = c.contactNo||'';
      panel.classList.remove('open');
      dtResetEquipmentFields();
      dtLoadCustomerEquipment(c.id).then(dtDefaultEquipTabForCustomer);
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
    input.addEventListener('input', ()=>{ delete input.dataset.customerId; render(input.value); });
    caret.addEventListener('click', (e)=>{
      e.preventDefault();
      if(panel.classList.contains('open')){ panel.classList.remove('open'); } else { render(input.value); input.focus(); }
    });
    document.addEventListener('click', (e)=>{ if(!wrap.contains(e.target)) panel.classList.remove('open'); });
    if(!$('dtEquipTabExisting').dataset.hooked){
      $('dtEquipTabExisting').dataset.hooked = '1';
      $('dtEquipTabExisting').addEventListener('click', ()=> dtSetEquipTab('existing'));
      $('dtEquipTabAddNew').addEventListener('click', ()=> dtSetEquipTab('addnew'));
      dtSetEquipTab(null);
    }
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
    if(!box.dataset.hooked){
      box.dataset.hooked = '1';
      box.addEventListener('change', dtRenderReporterChecklist);
    }
    dtRenderReporterChecklist();
  }
  // The "who can create the Service Report" list is always a SUBSET of
  // whoever is currently checked in Assigned Workers — kept in sync live,
  // so admin can't accidentally authorize someone who isn't even assigned.
  function dtRenderReporterChecklist(){
    const assigned = Array.from($('dtWorkerChecklist').querySelectorAll('input:checked'))
      .map(el=>({id: el.value, name: el.dataset.name}));
    const box = $('dtReporterChecklist');
    const previouslyChecked = new Set(Array.from(box.querySelectorAll('input:checked')).map(el=>el.value));
    if(assigned.length===0){ box.innerHTML = '<div class="empty-state">Assign workers above first.</div>'; return; }
    box.innerHTML = '';
    assigned.forEach(w=>{
      const lbl = document.createElement('label');
      lbl.className = 'chk';
      const checked = previouslyChecked.has(w.id) ? ' checked' : '';
      lbl.innerHTML = '<input type="checkbox" value="'+w.id+'" data-name="'+escapeHtml(w.name)+'"'+checked+'><span>'+escapeHtml(w.name)+'</span>';
      box.appendChild(lbl);
    });
  }

  function dtResetForm(){
    $('dtJobOrderNo').value = '—';
    $('dtDate').value = todayISO();
    $('dtExpectedTime').value = '';
    $('dtCustName').value = ''; delete $('dtCustName').dataset.customerId;
    $('dtSiteAddress').value = '';
    $('dtContactName').value = ''; $('dtContactNo').value = '';
    dtResetEquipmentFields();
    dtLoadCustomerEquipment(null);
    dtSetEquipTab(null);
    $('dtDefaultScopeList').innerHTML=''; dtAddSimpleRow('dtDefaultScopeList');
    dtDraftEquipItems = [];
    $('dtEquipItemsList').innerHTML = '<div class="empty-state">No equipment added yet.</div>';
    dtEquipCountLabel();
    $('dtRemarks').value = '';
    ['dtReqWorkPermit','dtReqGatePass','dtReqSafety','dtReqOthers'].forEach(id=> $(id).checked=false);
    $('dtReqOthersDetail').value = '';
    $('dtReqOthersDetailWrap').style.display = 'none';
    dtRenderWorkerChecklist();
  }

  async function dtCreateTicket(){
    const workers = Array.from($('dtWorkerChecklist').querySelectorAll('input:checked'))
      .map(el=>({id: el.value, name: el.dataset.name}));
    const reporters = Array.from($('dtReporterChecklist').querySelectorAll('input:checked'))
      .map(el=>({id: el.value, name: el.dataset.name}));
    const custName = $('dtCustName').value.trim();
    const custId = $('dtCustName').dataset.customerId || null;
    if(workers.length===0){ toast('Assign at least one worker'); return; }
    if(reporters.length===0){ toast('Select at least one technician who can create the Service Report'); return; }
    if(!custName){ toast('Enter the customer\'s name'); return; }
    if(!$('dtDate').value){ toast('Set the date'); return; }
    if(dtDraftEquipItems.length===0){ toast('Add at least one piece of equipment to the ticket'); return; }
    $('dtCreateBtn').disabled = true; $('dtCreateBtn').textContent = 'Creating…';
    const jobOrderNo = await dtNextJobOrderNo();
    const id = jobOrderNo || dtGenLocalId();
    // One line item per piece of equipment, each with its own scope — one
    // Service Report gets filed per item later, tracked via reportSrNo.
    const equipmentList = dtDraftEquipItems.map(item=>{
      const scope = dtCollectSimpleList('dtEquipScope-'+item.id);
      return Object.assign({}, item, { scope, reportSrNo: null });
    });
    const data = {
      id, jobOrderNo: id, status: 'open',
      date: $('dtDate').value, expectedTime: $('dtExpectedTime').value,
      assignedWorkerIds: workers.map(w=>w.id), assignedWorkerNames: workers.map(w=>w.name),
      reportAllowedWorkerIds: reporters.map(w=>w.id), reportAllowedWorkerNames: reporters.map(w=>w.name),
      custName, siteAddress: $('dtSiteAddress').value.trim(),
      contactName: $('dtContactName').value.trim(), contactNo: $('dtContactNo').value.trim(),
      equipment: equipmentList.map(dtEquipSummaryLine), equipmentList,
      remarks: $('dtRemarks').value.trim(),
      requirements: {
        workPermit: $('dtReqWorkPermit').checked, gatePass: $('dtReqGatePass').checked,
        safety: $('dtReqSafety').checked, others: $('dtReqOthers').checked,
        othersDetail: $('dtReqOthersDetail').value.trim()
      },
      createdAt: new Date().toISOString(),
      createdBy: currentUser ? currentUser.name : 'Admin',
      acknowledgedBy: [], completedBy: [], completedAt: null
    };
    const res = await dtSaveTicket(id, data);
    $('dtCreateBtn').disabled = false; $('dtCreateBtn').textContent = 'Create Dispatch Ticket';
    if(res===SAVE_FAILED){ toast('Could not create ticket — check your connection'); return; }
    if(custId) equipmentList.forEach(item=> dtAddCustomerEquipmentIfNew(custId, item));
    toast(res===SAVE_CLOUD
      ? ('Dispatch ticket '+id+' created')
      : ('Ticket '+id+' saved on this device — technicians will see it once you are online'));
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
  // ---------- Auto-expire (display-only) ----------
  // A ticket is never silently rewritten by this — "expired" is computed
  // fresh every render, purely from today's date vs. the ticket's scheduled
  // date. Nothing is actually resolved until someone uses Close Job Order
  // (see dtCloseTicket below), which is the only thing that writes a final
  // status. If the date field is edited or the ticket already reached
  // completed/closed, this stops applying on its own — no cleanup needed.
  function dtIsPastDue(r){ return !!r.date && r.date < todayISO(); }
  function dtEffectiveStatus(r){
    if(r.status==='completed' || r.status==='closed') return r.status;
    if(dtIsPastDue(r)) return 'expired';
    return r.status || 'open';
  }
  function dtStatusPill(r){
    const status = dtEffectiveStatus(r);
    if(status==='completed') return leaveStatusPill('approved');
    if(status==='closed'){
      const hasExceptions = (r.equipmentList||[]).some(it=> it.notDone);
      return '<span class="status-pill" style="background:#E4E7E4; color:#4A524B;">Closed'+(hasExceptions ? ' \u26A0' : '')+'</span>';
    }
    if(status==='expired') return '<span class="status-pill" style="background:#F8D7DA; color:#B02A37;">Expired</span>';
    if(status==='acknowledged') return '<span class="status-pill" style="background:#DCEAE0; color:var(--green-dark);">Acknowledged</span>';
    return '<span class="status-pill status-draft">Open</span>';
  }
  // Shows every equipment item on the ticket with its own scope and
  // report status, capped so a 100-unit ticket doesn't blow up the card —
  // the full list is still reachable via the technician's equipment
  // checklist when filing reports. Each row is a link (data-ticket-id /
  // data-equip-idx) opening dtOpenEquipDetailOverlay with that unit's full
  // record — see the click delegation on #dtAdminList/#dtTechList below,
  // since dtCardHtml's result is injected via innerHTML rather than built
  // as live DOM nodes, so individual listeners can't be attached here.
  function dtEquipmentSummaryBlock(r){
    const items = r.equipmentList || [];
    if(items.length===0) return '';
    const reported = items.filter(it=>it.reportSrNo).length;
    const cap = 8;
    const rows = items.slice(0,cap).map((it,i)=>{
      const scope = (it.scope||[]).map(escapeHtml).join('; ');
      return '<div class="dt-equip-row" data-ticket-id="'+escapeHtml(r.id)+'" data-equip-idx="'+i+'" '+
        'style="margin:4px 0; padding-left:8px; border-left:2px solid var(--border); cursor:pointer;">'+
        '<div>'+escapeHtml(dtEquipSummaryLine(it))+(it.reportSrNo ? ' <span style="color:var(--green-dark);">&#10003; Reported</span>' : '')+
          ' <span style="color:var(--green-dark); text-decoration:underline; font-size:12px;">View details ›</span></div>'+
        (scope ? '<div style="font-size:12px; color:var(--text-muted);">Scope: '+scope+'</div>' : '')+
      '</div>';
    }).join('') + (items.length>cap ? '<div style="font-size:12px; color:var(--text-muted);">+'+(items.length-cap)+' more…</div>' : '');
    return '<div class="leave-comment"><b>Equipment ('+reported+' of '+items.length+' reported)</b>'+rows+'</div>';
  }
  // Full-detail view for one equipment line item — every field the
  // Equipment Information section of a Service Report would show, plus
  // this unit's Scope of Service and its report status on this ticket.
  const DT_EQUIP_DETAIL_KEYS = [
    'equipType','brand','mountType','coolCap','modelCU','serialCU',
    'modelFCU','serialFCU','refrigerantType','compressorType','equipLocation'
  ];
  function dtOpenEquipDetailOverlay(ticket, item){
    if(!item) return;
    $('dtEquipDetailTitle').textContent = dtEquipSummaryLine(item);
    const fieldRows = DT_EQUIP_DETAIL_KEYS.map(k=>{
      const val = (item[k]||'').toString().trim();
      if(!val) return '';
      const label = (FIELD_META[k] && FIELD_META[k].label) || k;
      return '<div class="equip-detail-row"><span class="equip-detail-label">'+escapeHtml(label)+'</span><span>'+escapeHtml(val)+'</span></div>';
    }).join('');
    const scope = (item.scope||[]).map(escapeHtml).join('; ');
    const scopeRow = scope ? '<div class="equip-detail-row"><span class="equip-detail-label">Scope of Service</span><span>'+scope+'</span></div>' : '';
    const statusRow = item.reportSrNo
      ? '<div class="equip-detail-row"><span class="equip-detail-label">Report</span><span>'+escapeHtml(item.reportSrNo)+' — Reported</span></div>'
      : item.draftSrNo
        ? '<div class="equip-detail-row"><span class="equip-detail-label">Report</span><span>'+escapeHtml(item.draftSrNo)+' — Draft saved</span></div>'
        : '<div class="equip-detail-row"><span class="equip-detail-label">Report</span><span>Not started yet</span></div>';
    $('dtEquipDetailBody').innerHTML = (fieldRows || '<div class="empty-state">No equipment details on file.</div>') + scopeRow + statusRow;
    $('dtEquipDetailOverlay').classList.add('open');
  }
  $('closeDtEquipDetail').addEventListener('click', ()=> $('dtEquipDetailOverlay').classList.remove('open'));
  $('dtEquipDetailOverlay').addEventListener('click', (e)=>{ if(e.target.id==='dtEquipDetailOverlay') $('dtEquipDetailOverlay').classList.remove('open'); });
  // Both admin's "All" tab and a technician's "My Job Order" tab render
  // dtCardHtml() straight into innerHTML, so a single delegated listener per
  // list (rather than one per row) is what actually gets a click on a
  // "View details" row, or the "Open Job Order" button. dtLastTicketsById is
  // refreshed by whichever render function ran most recently, so a click
  // always resolves against what's currently on screen.
  let dtLastTicketsById = {};
  function dtHandleEquipRowClick(e){
    const openBtn = e.target.closest('[data-jo-open]');
    if(openBtn){
      e.stopPropagation();
      dtOpenTicketOverlay(openBtn.dataset.joOpen);
      return;
    }
    const row = e.target.closest('.dt-equip-row');
    if(!row) return;
    e.stopPropagation();
    const ticket = dtLastTicketsById[row.dataset.ticketId];
    const item = ticket && (ticket.equipmentList||[])[Number(row.dataset.equipIdx)];
    dtOpenEquipDetailOverlay(ticket, item);
  }
  $('dtAdminList').addEventListener('click', dtHandleEquipRowClick);
  $('dtTechList').addEventListener('click', dtHandleEquipRowClick);
  // The Job Order detail overlay re-renders dtCardHtml() too (for the
  // summary at the top), so its equipment "View details" rows need the
  // same delegated handler — see dtOpenTicketOverlay, which also seeds
  // dtLastTicketsById with the ticket being viewed.
  $('dtTicketOverlay').addEventListener('click', dtHandleEquipRowClick);
  function dtCardHtml(r, forAdmin){
    return '<div class="user-card-head">'+
        '<div>'+
          '<div class="u-name">'+escapeHtml(r.jobOrderNo)+' — '+escapeHtml(r.custName)+'</div>'+
          '<div class="u-status">'+leaveFmtDate(r.date)+(r.expectedTime ? (' at '+r.expectedTime) : '')+' · '+escapeHtml((r.assignedWorkerNames||[]).join(', '))+'</div>'+
        '</div>'+
        dtStatusPill(r)+
      '</div>'+
      (r.siteAddress ? '<div class="leave-comment"><b>Site Address</b>'+escapeHtml(r.siteAddress)+'</div>' : '')+
      (forAdmin && r.reportAllowedWorkerNames && r.reportAllowedWorkerNames.length ? '<div class="leave-comment"><b>Can Create Service Report</b>'+escapeHtml(r.reportAllowedWorkerNames.join(', '))+'</div>' : '')+
      (r.contactName ? '<div class="leave-comment"><b>Contact at Site</b>'+escapeHtml(r.contactName)+(r.contactNo?(' · '+escapeHtml(r.contactNo)):'')+'</div>' : '')+
      dtEquipmentSummaryBlock(r)+
      (r.remarks ? '<div class="leave-comment"><b>Special Instructions</b>'+escapeHtml(r.remarks)+'</div>' : '')+
      '<div class="leave-comment"><b>Requirements</b>'+dtReqSummary(r)+'</div>'+
      (forAdmin ? '<div class="leave-comment"><b>Created by</b>'+escapeHtml(r.createdBy||'Admin')+'</div>' : '')+
      '<div style="margin-top:10px;"><button type="button" class="btn" data-jo-open="'+escapeHtml(r.id)+'">Open Job Order</button></div>';
  }
  // Best-effort write-back: called after a Service Report tied to one
  // equipment line item is saved, so the ticket's progress ("38 of 100
  // reported") reflects it. Never blocks or fails the report save itself —
  // if it can't reach the cloud right now, the ticket just catches up
  // whenever it's next viewed online.
  async function dtMarkEquipmentReported(ticketId, equipId, srNo){
    if(!ticketId || !equipId) return;
    if(!(await ensureCloud())) return;
    try{
      const rec = await dtGetTicket(ticketId);
      if(!rec || !rec.equipmentList) return;
      const idx = rec.equipmentList.findIndex(it=> it.id===equipId);
      if(idx<0 || rec.equipmentList[idx].reportSrNo===srNo) return;
      const equipmentList = rec.equipmentList.slice();
      equipmentList[idx] = Object.assign({}, equipmentList[idx], { reportSrNo: srNo });
      const merged = Object.assign({}, rec, { equipmentList });
      const { error } = await db.from('dispatch_tickets').update({ data: merged }).eq('id', ticketId);
      if(error) throw error;
    }catch(e){ console.error('mark equipment reported failed', describeCloudError(e)); }
  }
  // Same idea as dtMarkEquipmentReported, but for a Service Report that was
  // only saved as a draft. Lets the "From Job Order" picker show "Draft
  // Saved" on that equipment instead of leaving it looking untouched, which
  // is what let technicians file a second report for the same unit.
  async function dtMarkEquipmentDraft(ticketId, equipId, srNo){
    if(!ticketId || !equipId) return;
    if(!(await ensureCloud())) return;
    try{
      const rec = await dtGetTicket(ticketId);
      if(!rec || !rec.equipmentList) return;
      const idx = rec.equipmentList.findIndex(it=> it.id===equipId);
      // Never downgrade an item that's already fully reported, and skip the
      // write if it's already flagged with this exact draft.
      if(idx<0 || rec.equipmentList[idx].reportSrNo || rec.equipmentList[idx].draftSrNo===srNo) return;
      const equipmentList = rec.equipmentList.slice();
      equipmentList[idx] = Object.assign({}, equipmentList[idx], { draftSrNo: srNo });
      const merged = Object.assign({}, rec, { equipmentList });
      const { error } = await db.from('dispatch_tickets').update({ data: merged }).eq('id', ticketId);
      if(error) throw error;
    }catch(e){ console.error('mark equipment draft failed', describeCloudError(e)); }
  }

  let dtAdminFilter = 'open';
  async function dtRenderAdminList(){
    const list = $('dtAdminList');
    list.innerHTML = '<div class="empty-state">Loading…</div>';
    const all = await dtListAll();
    const items = dtAdminFilter==='all' ? all : all.filter(r=> dtEffectiveStatus(r)===dtAdminFilter);
    dtLastTicketsById = {};
    items.forEach(r=> dtLastTicketsById[r.id] = r);
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
    $('dtTabCalendar').classList.toggle('active', which==='calendar');
    $('dtNewCard').style.display = which==='new' ? '' : 'none';
    $('dtAllCard').style.display = which==='all' ? '' : 'none';
    $('dtCalendarCard').style.display = which==='calendar' ? '' : 'none';
    if(which==='new') dtResetForm();
    else if(which==='calendar') dtRenderCalendarTab();
    else dtRenderAdminList();
  }
  $('dtTabNew').addEventListener('click', ()=> dtShowAdminTab('new'));
  $('dtTabAll').addEventListener('click', ()=> dtShowAdminTab('all'));
  $('dtTabCalendar').addEventListener('click', ()=> dtShowAdminTab('calendar'));

  let dtTechFilter = 'open';
  async function dtRenderTechList(){
    const list = $('dtTechList');
    if(!currentUser || currentUser.role==='admin') return;
    list.innerHTML = '<div class="empty-state">Loading…</div>';
    const mine = await dtListForWorker(currentUser.id);
    const items = dtTechFilter==='all' ? mine : mine.filter(r=> dtEffectiveStatus(r)===dtTechFilter);
    dtLastTicketsById = {};
    items.forEach(r=> dtLastTicketsById[r.id] = r);
    if(items.length===0){ list.innerHTML = '<div class="empty-state">No '+(dtTechFilter==='all'?'':dtTechFilter+' ')+'dispatch tickets assigned to you.</div>'; return; }
    list.innerHTML = '';
    items.forEach(r=>{
      const card = document.createElement('div');
      card.className = 'user-card';
      // Buttons now follow THIS technician's own progress, not the whole
      // ticket's status. Previously a shared ticket could sit at "open" so a
      // colleague who had already acknowledged never got a Complete button,
      // and one person's Complete closed it for everyone.
      const alreadyAck = (r.acknowledgedBy||[]).includes(currentUser.id);
      const alreadyDone = r.status==='completed' || (r.completedBy||[]).includes(currentUser.id);
      card.innerHTML = dtCardHtml(r, false) +
        '<div class="user-card-actions">'+
          (!alreadyAck && !alreadyDone ? '<button data-act="ack" class="primary">Acknowledge</button>' : '')+
          (alreadyAck && !alreadyDone ? '<button data-act="complete" class="primary">Mark Completed</button>' : '')+
          (alreadyDone && r.status!=='completed' ? '<span class="u-status">Waiting for the other assigned technician(s)</span>' : '')+
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
  // Fetches only the ticket being changed, checks the current user is actually
  // assigned to it, and writes a targeted update instead of upserting the whole
  // record — so two technicians acting at once no longer overwrite each other.
  async function dtGetTicket(id){
    if(await ensureCloud()){
      try{
        const { data, error } = await db.from('dispatch_tickets').select('data').eq('id', id).maybeSingle();
        if(error) throw error;
        return data ? dtNormalizeTicket(data.data) : null;
      }catch(e){ console.error('dispatch fetch failed', describeCloudError(e)); return null; }
    }
    try{
      const item = await window.storage.get('dispatch:'+id, false);
      return item ? dtNormalizeTicket(JSON.parse(item.value)) : null;
    }catch(e){ return null; }
  }
  async function dtApplyWorkerChange(id, mutate){
    if(!currentUser){ toast('Please sign in again'); return false; }
    if(!(await ensureCloud())){ toast('This needs a connection — try again when online'); return false; }
    try{
      const rec = await dtGetTicket(id);
      if(!rec){ toast('Ticket not found'); return false; }
      const assigned = rec.assignedWorkerIds || [];
      if(currentUser.role!=='admin' && !assigned.includes(currentUser.id)){
        toast('This ticket is not assigned to you');
        return false;
      }
      const change = mutate(rec, assigned);
      if(!change) return false;
      const merged = Object.assign({}, rec, change);
      const { data: rows, error } = await db.from('dispatch_tickets')
        .update({ status: merged.status, data: merged }).eq('id', id).select('id');
      if(error) throw error;
      if(!rows || !rows.length){ toast('This ticket changed elsewhere — refreshing'); return false; }
      return true;
    }catch(e){
      console.error('dispatch update failed', describeCloudError(e));
      toast('Could not save — please try again');
      return false;
    }
  }
  async function dtAcknowledge(id){
    const ok = await dtApplyWorkerChange(id, (rec, assigned)=>{
      const ackBy = new Set(rec.acknowledgedBy||[]);
      if(ackBy.has(currentUser.id)){ toast('You already acknowledged this'); return null; }
      ackBy.add(currentUser.id);
      const list = Array.from(ackBy);
      // A multi-worker ticket is only fully "acknowledged" once everyone
      // assigned has confirmed; before that it stays open so the remaining
      // technicians still see the Acknowledge button.
      const everyone = assigned.length>0 && assigned.every(w=> list.includes(w));
      return { acknowledgedBy: list, status: everyone ? 'acknowledged' : (rec.status||'open') };
    });
    if(ok) toast('Acknowledged');
    dtRenderTechList();
  }
  async function dtComplete(id){
    const ok = await dtApplyWorkerChange(id, (rec, assigned)=>{
      if(rec.status==='completed'){ toast('Already completed'); return null; }
      const ackBy = rec.acknowledgedBy || [];
      if(currentUser.role!=='admin' && !ackBy.includes(currentUser.id)){
        toast('Acknowledge this ticket first'); return null;
      }
      const done = new Set(rec.completedBy||[]);
      done.add(currentUser.id);
      const list = Array.from(done);
      const everyone = assigned.length>0 && assigned.every(w=> list.includes(w));
      if(!everyone){
        toast('Recorded — waiting for the other assigned technician(s)');
        return { completedBy: list, status: rec.status||'acknowledged' };
      }
      return { completedBy: list, status: 'completed', completedAt: new Date().toISOString() };
    });
    if(ok) toast('Marked completed');
    dtRenderTechList();
  }

  // ---------- Job Order detail overlay: close-with-exceptions + inquiry thread ----------
  // Opened via the "Open Job Order" button on any ticket card (admin or
  // technician). Two things live here that don't belong on the card list
  // itself: the "Close Job Order" flow (report any scope that wasn't done,
  // then close), and a small message thread scoped to this one ticket.
  let dtOverlayTicket = null;
  let dtMsgChannel = null;

  function dtCloseTicketOverlay(){
    const overlay = $('dtTicketOverlay');
    if(overlay) overlay.classList.remove('open');
    if(dtMsgChannel && db){ try{ db.removeChannel(dtMsgChannel); }catch(e){} }
    dtMsgChannel = null;
    dtOverlayTicket = null;
  }

  function dtRenderCloseChecklist(rec){
    const items = rec.equipmentList || [];
    if(items.length===0) return '<div class="empty-state">No equipment on this ticket.</div>';
    return items.map((it,i)=>{
      const reportStatus = it.reportSrNo
        ? ('Reported ('+escapeHtml(it.reportSrNo)+')')
        : (it.draftSrNo ? 'Draft saved' : 'Not started');
      const checked = it.notDone ? 'checked' : '';
      return '<div class="dt-close-row" data-idx="'+i+'">'+
        '<div style="font-weight:600;">'+escapeHtml(dtEquipSummaryLine(it))+'</div>'+
        '<div class="u-status" style="margin-bottom:6px;">'+reportStatus+'</div>'+
        '<label class="chk"><input type="checkbox" class="dt-notdone-chk" '+checked+'><span>Scope not completed on this unit</span></label>'+
        '<textarea class="dt-notdone-reason" rows="2" placeholder="Reason (e.g. parts needed, access denied, unit not operational)" '+
          'style="display:'+(it.notDone ? '' : 'none')+';">'+escapeHtml(it.notDoneReason||'')+'</textarea>'+
      '</div>';
    }).join('');
  }

  function dtCanActOnTicket(rec){
    if(!currentUser) return false;
    if(currentUser.role==='admin') return true;
    return (rec.assignedWorkerIds||[]).includes(currentUser.id);
  }

  async function dtOpenTicketOverlay(ticketId){
    const rec = await dtGetTicket(ticketId);
    if(!rec){ toast('Ticket not found'); return; }
    dtOverlayTicket = rec;
    dtLastTicketsById[rec.id] = rec; // so equipment "View details" rows inside this overlay resolve
    const canAct = dtCanActOnTicket(rec);
    const alreadyClosed = dtEffectiveStatus(rec)==='closed';

    $('dtTicketTitle').textContent = rec.jobOrderNo+' — '+rec.custName;
    $('dtTicketStatusWrap').innerHTML = dtStatusPill(rec);
    $('dtTicketSummary').innerHTML = dtCardHtml(rec, currentUser && currentUser.role==='admin')
      // The card's own "Open Job Order" button doesn't belong inside itself.
      .replace(/<div style="margin-top:10px;"><button[^]*?<\/button><\/div>$/, '');

    if(alreadyClosed){
      const closedNote = '<div class="leave-comment"><b>Closed</b>'+
        escapeHtml(rec.closedBy||'—')+' · '+(rec.closedAt ? leaveFmtDate(rec.closedAt.slice(0,10)) : '')+
        (rec.closeRemarks ? ('<br>'+escapeHtml(rec.closeRemarks)) : '')+'</div>';
      $('dtCloseSection').innerHTML = closedNote + '<div style="margin-top:10px;">'+dtRenderCloseChecklist(rec)+'</div>';
      $$('#dtCloseSection .dt-notdone-chk, #dtCloseSection .dt-close-row textarea', document).forEach(el=> el.disabled = true);
      $('dtCloseSubmitBtn').style.display = 'none';
    }else if(canAct){
      $('dtCloseSection').innerHTML =
        '<div id="dtCloseChecklist">'+dtRenderCloseChecklist(rec)+'</div>'+
        '<div class="field" style="margin-top:8px;"><label>Overall Remarks (optional)</label>'+
        '<textarea id="dtCloseRemarks" rows="2" placeholder="Anything else worth noting before closing"></textarea></div>';
      $('dtCloseSubmitBtn').style.display = '';
    }else{
      $('dtCloseSection').innerHTML = '<div class="empty-state">Only the assigned technician(s) or admin can close this ticket.</div>';
      $('dtCloseSubmitBtn').style.display = 'none';
    }

    $('dtTicketOverlay').classList.add('open');
    await dtRefreshMessages();
    if(dtMsgChannel && db){ try{ db.removeChannel(dtMsgChannel); }catch(e){} dtMsgChannel = null; }
    if(await ensureCloud()){
      dtMsgChannel = db.channel('dt-messages-'+ticketId)
        .on('postgres_changes', { event:'INSERT', schema:'public', table:'dispatch_ticket_messages', filter:'ticket_id=eq.'+ticketId }, ()=> dtRefreshMessages())
        .subscribe();
    }
  }
  $('closeDtTicketOverlay').addEventListener('click', dtCloseTicketOverlay);
  $('dtTicketOverlay').addEventListener('click', (e)=>{ if(e.target.id==='dtTicketOverlay') dtCloseTicketOverlay(); });

  // Toggle a unit's reason textarea as its "not completed" checkbox changes.
  $('dtCloseSection').addEventListener('change', (e)=>{
    if(!e.target.classList.contains('dt-notdone-chk')) return;
    const row = e.target.closest('.dt-close-row');
    const ta = row && row.querySelector('.dt-notdone-reason');
    if(ta) ta.style.display = e.target.checked ? '' : 'none';
  });

  async function dtCloseTicket(ticketId, equipmentList, remarks){
    if(!currentUser){ toast('Please sign in again'); return false; }
    if(!(await ensureCloud())){ toast('This needs a connection — try again when online'); return false; }
    try{
      const rec = await dtGetTicket(ticketId);
      if(!rec){ toast('Ticket not found'); return false; }
      if(!dtCanActOnTicket(rec)){ toast('This ticket is not assigned to you'); return false; }
      if(dtEffectiveStatus(rec)==='closed'){ toast('Already closed'); return false; }
      const merged = Object.assign({}, rec, {
        equipmentList,
        status: 'closed',
        closedBy: currentUser.name,
        closedById: currentUser.id,
        closedAt: new Date().toISOString(),
        closeRemarks: remarks || ''
      });
      const { data: rows, error } = await db.from('dispatch_tickets')
        .update({ status: 'closed', data: merged }).eq('id', ticketId).select('id');
      if(error) throw error;
      if(!rows || !rows.length){ toast('This ticket changed elsewhere — refreshing'); return false; }
      return true;
    }catch(e){
      console.error('close ticket failed', describeCloudError(e));
      toast('Could not close — please try again');
      return false;
    }
  }
  $('dtCloseSubmitBtn').addEventListener('click', async ()=>{
    if(!dtOverlayTicket) return;
    const rows = $$('#dtCloseChecklist .dt-close-row');
    const equipmentList = (dtOverlayTicket.equipmentList||[]).slice();
    for(let i=0; i<rows.length; i++){
      const chk = rows[i].querySelector('.dt-notdone-chk');
      const reasonEl = rows[i].querySelector('.dt-notdone-reason');
      const notDone = chk.checked;
      const reason = reasonEl.value.trim();
      if(notDone && !reason){
        toast('Add a reason for every unit marked "not completed"');
        reasonEl.focus();
        return;
      }
      equipmentList[i] = Object.assign({}, equipmentList[i], { notDone, notDoneReason: notDone ? reason : '' });
    }
    const exceptionCount = equipmentList.filter(it=>it.notDone).length;
    const confirmMsg = exceptionCount>0
      ? ('Close this Job Order with '+exceptionCount+' unit'+(exceptionCount===1?'':'s')+' marked as not completed?')
      : 'Close this Job Order? This marks it as fully done.';
    if(!confirm(confirmMsg)) return;
    const remarksEl = $('dtCloseRemarks');
    const remarks = remarksEl ? remarksEl.value.trim() : '';
    $('dtCloseSubmitBtn').disabled = true;
    const ok = await dtCloseTicket(dtOverlayTicket.id, equipmentList, remarks);
    $('dtCloseSubmitBtn').disabled = false;
    if(ok){
      toast('Job Order closed');
      dtCloseTicketOverlay();
      if(currentUser && currentUser.role==='admin') dtRenderAdminList(); else dtRenderTechList();
    }
  });

  // ---- Job Order inquiry thread ----
  async function dtLoadMessages(ticketId){
    if(!(await ensureCloud())) return [];
    try{
      const { data, error } = await db.from('dispatch_ticket_messages').select('*')
        .eq('ticket_id', ticketId).order('created_at', {ascending:true});
      if(error) throw error;
      return data || [];
    }catch(e){ console.error('load JO messages failed', describeCloudError(e)); return []; }
  }
  function dtRenderMessages(msgs){
    const list = $('dtMsgList');
    if(!list) return;
    if(msgs.length===0){
      list.innerHTML = '<div class="empty-state">No messages yet — ask a question about this Job Order here.</div>';
      return;
    }
    list.innerHTML = msgs.map(m=>{
      const mine = currentUser && m.sender_id===currentUser.id;
      const time = new Date(m.created_at).toLocaleString([], {month:'short', day:'numeric', hour:'2-digit', minute:'2-digit'});
      return '<div class="dt-msg-row" style="text-align:'+(mine?'right':'left')+';">'+
        '<div class="dt-msg-meta">'+escapeHtml(m.sender_name)+' · '+time+'</div>'+
        '<div class="dt-msg-bubble" style="background:'+(mine?'var(--green)':'#EEF1EE')+'; color:'+(mine?'#fff':'var(--text)')+';">'+escapeHtml(m.body)+'</div>'+
      '</div>';
    }).join('');
    list.scrollTop = list.scrollHeight;
  }
  // ---- Unread tracking (device-local — no "read receipts" table exists,
  // so this is per-device, not synced across a technician's other phones) ----
  function dtLastReadKey(ticketId){ return 'jo-lastread:'+(currentUser?currentUser.id:'')+':'+ticketId; }
  function dtGetLastRead(ticketId){ try{ return localStorage.getItem(dtLastReadKey(ticketId)); }catch(e){ return null; } }
  function dtMarkRead(ticketId, iso){ try{ localStorage.setItem(dtLastReadKey(ticketId), iso); }catch(e){} }

  async function dtRefreshMessages(){
    if(!dtOverlayTicket) return;
    const msgs = await dtLoadMessages(dtOverlayTicket.id);
    dtRenderMessages(msgs);
    // Viewing the thread marks everything in it read up to this point.
    if(msgs.length>0){
      dtMarkRead(dtOverlayTicket.id, msgs[msgs.length-1].created_at);
      refreshUnreadMsgBadges();
    }
  }
  // Dashboard tile: how many messages across ALL of my tickets arrived after
  // I last opened that specific ticket's thread, from someone other than me.
  // One query covers every ticket — RLS on dispatch_ticket_messages already
  // limits what comes back to messages on tickets I'm actually assigned to
  // (or every ticket, for admin), so no per-ticket filtering is needed here.
  async function dtCountUnreadMessages(){
    if(!currentUser) return 0;
    if(!(await ensureCloud())) return 0;
    try{
      const { data, error } = await db.from('dispatch_ticket_messages').select('ticket_id,sender_id,created_at');
      if(error) throw error;
      let count = 0;
      (data||[]).forEach(m=>{
        if(m.sender_id===currentUser.id) return;
        const lastRead = dtGetLastRead(m.ticket_id);
        if(!lastRead || new Date(m.created_at) > new Date(lastRead)) count++;
      });
      return count;
    }catch(e){ console.error('unread JO message count failed', describeCloudError(e)); return 0; }
  }
  async function dtSendMessage(){
    if(!dtOverlayTicket) return;
    const input = $('dtMsgInput');
    const body = input.value.trim();
    if(!body) return;
    if(!currentUser){ toast('Please sign in again'); return; }
    if(!(await ensureCloud())){ toast('This needs a connection — try again when online'); return; }
    $('dtMsgSendBtn').disabled = true;
    try{
      const { error } = await db.from('dispatch_ticket_messages').insert({
        ticket_id: dtOverlayTicket.id, sender_id: currentUser.id,
        sender_name: currentUser.name, sender_role: currentUser.role,
        body
      });
      if(error) throw error;
      input.value = '';
      await dtRefreshMessages();
    }catch(e){ console.error('send JO message failed', describeCloudError(e)); toast('Could not send — try again'); }
    $('dtMsgSendBtn').disabled = false;
  }
  $('dtMsgSendBtn').addEventListener('click', dtSendMessage);
  $('dtMsgInput').addEventListener('keydown', (e)=>{
    if(e.key==='Enter' && !e.shiftKey){ e.preventDefault(); dtSendMessage(); }
  });

  // ---------- Schedule Calendar ----------
  // One rendering engine, used both by the Dispatch > Calendar tab (full
  // size, admin-only) and the compact widget on the admin dashboard. Each
  // caller passes its own id "prefix" (e.g. "dtCal" or "homeCal") matching
  // <prefix>Grid / <prefix>MonthLabel / <prefix>DayDetailHead / <prefix>DayList
  // in the HTML, plus the ticket list to draw from — the dashboard widget
  // reuses the tickets renderHomeOverview() already fetched rather than
  // querying again. State (which month/day is showing) is kept per prefix
  // so the two widgets can be on different months at once.
  const DT_CAL_STATUS_COLORS = { open:'#B9791F', acknowledged:'#1F7A50', completed:'#154D34', expired:'#B3402D', closed:'#8A9089' };
  const dtCalStates = {};
  function dtCalState(prefix){
    if(!dtCalStates[prefix]){
      const n = new Date();
      dtCalStates[prefix] = { year: n.getFullYear(), month: n.getMonth(), selected: todayISO() };
    }
    return dtCalStates[prefix];
  }
  function dtCalPrev(prefix){ const s=dtCalState(prefix); s.month--; if(s.month<0){ s.month=11; s.year--; } }
  function dtCalNext(prefix){ const s=dtCalState(prefix); s.month++; if(s.month>11){ s.month=0; s.year++; } }
  function dtCalGoToday(prefix){ const s=dtCalState(prefix); const n=new Date(); s.year=n.getFullYear(); s.month=n.getMonth(); s.selected=todayISO(); }
  function dtBuildTicketsByDate(tickets){
    const map = {};
    (tickets||[]).forEach(r=>{ if(r.date) (map[r.date] = map[r.date] || []).push(r); });
    return map;
  }
  function dtCalRenderDayList(prefix, tickets){
    const state = dtCalState(prefix);
    const headEl = $(prefix+'DayDetailHead');
    const listEl = $(prefix+'DayList');
    if(!listEl) return;
    const items = dtBuildTicketsByDate(tickets)[state.selected] || [];
    if(headEl) headEl.textContent = leaveFmtDate(state.selected) + (items.length ? ' \u00b7 '+items.length+' scheduled' : '');
    items.forEach(r=> dtLastTicketsById[r.id] = r);
    if(items.length===0){ listEl.innerHTML = '<div class="empty-state">No dispatch tickets scheduled this day.</div>'; return; }
    listEl.innerHTML = '';
    items.forEach(r=>{
      const card = document.createElement('div');
      card.className = 'user-card';
      card.innerHTML = dtCardHtml(r, true);
      listEl.appendChild(card);
    });
  }
  function dtCalRender(prefix, tickets){
    const grid = $(prefix+'Grid');
    if(!grid) return;
    const state = dtCalState(prefix);
    const byDate = dtBuildTicketsByDate(tickets);
    const y = state.year, m = state.month;
    const labelEl = $(prefix+'MonthLabel');
    if(labelEl) labelEl.textContent = new Date(y,m,1).toLocaleDateString('en-US',{month:'long', year:'numeric'});
    const firstDow = new Date(y,m,1).getDay();
    const daysInMonth = new Date(y,m+1,0).getDate();
    const daysInPrevMonth = new Date(y,m,0).getDate();
    const today = todayISO();
    const cells = [];
    for(let i=0;i<firstDow;i++) cells.push({ label: daysInPrevMonth-firstDow+1+i, otherMonth:true });
    for(let d=1; d<=daysInMonth; d++){
      cells.push({ dateStr: y+'-'+String(m+1).padStart(2,'0')+'-'+String(d).padStart(2,'0'), label:d, otherMonth:false });
    }
    let trailing = 1;
    while(cells.length % 7 !== 0){ cells.push({ label: trailing++, otherMonth:true }); }
    grid.innerHTML = cells.map(c=>{
      if(c.otherMonth) return '<div class="cal-cell cal-cell-muted"><span class="cal-cell-num">'+c.label+'</span></div>';
      const dayTickets = byDate[c.dateStr] || [];
      const statuses = {};
      dayTickets.forEach(t=> statuses[dtEffectiveStatus(t)] = true);
      const dots = Object.keys(statuses).slice(0,4)
        .map(s=> '<span class="cal-dot" style="background:'+(DT_CAL_STATUS_COLORS[s]||'#8A9089')+'"></span>').join('');
      const isToday = c.dateStr===today, isSelected = c.dateStr===state.selected;
      return '<button type="button" class="cal-cell'+(isToday?' cal-cell-today':'')+(isSelected?' cal-cell-selected':'')+'" data-date="'+c.dateStr+'">'+
        '<span class="cal-cell-num">'+c.label+'</span>'+
        (dayTickets.length ? '<span class="cal-cell-dots">'+dots+'</span><span class="cal-cell-count">'+dayTickets.length+'</span>' : '')+
        '</button>';
    }).join('');
    grid.querySelectorAll('.cal-cell[data-date]').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        state.selected = btn.dataset.date;
        dtCalRender(prefix, tickets);
      });
    });
    dtCalRenderDayList(prefix, tickets);
  }
  $('dtCalPrevBtn').addEventListener('click', ()=>{ dtCalPrev('dtCal'); dtCalRender('dtCal', dtCalTicketsCache); });
  $('dtCalNextBtn').addEventListener('click', ()=>{ dtCalNext('dtCal'); dtCalRender('dtCal', dtCalTicketsCache); });
  $('dtCalTodayBtn').addEventListener('click', ()=>{ dtCalGoToday('dtCal'); dtCalRender('dtCal', dtCalTicketsCache); });
  $('dtCalDayList').addEventListener('click', dtHandleEquipRowClick);
  let dtCalTicketsCache = [];
  async function dtRenderCalendarTab(){
    $('dtCalGrid').innerHTML = '<div class="empty-state">Loading…</div>';
    dtCalTicketsCache = await dtListAll();
    dtCalRender('dtCal', dtCalTicketsCache);
  }

  async function showDispatchView(initialTab){
    document.body.classList.remove('dashboard-active');
    $('homeScreen').style.display = 'none';
    $('serviceReportView').style.display = 'none';
    $('dtrView').style.display = 'none';
    $('leaveView').style.display = 'none';
    $('cashAdvanceView').style.display = 'none';
    $('equipmentManagerView').style.display = 'none';
    $('customersManagerView').style.display = 'none';
    $('serviceReportsManagerView').style.display = 'none';
    $('messagesView').style.display = 'none';
    $('documentsView').style.display = 'none';
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
      dtShowAdminTab(initialTab || 'new');
    }else{
      $('dispatchAdminArea').style.display = 'none';
      $('dispatchTechArea').style.display = '';
      dtRenderTechList();
    }
  }

  async function showLeaveView(){
    document.body.classList.remove('dashboard-active');
    $('homeScreen').style.display = 'none';
    $('serviceReportView').style.display = 'none';
    $('dtrView').style.display = 'none';
    $('cashAdvanceView').style.display = 'none';
    $('dispatchView').style.display = 'none';
    $('equipmentManagerView').style.display = 'none';
    $('customersManagerView').style.display = 'none';
    $('serviceReportsManagerView').style.display = 'none';
    $('messagesView').style.display = 'none';
    $('documentsView').style.display = 'none';
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

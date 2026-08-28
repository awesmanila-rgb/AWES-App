// ---------- Manage Users ----------
  function restrictionLabel(r){
    r = r || {};
    const flags = [];
    if(r.noHistory) flags.push('No history');
    if(r.noReport) flags.push('No report generation');
    if(r.readOnly) flags.push('Read-only');
    return flags.length ? flags.join(' · ') : 'No restrictions';
  }

  async function renderUsersList(){
    const body = $('usersList');
    body.innerHTML = '<div class="empty-state">Loading…</div>';
    const cloudOn = await ensureCloud();
    const users = (await cloudListUsers()) || [];
    body.innerHTML = '';
    if(!cloudOn){
      const note = document.createElement('div');
      note.style.cssText = 'font-size:12px; color:var(--amber); margin-bottom:10px;';
      note.textContent = 'Not connected to Shared Cloud — user accounts are saved on this device only.';
      body.appendChild(note);
    }
    if(users.length===0){
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = 'No users added yet.';
      body.appendChild(empty);
      return;
    }
    users.sort((a,b)=> (a.name||'').localeCompare(b.name||'')).forEach(u=>{
      const r = u.restrictions || {};
      const active = u.active!==false;
      const card = document.createElement('div');
      card.className = 'user-card' + (active ? '' : ' inactive');
      card.innerHTML =
        '<div class="user-card-head">'+
          '<div>'+
            '<div class="u-name">'+escapeHtml(u.name)+'</div>'+
            '<div class="u-status '+(active?'':'deact')+'">'+
              (active ? 'Active' : 'Deactivated')+' · '+escapeHtml(restrictionLabel(r))+
            '</div>'+
          '</div>'+
        '</div>'+
        '<div class="user-card-actions">'+
          '<button data-act="edit" class="primary">Edit</button>'+
          '<button data-act="toggle">'+(active ? 'Restrict (Deactivate)' : 'Reactivate')+'</button>'+
          '<button data-act="resetDevice">Reset DTR Device</button>'+
          '<button data-act="remove" class="danger">Remove</button>'+
        '</div>'+
        '<div class="user-edit-panel" data-panel="1">'+
          '<div class="field"><label>Full Name</label><input type="text" data-f="name" value="'+escapeHtml(u.name)+'"></div>'+
          '<div class="field"><label>New Password (leave blank to keep current)</label><input type="password" data-f="pw1" placeholder="Set a new password"></div>'+
          '<div class="field"><label>Confirm New Password</label><input type="password" data-f="pw2" placeholder="Re-enter the new password"></div>'+
          '<div class="restrict-group">'+
            '<h5>Restrictions</h5>'+
            '<label class="restrict-row"><input type="checkbox" data-f="noHistory" '+(r.noHistory?'checked':'')+'>'+
              '<span class="rtxt"><span class="rt-title">Block History access</span><span class="rt-desc">User cannot open the History sheet or view past reports.</span></span></label>'+
            '<label class="restrict-row"><input type="checkbox" data-f="noReport" '+(r.noReport?'checked':'')+'>'+
              '<span class="rtxt"><span class="rt-title">Block report generation</span><span class="rt-desc">User cannot preview, generate, or share PDF reports.</span></span></label>'+
            '<label class="restrict-row"><input type="checkbox" data-f="readOnly" '+(r.readOnly?'checked':'')+'>'+
              '<span class="rtxt"><span class="rt-title">Read-only</span><span class="rt-desc">User cannot save drafts, start new reports, or generate reports.</span></span></label>'+
          '</div>'+
          '<div class="edit-save-row">'+
            '<button class="cancel-btn" data-act="cancel" type="button">Cancel</button>'+
            '<button class="save-btn" data-act="save" type="button">Save Changes</button>'+
          '</div>'+
        '</div>';

      const panel = card.querySelector('[data-panel="1"]');
      card.querySelector('[data-act="edit"]').addEventListener('click', ()=>{
        // close any other open panels
        body.querySelectorAll('.user-edit-panel.open').forEach(p=>{ if(p!==panel) p.classList.remove('open'); });
        panel.classList.toggle('open');
      });
      card.querySelector('[data-act="cancel"]').addEventListener('click', ()=>{
        panel.classList.remove('open');
        // reset fields
        panel.querySelector('[data-f="name"]').value = u.name;
        panel.querySelector('[data-f="pw1"]').value = '';
        panel.querySelector('[data-f="pw2"]').value = '';
        panel.querySelector('[data-f="noHistory"]').checked = !!r.noHistory;
        panel.querySelector('[data-f="noReport"]').checked = !!r.noReport;
        panel.querySelector('[data-f="readOnly"]').checked = !!r.readOnly;
      });
      card.querySelector('[data-act="save"]').addEventListener('click', async ()=>{
        const newName = panel.querySelector('[data-f="name"]').value.trim();
        const pw1 = panel.querySelector('[data-f="pw1"]').value;
        const pw2 = panel.querySelector('[data-f="pw2"]').value;
        if(!newName){ toast('Name cannot be empty'); return; }
        if(pw1 || pw2){
          if(pw1.length < 4){ toast('Password must be at least 4 characters'); return; }
          if(pw1 !== pw2){ toast('Passwords do not match'); return; }
        }
        const restrictions = {
          noHistory: panel.querySelector('[data-f="noHistory"]').checked,
          noReport: panel.querySelector('[data-f="noReport"]').checked,
          readOnly: panel.querySelector('[data-f="readOnly"]').checked
        };
        const ok1 = await cloudSetUser(u.id, { name: newName, restrictions });
        let ok2 = true;
        if(pw1){
          const { data, error } = await db.functions.invoke('admin-create-technician', {
            body: { action:'reset_password', technicianId: u.id, password: pw1 }
          });
          ok2 = !error && !(data && data.error);
        }
        if(ok1 && ok2){
          toast('Saved changes for '+newName);
          renderUsersList();
        }else toast('Could not save all changes');
      });
      card.querySelector('[data-act="toggle"]').addEventListener('click', async ()=>{
        const ok = await cloudSetUser(u.id, {active: active ? false : true});
        if(ok){ toast(active ? 'Restricted '+u.name+' (access revoked)' : 'Reactivated '+u.name); renderUsersList(); }
        else toast('Could not update');
      });
      card.querySelector('[data-act="resetDevice"]').addEventListener('click', async ()=>{
        if(!confirm('Unlock '+u.name+"'s DTR from their current device? Use this if they lost or replaced their phone — the next device they time in from will become the new locked device.")) return;
        const ok = await clearDeviceLock(u.id);
        toast(ok ? "Device lock cleared for "+u.name : 'Could not clear device lock');
      });
      card.querySelector('[data-act="remove"]').addEventListener('click', async ()=>{
        if(!confirm('Remove '+u.name+' completely? Their past reports stay saved, but they will no longer appear anywhere.')) return;
        const ok = await cloudDeleteUser(u.id);
        if(ok){ toast('Removed '+u.name); renderUsersList(); }
        else toast('Could not remove');
      });
      body.appendChild(card);
    });
  }
  $('closeUsers').addEventListener('click', ()=> $('usersOverlay').classList.remove('open'));
  $('usersOverlay').addEventListener('click', (e)=>{ if(e.target.id==='usersOverlay') $('usersOverlay').classList.remove('open'); });

  // ---------- Manage Customers (admin-only) ----------
  async function renderCustomersList(filterText){
    const body = $('customersList');
    body.innerHTML = '<div class="empty-state">Loading…</div>';
    const cloudOn = await ensureCloud();
    await loadCustomers();
    body.innerHTML = '';
    if(!cloudOn){
      const note = document.createElement('div');
      note.style.cssText = 'font-size:12px; color:var(--amber); margin-bottom:10px;';
      note.textContent = 'Not connected to Shared Cloud — customers are saved on this device only.';
      body.appendChild(note);
    }
    const q = (filterText||'').toLowerCase();
    const list = customersCache.filter(c=> c.name.toLowerCase().includes(q)).sort((a,b)=> a.name.localeCompare(b.name));
    if(list.length===0){
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = customersCache.length===0 ? 'No customers added yet.' : 'No matches.';
      body.appendChild(empty);
      return;
    }
    list.forEach(c=>{
      const card = document.createElement('div');
      card.className = 'user-card';
      card.innerHTML =
        '<div class="user-card-head"><div>'+
          '<div class="u-name">'+escapeHtml(c.name)+'</div>'+
          '<div class="u-status">'+escapeHtml(c.address||'No address on file')+'</div>'+
        '</div></div>'+
        '<div class="user-card-actions">'+
          '<button data-act="edit" class="primary">Edit</button>'+
          '<button data-act="remove" class="danger">Remove</button>'+
        '</div>';
      card.querySelector('[data-act="edit"]').addEventListener('click', ()=> startEditCustomer(c));
      card.querySelector('[data-act="remove"]').addEventListener('click', async ()=>{
        if(!confirm('Remove '+c.name+' from the customer list? This does not affect past reports.')) return;
        const ok = await cloudDeleteCustomer(c.id);
        if(ok){ toast('Removed '+c.name); renderCustomersList($('customerSearch').value); }
        else toast('Could not remove');
      });
      body.appendChild(card);
    });
  }
  function startEditCustomer(c){
    $('editCustomerId').value = c.id;
    $('customerFormTitle').textContent = 'Edit customer';
    $('newCustName').value = c.name;
    $('newCustAddress').value = c.address||'';
    $('newCustContactNo').value = c.contactNo||'';
    $('newCustContactPerson').value = c.contactPerson||'';
    $('newCustEmail').value = c.email||'';
    $('cancelEditCustomerBtn').style.display = '';
    $('customerEquipmentSection').style.display = '';
    renderCustomerEquipmentList(c.id);
    $('customersOverlay').querySelector('.sheet').scrollTop = $('customersOverlay').querySelector('.sheet').scrollHeight;
  }
  async function renderCustomerEquipmentList(customerId){
    const body = $('customerEquipmentList');
    body.innerHTML = '<div class="empty-state">Loading…</div>';
    await loadCustomerEquipment(customerId);
    body.innerHTML = '';
    if(currentEquipmentCache.length===0){
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = 'No equipment recorded yet for this customer.';
      body.appendChild(empty);
      return;
    }
    currentEquipmentCache.forEach(e=>{
      const card = document.createElement('div');
      card.className = 'user-card';
      const summary = [e.equipType, e.brand, e.coolCap, e.mountType, e.equipLocation].filter(Boolean).join(' · ') || '(no details)';
      const serials = [e.serialCU && ('CU: '+e.serialCU), e.serialFCU && ('FCU: '+e.serialFCU)].filter(Boolean).join('  ');
      card.innerHTML =
        '<div class="user-card-head"><div>'+
          '<div class="u-name">'+escapeHtml(summary)+'</div>'+
          '<div class="u-status">'+escapeHtml(serials||'No serials on file')+'</div>'+
        '</div></div>'+
        '<div class="user-card-actions">'+
          '<button data-act="remove" class="danger">Remove</button>'+
        '</div>';
      card.querySelector('[data-act="remove"]').addEventListener('click', async ()=>{
        if(!confirm('Remove this equipment record? This does not affect past reports.')) return;
        const ok = await cloudDeleteCustomerEquipment(e.id);
        if(ok){ toast('Removed'); renderCustomerEquipmentList(customerId); }
        else toast('Could not remove');
      });
      body.appendChild(card);
    });
  }

  // ---------- Manage Equipment List (admin menu — the equipment list per
  // customer, in one master view across every customer, not scoped to
  // whichever one is open in Manage Customers) ----------
  let equipListTab = 'edit'; // 'edit' | 'add' | 'delete'

  // (Re)builds the customer filter (Edit/Delete tabs) and the customer
  // picker on the Add tab from the shared customers list, keeping whatever
  // was already selected if it's still there.
  async function populateEquipmentCustomerSelects(){
    if(customersCache.length===0) await loadCustomers();
    const sorted = customersCache.slice().sort((a,b)=> (a.name||'').localeCompare(b.name||''));
    const opts = sorted.map(c=> '<option value="'+c.id+'">'+escapeHtml(c.name)+'</option>').join('');
    const filterSel = $('equipmentListCustomerFilter');
    const keepFilter = filterSel.value;
    filterSel.innerHTML = '<option value="">All Customers</option>' + opts;
    filterSel.value = keepFilter;
    const addSel = $('eqAddCustomer');
    const keepAdd = addSel.value;
    addSel.innerHTML = '<option value="">Select a customer…</option>' + opts;
    addSel.value = keepAdd;
  }
  function setEquipListTab(tab){
    equipListTab = tab;
    $('equipListTabEdit').classList.toggle('active', tab==='edit');
    $('equipListTabAdd').classList.toggle('active', tab==='add');
    $('equipListTabDelete').classList.toggle('active', tab==='delete');
    $('equipListViewSection').style.display = tab==='add' ? 'none' : '';
    $('equipAddSection').style.display = tab==='add' ? '' : 'none';
    if(tab!=='add') renderEquipmentMasterList();
  }
  async function renderEquipmentMasterList(){
    const body = $('equipmentListBody');
    body.innerHTML = '<div class="empty-state">Loading…</div>';
    const all = await loadAllCustomerEquipment();
    const custId = $('equipmentListCustomerFilter').value;
    const q = ($('equipmentListSearch').value||'').trim().toLowerCase();
    let items = custId ? all.filter(e=> String(e.customerId)===String(custId)) : all;
    if(q){
      items = items.filter(e=>{
        const hay = [e.customerName, e.equipType, e.equipLocation, e.brand, e.mountType, e.modelCU, e.serialCU, e.modelFCU, e.serialFCU]
          .filter(Boolean).join(' ').toLowerCase();
        return hay.includes(q);
      });
    }
    items.sort((a,b)=> (a.customerName||'').localeCompare(b.customerName||''));
    body.innerHTML = '';
    if(items.length===0){
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = q ? 'No equipment matches "'+$('equipmentListSearch').value+'".' : 'No equipment on file yet.';
      body.appendChild(empty);
      return;
    }
    items.forEach(e=>{
      const card = document.createElement('div');
      card.className = 'user-card';
      const summary = [e.equipType, e.brand, e.coolCap, e.mountType, e.equipLocation].filter(Boolean).join(' · ') || '(no details)';
      const serials = [e.serialCU && ('CU: '+e.serialCU), e.serialFCU && ('FCU: '+e.serialFCU)].filter(Boolean).join('  ');
      card.innerHTML =
        '<div class="user-card-head"'+(equipListTab==='edit' ? ' data-act="toggle" style="cursor:pointer;"' : '')+'><div>'+
          '<div class="u-name">'+escapeHtml(e.customerName)+'</div>'+
          '<div class="u-status">'+escapeHtml(summary)+'</div>'+
          (serials ? '<div class="u-status">'+escapeHtml(serials)+'</div>' : '')+
        '</div></div>'+
        (equipListTab==='delete' ?
          '<div class="user-card-actions"><button data-act="remove" class="danger">Delete</button></div>' : '')+
        (equipListTab==='edit' ?
          '<div class="user-edit-panel" data-panel="1">'+
            '<div class="field"><label>Equipment Type</label><input type="text" data-f="equipType" value="'+escapeHtml(e.equipType||'')+'"></div>'+
            '<div class="field"><label>Specific Location</label><input type="text" data-f="equipLocation" value="'+escapeHtml(e.equipLocation||'')+'"></div>'+
            '<div class="field"><label>Manufacturer / Brand</label><input type="text" data-f="brand" value="'+escapeHtml(e.brand||'')+'"></div>'+
            '<div class="field"><label>Mounting Type</label><input type="text" data-f="mountType" value="'+escapeHtml(e.mountType||'')+'"></div>'+
            '<div class="field"><label>Cooling Capacity</label><input type="text" data-f="coolCap" value="'+escapeHtml(e.coolCap||'')+'"></div>'+
            '<div class="field"><label>Model No. (CU)</label><input type="text" data-f="modelCU" value="'+escapeHtml(e.modelCU||'')+'"></div>'+
            '<div class="field"><label>Serial No. (CU)</label><input type="text" data-f="serialCU" value="'+escapeHtml(e.serialCU||'')+'"></div>'+
            '<div class="field"><label>Model No. (FCU)</label><input type="text" data-f="modelFCU" value="'+escapeHtml(e.modelFCU||'')+'"></div>'+
            '<div class="field"><label>Serial No. (FCU)</label><input type="text" data-f="serialFCU" value="'+escapeHtml(e.serialFCU||'')+'"></div>'+
            '<div class="field"><label>Refrigerant Type</label><input type="text" data-f="refrigerantType" value="'+escapeHtml(e.refrigerantType||'')+'"></div>'+
            '<div class="field"><label>Compressor Type</label><input type="text" data-f="compressorType" value="'+escapeHtml(e.compressorType||'')+'"></div>'+
            '<div class="edit-save-row">'+
              '<button class="cancel-btn" data-act="panelClose" type="button">Close</button>'+
              '<button class="cancel-btn" data-act="panelEdit" type="button">Edit</button>'+
              '<button class="save-btn" data-act="panelSave" type="button" disabled>Save Changes</button>'+
            '</div>'+
          '</div>' : '');
      if(equipListTab==='edit'){
        const panel = card.querySelector('[data-panel="1"]');
        const inputs = Array.from(panel.querySelectorAll('input[data-f]'));
        const closeBtn = panel.querySelector('[data-act="panelClose"]');
        const editBtn = panel.querySelector('[data-act="panelEdit"]');
        const saveBtn = panel.querySelector('[data-act="panelSave"]');
        // Tapping the card first opens a read-only view of every field, all
        // locked. Tapping Edit unlocks the fields and unlocks Save (which
        // stays disabled until then) — Save only ever writes once Edit has
        // been tapped.
        function setPanelMode(mode){
          panel.dataset.mode = mode;
          inputs.forEach(inp=> inp.disabled = (mode==='view'));
          editBtn.disabled = (mode==='edit');
          saveBtn.disabled = (mode==='view');
          closeBtn.textContent = mode==='view' ? 'Close' : 'Cancel';
        }
        panel._setMode = setPanelMode;
        setPanelMode('view');
        card.querySelector('[data-act="toggle"]').addEventListener('click', ()=>{
          body.querySelectorAll('.user-edit-panel.open').forEach(p=>{
            if(p!==panel){ p.classList.remove('open'); if(p._setMode) p._setMode('view'); }
          });
          panel.classList.toggle('open');
        });
        closeBtn.addEventListener('click', ()=>{
          if(panel.dataset.mode==='edit'){
            inputs.forEach(inp=>{ inp.value = e[inp.dataset.f]||''; });
            setPanelMode('view');
          }else{
            panel.classList.remove('open');
          }
        });
        editBtn.addEventListener('click', ()=> setPanelMode('edit'));
        saveBtn.addEventListener('click', async ()=>{
          const fields = {};
          inputs.forEach(inp=> fields[inp.dataset.f] = inp.value.trim());
          const ok = await cloudUpdateCustomerEquipment(e.id, fields);
          if(ok){ toast('Saved'); renderEquipmentMasterList(); }
          else toast('Could not save — check your connection');
        });
      }
      if(equipListTab==='delete'){
        card.querySelector('[data-act="remove"]').addEventListener('click', async ()=>{
          if(!confirm('Remove this equipment record for '+e.customerName+'? This does not affect past reports.')) return;
          const ok = await cloudDeleteCustomerEquipment(e.id);
          if(ok){ toast('Removed'); renderEquipmentMasterList(); }
          else toast('Could not remove');
        });
      }
      body.appendChild(card);
    });
  }
  // ---------- Scan Equipment Label (Manage Equipment List → Add) ----------
  // Best-effort only: OCR reads whatever text is on the nameplate photo, then
  // a handful of regexes guess which bits are the model/serial/refrigerant/
  // capacity/compressor/type. Anything it can't confidently identify — and
  // anything it gets wrong — is left for the technician to fill in or fix by
  // hand; the raw scanned text is kept visible for that reason.
  function parseEquipmentLabelText(raw){
    const text = (raw||'').toUpperCase();
    const fields = {};
    function grabAfter(regexes){
      for(const re of regexes){
        const m = text.match(re);
        if(m && m[1]) return m[1].trim();
      }
      return '';
    }
    fields.modelCU = grabAfter([
      /MODEL\s*(?:NO\.?|NUMBER|N[°O])?\s*[:\-]?\s*([A-Z0-9][A-Z0-9\-\/\.]{3,})/
    ]);
    fields.serialCU = grabAfter([
      /SERIAL\s*(?:NO\.?|NUMBER)?\s*[:\-]?\s*([A-Z0-9][A-Z0-9\-\/\.]{4,})/,
      /S\/N\s*[:\-]?\s*([A-Z0-9][A-Z0-9\-\/\.]{4,})/
    ]);
    const refMatch = text.match(/\bR[\-\s]?(22|32|134A|404A|407C|410A|410|290|600A)\b/);
    if(refMatch) fields.refrigerantType = 'R-'+refMatch[1];
    const btu = text.match(/([\d,]{3,7})\s*BTU/);
    const hp = text.match(/(\d+(?:\.\d+)?)\s*HP\b/);
    const kw = text.match(/(\d+(?:\.\d+)?)\s*KW\b/);
    const ton = text.match(/(\d+(?:\.\d+)?)\s*(?:TON|TR)\b/);
    if(btu) fields.coolCap = btu[1]+' BTU/hr';
    else if(hp) fields.coolCap = hp[1]+' HP';
    else if(kw) fields.coolCap = kw[1]+' kW';
    else if(ton) fields.coolCap = ton[1]+' TR';
    if(/\bSCROLL\b/.test(text)) fields.compressorType = 'Scroll';
    else if(/\bROTARY\b/.test(text)) fields.compressorType = 'Rotary';
    else if(/\bRECIPROCATING\b/.test(text)) fields.compressorType = 'Reciprocating';
    if(/\bWINDOW\s*TYPE\b/.test(text)) fields.equipType = 'Window Type Unit';
    else if(/\bSPLIT\s*TYPE\b/.test(text)) fields.equipType = 'Split Type Unit';
    else if(/\bPACKAGE(?:D)?\s*TYPE\b/.test(text)) fields.equipType = 'Package Type Unit';
    else if(/\bVRF\b|\bVRV\b/.test(text)) fields.equipType = 'VRF/VRV System';
    const knownBrands = {
      PANASONIC:'Panasonic', DAIKIN:'Daikin', CARRIER:'Carrier', LG:'LG', SAMSUNG:'Samsung',
      MITSUBISHI:'Mitsubishi', YORK:'York', FUJITSU:'Fujitsu', HITACHI:'Hitachi', KOLIN:'Kolin',
      CONDURA:'Condura', TCL:'TCL', MIDEA:'Midea', GREE:'Gree', KOPPEL:'Koppel', HAIER:'Haier',
      SHARP:'Sharp', AUX:'AUX', CHIGO:'Chigo', TOSOT:'Tosot', ELECTROLUX:'Electrolux'
    };
    const brandKey = Object.keys(knownBrands).find(b=> text.includes(b));
    if(brandKey) fields.brand = knownBrands[brandKey];
    return fields;
  }
  async function scanEquipmentLabel(file){
    const status = $('eqScanStatus');
    status.style.display = '';
    status.textContent = 'Loading scanner…';
    try{
      await loadAwesScript('tesseract', awesLibs.tesseract);
    }catch(e){
      status.textContent = 'Could not load the scanner — check your connection and try again.';
      return;
    }
    status.textContent = 'Reading label… this can take a few seconds.';
    let result;
    try{
      result = await Tesseract.recognize(file, 'eng');
    }catch(e){
      console.error('OCR failed', e);
      status.textContent = 'Could not read that photo. Try a clearer, well-lit shot, or fill in the fields manually.';
      return;
    }
    const rawText = (result && result.data && result.data.text) || '';
    const parsed = parseEquipmentLabelText(rawText);
    const filledLabels = [];
    Object.keys(parsed).forEach(k=>{
      if(!parsed[k]) return;
      const el = $('eqAdd'+k.charAt(0).toUpperCase()+k.slice(1));
      // Never overwrite something the technician already typed in.
      if(el && !el.value.trim()){ el.value = parsed[k]; filledLabels.push((FIELD_META[k]&&FIELD_META[k].label)||k); }
    });
    status.textContent = filledLabels.length
      ? 'Filled in from the label: '+filledLabels.join(', ')+'. Please review before saving.'
      : 'Could not confidently read any fields from that photo — please fill them in manually.';
    const rawWrap = $('eqScanRawWrap');
    rawWrap.style.display = rawText.trim() ? '' : 'none';
    $('eqScanRawText').textContent = rawText.trim() || '(no text detected)';
  }
  $('eqScanBtn').addEventListener('click', ()=> $('eqScanInput').click());
  $('eqScanInput').addEventListener('change', (e)=>{
    const file = e.target.files && e.target.files[0];
    e.target.value = ''; // lets the same photo be re-picked next time
    if(file) scanEquipmentLabel(file);
  });

  $('equipmentListSearch').addEventListener('input', ()=> renderEquipmentMasterList());
  $('equipmentListCustomerFilter').addEventListener('change', ()=> renderEquipmentMasterList());
  $('closeEquipmentList').addEventListener('click', ()=> $('equipmentListOverlay').classList.remove('open'));
  $('equipmentListOverlay').addEventListener('click', (e)=>{ if(e.target.id==='equipmentListOverlay') $('equipmentListOverlay').classList.remove('open'); });
  $('equipListTabEdit').addEventListener('click', ()=> setEquipListTab('edit'));
  $('equipListTabAdd').addEventListener('click', ()=> setEquipListTab('add'));
  $('equipListTabDelete').addEventListener('click', ()=> setEquipListTab('delete'));
  function resetEqScanUI(){
    $('eqScanStatus').style.display = 'none';
    $('eqScanStatus').textContent = '';
    $('eqScanRawWrap').style.display = 'none';
    $('eqScanRawText').textContent = '';
  }
  $('eqAddSaveBtn').addEventListener('click', async ()=>{
    const customerId = $('eqAddCustomer').value;
    if(!customerId){ toast('Select a customer'); return; }
    const fields = {};
    EQUIP_FIELD_KEYS.forEach(k=>{
      const el = $('eqAdd'+k.charAt(0).toUpperCase()+k.slice(1));
      fields[k] = el ? el.value.trim() : '';
    });
    if(!EQUIP_FIELD_KEYS.some(k=>fields[k])){ toast('Enter at least one equipment detail'); return; }
    $('eqAddSaveBtn').disabled = true;
    const result = await cloudAddCustomerEquipmentAdmin(customerId, fields);
    $('eqAddSaveBtn').disabled = false;
    if(result==='dupe'){ toast('That equipment is already on file for this customer'); return; }
    if(!result){ toast('Could not add — check your connection'); return; }
    toast('Equipment added');
    EQUIP_FIELD_KEYS.forEach(k=>{
      const el = $('eqAdd'+k.charAt(0).toUpperCase()+k.slice(1));
      if(el) el.value = '';
    });
    resetEqScanUI();
  });
  $('menuManageEquipment').addEventListener('click', async ()=>{
    closeMainMenu();
    if(!(await ensureAdminAuthenticated())) return;
    $('equipmentListSearch').value = '';
    await populateEquipmentCustomerSelects();
    $('equipmentListCustomerFilter').value = '';
    resetEqScanUI();
    setEquipListTab('edit');
    $('equipmentListOverlay').classList.add('open');
  });


  function resetCustomerForm(){
    $('editCustomerId').value = '';
    $('customerFormTitle').textContent = 'Add a customer';
    $('newCustName').value=''; $('newCustAddress').value=''; $('newCustContactNo').value='';
    $('newCustContactPerson').value=''; $('newCustEmail').value='';
    $('cancelEditCustomerBtn').style.display = 'none';
    $('customerEquipmentSection').style.display = 'none';
  }
  $('cancelEditCustomerBtn').addEventListener('click', resetCustomerForm);
  $('saveCustomerBtn').addEventListener('click', async ()=>{
    const name = $('newCustName').value.trim();
    if(!name){ toast('Enter a customer name'); return; }
    if(!(await ensureCloud())){ toast('Not connected to the cloud'); return; }
    const editingId = $('editCustomerId').value;
    const payload = {
      name, address: $('newCustAddress').value.trim(), contactNo: $('newCustContactNo').value.trim(),
      contactPerson: $('newCustContactPerson').value.trim(), email: $('newCustEmail').value.trim()
    };
    $('saveCustomerBtn').disabled = true;
    try{
      if(editingId){
        const { error } = await db.from('customers').update({
          name: payload.name, address: payload.address, contact_no: payload.contactNo,
          contact_person: payload.contactPerson, email: payload.email, updated_at: new Date().toISOString()
        }).eq('id', editingId);
        if(error){ toast('Could not save: '+error.message); return; }
      }else{
        await cloudUpsertCustomer(payload);
      }
      await loadCustomers();
      resetCustomerForm();
      toast('Saved '+name);
      renderCustomersList($('customerSearch').value);
    } finally { $('saveCustomerBtn').disabled = false; }
  });
  $('customerSearch').addEventListener('input', ()=> renderCustomersList($('customerSearch').value));
  $('closeCustomers').addEventListener('click', ()=> $('customersOverlay').classList.remove('open'));
  $('customersOverlay').addEventListener('click', (e)=>{ if(e.target.id==='customersOverlay') $('customersOverlay').classList.remove('open'); });
  $('menuManageCustomers').addEventListener('click', async ()=>{
    closeMainMenu();
    if(!(await ensureAdminAuthenticated())) return;
    resetCustomerForm();
    $('customersOverlay').classList.add('open');
    renderCustomersList('');
  });

  $('addUserBtn').addEventListener('click', async ()=>{
    const name = $('newUserName').value.trim();
    const pin = $('newUserPin').value;
    const pin2 = $('newUserPin2').value;
    if(!name){ toast('Enter a name'); return; }
    if(!pin || pin.length < 4){ toast('Password must be at least 4 characters'); return; }
    if(pin !== pin2){ toast('Passwords do not match'); return; }
    if(!(await ensureCloud())){ toast('Not connected to the cloud'); return; }
    $('addUserBtn').disabled = true;
    try{
      // Real account creation happens server-side (Edge Function) so it can't
      // hijack the admin's own browser session — see admin-create-technician.
      const { data, error } = await db.functions.invoke('admin-create-technician', {
        body: { name, password: pin }
      });
      if(error || (data && data.error)){
        toast((data && data.error) || 'Could not add user');
      }else{
        $('newUserName').value=''; $('newUserPin').value=''; $('newUserPin2').value='';
        toast('Added '+name);
        renderUsersList();
      }
    }finally{ $('addUserBtn').disabled = false; }
  });

  async function doChangeAdminPin(){
    const cur = await askPassword({
      title: 'Change Admin Password',
      label: 'Enter your CURRENT admin password'
    });
    if(cur===null) return;
    if(!(await verifyAdminPassword(cur))){ toast('Incorrect password'); return; }
    const next = await askPassword({
      title: 'Change Admin Password',
      label: 'Enter your NEW admin password (at least 8 characters)',
      placeholder: 'New password'
    });
    if(next===null) return;
    // Raised from 4 to 8: this single password protects every technician
    // account, all reports and all cash-advance approvals in the business.
    if(next.length < 8){ toast('Password must be at least 8 characters'); return; }
    if(next===cur){ toast('That is the same as your current password'); return; }
    const { error } = await db.auth.updateUser({ password: next });
    if(error){ toast('Could not update password: '+error.message); return; }
    toast('Password updated');
  }

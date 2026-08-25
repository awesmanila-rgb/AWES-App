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
      const summary = [e.equipType, e.brand, e.coolCap, e.equipLocation].filter(Boolean).join(' · ') || '(no details)';
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

  // ---------- Customer Equipment List (admin menu — master view across
  // every customer, not scoped to whichever one is open in Manage Customers) ----------
  async function renderEquipmentMasterList(filterText){
    const body = $('equipmentListBody');
    body.innerHTML = '<div class="empty-state">Loading…</div>';
    const all = await loadAllCustomerEquipment();
    const q = (filterText||'').trim().toLowerCase();
    const items = !q ? all : all.filter(e=>{
      const hay = [e.customerName, e.equipType, e.equipLocation, e.brand, e.modelCU, e.serialCU, e.modelFCU, e.serialFCU]
        .filter(Boolean).join(' ').toLowerCase();
      return hay.includes(q);
    });
    items.sort((a,b)=> (a.customerName||'').localeCompare(b.customerName||''));
    body.innerHTML = '';
    if(items.length===0){
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = q ? 'No equipment matches "'+filterText+'".' : 'No equipment on file yet.';
      body.appendChild(empty);
      return;
    }
    items.forEach(e=>{
      const card = document.createElement('div');
      card.className = 'user-card';
      const summary = [e.equipType, e.brand, e.coolCap, e.equipLocation].filter(Boolean).join(' · ') || '(no details)';
      const serials = [e.serialCU && ('CU: '+e.serialCU), e.serialFCU && ('FCU: '+e.serialFCU)].filter(Boolean).join('  ');
      card.innerHTML =
        '<div class="user-card-head"><div>'+
          '<div class="u-name">'+escapeHtml(e.customerName)+'</div>'+
          '<div class="u-status">'+escapeHtml(summary)+'</div>'+
          (serials ? '<div class="u-status">'+escapeHtml(serials)+'</div>' : '')+
        '</div></div>'+
        '<div class="user-card-actions">'+
          '<button data-act="remove" class="danger">Remove</button>'+
        '</div>';
      card.querySelector('[data-act="remove"]').addEventListener('click', async ()=>{
        if(!confirm('Remove this equipment record for '+e.customerName+'? This does not affect past reports.')) return;
        const ok = await cloudDeleteCustomerEquipment(e.id);
        if(ok){ toast('Removed'); renderEquipmentMasterList($('equipmentListSearch').value); }
        else toast('Could not remove');
      });
      body.appendChild(card);
    });
  }
  $('equipmentListSearch').addEventListener('input', ()=> renderEquipmentMasterList($('equipmentListSearch').value));
  $('closeEquipmentList').addEventListener('click', ()=> $('equipmentListOverlay').classList.remove('open'));
  $('equipmentListOverlay').addEventListener('click', (e)=>{ if(e.target.id==='equipmentListOverlay') $('equipmentListOverlay').classList.remove('open'); });
  $('menuManageEquipment').addEventListener('click', async ()=>{
    closeMainMenu();
    if(!(await ensureAdminAuthenticated())) return;
    $('equipmentListSearch').value = '';
    $('equipmentListOverlay').classList.add('open');
    renderEquipmentMasterList('');
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

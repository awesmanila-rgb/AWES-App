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
      empty.textContent = 'No technicians added yet.';
      body.appendChild(empty);
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

    // ---------- Customer Portal Logins ----------
    // Rendered in the same list, below the technician cards. Kept as its
    // own pass (not merged into the users.forEach above) since the card
    // shape differs — a set of linked customer records to edit instead of
    // restrictions/DTR device lock.
    if(!customersCache || customersCache.length===0) await loadCustomers();
    const custLogins = await cloudListCustomerLogins();
    const custHeader = document.createElement('div');
    custHeader.style.cssText = 'font-size:12px; font-weight:700; margin:18px 0 8px; padding-top:14px; border-top:1px solid var(--border); color:var(--text-muted); text-transform:uppercase; letter-spacing:.5px;';
    custHeader.textContent = 'Customer Portal Logins';
    body.appendChild(custHeader);
    if(custLogins.length===0){
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = 'No customer portal logins yet — add one below.';
      body.appendChild(empty);
    }
    custLogins.sort((a,b)=> (a.name||'').localeCompare(b.name||'')).forEach(u=>{
      const active = u.active!==false;
      const card = document.createElement('div');
      card.className = 'user-card' + (active ? '' : ' inactive');
      card.innerHTML =
        '<div class="user-card-head">'+
          '<div>'+
            '<div class="u-name">'+escapeHtml(u.name)+'</div>'+
            '<div class="u-status '+(active?'':'deact')+'">'+
              (active ? 'Active' : 'Deactivated')+' · '+
              (u.customerNames.length ? escapeHtml(u.customerNames.join(', ')) : 'No customer records linked')+
            '</div>'+
          '</div>'+
        '</div>'+
        '<div class="user-card-actions">'+
          '<button data-act="edit" class="primary">Edit</button>'+
          '<button data-act="toggle">'+(active ? 'Restrict (Deactivate)' : 'Reactivate')+'</button>'+
          '<button data-act="remove" class="danger">Remove</button>'+
        '</div>'+
        '<div class="user-edit-panel" data-panel="1">'+
          '<div class="field"><label>Contact Name</label><input type="text" data-f="name" value="'+escapeHtml(u.name)+'"></div>'+
          '<div class="field"><label>New Password (leave blank to keep current)</label><input type="password" data-f="pw1" placeholder="Set a new password"></div>'+
          '<div class="field"><label>Confirm New Password</label><input type="password" data-f="pw2" placeholder="Re-enter the new password"></div>'+
          '<div class="field"><label>Linked Customer Record(s)</label>'+
            '<div class="restrict-group" data-f="custBox" style="max-height:200px; overflow-y:auto; border:1px solid var(--border); border-radius:8px; padding:8px 10px;">'+
              customerCheckboxListHtml('edit-'+u.id, u.customerIds)+
            '</div>'+
          '</div>'+
          '<div class="edit-save-row">'+
            '<button class="cancel-btn" data-act="cancel" type="button">Cancel</button>'+
            '<button class="save-btn" data-act="save" type="button">Save Changes</button>'+
          '</div>'+
        '</div>';

      const panel = card.querySelector('[data-panel="1"]');
      card.querySelector('[data-act="edit"]').addEventListener('click', ()=>{
        body.querySelectorAll('.user-edit-panel.open').forEach(p=>{ if(p!==panel) p.classList.remove('open'); });
        panel.classList.toggle('open');
      });
      card.querySelector('[data-act="cancel"]').addEventListener('click', ()=>{
        panel.classList.remove('open');
        panel.querySelector('[data-f="name"]').value = u.name;
        panel.querySelector('[data-f="pw1"]').value = '';
        panel.querySelector('[data-f="pw2"]').value = '';
        panel.querySelector('[data-f="custBox"]').innerHTML = customerCheckboxListHtml('edit-'+u.id, u.customerIds);
      });
      card.querySelector('[data-act="save"]').addEventListener('click', async ()=>{
        const newName = panel.querySelector('[data-f="name"]').value.trim();
        const pw1 = panel.querySelector('[data-f="pw1"]').value;
        const pw2 = panel.querySelector('[data-f="pw2"]').value;
        const custIds = getCheckedCustomerIds(panel.querySelector('[data-f="custBox"]'));
        if(!newName){ toast('Name cannot be empty'); return; }
        if(pw1 || pw2){
          if(pw1.length < 4){ toast('Password must be at least 4 characters'); return; }
          if(pw1 !== pw2){ toast('Passwords do not match'); return; }
        }
        if(!custIds.length){ toast('Select at least one linked customer record'); return; }
        const saveBtn = panel.querySelector('[data-act="save"]');
        saveBtn.disabled = true;
        try{
          const ok1 = await cloudSetUser(u.id, { name: newName });
          let ok2 = true;
          if(pw1){
            const { data, error } = await db.functions.invoke('admin-create-customer', {
              body: { action:'reset_password', customerLoginId: u.id, password: pw1 }
            });
            ok2 = !error && !(data && data.error);
          }
          let ok3 = true;
          const changedCust = custIds.slice().sort().join(',') !== u.customerIds.slice().sort().join(',');
          if(changedCust){
            const { data, error } = await db.functions.invoke('admin-create-customer', {
              body: { action:'set_customers', customerLoginId: u.id, customerIds: custIds }
            });
            ok3 = !error && !(data && data.error);
          }
          if(ok1 && ok2 && ok3){
            toast('Saved changes for '+newName);
            renderUsersList();
          }else toast('Could not save all changes');
        } finally { saveBtn.disabled = false; }
      });
      card.querySelector('[data-act="toggle"]').addEventListener('click', async ()=>{
        const ok = await cloudSetUser(u.id, {active: active ? false : true});
        if(ok){ toast(active ? 'Restricted '+u.name+' (access revoked)' : 'Reactivated '+u.name); renderUsersList(); }
        else toast('Could not update');
      });
      card.querySelector('[data-act="remove"]').addEventListener('click', async ()=>{
        if(!confirm('Remove '+u.name+"'s customer portal login completely? They will no longer be able to sign in.")) return;
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
        '<div class="user-card-head" data-act="toggle" style="cursor:pointer;"><div>'+
          '<div class="u-name">'+escapeHtml(c.name)+'</div>'+
          '<div class="u-status">'+escapeHtml(c.address||'No address on file')+'</div>'+
        '</div><span class="card-caret">▾</span></div>'+
        '<div class="user-edit-panel" data-panel="1">'+
          '<div class="cust-detail-row"><b>Address:</b> '+escapeHtml(c.address||'—')+'</div>'+
          '<div class="cust-detail-row"><b>Contact No.:</b> '+escapeHtml(c.contactNo||'—')+'</div>'+
          '<div class="cust-detail-row"><b>Contact Person:</b> '+escapeHtml(c.contactPerson||'—')+'</div>'+
          '<div class="cust-detail-row"><b>Email:</b> '+escapeHtml(c.email||'—')+'</div>'+
          '<div class="user-card-actions">'+
            '<button data-act="edit" class="primary">Edit</button>'+
            '<button data-act="history">History</button>'+
            '<button data-act="remove" class="danger">Delete</button>'+
          '</div>'+
        '</div>';
      const panel = card.querySelector('[data-panel="1"]');
      card.querySelector('[data-act="toggle"]').addEventListener('click', (e)=>{
        // Accordion behavior: opening one card's details closes any other
        // that was left open, same convention as Manage Users above.
        body.querySelectorAll('.user-edit-panel.open').forEach(p=>{
          if(p!==panel){ p.classList.remove('open'); p.previousElementSibling.classList.remove('open'); }
        });
        panel.classList.toggle('open');
        e.currentTarget.classList.toggle('open', panel.classList.contains('open'));
      });
      card.querySelector('[data-act="edit"]').addEventListener('click', (e)=>{ e.stopPropagation(); startEditCustomer(c); });
      card.querySelector('[data-act="history"]').addEventListener('click', (e)=>{ e.stopPropagation(); showCustomerHistoryView(c); });
      card.querySelector('[data-act="remove"]').addEventListener('click', async (e)=>{
        e.stopPropagation();
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
    $('customerFormTitle').scrollIntoView({behavior:'smooth', block:'start'});
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

  // ---------- Customer History (admin-only, full page) — reached via the
  // "History" action on a customer card above. Two states within the same
  // page, same drill-down convention as the DTR attendance table: the
  // equipment-list card (customer details + every equipment record on
  // file) and the service-history card for whichever equipment was tapped. ----------
  let custHistCustomer = null;   // the customer this page is currently showing
  let custHistEquipment = null;  // the equipment currently drilled into, or null
  async function openCustomerHistoryPage(c){
    custHistCustomer = c;
    custHistEquipment = null;
    const d = $('custHistDetails');
    d.innerHTML =
      '<div class="cust-detail-row"><b>'+escapeHtml(c.name)+'</b></div>'+
      '<div class="cust-detail-row"><b>Address:</b> '+escapeHtml(c.address||'—')+'</div>'+
      '<div class="cust-detail-row"><b>Contact No.:</b> '+escapeHtml(c.contactNo||'—')+'</div>'+
      '<div class="cust-detail-row"><b>Contact Person:</b> '+escapeHtml(c.contactPerson||'—')+'</div>'+
      '<div class="cust-detail-row"><b>Email:</b> '+escapeHtml(c.email||'—')+'</div>';
    custHistShowEquipList();
    await renderCustHistEquipList(c);
  }
  function custHistShowEquipList(){
    custHistEquipment = null;
    $('custHistServiceCard').style.display = 'none';
    $('custHistEquipListCard').style.display = '';
    window.scrollTo({top:0});
  }
  async function renderCustHistEquipList(c){
    const body = $('custHistEquipList');
    body.innerHTML = '<div class="empty-state">Loading…</div>';
    await loadCustomerEquipment(c.id);
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
        '<div class="user-card-head" data-act="open" style="cursor:pointer;"><div>'+
          '<div class="u-name">'+escapeHtml(summary)+'</div>'+
          '<div class="u-status">'+escapeHtml(serials||'No serials on file')+'</div>'+
        '</div><span class="card-caret">›</span></div>';
      card.querySelector('[data-act="open"]').addEventListener('click', ()=> custHistShowServiceHistory(c, e));
      body.appendChild(card);
    });
  }
  // A report is treated as belonging to a piece of equipment when it was
  // filed under the same customer name and every equipment field on the
  // report matches that equipment record exactly — the same identity check
  // cloudAddCustomerEquipment() uses to avoid creating duplicate equipment
  // records in the first place, so "same equipment" means the same thing in
  // both places.
  function reportMatchesEquipment(report, custName, equip){
    if((report.custName||'').trim().toLowerCase() !== (custName||'').trim().toLowerCase()) return false;
    return EQUIP_FIELD_KEYS.every(k=> (report[k]||'') === (equip[k]||''));
  }
  async function custHistShowServiceHistory(c, equip){
    custHistEquipment = equip;
    $('custHistEquipListCard').style.display = 'none';
    $('custHistServiceCard').style.display = '';
    window.scrollTo({top:0});
    const summary = [equip.equipType, equip.brand, equip.coolCap, equip.mountType, equip.equipLocation].filter(Boolean).join(' · ') || '(no details)';
    const serials = [equip.serialCU && ('CU: '+equip.serialCU), equip.serialFCU && ('FCU: '+equip.serialFCU)].filter(Boolean).join('  ');
    $('custHistEquipSummary').innerHTML =
      '<div class="cust-detail-row"><b>'+escapeHtml(c.name)+' — '+escapeHtml(summary)+'</b></div>'+
      (serials ? '<div class="cust-detail-row">'+escapeHtml(serials)+'</div>' : '');
    const body = $('custHistServiceTableBody');
    body.innerHTML = '<tr><td colspan="4"><div class="empty-state">Loading…</div></td></tr>';
    let reports = null;
    if(await ensureCloud()) reports = await cloudListReports();
    if(reports===null){
      reports = [];
      try{
        const res = await window.storage.list('report:', false);
        const keys = (res && res.keys) ? res.keys : [];
        for(const key of keys){
          try{ const item = await window.storage.get(key, false); reports.push(JSON.parse(item.value)); }catch(e){}
        }
      }catch(e){}
    }
    const matches = reports.filter(r=> r.completed && reportMatchesEquipment(r, c.name, equip))
      .sort((a,b)=> (b.date||'').localeCompare(a.date||''));
    body.innerHTML = '';
    if(matches.length===0){
      body.innerHTML = '<tr><td colspan="4"><div class="empty-state">No completed service reports for this equipment yet.</div></td></tr>';
      return;
    }
    matches.forEach(d=>{
      const svcArr = Array.isArray(d.servicesDone) ? d.servicesDone : (d.servicesDone ? [d.servicesDone] : []);
      const svcText = svcArr.length ? svcArr.join('; ') : '—';
      const row = document.createElement('tr');
      row.innerHTML =
        '<td>'+escapeHtml(svcText)+'</td>'+
        '<td>'+escapeHtml(fmtDate(d.date)||'—')+'</td>'+
        '<td>'+escapeHtml(d.srNo||'—')+'</td>'+
        '<td><button type="button" class="att-view-btn" data-act="view">View</button></td>';
      row.querySelector('[data-act="view"]').addEventListener('click', async ()=>{
        try{
          const doc = await buildPdf(d);
          $('previewOverlay').querySelector('h3').textContent = d.custName ? d.custName : 'Report';
          $('previewOkBtn').textContent = 'Close';
          $('previewOverlay').classList.add('open');
          await renderPdfPreview(doc);
        }catch(err){
          console.error('view report failed', err);
          toast('Could not open this report');
        }
      });
      body.appendChild(row);
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
          '<div class="user-card-actions"><button data-act="remove" class="danger">Delete</button></div>' : '');
      if(equipListTab==='edit'){
        card.querySelector('[data-act="toggle"]').addEventListener('click', ()=> openEquipmentDetailOverlay(e));
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
  // ---------- Equipment full-detail overlay (Manage Equipment List → View
  // All → tap a row) — a clean label/value view of every field, the same
  // layout the Dispatch Ticket equipment detail popup uses. "Edit" swaps the
  // read-only rows for input fields in place; "Save" writes and re-renders
  // the master list; "Cancel" discards and returns to the read-only view.
  const EQUIP_DETAIL_KEYS = [
    'equipType','brand','mountType','coolCap','modelCU','serialCU',
    'modelFCU','serialFCU','refrigerantType','compressorType','equipLocation'
  ];
  let equipDetailRecord = null; // the equipment row currently open in the overlay
  function equipDetailRowsHtml(record, editing){
    return EQUIP_DETAIL_KEYS.map(k=>{
      const label = (FIELD_META[k] && FIELD_META[k].label) || k;
      const val = (record[k]||'').toString();
      return '<div class="equip-detail-row"><span class="equip-detail-label">'+escapeHtml(label)+'</span>'+
        (editing
          ? '<input type="text" data-f="'+k+'" value="'+escapeHtml(val)+'" style="text-align:right; border:1px solid var(--border); border-radius:6px; padding:4px 6px; font-size:13px; flex:1; max-width:60%;">'
          : '<span>'+(val.trim() ? escapeHtml(val) : '—')+'</span>')+
      '</div>';
    }).join('');
  }
  function setEquipDetailMode(mode){
    if(!equipDetailRecord) return;
    $('equipmentDetailBody').innerHTML = equipDetailRowsHtml(equipDetailRecord, mode==='edit');
    $('equipmentDetailEditBtn').style.display = mode==='edit' ? 'none' : '';
    $('equipmentDetailCancelBtn').style.display = mode==='edit' ? '' : 'none';
    $('equipmentDetailSaveBtn').style.display = mode==='edit' ? '' : 'none';
  }
  function openEquipmentDetailOverlay(record){
    equipDetailRecord = record;
    const summary = [record.equipType, record.brand, record.coolCap, record.mountType, record.equipLocation].filter(Boolean).join(' · ') || record.customerName;
    $('equipmentDetailTitle').textContent = summary;
    setEquipDetailMode('view');
    $('equipmentDetailOverlay').classList.add('open');
  }
  $('closeEquipmentDetail').addEventListener('click', ()=> $('equipmentDetailOverlay').classList.remove('open'));
  $('equipmentDetailOverlay').addEventListener('click', (e)=>{ if(e.target.id==='equipmentDetailOverlay') $('equipmentDetailOverlay').classList.remove('open'); });
  $('equipmentDetailEditBtn').addEventListener('click', ()=> setEquipDetailMode('edit'));
  $('equipmentDetailCancelBtn').addEventListener('click', ()=> setEquipDetailMode('view'));
  $('equipmentDetailSaveBtn').addEventListener('click', async ()=>{
    if(!equipDetailRecord) return;
    const fields = {};
    Array.from($('equipmentDetailBody').querySelectorAll('input[data-f]')).forEach(inp=> fields[inp.dataset.f] = inp.value.trim());
    const ok = await cloudUpdateCustomerEquipment(equipDetailRecord.id, fields);
    if(ok){
      toast('Saved');
      Object.assign(equipDetailRecord, fields);
      $('equipmentDetailOverlay').classList.remove('open');
      renderEquipmentMasterList();
    }else{
      toast('Could not save — check your connection');
    }
  });
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
  // Links each "Add Equipment" field to the same named suggestion list the
  // technician's own Service Report Equipment section uses (configured via
  // Manage Dropdown Lists), even though these inputs have different ids —
  // attachCombo's keyOverride lets a differently-id'd input share a list.
  // Guarded by attachCombo's own dataset flag, so calling this more than
  // once (e.g. every time the overlay opens) is harmless.
  function attachEquipAddCombos(){
    const idFor = (key)=> 'eqAdd'+key.charAt(0).toUpperCase()+key.slice(1);
    EQUIP_FIELD_KEYS.forEach(key=>{
      const el = $(idFor(key));
      if(el) attachCombo(el, key);
    });
  }
  // ---------- Manage Equipment List — full page (admin-only) ----------
  // Reached via the "Equipment" sidebar nav item; see showEquipmentManagerView()
  // in home.js, which shows this page and then calls this to populate it.
  async function openEquipmentManagerPage(){
    $('equipmentListSearch').value = '';
    await populateEquipmentCustomerSelects();
    $('equipmentListCustomerFilter').value = '';
    resetEqScanUI();
    setEquipListTab('edit');
    attachEquipAddCombos();
  }


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
      let renamedCount = 0;
      if(editingId){
        const existing = customersCache.find(x=> String(x.id)===String(editingId));
        const oldName = existing ? existing.name : '';
        const { error } = await db.from('customers').update({
          name: payload.name, address: payload.address, contact_no: payload.contactNo,
          contact_person: payload.contactPerson, email: payload.email, updated_at: new Date().toISOString()
        }).eq('id', editingId);
        if(error){ toast('Could not save: '+error.message); return; }
        // Carry every past report filed under the old name forward to the new
        // one, so this customer's History stays complete after a rename.
        if(oldName && oldName.trim().toLowerCase() !== name.toLowerCase()){
          renamedCount = await cloudRenameReportsCustomer(oldName, name);
        }
      }else{
        await cloudUpsertCustomer(payload);
      }
      await loadCustomers();
      resetCustomerForm();
      toast(renamedCount>0 ? ('Saved '+name+' — updated '+renamedCount+' past report(s) to the new name') : ('Saved '+name));
      renderCustomersList($('customerSearch').value);
    } finally { $('saveCustomerBtn').disabled = false; }
  });
  $('customerSearch').addEventListener('input', ()=> renderCustomersList($('customerSearch').value));

  // ---------- Manage Customers — full page (admin-only) ----------
  // Reached via the "Customers" sidebar nav item; see showCustomersManagerView()
  // in home.js, which shows this page and then calls this to populate it.
  async function openCustomersManagerPage(){
    resetCustomerForm();
    renderCustomersList('');
  }

  // Populates the "Linked Customer Record(s)" checkbox list in Add a User
  // from the same customers table Manage Customers uses. A customer login
  // can be linked to more than one customer record (an account holder
  // managing several sites/branches) — the admin ticks as many as apply.
  function customerCheckboxListHtml(containerId, checkedIds){
    const checked = new Set((checkedIds||[]).map(String));
    return customersCache.slice().sort((a,b)=> (a.name||'').localeCompare(b.name||''))
      .map(c=>
        '<label class="restrict-row"><input type="checkbox" data-cust-check="'+containerId+'" value="'+c.id+'" '+(checked.has(String(c.id))?'checked':'')+'>'+
          '<span class="rtxt"><span class="rt-title">'+escapeHtml(c.name)+'</span></span></label>'
      ).join('') || '<div class="empty-state" style="padding:6px 0;">No customer records yet — add one under Manage Customers first.</div>';
  }
  function getCheckedCustomerIds(container){
    return $$('input[type="checkbox"]', container).filter(cb=> cb.checked).map(cb=> cb.value);
  }
  async function populateNewUserCustomerOptions(){
    const box = $('newUserCustomerOptions');
    if(!box) return;
    if(!customersCache || customersCache.length===0) await loadCustomers();
    box.innerHTML = customerCheckboxListHtml('newUserCustomerOptions', []);
  }
  $('newUserRole').addEventListener('change', ()=>{
    const isCust = $('newUserRole').value === 'customer';
    $('newUserCustomerField').style.display = isCust ? '' : 'none';
    $('newUserEmail').style.display = isCust ? '' : 'none';
    $('newUserNameLabel').textContent = isCust ? 'Contact Name' : 'Full Name';
    $('newUserName').placeholder = isCust ? 'e.g. Maria Santos' : 'e.g. Juan Dela Cruz';
    if(isCust) populateNewUserCustomerOptions();
  });

  $('addUserBtn').addEventListener('click', async ()=>{
    const role = $('newUserRole').value;
    const name = $('newUserName').value.trim();
    const pin = $('newUserPin').value;
    const pin2 = $('newUserPin2').value;
    if(!name){ toast(role==='customer' ? 'Enter a contact name' : 'Enter a name'); return; }
    if(!pin || pin.length < 4){ toast('Password must be at least 4 characters'); return; }
    if(pin !== pin2){ toast('Passwords do not match'); return; }
    if(!(await ensureCloud())){ toast('Not connected to the cloud'); return; }

    if(role === 'customer'){
      const customerIds = getCheckedCustomerIds($('newUserCustomerOptions'));
      const email = $('newUserEmail').value.trim();
      if(!customerIds.length){ toast('Select at least one customer record this login belongs to'); return; }
      if(!email){ toast('Enter an email for this customer login'); return; }
      $('addUserBtn').disabled = true;
      try{
        // Customer logins go through their own Edge Function rather than
        // admin-create-technician — that function's deployed source isn't
        // part of this codebase, so its technician-creation logic is left
        // completely untouched rather than guessed at and extended blind.
        // See supabase/functions/admin-create-customer/index.ts (new —
        // needs to be deployed to Supabase before this button will work).
        const { data, error } = await db.functions.invoke('admin-create-customer', {
          body: { name, email, password: pin, customerIds }
        });
        if(error || (data && data.error)){
          toast((data && data.error) || 'Could not add customer login');
        }else{
          $('newUserName').value=''; $('newUserPin').value=''; $('newUserPin2').value=''; $('newUserEmail').value='';
          $$('input[type="checkbox"]', $('newUserCustomerOptions')).forEach(cb=> cb.checked=false);
          toast('Added customer login for '+name);
          renderUsersList();
        }
      }finally{ $('addUserBtn').disabled = false; }
      return;
    }

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

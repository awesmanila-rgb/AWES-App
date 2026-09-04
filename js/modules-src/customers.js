// ---------- Customer database (table: customers) ----------
  // Powers the Customer's Name autocomplete: picking an existing customer
  // auto-fills address/contact/email; saving a report keeps this list fresh.
  let customersCache = [];
  function customerRowToObj(row){
    return { id: row.id, name: row.name, address: row.address||'', contactNo: row.contact_no||'', contactPerson: row.contact_person||'', email: row.email||'' };
  }
  async function loadCustomers(){
    if(await ensureCloud()){
      try{
        const { data, error } = await db.from('customers').select('*').order('name');
        if(error) throw error;
        customersCache = (data||[]).map(customerRowToObj);
        return;
      }catch(e){ console.error('load customers failed', describeCloudError(e)); }
    }
    try{
      const res = await window.storage.get('customers', false);
      customersCache = res ? JSON.parse(res.value) : [];
    }catch(e){ customersCache = []; }
  }
  async function saveCustomersLocal(){
    try{ await window.storage.set('customers', JSON.stringify(customersCache), false); }catch(e){}
  }
  // Called when a report is saved — creates or updates the customer record
  // so the next report for the same client can auto-fill from it.
  async function cloudUpsertCustomer(c){
    if(!c.name || !c.name.trim()) return;
    const rec = { name: c.name.trim(), address: c.address||'', contact_no: c.contactNo||'', contact_person: c.contactPerson||'', email: c.email||'', updated_at: new Date().toISOString() };
    if(await ensureCloud()){
      try{
        const { error } = await db.from('customers').upsert(rec, { onConflict: 'name' });
        if(error) throw error;
        await loadCustomers();
        return;
      }catch(e){ console.error('upsert customer failed', describeCloudError(e)); }
    }
    const idx = customersCache.findIndex(x=> x.name.toLowerCase() === rec.name.toLowerCase());
    const obj = { id: idx>=0 ? customersCache[idx].id : ('local-'+Date.now()), name: rec.name, address: rec.address, contactNo: rec.contact_no, contactPerson: rec.contact_person, email: rec.email };
    if(idx>=0) customersCache[idx] = obj; else customersCache.push(obj);
    await saveCustomersLocal();
  }
  async function cloudDeleteCustomer(id){
    if(await ensureCloud()){
      try{
        const { error } = await db.from('customers').delete().eq('id', id);
        if(error) throw error;
        await loadCustomers();
        return true;
      }catch(e){ console.error('delete customer failed', describeCloudError(e)); return false; }
    }
    customersCache = customersCache.filter(c=>c.id!==id);
    await saveCustomersLocal();
    return true;
  }

  // ---------- Customer Equipment (table: customer_equipment) ----------
  // Equipment fields all use the normal global dropdown lists for free entry
  // (via the generic combo). The toggle below lets a technician instead pick
  // a whole known unit for the selected customer, filling every field at once.
  const EQUIP_FIELD_KEYS = ['equipType','equipLocation','brand','mountType','coolCap','modelCU','serialCU','modelFCU','serialFCU','refrigerantType','compressorType'];
  const EQUIP_FIELD_TO_COLUMN = {
    equipType:'equip_type', equipLocation:'equip_location', brand:'brand', mountType:'mount_type', coolCap:'cool_cap',
    modelCU:'model_cu', serialCU:'serial_cu', modelFCU:'model_fcu', serialFCU:'serial_fcu',
    refrigerantType:'refrigerant_type', compressorType:'compressor_type'
  };
  let currentCustomerId = null;      // which customer's equipment is currently loaded
  let currentEquipmentCache = [];    // that customer's equipment rows
  function equipRowToObj(row){
    return {
      id: row.id, customerId: row.customer_id, equipType: row.equip_type, equipLocation: row.equip_location,
      brand: row.brand, mountType: row.mount_type, coolCap: row.cool_cap, modelCU: row.model_cu, serialCU: row.serial_cu,
      modelFCU: row.model_fcu, serialFCU: row.serial_fcu, refrigerantType: row.refrigerant_type, compressorType: row.compressor_type
    };
  }
  async function loadCustomerEquipment(customerId){
    currentCustomerId = customerId;
    if(!customerId){ currentEquipmentCache = []; return; }
    if(await ensureCloud()){
      try{
        const { data, error } = await db.from('customer_equipment').select('*').eq('customer_id', customerId);
        if(error) throw error;
        currentEquipmentCache = (data||[]).map(equipRowToObj);
        return;
      }catch(e){ console.error('load customer equipment failed', describeCloudError(e)); }
    }
    try{
      const res = await window.storage.get('cequip:'+customerId, false);
      currentEquipmentCache = res ? JSON.parse(res.value) : [];
    }catch(e){ currentEquipmentCache = []; }
  }
  // Called on report save — if this customer + equipment combo hasn't been
  // seen before, record it so it shows up in future dropdowns for this site.
  async function cloudAddCustomerEquipment(customerId, fields){
    if(!customerId) return;
    const hasAnyValue = EQUIP_FIELD_KEYS.some(k=> (fields[k]||'').trim());
    if(!hasAnyValue) return;
    // Skip if an identical record already exists for this customer.
    const dupe = currentEquipmentCache.find(e=> EQUIP_FIELD_KEYS.every(k=> (e[k]||'') === (fields[k]||'')));
    if(dupe) return;
    const rec = { customer_id: customerId };
    EQUIP_FIELD_KEYS.forEach(k=> rec[EQUIP_FIELD_TO_COLUMN[k]] = fields[k]||'');
    if(await ensureCloud()){
      try{
        const { error } = await db.from('customer_equipment').insert(rec);
        if(error) throw error;
        await loadCustomerEquipment(customerId);
        return;
      }catch(e){ console.error('add customer equipment failed', describeCloudError(e)); }
    }
    const obj = { id:'local-'+Date.now(), customerId }; EQUIP_FIELD_KEYS.forEach(k=> obj[k]=fields[k]||'');
    currentEquipmentCache.push(obj);
    try{ await window.storage.set('cequip:'+customerId, JSON.stringify(currentEquipmentCache), false); }catch(e){}
  }
  // Deleting equipment requires a connection: there is no local delete queue,
  // so the old offline path just dropped it from the in-memory cache and
  // reported success — the record was still on the server and reappeared on the
  // next refresh.
  async function cloudDeleteCustomerEquipment(id){
    if(!(await ensureCloud())) return false;
    try{
      const { error } = await db.from('customer_equipment').delete().eq('id', id);
      if(error) throw error;
    }catch(e){
      console.error('delete equipment failed', describeCloudError(e));
      return false;
    }
    currentEquipmentCache = currentEquipmentCache.filter(e=>e.id!==id);
    return true;
  }
  // Editing a record from the admin "Manage Equipment List → Edit" tab.
  // Same reasoning as delete above: admin-only and requires a live cloud
  // connection, no offline queue. Deliberately doesn't touch
  // currentEquipmentCache — that cache belongs to whichever customer is
  // currently open in Manage Customers / a report in progress, which may not
  // be the customer this record belongs to; the admin list re-fetches fresh
  // after saving instead.
  async function cloudUpdateCustomerEquipment(id, fields){
    if(!(await ensureCloud())) return false;
    const rec = {};
    EQUIP_FIELD_KEYS.forEach(k=> rec[EQUIP_FIELD_TO_COLUMN[k]] = (fields[k]||'').trim());
    try{
      const { error } = await db.from('customer_equipment').update(rec).eq('id', id);
      if(error) throw error;
    }catch(e){
      console.error('update equipment failed', describeCloudError(e));
      return false;
    }
    return true;
  }
  // Adding a record from the admin "Manage Equipment List → Add" tab, for
  // whichever customer the admin picks — deliberately independent of
  // currentCustomerId / currentEquipmentCache (same reasoning as the
  // dedicated dt* equipment state kept for the Dispatch Ticket picker):
  // this runs the dupe-check against a fresh fetch for the target customer
  // instead of the shared cache, so it can never clobber whatever customer's
  // equipment is loaded behind this admin sheet in Manage Customers or an
  // open report. Requires a live cloud connection.
  async function cloudAddCustomerEquipmentAdmin(customerId, fields){
    if(!customerId) return false;
    const hasAnyValue = EQUIP_FIELD_KEYS.some(k=> (fields[k]||'').trim());
    if(!hasAnyValue) return false;
    if(!(await ensureCloud())) return false;
    try{
      const { data, error } = await db.from('customer_equipment').select('*').eq('customer_id', customerId);
      if(error) throw error;
      const existing = (data||[]).map(equipRowToObj);
      const dupe = existing.find(e=> EQUIP_FIELD_KEYS.every(k=> (e[k]||'') === (fields[k]||'').trim()));
      if(dupe) return 'dupe';
      const rec = { customer_id: customerId };
      EQUIP_FIELD_KEYS.forEach(k=> rec[EQUIP_FIELD_TO_COLUMN[k]] = (fields[k]||'').trim());
      const { error: insErr } = await db.from('customer_equipment').insert(rec);
      if(insErr) throw insErr;
      return true;
    }catch(e){
      console.error('admin add customer equipment failed', describeCloudError(e));
      return false;
    }
  }
  // Loads every equipment record across every customer, with the owning
  // customer's name attached — powers the admin "Customer Equipment List"
  // master view. (loadCustomerEquipment above is scoped to one customer,
  // for the picker shown while filing a report / editing that customer.)
  async function loadAllCustomerEquipment(){
    if(await ensureCloud()){
      try{
        const { data, error } = await db.from('customer_equipment')
          .select('*, customers(name)')
          .order('customer_id');
        if(error) throw error;
        return (data||[]).map(row=>{
          const obj = equipRowToObj(row);
          obj.customerName = row.customers ? row.customers.name : '(unknown customer)';
          return obj;
        });
      }catch(e){ console.error('load all customer equipment failed', describeCloudError(e)); }
    }
    // Offline fallback: stitch together each customer's own locally cached list.
    try{
      if(customersCache.length===0) await loadCustomers();
      const list = [];
      for(const c of customersCache){
        try{
          const res = await window.storage.get('cequip:'+c.id, false);
          const items = res ? JSON.parse(res.value) : [];
          items.forEach(e=> list.push(Object.assign({}, e, { customerName: c.name })));
        }catch(e){ /* skip this customer's cache on read error */ }
      }
      return list;
    }catch(e){ return []; }
  }
  // Detail fields (everything except Equipment Type) dynamically decide their
  // own source each time they're opened:
  // Equipment picker toggle: ON shows a list of this customer's known
  // equipment (identified by Type + Brand + Capacity + Mounting + Location) to
  // pick from as one unit. "Add New" reveals the normal input fields (global
  // dropdown lists, free entry) for equipment not yet on file.
  let currentEquipTab = 'addnew';
  function equipSummaryLine(e){
    return [e.equipLocation, e.brand, e.mountType, e.equipType, e.coolCap].filter(Boolean).join('  ·  ') || '(no details on file)';
  }
  function renderEquipPicker(){
    const list = $('equipPickerList');
    list.innerHTML = '';
    if(!currentCustomerId){
      list.innerHTML = '<div class="combo-empty">Select a customer first (step 1).</div>';
      return;
    }
    if(currentEquipmentCache.length===0){
      list.innerHTML = '<div class="combo-empty">No equipment on file yet for this customer — tap "+ Add New" to add one.</div>';
      return;
    }
    currentEquipmentCache.forEach(e=>{
      const row = document.createElement('div');
      row.className = 'combo-item';
      row.style.cssText = 'border:1px solid var(--border); border-radius:8px; margin-bottom:6px; padding:10px;';
      row.textContent = equipSummaryLine(e);
      row.addEventListener('click', ()=>{
        EQUIP_FIELD_KEYS.forEach(k=>{ const el=$(k); if(el) el.value = e[k]||''; });
        setEquipTab('addnew');
        toast('Loaded equipment: '+equipSummaryLine(e));
      });
      list.appendChild(row);
    });
  }
  function setEquipTab(tab){
    currentEquipTab = tab;
    $('equipTabExisting').classList.toggle('active', tab==='existing');
    $('equipTabAddNew').classList.toggle('active', tab==='addnew');
    if(tab==='existing'){
      if(!currentCustomerId){ toast('Select a customer first (step 1)'); currentEquipTab='addnew'; $('equipTabExisting').classList.remove('active'); $('equipTabAddNew').classList.add('active'); }
      $('equipPickerPanel').style.display = currentEquipTab==='existing' ? '' : 'none';
      $('equipFieldsWrap').style.display = currentEquipTab==='existing' ? 'none' : '';
      if(currentEquipTab==='existing') renderEquipPicker();
    }else if(tab==='addnew'){
      $('equipPickerPanel').style.display = 'none';
      $('equipFieldsWrap').style.display = '';
    }else{
      // Neutral state: nothing picked yet — keep both hidden until the
      // technician taps a tab (or picking a customer auto-picks one).
      $('equipPickerPanel').style.display = 'none';
      $('equipFieldsWrap').style.display = 'none';
    }
  }
  // When a customer is selected, default to whichever tab makes sense:
  // show their equipment list if they have any on file, otherwise go
  // straight to Add New so the technician isn't stuck looking at an empty list.
  function defaultEquipTabForCustomer(){
    // Neutral state: show only the "Select Existing" / "+ Add New" tab
    // buttons, with neither box expanded — the technician taps one to
    // reveal the picker list or the entry fields.
    setEquipTab(null);
  }
  // Dedicated autocomplete for Customer's Name — separate from the generic
  // attachCombo() used elsewhere, because selecting a result here fills
  // FOUR fields (address/contact/person/email) at once, not just one.
  function revealSectionsAfterCustomer(){
    $('custDetailsWrap').style.display = '';
    ['sec2Card','sec3Card','sec4Card','sec5Card','sec6Card','sec7Card','sec8Card'].forEach(id=>{
      const el = $(id); if(el) el.style.display = '';
    });
  }
  // Shared by the customer-picker combo (below) and the "From Job Order"
  // autofill — anywhere a customer record needs to populate section 1.
  function applyCustomerToForm(c){
    $('custName').value = c.name;
    $('custAddress').value = c.address||'';
    $('contactNo').value = c.contactNo||'';
    $('contactPerson').value = c.contactPerson||'';
    $('custEmail').value = c.email||'';
    // Switching customers means switching equipment context — clear the old
    // customer's equipment values so nothing from a different site lingers,
    // then load this customer's own equipment list for the picker.
    EQUIP_FIELD_KEYS.forEach(k=>{ const el=$(k); if(el) el.value=''; });
    loadCustomerEquipment(c.id).then(defaultEquipTabForCustomer);
    revealSectionsAfterCustomer();
  }
  function attachCustomerCombo(input){
    if(input.dataset.comboAttached) return;
    input.dataset.comboAttached = '1';
    const wrap = document.createElement('div');
    wrap.className = 'combo-wrap';
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);
    input.classList.add('combo-input');
    const caret = document.createElement('button');
    caret.type='button'; caret.className='combo-caret'; caret.innerHTML='&#9662;';
    wrap.appendChild(caret);
    const panel = document.createElement('div');
    panel.className = 'combo-panel';
    wrap.appendChild(panel);

    function fillFromCustomer(c){
      applyCustomerToForm(c);
      panel.classList.remove('open');
      input.dispatchEvent(new Event('change'));
    }
    // Selecting from the dropdown calls this directly (fillFromCustomer, above).
    // Typing a brand-new customer name that isn't in the list should reveal
    // the rest of the form too, once the technician moves on from the field —
    // otherwise a new customer would have no way to get past step 1.
    input.addEventListener('blur', ()=>{
      if(input.value.trim()) revealSectionsAfterCustomer();
    });
    function render(filterText){
      const q = (filterText||'').toLowerCase();
      const filtered = customersCache.filter(c=> c.name.toLowerCase().includes(q));
      panel.innerHTML = '';
      if(filtered.length===0){
        const empty = document.createElement('div');
        empty.className = 'combo-empty';
        empty.textContent = customersCache.length===0 ? 'No saved customers yet — fill in details and save a report to add one' : 'No matches — new customer? Just fill in the fields below';
        panel.appendChild(empty);
      }
      filtered.slice(0,25).forEach(c=>{
        const row = document.createElement('div');
        row.className = 'combo-item';
        const span = document.createElement('span');
        span.textContent = c.name + (c.address ? '  —  '+c.address : '');
        row.appendChild(span);
        row.addEventListener('mousedown', (e)=> e.preventDefault());
        row.addEventListener('click', ()=> fillFromCustomer(c));
        panel.appendChild(row);
      });
    }
    function open(){
      closeAllCombos(panel);
      render(input.value);
      panel.classList.add('open');
      panel.style.top=''; panel.style.bottom='';
      const rect = wrap.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      const spaceAbove = rect.top;
      if(spaceBelow < 200 && spaceAbove > spaceBelow){
        panel.style.top='auto'; panel.style.bottom='calc(100% + 4px)';
      }
      setTimeout(()=>{ panel.scrollIntoView({block:'nearest', behavior:'smooth'}); }, 30);
    }
    input.addEventListener('focus', open);
    input.addEventListener('input', ()=> render(input.value));
    caret.addEventListener('click', (e)=>{
      e.preventDefault();
      if(panel.classList.contains('open')){ panel.classList.remove('open'); } else { open(); input.focus(); }
    });
  }

  const DEFAULT_LISTS = {
    troubleCall: [
      'No cooling', 'Weak airflow', 'Water leaking from unit', 'Unit not turning on',
      'Noisy operation', 'Foul odor from unit', 'Preventive maintenance / cleaning',
      'Unit cycling on and off frequently', 'Remote control not responding', 'Ice buildup on coil'
    ],
    findings: [
      'Dirty/clogged air filter', 'Low refrigerant charge / possible leak', 'Dirty condenser coil',
      'Dirty evaporator coil', 'Clogged condensate drain line', 'Faulty capacitor', 'Faulty compressor',
      'Damaged/worn fan motor', 'Loose or damaged electrical wiring', 'Frozen evaporator coil',
      'Thermostat/sensor malfunction', 'Normal wear from lack of maintenance'
    ],
    recs: [
      'Clean or replace air filter', 'Recharge refrigerant to proper level', 'Clean condenser coil',
      'Clean evaporator coil', 'Clear condensate drain line', 'Replace capacitor', 'Replace/repair compressor',
      'Replace fan motor', 'Repair/secure electrical wiring', 'Schedule regular preventive maintenance (every 3–6 months)',
      'Monitor unit performance after repair'
    ],
    servicesDone: [
      'General cleaning (air filter, evaporator coil, condenser coil)',
      'Recharged refrigerant to proper level',
      'Flushed and cleared condensate drain line',
      'Replaced capacitor',
      'Replaced air filter',
      'Checked and tightened electrical connections',
      'Checked and adjusted refrigerant pressure',
      'Repaired refrigerant leak',
      'Replaced fan motor',
      'Performed full preventive maintenance service',
      'Tested unit operation after service — normal cooling confirmed'
    ],
    coolCap: [
      '0.5 HP (5,000 BTU/hr)', '0.75 HP (7,500 BTU/hr)', '1.0 HP (9,000 BTU/hr)',
      '1.5 HP (12,000 BTU/hr)', '2.0 HP (18,000 BTU/hr)', '2.5 HP (21,000 BTU/hr)',
      '3.0 HP (24,000 BTU/hr)', '4.0 HP (36,000 BTU/hr / 3 TR)', '5.0 HP (48,000 BTU/hr / 4 TR)',
      '6.0 HP (56,000 BTU/hr / 5 TR)', '7.5 HP (72,000 BTU/hr / 6 TR)', '10 HP (96,000 BTU/hr / 8 TR)',
      '15 HP (12 TR)', '20 HP (16 TR)', '25 HP (20 TR)', '30 HP (25 TR)'
    ],
    mountType: [
      'Wall Mounted', 'Ceiling Mounted (Cassette)', 'Ceiling Concealed (Ducted)',
      'Floor Standing', 'Window Type', 'Portable', 'Rooftop Package Unit', 'Ceiling Suspended'
    ],
    brand: [
      'Daikin', 'Carrier', 'Panasonic', 'LG', 'Samsung', 'Hitachi', 'Mitsubishi Electric',
      'Mitsubishi Heavy Industries', 'Fujitsu General', 'York', 'Trane', 'McQuay', 'Kolin',
      'Condura', 'Koppel', 'Century', 'TCL', 'Midea', 'Gree', 'Sharp'
    ],
    refrigerantType: [
      'R22', 'R410A', 'R32', 'R404A', 'R134A', 'R407C', 'R290'
    ],
    compressorType: [
      'Inverter', 'Non-Inverter'
    ],
    bracketType: [
      'L-Type Bracket', 'Floor Mounted Type'
    ],
    transportMode: [
      'Jeepney', 'Tricycle', 'Bus', 'Taxi', 'Grab/Ride-hailing', 'Motorcycle', 'Company Vehicle', 'Own Vehicle', 'Van Rental', 'Other'
    ],
    equipType: [
      'Split Type Unit', 'Window Type', 'Chilled Water', 'Water-Cooled Type', 'Refrigerator', 'Freezer/Chiller'
    ],
    m_desc: [
      'Compressor', 'Condenser Fan Motor', 'Blower/Fan Motor', 'Indoor PCB', 'Outdoor PCB',
      'Remote Control', 'Capacitor', 'Contactor', 'Overload Relay', 'Thermostat/Sensor',
      'Air Filter', 'Drain Pump', 'Cross Flow Fan', 'Expansion Valve', 'Solenoid Valve',
      'Copper Pipe/Tubing', 'Insulation Tape/Armaflex', 'Refrigerant R22', 'Refrigerant R410A',
      'Refrigerant R32', 'General Cleaning/Aircon Service'
    ],
    m_unit: [
      'pc/s', 'set', 'assy', 'unit', 'lot', 'pair', 'roll', 'meter', 'kg', 'liter', 'can', 'box'
    ]
  };
  // The Qty and Item Description suggestion lists moved to fresh keys/columns
  // when this table split "Model No. / Details" into a plain Item Description
  // column and a separate Unit column. Anyone who had already been building up
  // suggestions under the old keys — or who (understandably, given the old
  // combined field) had typed part descriptions into the Qty box and saved them
  // there by mistake — would otherwise see those suggestions vanish from
  // Description and linger, out of place, under Qty. Run this once to carry
  // them over to where they now belong.
  function looksLikePlainQty(v){ return /^\d+(\.\d+)?$/.test(String(v).trim()); }
  async function migrateComponentFieldLists(){
    if(fieldLists.__componentListsMigrated) return;
    let changed = false;
    if(Array.isArray(fieldLists.m_details) && fieldLists.m_details.length){
      const desc = ensureList('m_desc');
      fieldLists.m_details.forEach(v=>{ if(!desc.includes(v)) desc.push(v); });
      changed = true;
    }
    if(Array.isArray(fieldLists.m_qty) && fieldLists.m_qty.length){
      const desc = ensureList('m_desc');
      const stillQty = [];
      fieldLists.m_qty.forEach(v=>{
        if(looksLikePlainQty(v)) stillQty.push(v);
        else { if(!desc.includes(v)) desc.push(v); changed = true; }
      });
      if(stillQty.length !== fieldLists.m_qty.length){ fieldLists.m_qty = stillQty; changed = true; }
    }
    // Top up with the curated defaults too, so accounts that already had some
    // Description suggestions (migrated or otherwise) still get the rest of
    // the starter list, and everyone gets the new Unit suggestions — plain
    // seedDefaultLists() below only seeds a key the very first time it's seen,
    // which these two keys no longer qualify for once migration touches them.
    ['m_desc','m_unit'].forEach(key=>{
      const list = ensureList(key);
      DEFAULT_LISTS[key].forEach(v=>{ if(!list.includes(v)){ list.push(v); changed = true; } });
    });
    fieldLists.__componentListsMigrated = true;
    if(changed) await saveFieldLists();
  }
  async function seedDefaultLists(){
    let changed = false;
    Object.keys(DEFAULT_LISTS).forEach(key=>{
      if(!(key in fieldLists)){ fieldLists[key] = DEFAULT_LISTS[key].slice(); changed = true; }
    });
    if(changed) await saveFieldLists();
  }

  function closeAllCombos(except){
    document.querySelectorAll('.combo-panel.open').forEach(p=>{ if(p!==except) p.classList.remove('open'); });
  }

  function attachCombo(input, keyOverride){
    if(input.dataset.comboAttached) return;
    input.dataset.comboAttached = '1';
    const key = keyOverride || input.id;
    if(!key) return;
    const wrap = document.createElement('div');
    wrap.className = 'combo-wrap';
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);
    input.classList.add('combo-input');
    const caret = document.createElement('button');
    caret.type = 'button'; caret.className = 'combo-caret'; caret.innerHTML = '&#9662;';
    wrap.appendChild(caret);
    const panel = document.createElement('div');
    panel.className = 'combo-panel';
    wrap.appendChild(panel);

    // One delegated handler replaces dozens of per-option listeners created every
    // time the suggestion list is rendered. This is both lighter and easier to maintain.
    panel.addEventListener('mousedown', e=>{
      if(e.target.closest('.combo-item')) e.preventDefault();
    });
    panel.addEventListener('click', async e=>{
      const del = e.target.closest('.combo-del');
      if(del){
        e.stopPropagation();
        const row = del.closest('.combo-item');
        const opt = row && row.dataset.value;
        const idx = ensureList(key).indexOf(opt);
        if(idx>-1){ ensureList(key).splice(idx,1); await saveFieldLists(); render(input.value); }
        return;
      }
      const add = e.target.closest('.combo-additem');
      if(add){
        const value = add.dataset.value || '';
        if(value){ ensureList(key).push(value); await saveFieldLists(); render(value); }
        return;
      }
      const row = e.target.closest('.combo-item');
      if(row && !row.classList.contains('combo-additem')){
        input.value = row.dataset.value || '';
        panel.classList.remove('open');
        input.dispatchEvent(new Event('change'));
      }
    });

    function render(filterText){
      const list = ensureList(key);
      const q = (filterText||'').toLowerCase();
      const filtered = list.filter(o=>o.toLowerCase().includes(q));
      panel.innerHTML = '';
      if(filtered.length===0){
        const empty = document.createElement('div');
        empty.className = 'combo-empty';
        empty.textContent = list.length===0
          ? (USER_ADDABLE_LIST_KEYS.has(key) ? 'No suggestions yet — start typing to add one' : 'No suggestions yet — set up via Admin')
          : 'No matches';
        panel.appendChild(empty);
      }
      filtered.forEach(opt=>{
        const row = document.createElement('div');
        row.className = 'combo-item';
        row.dataset.value = opt;
        const span = document.createElement('span'); span.textContent = opt;
        row.appendChild(span);
        if(adminMode){
          const del = document.createElement('button');
          del.type='button'; del.className='combo-del'; del.textContent='\u2715';
          row.appendChild(del);
        }
        panel.appendChild(row);
      });
      if((adminMode || USER_ADDABLE_LIST_KEYS.has(key)) && filterText && filterText.trim() && !list.includes(filterText.trim())){
        const addRow = document.createElement('div');
        addRow.className = 'combo-item combo-additem';
        addRow.dataset.value = filterText.trim();
        addRow.textContent = '+ Add "'+filterText.trim()+'" to list';
        panel.appendChild(addRow);
      }
    }
    function open(){
      closeAllCombos(panel);
      render(input.value);
      panel.classList.add('open');
      panel.style.top = ''; panel.style.bottom = '';
      const rect = wrap.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      const spaceAbove = rect.top;
      if(spaceBelow < 200 && spaceAbove > spaceBelow){
        panel.style.top = 'auto';
        panel.style.bottom = 'calc(100% + 4px)';
      }
      setTimeout(()=>{ panel.scrollIntoView({block:'nearest', behavior:'smooth'}); }, 30);
    }
    input.addEventListener('focus', open);
    input.addEventListener('input', ()=> render(input.value));
    caret.addEventListener('click', e=>{
      e.preventDefault();
      if(panel.classList.contains('open')) panel.classList.remove('open');
      else { open(); input.focus(); }
    });
  }
  document.addEventListener('click', (e)=>{
    if(!e.target.closest('.combo-wrap')) closeAllCombos(null);
  });
  function attachAllCombos(){
    // Only attach the suggestion dropdown to fields that actually have saved
    // suggestions (the FIELD_META keys). The old version attached it to every
    // text input in the document, which meant Dispatch, Leave, Cash Advance and
    // Admin inputs all sprouted an empty suggestion panel and a caret button.
    Object.keys(FIELD_META).forEach(key=>{
      if(key==='custName') return; // has its own customer-record combo below
      const el = $(key);
      if(el && el.tagName==='INPUT' && el.type==='text') attachCombo(el);
    });
    attachCombo($('troubleCall'), 'troubleCall');
    attachCustomerCombo($('custName'));
    if(!$('equipTabExisting').dataset.hooked){
      $('equipTabExisting').dataset.hooked = '1';
      $('equipTabExisting').addEventListener('click', ()=> setEquipTab('existing'));
      $('equipTabAddNew').addEventListener('click', ()=>{
        // A direct tap on "+ Add New" means the technician wants to log
        // equipment that isn't on file yet — start blank. (Don't put this
        // inside setEquipTab() itself: history.js/dispatch.js/the equipment
        // picker all call setEquipTab('addnew') AFTER filling the fields
        // with data they want kept, so clearing has to be scoped to this
        // literal button tap only.)
        EQUIP_FIELD_KEYS.forEach(k=>{ const el=$(k); if(el) el.value=''; });
        setEquipTab('addnew');
      });
      setEquipTab(null);
    }
  }
  // Sections 3–8 (Report Summary through Acknowledgment) show only their
  // title until tapped — tapping the header expands/collapses its body.
  function toggleCollapsibleSection(head, forceOpen){
    const body = head.nextElementSibling;
    if(!body) return;
    const isOpen = forceOpen!==undefined ? forceOpen : body.style.display==='none';
    body.style.display = isOpen ? '' : 'none';
    head.classList.toggle('open', isOpen);
  }
  function collapseAllSections(){
    document.querySelectorAll('.collapsible-head').forEach(head=> toggleCollapsibleSection(head, false));
  }
  function expandAllSections(){
    document.querySelectorAll('.collapsible-head').forEach(head=> toggleCollapsibleSection(head, true));
  }
  // Wired via event delegation on document, at load time — NOT inside
  // attachAllCombos(). attachAllCombos() only runs after an async chain
  // (loadFieldLists -> seedDefaultLists -> loadCustomers) that can stall or
  // throw on a slow/offline connection; if it never completes, the old
  // per-element listeners here never got attached and every header appeared
  // permanently dead ("nothing happens" on tap). Delegation on document
  // means tapping a header always works, independent of that network chain.
  document.addEventListener('click', (e)=>{
    const head = e.target.closest('.collapsible-head');
    if(!head) return;
    const body = head.nextElementSibling;
    if(!body) return;
    // Accordion behavior: the phone screen is too small to read two open
    // sections at once, so opening one collapses whichever other section
    // was open. expandAllSections() (read-only history view) and
    // resetForm's initial state still show multiple — this only governs
    // what happens on a user tap.
    const willOpen = body.style.display === 'none';
    if(willOpen){
      document.querySelectorAll('.collapsible-head').forEach(h=>{
        if(h !== head) toggleCollapsibleSection(h, false);
      });
    }
    toggleCollapsibleSection(head, willOpen);
  });

  function fieldsInGroup(group){
    return Object.keys(FIELD_META).filter(k=>FIELD_META[k].group===group);
  }
  function renderManageLists(){
    const body = $('adminListsBody');
    body.innerHTML = '';
    GROUP_ORDER.forEach(group=>{
      const keys = fieldsInGroup(group);
      if(keys.length===0) return;
      const gDiv = document.createElement('div');
      gDiv.className = 'admin-group';
      const h4 = document.createElement('h4'); h4.textContent = group;
      gDiv.appendChild(h4);
      keys.forEach(key=>{
        const list = ensureList(key);
        const fDiv = document.createElement('div');
        fDiv.className = 'admin-field';
        const lbl = document.createElement('label'); lbl.textContent = FIELD_META[key].label;
        fDiv.appendChild(lbl);
        const chips = document.createElement('div'); chips.className='chips';
        if(list.length===0){
          const em = document.createElement('span'); em.className='chip-empty'; em.textContent='No items yet';
          chips.appendChild(em);
        }
        list.forEach(item=>{
          const chip = document.createElement('div'); chip.className='chip';
          const txt = document.createElement('span'); txt.textContent = item;
          const edit = document.createElement('button'); edit.type='button'; edit.textContent='\u270E';
          edit.title = 'Rename';
          edit.addEventListener('click', async ()=>{
            const idx = list.indexOf(item);
            if(idx===-1) return;
            const next = prompt('Rename "'+item+'" to:', item); // plain text, not a secret
            if(next===null) return;
            const trimmed = next.trim();
            if(!trimmed) return;
            list[idx] = trimmed;
            await saveFieldLists();
            renderManageLists();
          });
          const rm = document.createElement('button'); rm.type='button'; rm.textContent='\u2715';
          rm.title = 'Remove';
          rm.addEventListener('click', async ()=>{
            const idx = list.indexOf(item);
            if(idx>-1){ list.splice(idx,1); await saveFieldLists(); renderManageLists(); }
          });
          chip.appendChild(txt); chip.appendChild(edit); chip.appendChild(rm);
          chips.appendChild(chip);
        });
        fDiv.appendChild(chips);
        const addRow = document.createElement('div'); addRow.className='admin-add-row';
        const inp = document.createElement('input'); inp.type='text'; inp.placeholder='Add new value…';
        const btn = document.createElement('button'); btn.type='button'; btn.textContent='Add';
        async function doAdd(){
          const v = inp.value.trim();
          if(!v) return;
          if(!list.includes(v)) list.push(v);
          inp.value='';
          await saveFieldLists();
          renderManageLists();
        }
        btn.addEventListener('click', doAdd);
        inp.addEventListener('keydown', (e)=>{ if(e.key==='Enter'){ e.preventDefault(); doAdd(); } });
        addRow.appendChild(inp); addRow.appendChild(btn);
        fDiv.appendChild(addRow);
        gDiv.appendChild(fDiv);
      });
      body.appendChild(gDiv);
    });
  }

  $('adminBtn').addEventListener('click', async ()=>{
    if(!adminMode){
      const pin = await askPassword({
        title: 'Manage Dropdown Lists',
        label: 'Enter the Admin Password to edit the dropdown lists'
      });
      if(pin===null) return;
      if(!(await verifyAdminPassword(pin))){ toast('Incorrect password'); return; }
      enterAdminMode();
      toast('Admin mode on — dropdowns are now editable');
    }
    renderManageLists();
    $('adminOverlay').classList.add('open');
  });
  $('closeAdmin').addEventListener('click', ()=> $('adminOverlay').classList.remove('open'));
  $('adminOverlay').addEventListener('click', (e)=>{ if(e.target.id==='adminOverlay') $('adminOverlay').classList.remove('open'); });

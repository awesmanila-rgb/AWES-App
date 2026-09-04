// ---------- Customer Portal (customer-facing home screen) ----------
// Read-only view for logged-in customer accounts: their enrolled equipment,
// service report history, and open service requests.
//
// SCHEMA NOTES / ASSUMPTIONS (please verify against your Supabase project):
//
// 1. customer_equipment already exists and is keyed by customer_id — this
//    module reuses it as-is (see customers.js: EQUIP_FIELD_TO_COLUMN).
//
// 2. service_reports is currently matched to a customer by the free-text
//    `cust_name` column, NOT a customer_id foreign key (see core.js:
//    REPORT_STRING_FIELDS). That works fine for techs filling the field in
//    by hand, but it's fragile for a customer portal — a typo'd or
//    inconsistently-cased name will silently exclude reports. Before
//    shipping this to real customers, add a `customer_id uuid references
//    customers(id)` column to service_reports (nullable, backfilled by
//    matching cust_name once), and switch loadCustomerReports() below to
//    filter on that instead of cust_name. Left as cust_name matching here
//    so this runs against your current schema without a migration.
//
// 3. "Status" (Running well / Needs attention / PM due) is not a stored
//    field anywhere yet. computeEquipmentStatus() below is a placeholder
//    heuristic: it looks at the equipment's most recent report and flags
//    "Needs attention" if that report has any findings/recommendations
//    text. Replace with a real stored status once technicians have a way
//    to set one explicitly on the report (recommended — heuristics like
//    this will misfire on reports where findings are informational, not
//    actionable).
//
// 4. Requires a `profiles` row with role='customer' and a `customer_id`
//    column added to profiles, so a logged-in customer account can be
//    resolved to a customers.id row. See customers table already used by
//    customers.js. Also needs a Supabase RLS policy scoping
//    customer_equipment/service_reports SELECT to rows matching the caller's
//    own customer_id — without RLS, any authenticated customer could query
//    another customer's data directly via the JS client.

  let cpEquipment = [];   // this customer's equipment, from customer_equipment
  let cpReports = [];     // this customer's service reports, most recent first
  let cpCustomer = null;  // {id, name, ...} row from customers

  async function loadCustomerPortalData(customerId){
    cpCustomer = null; cpEquipment = []; cpReports = [];
    if(!customerId) return;
    if(!(await ensureCloud())) return;
    try{
      const { data: custRow, error: custErr } = await db.from('customers')
        .select('*').eq('id', customerId).maybeSingle();
      if(custErr) throw custErr;
      cpCustomer = custRow || null;
    }catch(e){ console.error('load customer record failed', describeCloudError(e)); }

    try{
      const { data, error } = await db.from('customer_equipment')
        .select('*').eq('customer_id', customerId).order('id');
      if(error) throw error;
      cpEquipment = (data||[]).map(row => ({
        id: row.id, equipType: row.equip_type, equipLocation: row.equip_location,
        brand: row.brand, mountType: row.mount_type, coolCap: row.cool_cap,
        modelCU: row.model_cu, serialCU: row.serial_cu, modelFCU: row.model_fcu, serialFCU: row.serial_fcu
      }));
    }catch(e){ console.error('load customer equipment failed', describeCloudError(e)); }

    if(cpCustomer && cpCustomer.name){
      try{
        // See schema note #2 above — matched by name until service_reports
        // gets a customer_id column. Selecting the full set of columns here
        // (not just summary fields) so the equipment history screen can
        // show findings/recommendations/materials/services done per visit
        // without a second round-trip per unit.
        const { data, error } = await db.from('service_reports')
          .select('sr_no, date, cust_name, equip_type, equip_location, model_cu, serial_cu, model_fcu, serial_fcu, trouble_call, remarks, completed, technician_name, findings, recommendations, materials, services_done')
          .eq('cust_name', cpCustomer.name)
          .order('date', { ascending:false });
        if(error) throw error;
        cpReports = data || [];
      }catch(e){ console.error('load customer reports failed', describeCloudError(e)); }
    }

    // Attach each equipment's full matching report history, for the status
    // heuristic, "last serviced" date, and the equipment detail screen.
    //
    // Matched by serial number first (serial_cu / serial_fcu) when the
    // equipment record has one on file — far more reliable than matching by
    // location+type text, which breaks the moment two units share a room or
    // a location gets renamed/retyped slightly differently on a visit.
    // Falls back to location+type only when no serial is on file.
    cpEquipment.forEach(eq => {
      const hasSerial = !!(eq.serialCU || eq.serialFCU);
      eq.reportHistory = cpReports.filter(r => {
        if(hasSerial){
          return (eq.serialCU && r.serial_cu === eq.serialCU) ||
                 (eq.serialFCU && r.serial_fcu === eq.serialFCU);
        }
        return (r.equip_location||'') === (eq.equipLocation||'') &&
               (r.equip_type||'') === (eq.equipType||'');
      }).sort((a,b) => (b.date||'').localeCompare(a.date||''));
      eq.lastReport = eq.reportHistory[0] || null;
      eq.status = computeEquipmentStatus(eq);
    });
  }

  // Placeholder heuristic — see schema note #3 above.
  function computeEquipmentStatus(eq){
    if(!eq.lastReport) return { key:'ok', label:'Running well' };
    if(!eq.lastReport.completed) return { key:'flag', label:'Service in progress' };
    if((eq.lastReport.remarks||'').trim()) return { key:'flag', label:'Needs attention' };
    return { key:'ok', label:'Running well' };
  }

  function cpStatusPillHtml(status){
    return '<span class="status-pill status-'+status.key+'">'+escapeHtml(status.label)+'</span>';
  }

  function cpUpdateSidebarBadge(id, count){
    const el = $(id);
    if(!el) return;
    if(count > 0){ el.textContent = String(count); el.style.display = ''; }
    else { el.style.display = 'none'; }
  }

  function cpEquipmentCardHtml(eq){
    const name = escapeHtml(eq.equipType || 'Equipment');
    const loc = escapeHtml(eq.equipLocation || '—');
    const lastDate = eq.lastReport ? fmtDate(eq.lastReport.date) : '—';
    return (
      '<div class="cp-equip-card" data-equip-id="'+eq.id+'">'+
        '<div class="cp-equip-card-top">'+
          '<div class="cp-equip-icon">❄️</div>'+
          cpStatusPillHtml(eq.status)+
        '</div>'+
        '<div class="cp-unit-name">'+name+'</div>'+
        '<div class="cp-unit-loc">'+loc+'</div>'+
        '<div class="cp-unit-date">Last serviced '+escapeHtml(lastDate)+'</div>'+
      '</div>'
    );
  }

  function cpReportRowHtml(r){
    const title = escapeHtml((r.trouble_call && r.trouble_call.trim()) ? r.trouble_call : (r.equip_type||'Service report'));
    const sub = escapeHtml(r.sr_no||'')+' · '+escapeHtml(r.equip_location||'')+' · '+fmtDate(r.date);
    return (
      '<div class="cp-row" data-sr-no="'+escapeHtml(r.sr_no||'')+'">'+
        '<div class="cp-row-icon">📄</div>'+
        '<div class="cp-row-body">'+
          '<div class="cp-row-title">'+title+'</div>'+
          '<div class="cp-row-sub">'+sub+'</div>'+
        '</div>'+
        '<div class="cp-row-chev">›</div>'+
      '</div>'
    );
  }

  function renderCustomerHome(){
    const flaggedEquip = cpEquipment.filter(e => e.status.key === 'flag');

    // Stat strip
    $('cpStatUnits').textContent = String(cpEquipment.length);
    $('cpStatFlagged').textContent = String(flaggedEquip.length);
    $('cpStatOpenReports').textContent = String(cpReports.filter(r => !r.completed).length);

    // Alert banner — only shown when something needs attention
    const alertEl = $('cpAlertBanner');
    if(flaggedEquip.length){
      const names = flaggedEquip.map(e => escapeHtml(e.equipType||'a unit')+' ('+escapeHtml(e.equipLocation||'—')+')').join(', ');
      $('cpAlertText').innerHTML = names+' '+(flaggedEquip.length===1?'was':'were')+' flagged during the last service visit.';
      alertEl.style.display = '';
    } else {
      alertEl.style.display = 'none';
    }

    // Sidebar badges — same pattern as your existing #sidebarMsgBadge on
    // the technician nav.
    cpUpdateSidebarBadge('custEquipBadge', flaggedEquip.length);
    cpUpdateSidebarBadge('custRequestsBadge', cpReports.filter(r => !r.completed).length);

    // Equipment grid
    $('cpEquipGrid').innerHTML = cpEquipment.length
      ? cpEquipment.map(cpEquipmentCardHtml).join('')
      : '<div class="empty-state">No equipment enrolled yet.</div>';

    // Recent reports (cap at 5 on the home screen)
    $('cpReportsList').innerHTML = cpReports.length
      ? cpReports.slice(0,5).map(cpReportRowHtml).join('')
      : '<div class="empty-state">No service reports yet.</div>';

    // Wire equipment cards to open the (separate) equipment detail screen —
    // hook up to whatever your detail/history screen is called.
    $$('.cp-equip-card', $('customerHomeScreen')).forEach(card => {
      card.onclick = () => {
        const eq = cpEquipment.find(e => String(e.id) === card.dataset.equipId);
        if(eq && typeof openCustomerEquipmentDetail === 'function') openCustomerEquipmentDetail(eq);
      };
    });
    $$('.cp-row', $('customerHomeScreen')).forEach(row => {
      row.onclick = () => {
        const sr = row.dataset.srNo;
        if(sr && typeof openCustomerReportPreview === 'function') openCustomerReportPreview(sr);
      };
    });
  }

  // "Viewing: [customer ▾]" switcher — only shown when this login is linked
  // to more than one customer record (see auth.js: currentUser.customerList,
  // populated at login/session-restore from customer_login_links). Picking
  // a different customer re-scopes the whole home screen (equipment,
  // reports, stat strip) to that customer, and is remembered per device so
  // it's still selected next time this login signs in here.
  function cpRenderSwitcher(){
    const field = $('cpSwitcherField');
    const sel = $('cpCustomerSwitcher');
    if(!field || !sel) return;
    const list = currentUser.customerList || [];
    if(list.length <= 1){ field.style.display = 'none'; return; }
    field.style.display = '';
    sel.innerHTML = list.map(c=> '<option value="'+c.id+'" '+(String(c.id)===String(currentUser.customerId)?'selected':'')+'>'+escapeHtml(c.name)+'</option>').join('');
  }
  async function cpSwitchActiveCustomer(customerId){
    currentUser.customerId = customerId;
    try{ localStorage.setItem('cust-active-customer:'+currentUser.id, customerId); }catch(e){}
    try{ localStorage.setItem('current-user', JSON.stringify(currentUser)); }catch(e){}
    $('cpEquipGrid').innerHTML = '<div class="empty-state">Loading…</div>';
    $('cpReportsList').innerHTML = '<div class="empty-state">Loading…</div>';
    await loadCustomerPortalData(customerId);
    $('cpGreetingName').textContent = currentUser.name || 'there';
    renderCustomerHome();
  }
  $('cpCustomerSwitcher').addEventListener('change', (e)=> cpSwitchActiveCustomer(e.target.value));

  // Entry point — call this after a customer logs in and homeScreen (or a
  // dedicated customerHomeScreen, see the HTML snippet) is shown.
  // currentUser is expected to carry a `customerId` (the one currently
  // being viewed) and a `customerList` (every customer this login can see)
  // when role==='customer' — see auth.js.
  async function initCustomerHomeScreen(){
    if(!currentUser || currentUser.role !== 'customer' || !currentUser.customerId) return;
    $('cpGreetingName').textContent = currentUser.name || 'there';
    cpRenderSwitcher();
    await loadCustomerPortalData(currentUser.customerId);
    renderCustomerHome();
  }

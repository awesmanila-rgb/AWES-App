// ---------- Customer Portal (customer-facing home screen) ----------
// Read-only view for logged-in customer accounts: their enrolled equipment,
// service report history, and open service requests.
//
// SCHEMA NOTES / ASSUMPTIONS (please verify against your Supabase project):
//
// 1. customer_equipment already exists and is keyed by customer_id — this
//    module reuses it as-is (see customers.js: EQUIP_FIELD_TO_COLUMN).
//
// 2. service_reports is matched to a customer via its `customer_id`
//    foreign key (added in 20260904_01_customer_portal.sql, set on every
//    new report by reportToRow() in core.js, and backfilled onto historic
//    rows by 20260908_02_backfill_report_customer_id.sql). This is also
//    what the "customers read own reports" RLS policy checks, so the
//    query below and RLS now agree. Do not switch this back to matching
//    on cust_name (free text) — that was tried first and is fragile: a
//    typo'd or inconsistently-cased name silently excludes reports that
//    RLS would otherwise correctly allow through.
//
// 3. "Status" — PM (preventive maintenance) due, overdue, on schedule, or
//    none scheduled — is derived from customer_equipment.next_pm_date (see
//    supabase/migrations/20260908_03_customer_equipment_next_pm_date.sql),
//    an admin-set tentative date, not anything measured off the equipment
//    itself. See computeEquipmentStatus() below.
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
        modelCU: row.model_cu, serialCU: row.serial_cu, modelFCU: row.model_fcu, serialFCU: row.serial_fcu,
        nextPmDate: row.next_pm_date || '',
        // Admin-set display name for this unit (see
        // 20260909_02_customer_equipment_label.sql) — equipDisplayName()
        // (core.js) shows this instead of the raw id once it's set.
        label: row.label || ''
      }));
      // Photo counts — one query for the whole grid rather than one per
      // card. Powers the small "📷 N" badge in cpEquipmentCardHtml below;
      // actual thumbnails only load in the per-unit detail screen (see
      // renderCustomerEquipmentPhotos, customer-equipment-history.js).
      const photoCounts = await cloudGetEquipmentPhotoCounts(customerId);
      cpEquipment.forEach(eq=> eq.photoCount = photoCounts[eq.id] || 0);
    }catch(e){ console.error('load customer equipment failed', describeCloudError(e)); }

    if(cpCustomer){
      try{
        // Matched by service_reports.customer_id, not cust_name — see
        // schema note #2 above. That column now exists, is set on every
        // new report (reportToRow() in core.js) and was backfilled onto
        // historic rows (20260908_02_backfill_report_customer_id.sql), and
        // it's what the "customers read own reports" RLS policy itself
        // checks. Matching cust_name here as well was fragile: a report
        // whose cust_name didn't exactly match customers.name (typo,
        // different casing/whitespace, a nickname a technician typed in)
        // was otherwise fully visible under RLS but got filtered out by
        // this query before ever reaching the equipment history screen —
        // which is why a unit with real recorded visits could still show
        // "0 service visits". Selecting the full set of columns here (not
        // just summary fields) so the equipment history screen can show
        // findings/recommendations/materials/services done per visit
        // without a second round-trip per unit.
        const { data, error } = await db.from('service_reports')
          .select('sr_no, date, cust_name, equipment_id, equip_type, equip_location, model_cu, serial_cu, model_fcu, serial_fcu, trouble_call, remarks, completed, technician_name, findings, recommendations, materials, services_done')
          .eq('customer_id', cpCustomer.id)
          .order('date', { ascending:false });
        if(error) throw error;
        cpReports = data || [];
      }catch(e){ console.error('load customer reports failed', describeCloudError(e)); }
    }

    // Attach each equipment's full matching report history, for the
    // "Last serviced" date and the equipment detail screen (status itself
    // is now computed from next_pm_date, not report history — see
    // computeEquipmentStatus below). Matching logic lives in
    // matchReportHistoryForEquipment() (core.js) — shared with the admin
    // equipment detail overlay's own history section.
    cpEquipment.forEach(eq => {
      eq.reportHistory = matchReportHistoryForEquipment(cpReports, eq);
      eq.lastReport = eq.reportHistory[0] || null;
      eq.status = computeEquipmentStatus(eq);
    });
  }

  // ---------- PM (preventive maintenance) due status ----------
  // Admin sets a tentative next-PM date per unit (Manage Equipment List →
  // tap a unit → Next PM Date, see admin.js/customers.js). The status pill
  // below is derived entirely from that date — overdue, due soon, on
  // schedule, or no date set. This replaces the old heuristic that guessed
  // "Needs attention" from whatever text happened to land in the last
  // report's remarks: nobody at AWES is actually monitoring these units
  // remotely, so that implied a kind of live condition-monitoring that
  // never existed. If a unit genuinely needs attention, the customer taps
  // "Request Service" themselves rather than waiting for a pill to notice.
  const PM_DUE_SOON_DAYS = 30;
  function daysUntil(iso){
    if(!iso) return null;
    const target = new Date(iso+'T00:00:00');
    const today = new Date(todayISO()+'T00:00:00');
    return Math.round((target - today) / 86400000);
  }
  function computeEquipmentStatus(eq){
    const days = daysUntil(eq.nextPmDate);
    if(days === null) return { key:'none', label:'No PM Scheduled' };
    if(days < 0) return { key:'overdue', label:'PM Overdue' };
    if(days <= PM_DUE_SOON_DAYS) return { key:'due-soon', label:'PM Due Soon' };
    return { key:'scheduled', label:'On Schedule' };
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
    // Same field order as the admin/technician equipment lines: Location,
    // Brand, Mount type, Equipment type, Capacity.
    const loc = escapeHtml(eq.equipLocation || 'Equipment');
    const details = [eq.brand, eq.mountType, eq.equipType, eq.coolCap].filter(Boolean).map(escapeHtml).join(' · ') || '—';
    const lastDate = eq.lastReport ? fmtDate(eq.lastReport.date) : '—';
    const pmLine = eq.status.key==='none' ? 'No PM scheduled'
      : eq.status.key==='overdue' ? 'PM was due '+escapeHtml(fmtDate(eq.nextPmDate))
      : 'Next PM: '+escapeHtml(fmtDate(eq.nextPmDate));
    // equipDisplayName() (core.js) shows this unit's admin-set label once
    // one exists (see 20260909_02_customer_equipment_label.sql); until
    // then it falls back to a shortened form of the fixed equipment id, so
    // every unit still shows some stable identifier a customer can
    // reference when requesting service.
    const idTag = escapeHtml(equipDisplayName(eq)) + (eq.photoCount ? ' &nbsp;📷 '+eq.photoCount : '');
    return (
      '<div class="cp-equip-card" data-equip-id="'+eq.id+'">'+
        '<div class="cp-equip-card-top">'+
          '<div class="cp-equip-icon">❄️</div>'+
          cpStatusPillHtml(eq.status)+
        '</div>'+
        '<div class="cp-unit-tag" style="font-size:11px; font-weight:600; letter-spacing:.02em; color:var(--text-muted); text-transform:uppercase;">'+idTag+'</div>'+
        '<div class="cp-unit-name">'+loc+'</div>'+
        '<div class="cp-unit-loc">'+details+'</div>'+
        '<div class="cp-unit-date">Last serviced '+escapeHtml(lastDate)+'</div>'+
        '<div class="cp-unit-date">'+pmLine+'</div>'+
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
    const pmDueEquip = cpEquipment.filter(e => e.status.key==='due-soon' || e.status.key==='overdue');

    // Stat strip
    $('cpStatUnits').textContent = String(cpEquipment.length);
    $('cpStatFlagged').textContent = String(pmDueEquip.length);
    $('cpStatOpenReports').textContent = String(cpReports.filter(r => !r.completed).length);

    // Alert banner — only shown when a unit is due or overdue for
    // preventive maintenance (see computeEquipmentStatus above).
    const alertEl = $('cpAlertBanner');
    if(pmDueEquip.length){
      const names = pmDueEquip.map(e => escapeHtml(e.equipType||'a unit')+' ('+escapeHtml(e.equipLocation||'—')+')').join(', ');
      const verb = pmDueEquip.length===1 ? 'is' : 'are';
      $('cpAlertText').innerHTML = names+' '+verb+' due for preventive maintenance.';
      alertEl.style.display = '';
    } else {
      alertEl.style.display = 'none';
    }

    // Sidebar badges — same pattern as your existing #sidebarMsgBadge on
    // the technician nav. custRequestsBadge (open service requests, not
    // service reports) comes from an async query, so it's kicked off here
    // fire-and-forget rather than blocking this otherwise-synchronous
    // render — see cpRefreshRequestsBadge() below.
    cpUpdateSidebarBadge('custEquipBadge', pmDueEquip.length);
    if(cpCustomer && cpCustomer.id) cpRefreshRequestsBadge(cpCustomer.id);

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
    cpInitRealtime(customerId);
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
    cpInitRealtime(currentUser.customerId);
  }

  // ---------- Live updates (customer portal) ----------
  // Same push+poll pattern as tracker.js's admin channel: a Supabase
  // realtime subscription for the instant case, plus a slower poll as the
  // offline-safe fallback. Scoped with a customer_id filter so a customer
  // login with access to multiple customers (see cpSwitchActiveCustomer)
  // only gets pushes for whichever one is currently being viewed — RLS
  // would block anything else anyway, but the filter also keeps this
  // login from re-rendering on another of its own customers' changes
  // while looking at a different one.
  let cpRealtimeChannel = null;
  let cpRealtimePollTimer = null;
  let cpRealtimeCustomerId = null;

  function cpInitRealtime(customerId){
    if(cpRealtimeChannel && cpRealtimeCustomerId === customerId) return; // already watching this customer
    cpTeardownRealtime();
    cpRealtimeCustomerId = customerId;
    if(!db) return;
    const onChange = ()=>{
      // Reload+re-render rather than patch state in place — same as every
      // other screen's realtime handler (dispatch.js, tracker.js) — so a
      // push doesn't have to duplicate loadCustomerPortalData's merge logic.
      loadCustomerPortalData(customerId).then(renderCustomerHome);
    };
    // A status change on one of this customer's own requests (e.g. admin
    // acknowledges/schedules/completes it) should update "My Requests" and
    // the sidebar badge the instant it happens — cheap to always run both
    // here since they're no-op-safe even when the requests screen isn't
    // currently visible.
    const onRequestChange = ()=>{
      if(typeof cpRenderMyRequests === 'function') cpRenderMyRequests(customerId);
      cpRefreshRequestsBadge(customerId);
    };
    cpRealtimeChannel = db.channel('customer-portal-'+customerId)
      .on('postgres_changes', { event:'*', schema:'public', table:'customer_equipment', filter:'customer_id=eq.'+customerId }, onChange)
      .on('postgres_changes', { event:'*', schema:'public', table:'service_reports', filter:'customer_id=eq.'+customerId }, onChange)
      .on('postgres_changes', { event:'*', schema:'public', table:'service_requests', filter:'customer_id=eq.'+customerId }, onRequestChange)
      .subscribe();
    if(!cpRealtimePollTimer) cpRealtimePollTimer = setInterval(()=>{ onChange(); onRequestChange(); }, 30000);
  }

  // Called on logout, and internally when switching to a different
  // customer_id, so no stale channel/poll from a previous session or a
  // previously-viewed customer keeps running.
  function cpTeardownRealtime(){
    if(cpRealtimePollTimer){ clearInterval(cpRealtimePollTimer); cpRealtimePollTimer = null; }
    if(cpRealtimeChannel && db){ try{ db.removeChannel(cpRealtimeChannel); }catch(e){} }
    cpRealtimeChannel = null;
    cpRealtimeCustomerId = null;
  }

  // Sidebar "Service Requests" badge — count of this customer's own
  // requests still open (not completed/cancelled). Separate from
  // renderCustomerHome() since srListForCustomer is an async query;
  // renderCustomerHome fires this off without waiting on it.
  async function cpRefreshRequestsBadge(customerId){
    const rows = await srListForCustomer(customerId);
    const openCount = rows.filter(r=> r.status!=='completed' && r.status!=='cancelled').length;
    cpUpdateSidebarBadge('custRequestsBadge', openCount);
  }

  // ---------- Request Service (customer-side) ----------
  // New Request form + My Requests history, reached via custNavRequests or
  // cpRequestServiceBtn (see customer-equipment-history.js wiring). Backend
  // functions (srCreate, srListForCustomer, srStatusLabel) live in
  // service-requests.js — this is just the customer-facing screen.
  function cpShowRequestsScreen(){
    $('customerHomeScreen').style.display = 'none';
    $('customerEquipmentDetailScreen').style.display = 'none';
    $('customerRequestsScreen').style.display = '';
    cpReqShowTab('new');
    cpPopulateReqEquipmentOptions();
    cpRenderMyRequests(currentUser.customerId);
    window.scrollTo({top:0});
  }
  function cpReqShowTab(tab){
    $('cpReqTabNew').classList.toggle('active', tab==='new');
    $('cpReqTabHistory').classList.toggle('active', tab==='history');
    $('cpReqNewPanel').style.display = tab==='new' ? '' : 'none';
    $('cpReqHistoryPanel').style.display = tab==='history' ? '' : 'none';
  }
  function cpPopulateReqEquipmentOptions(){
    const sel = $('cpReqEquipment');
    const generalOpt = '<option value="">General inquiry (not a specific unit)</option>';
    sel.innerHTML = generalOpt + cpEquipment.map(eq=>
      '<option value="'+eq.id+'">'+escapeHtml(equipDisplayName(eq))+' — '+escapeHtml(eq.equipLocation||'')+'</option>'
    ).join('');
  }
  function cpReqStatusPillClass(status){
    return { new:'status-sr-open', acknowledged:'status-sr-open', scheduled:'status-sr-active',
      in_progress:'status-sr-active', completed:'status-sr-done', cancelled:'status-sr-cancelled' }[status] || 'status-sr-done';
  }
  function cpReqRowHtml(r){
    const eq = cpEquipment.find(e=> String(e.id)===String(r.equipmentId));
    const eqLabel = eq ? escapeHtml(equipDisplayName(eq)) : 'General inquiry';
    return (
      '<div class="cp-row" style="align-items:flex-start; cursor:default;">'+
        '<div class="cp-row-icon">🛠️</div>'+
        '<div class="cp-row-body">'+
          '<div class="cp-row-title">'+eqLabel+'</div>'+
          '<div class="cp-row-sub">'+escapeHtml(r.description||'')+'</div>'+
          '<div class="cp-row-sub">'+fmtDate(r.createdAt)+'</div>'+
        '</div>'+
        '<span class="status-pill '+cpReqStatusPillClass(r.status)+'">'+escapeHtml(srStatusLabel(r.status))+'</span>'+
      '</div>'
    );
  }
  async function cpRenderMyRequests(customerId){
    const list = $('cpReqHistoryList');
    if(!list || !customerId) return;
    const rows = await srListForCustomer(customerId);
    list.innerHTML = rows.length
      ? rows.map(cpReqRowHtml).join('')
      : '<div class="empty-state">No service requests yet.</div>';
  }
  async function cpSubmitRequest(){
    const description = $('cpReqDescription').value.trim();
    if(!description){ toast('Please describe the issue'); return; }
    if(!currentUser || !currentUser.customerId){ toast('Please sign in again'); return; }
    $('cpReqSubmitBtn').disabled = true; $('cpReqSubmitBtn').textContent = 'Submitting…';
    const result = await srCreate({
      customerId: currentUser.customerId,
      equipmentId: $('cpReqEquipment').value || null,
      description,
      urgency: $('cpReqUrgency').value || 'normal',
      requestedDate: $('cpReqDate').value || null
    });
    $('cpReqSubmitBtn').disabled = false; $('cpReqSubmitBtn').textContent = 'Submit Request';
    if(!result){ toast('Could not submit — check your connection and try again'); return; }
    toast('Request submitted — we\'ll be in touch');
    $('cpReqDescription').value = '';
    $('cpReqUrgency').value = 'normal';
    $('cpReqDate').value = '';
    $('cpReqEquipment').value = '';
    cpReqShowTab('history');
    cpRenderMyRequests(currentUser.customerId);
    cpRefreshRequestsBadge(currentUser.customerId);
  }
  $('cpReqBackBtn').addEventListener('click', ()=>{ if(typeof showCustomerHome === 'function') showCustomerHome(); });
  $('cpReqTabNew').addEventListener('click', ()=> cpReqShowTab('new'));
  $('cpReqTabHistory').addEventListener('click', ()=>{ cpReqShowTab('history'); cpRenderMyRequests(currentUser.customerId); });
  $('cpReqSubmitBtn').addEventListener('click', cpSubmitRequest);

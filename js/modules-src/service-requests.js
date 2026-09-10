// ---------- Service Requests (table: service_requests) ----------
// Customer-filed, admin-only review — see supabase/migrations/
// 20260910_02_service_requests.sql for the schema/RLS. Technicians never
// see this data at all (no RLS policy grants them a row).
//
// This module owns:
//   - reading/writing service_requests rows
//   - the admin sidebar badge + Overview stat card counts, kept live via
//     a Supabase realtime channel (same pattern as tracker.js's
//     technician-locations-admin channel: realtime push, with a polling
//     fallback so a dropped socket doesn't leave the count stale forever)
//   - converting a request into a dispatch ticket (hands off to dispatch.js)
//
// The admin queue/detail screen itself (full list, filters, per-request
// actions) is a separate, not-yet-built UI — this module exposes the data
// functions it will call (srListAll, srSetStatus, srConvertToTicket) plus
// the live counts already wired into the sidebar/overview.

  const SR_OPEN_STATUSES = ['new', 'acknowledged'];

  function srRowToRequest(row){
    return {
      id: row.id,
      customerId: row.customer_id,
      equipmentId: row.equipment_id,
      description: row.description,
      urgency: row.urgency,
      requestedDate: row.requested_date,
      status: row.status,
      adminNotes: row.admin_notes,
      linkedDispatchTicketId: row.linked_dispatch_ticket_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  // Every service request, newest first. Admin-only — RLS returns nothing
  // (not an error) for any other role, so callers don't need to gate this
  // themselves, though the UI still should to avoid a pointless query.
  async function srListAll(){
    if(!(await ensureCloud())) return [];
    try{
      const { data, error } = await db.from('service_requests')
        .select('*').order('created_at', { ascending:false });
      if(error) throw error;
      return (data||[]).map(srRowToRequest);
    }catch(e){ console.error('load service requests failed', describeCloudError(e)); return []; }
  }

  // Just the count of open (new/acknowledged) requests — used by the badge
  // and Overview stat card, which don't need the full rows.
  async function srCountOpen(){
    if(!(await ensureCloud())) return 0;
    try{
      const { count, error } = await db.from('service_requests')
        .select('id', { count:'exact', head:true })
        .in('status', SR_OPEN_STATUSES);
      if(error) throw error;
      return count || 0;
    }catch(e){ console.error('count service requests failed', describeCloudError(e)); return 0; }
  }

  async function srSetStatus(id, status, adminNotes){
    if(!(await ensureCloud())) return false;
    try{
      const patch = { status };
      if(adminNotes !== undefined) patch.admin_notes = adminNotes;
      const { error } = await db.from('service_requests').update(patch).eq('id', id);
      if(error) throw error;
      return true;
    }catch(e){ console.error('update service request failed', describeCloudError(e)); return false; }
  }

  // Customer-side insert — called from customer-portal.js's "New Request"
  // form. Returns the inserted row (with its generated id) or null.
  async function srCreate({ customerId, equipmentId, description, urgency, requestedDate }){
    if(!(await ensureCloud())) return null;
    try{
      const { data, error } = await db.from('service_requests').insert({
        customer_id: customerId,
        equipment_id: equipmentId || null,
        description: description,
        urgency: urgency || 'normal',
        requested_date: requestedDate || null
      }).select().single();
      if(error) throw error;
      return srRowToRequest(data);
    }catch(e){ console.error('create service request failed', describeCloudError(e)); return null; }
  }

  // Customer-side history — explicit customer_id filter (RLS would already
  // scope a customer session's rows to just their own even without it, the
  // same way srListAll() would, but filtering here too keeps the query
  // self-explanatory and matches loadCustomerPortalData()'s convention in
  // customer-portal.js of always filtering by customer_id explicitly).
  async function srListForCustomer(customerId){
    if(!customerId || !(await ensureCloud())) return [];
    try{
      const { data, error } = await db.from('service_requests')
        .select('*').eq('customer_id', customerId).order('created_at', { ascending:false });
      if(error) throw error;
      return (data||[]).map(srRowToRequest);
    }catch(e){ console.error('load my service requests failed', describeCloudError(e)); return []; }
  }

  // Hands off to dispatch.js: opens the (existing, admin-filled) Create
  // Dispatch Ticket form with this request's customer/equipment/notes
  // pre-filled, so admin reviews and finishes the ticket themselves the
  // same way any other ticket gets created — this does not insert a
  // dispatch_tickets row on its own. dtPrefillCreateFromServiceRequest is
  // expected to live in dispatch.js; kept as a thin call here so this
  // module doesn't need to know the create form's field ids.
  // Once the resulting ticket is actually saved, dispatch.js's own
  // completion/creation path is responsible for calling srLinkTicket()
  // below to stamp linked_dispatch_ticket_id and flip the status forward.
  async function srConvertToTicket(request){
    if(typeof dtPrefillCreateFromServiceRequest !== 'function'){
      console.error('dispatch.js dtPrefillCreateFromServiceRequest not found');
      return false;
    }
    await dtPrefillCreateFromServiceRequest(request);
    return srSetStatus(request.id, 'acknowledged');
  }

  // Called by dispatch.js once a ticket created from a request is actually
  // saved — stamps the link and moves the request to 'scheduled'.
  async function srLinkTicket(requestId, ticketId){
    if(!(await ensureCloud())) return false;
    try{
      const { error } = await db.from('service_requests')
        .update({ linked_dispatch_ticket_id: ticketId, status: 'scheduled' })
        .eq('id', requestId);
      if(error) throw error;
      return true;
    }catch(e){ console.error('link service request to ticket failed', describeCloudError(e)); return false; }
  }

  // Called by dispatch.js when a linked ticket is marked completed, so the
  // originating request reflects that without admin having to update both.
  async function srMarkCompletedByTicket(ticketId){
    if(!(await ensureCloud())) return false;
    try{
      const { error } = await db.from('service_requests')
        .update({ status: 'completed' })
        .eq('linked_dispatch_ticket_id', ticketId);
      if(error) throw error;
      return true;
    }catch(e){ console.error('complete-sync service request failed', describeCloudError(e)); return false; }
  }

  // ---------- Admin queue screen ----------
  function srStatusLabel(status){
    return { new:'New', acknowledged:'Acknowledged', scheduled:'Scheduled',
      in_progress:'In Progress', completed:'Completed', cancelled:'Cancelled' }[status] || status;
  }
  function srRowHtml(r){
    const cust = (typeof customersCache !== 'undefined' ? customersCache : []).find(c=> String(c.id)===String(r.customerId));
    const custName = cust ? cust.name : ('Customer #'+r.customerId);
    const urgentTag = r.urgency==='urgent' ? ' <span class="status-pill status-sr-urgent">Urgent</span>' : '';
    const canConvert = r.status==='new' || r.status==='acknowledged';
    return (
      '<div class="cp-row" style="align-items:flex-start; cursor:default;" data-req-id="'+r.id+'">'+
        '<div class="cp-row-icon">🛠️</div>'+
        '<div class="cp-row-body">'+
          '<div class="cp-row-title">'+escapeHtml(custName)+urgentTag+'</div>'+
          '<div class="cp-row-sub">'+escapeHtml(r.description||'')+'</div>'+
          '<div class="cp-row-sub">'+escapeHtml(srStatusLabel(r.status))+' · '+escapeHtml(fmtDate(r.createdAt))+'</div>'+
        '</div>'+
        (canConvert ? '<button type="button" class="btn btn-secondary sr-convert-btn" data-req-id="'+r.id+'" style="margin-left:8px;">Convert to Job Order</button>' : '')+
      '</div>'
    );
  }
  async function srRenderQueueList(){
    const list = $('srQueueList');
    if(!list) return;
    const rows = await srListAll();
    if(rows.length===0){ list.innerHTML = '<div class="empty-state">No service requests yet.</div>'; return; }
    list.innerHTML = rows.map(srRowHtml).join('');
    $$('.sr-convert-btn', list).forEach(btn=>{
      btn.onclick = async ()=>{
        const req = rows.find(r=> String(r.id)===btn.dataset.reqId);
        if(!req) return;
        await srConvertToTicket(req);
      };
    });
  }
  async function showServiceRequestsView(){
    document.body.classList.remove('dashboard-active');
    $('homeScreen').style.display = 'none';
    $('serviceReportView').style.display = 'none';
    $('leaveView').style.display = 'none';
    $('cashAdvanceView').style.display = 'none';
    $('dispatchView').style.display = 'none';
    $('dtrView').style.display = 'none';
    $('equipmentManagerView').style.display = 'none';
    $('customersManagerView').style.display = 'none';
    $('serviceReportsManagerView').style.display = 'none';
    $('messagesView').style.display = 'none';
    $('documentsView').style.display = 'none';
    $('customerHistoryView').style.display = 'none';
    $('serviceRequestsView').style.display = '';
    $('footerBar').style.display = 'none';
    $('metaBar').style.display = 'none';
    $('homeBtn').style.display = '';
    setHeaderTitle('Service Requests', 'Customer-filed requests awaiting review');
    window.scrollTo({top:0});
    $('srQueueList').innerHTML = '<div class="empty-state">Loading…</div>';
    // Customer names in the queue rows come from customersCache (customers.js)
    // — make sure it's populated even if admin opened this screen straight
    // from login without visiting Dispatch/Customers first.
    if(typeof customersCache !== 'undefined' && customersCache.length===0 && typeof loadCustomers === 'function'){
      await loadCustomers();
    }
    await srRenderQueueList();
    // No separate realtime channel here — srAdminInit() (called from
    // renderHomeOverview on every dashboard visit) already keeps one open
    // on this same table for the badge/overview count. srRefreshAdminCounts
    // re-renders the queue list too whenever this screen happens to be the
    // one visible, so a second subscription isn't needed.
  }
  if($('sbNavServiceRequests')){
    $('sbNavServiceRequests').addEventListener('click', ()=>{
      if(typeof closeMainMenu === 'function') closeMainMenu();
      if(typeof setSidebarActive === 'function') setSidebarActive('sbNavServiceRequests');
      showServiceRequestsView();
    });
  }
  // Overview stat card (renderHomeOverview, home.js) — same destination as
  // the sidebar item above.
  if($('ovServiceReqCard')){
    $('ovServiceReqCard').addEventListener('click', ()=>{
      if(typeof setSidebarActive === 'function') setSidebarActive('sbNavServiceRequests');
      showServiceRequestsView();
    });
  }

  // ---------- Live badge + Overview stat (admin dashboard) ----------
  let srRealtimeChannel = null;
  let srPollTimer = null;

  async function srRefreshAdminCounts(){
    if(!currentUser || currentUser.role !== 'admin') return;
    const openCount = await srCountOpen();
    // Sidebar badge (admin-only nav item — see index.html sbNavServiceRequests).
    const badge = $('sbServiceRequestsBadge');
    if(badge){
      if(openCount > 0){ badge.textContent = openCount > 99 ? '99+' : String(openCount); badge.style.display = ''; }
      else badge.style.display = 'none';
    }
    // Overview stat card on the admin homepage (renderHomeOverview, home.js)
    // — only touch it if that card is actually on screen right now.
    const statEl = $('ovServiceReqValue');
    if(statEl){
      statEl.textContent = String(openCount);
      const subEl = $('ovServiceReqSub');
      if(subEl) subEl.textContent = openCount===0 ? 'Nothing pending' : openCount+' awaiting review';
    }
    // If the queue screen itself is the one currently on-screen, refresh
    // its list too — keeps a single realtime channel (opened once by
    // srAdminInit below) covering both the badge/overview AND the queue,
    // instead of each screen opening its own subscription to the same table.
    const queueView = $('serviceRequestsView');
    if(queueView && queueView.style.display !== 'none') srRenderQueueList();
    return openCount;
  }

  // Called once when the admin dashboard is shown (renderHomeOverview in
  // home.js). Cheap to call repeatedly — channel/poll are only set up once.
  async function srAdminInit(){
    if(!currentUser || currentUser.role !== 'admin') return 0;
    const openCount = await srRefreshAdminCounts();
    if(!srRealtimeChannel && db){
      srRealtimeChannel = db.channel('service-requests-admin')
        .on('postgres_changes', { event:'*', schema:'public', table:'service_requests' }, ()=> srRefreshAdminCounts())
        .subscribe();
    }
    // Offline-safe fallback, same interval as tracker.js's location poll —
    // catches anything missed if the realtime socket drops silently.
    if(!srPollTimer) srPollTimer = setInterval(srRefreshAdminCounts, 20000);
    return openCount || 0;
  }

  // Called on logout so a signed-out session doesn't keep an open realtime
  // channel or background poll running (mirrors trackerAdminTeardown()).
  function srAdminTeardown(){
    if(srPollTimer){ clearInterval(srPollTimer); srPollTimer = null; }
    if(srRealtimeChannel && db){ try{ db.removeChannel(srRealtimeChannel); }catch(e){} }
    srRealtimeChannel = null;
  }

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

  // Statuses where ADMIN is the one who needs to act next (badge/overview
  // count). Deliberately excludes fee_proposed/schedule_proposed — those
  // are waiting on the customer's response, not admin's — but a cancelled
  // request admin hasn't yet acknowledged still counts, via the separate
  // .or() clause in srCountOpen below.
  const SR_OPEN_STATUSES = ['new', 'acknowledged', 'fee_accepted', 'schedule_confirmed'];

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
      updatedAt: row.updated_at,
      feeAmount: row.fee_amount,
      feeStatus: row.fee_status,
      settlementMethod: row.settlement_method,
      settlementNote: row.settlement_note,
      proposedScheduleDate: row.proposed_schedule_date,
      proposedScheduleTime: row.proposed_schedule_time,
      scheduleConfirmedAt: row.schedule_confirmed_at,
      cancelReason: row.cancel_reason,
      cancelAcknowledged: row.cancel_acknowledged,
      accessGatePass: row.access_gate_pass,
      accessLadder: row.access_ladder,
      accessWorkPermit: row.access_work_permit,
      accessOthers: row.access_others,
      accessOthersDetail: row.access_others_detail,
      contactPerson: row.contact_person,
      contactNumber: row.contact_number,
      // 'customer' (default, submitted via the request form) or
      // 'technician_flag' (created off an issue noted on a completed visit —
      // see 20260912_01_service_requests_origin.sql). Drives the home
      // screen's D1 vs D2/D3 "needs attention" distinction.
      origin: row.origin || 'customer',
      flaggedIssueSummary: row.flagged_issue_summary || ''
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
      const statusList = SR_OPEN_STATUSES.map(s=>'status.eq.'+s).join(',');
      const { count, error } = await db.from('service_requests')
        .select('id', { count:'exact', head:true })
        .or(statusList+',and(status.eq.cancelled,cancel_acknowledged.eq.false)');
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
  async function srCreate({ customerId, equipmentId, description, urgency, requestedDate,
    accessGatePass, accessLadder, accessWorkPermit, accessOthers, accessOthersDetail,
    contactPerson, contactNumber }){
    if(!(await ensureCloud())) return null;
    try{
      const { data, error } = await db.from('service_requests').insert({
        customer_id: customerId,
        equipment_id: equipmentId || null,
        description: description,
        urgency: urgency || 'normal',
        requested_date: requestedDate || null,
        access_gate_pass: !!accessGatePass,
        access_ladder: !!accessLadder,
        access_work_permit: !!accessWorkPermit,
        access_others: !!accessOthers,
        access_others_detail: accessOthersDetail || null,
        contact_person: contactPerson || null,
        contact_number: contactNumber || null
      }).select().single();
      if(error) throw error;
      return srRowToRequest(data);
    }catch(e){ console.error('create service request failed', describeCloudError(e)); return null; }
  }

  // Admin-side insert for an issue noted on a completed visit — this is the
  // stand-in for the not-yet-built service-report "issue flag" field (see
  // 20260912_01_service_requests_origin.sql). Creates a request that starts
  // life as D2 ("quotation being prepared") on the customer's home screen;
  // proposing a fee against it (srProposeFee, already built) is what moves
  // it to D3 ("quotation ready").
  async function srFlagIssue({ customerId, equipmentId, issueSummary }){
    if(!(await ensureCloud())) return null;
    try{
      const { data, error } = await db.from('service_requests').insert({
        customer_id: customerId,
        equipment_id: equipmentId || null,
        description: issueSummary,
        urgency: 'normal',
        origin: 'technician_flag',
        flagged_issue_summary: issueSummary
      }).select().single();
      if(error) throw error;
      return srRowToRequest(data);
    }catch(e){ console.error('flag issue failed', describeCloudError(e)); return null; }
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
  // Opens the pre-filled Create Dispatch Ticket form — does NOT change the
  // request's status itself. In the v2 workflow this is only reachable
  // once a request has already reached 'schedule_confirmed' (see the admin
  // actions in srOpenDetail), so there's nothing to advance here; the
  // actual 'dispatched' transition happens in srLinkTicket below, once the
  // ticket is actually saved. (v1 used to set 'acknowledged' here, back
  // when this was reachable straight from 'new'/'acknowledged' — that
  // would now be a backward step in the wider v2 state machine, so it's
  // gone.)
  async function srConvertToTicket(request){
    if(typeof dtPrefillCreateFromServiceRequest !== 'function'){
      console.error('dispatch.js dtPrefillCreateFromServiceRequest not found');
      return false;
    }
    await dtPrefillCreateFromServiceRequest(request);
    return true;
  }

  // Called by dispatch.js once a ticket created from a request is actually
  // saved — stamps the link and moves the request to 'dispatched'.
  async function srLinkTicket(requestId, ticketId){
    if(!(await ensureCloud())) return false;
    try{
      const { error } = await db.from('service_requests')
        .update({ linked_dispatch_ticket_id: ticketId, status: 'dispatched' })
        .eq('id', requestId);
      if(error) throw error;
      return true;
    }catch(e){ console.error('link service request to ticket failed', describeCloudError(e)); return false; }
  }

  // Called by dispatch.js when a linked ticket is marked completed, so the
  // originating request reflects that without admin having to update both.
  // Goes through the sync_service_request_ticket_status() RPC since this
  // can run inside a TECHNICIAN's session (dtComplete is technicians' own
  // normal flow, not admin-only) — technicians have no UPDATE grant on
  // service_requests at all, only admin does.
  async function srMarkCompletedByTicket(ticketId){
    if(!(await ensureCloud())) return false;
    try{
      const { data, error } = await db.rpc('sync_service_request_ticket_status', { p_ticket_id: ticketId, p_new_status: 'completed' });
      if(error) throw error;
      return !!data;
    }catch(e){ console.error('complete-sync service request failed', describeCloudError(e)); return false; }
  }

  // Called by dispatch.js's dtAcknowledge() when the assigned technician(s)
  // acknowledge a ticket that came from a service request — moves the
  // request from 'dispatched' to 'in_progress' so the customer's homepage
  // progress tracker reflects that work has actually started. Same RPC
  // reasoning as srMarkCompletedByTicket above.
  async function srMarkInProgressByTicket(ticketId){
    if(!(await ensureCloud())) return false;
    try{
      const { data, error } = await db.rpc('sync_service_request_ticket_status', { p_ticket_id: ticketId, p_new_status: 'in_progress' });
      if(error) throw error;
      return !!data;
    }catch(e){ console.error('in-progress-sync service request failed', describeCloudError(e)); return false; }
  }

  // ---------- Fee workflow (admin proposes, customer responds) ----------
  async function srProposeFee(id, amount){
    if(!(await ensureCloud())) return false;
    try{
      const { error } = await db.from('service_requests')
        .update({ fee_amount: amount, fee_status: 'proposed', status: 'fee_proposed' })
        .eq('id', id);
      if(error) throw error;
      return true;
    }catch(e){ console.error('propose fee failed', describeCloudError(e)); return false; }
  }
  // Admin can also acknowledge with no fee — moves straight past the fee
  // step to 'acknowledged', ready for scheduling.
  async function srAcknowledgeNoFee(id){
    return srSetStatus(id, 'acknowledged');
  }
  // Goes through the customer_respond_service_request_fee() RPC — see
  // 20260911_02_service_requests_customer_actions.sql for why: there is no
  // customer UPDATE policy on service_requests, deliberately, since this
  // project's grants are wide open and a blanket policy would let a
  // customer session rewrite any column on their own row, not just these.
  async function srRespondFee(id, accept, settlementMethod, settlementNote){
    if(!(await ensureCloud())) return false;
    try{
      const { data, error } = await db.rpc('customer_respond_service_request_fee', {
        p_request_id: id, p_accept: accept,
        p_settlement_method: settlementMethod||null, p_settlement_note: settlementNote||null
      });
      if(error) throw error;
      return !!data;
    }catch(e){ console.error('respond to fee failed', describeCloudError(e)); return false; }
  }

  // ---------- Schedule workflow (admin proposes, customer confirms) ----------
  async function srProposeSchedule(id, date, time){
    if(!(await ensureCloud())) return false;
    try{
      const { error } = await db.from('service_requests')
        .update({ proposed_schedule_date: date, proposed_schedule_time: time||null, status: 'schedule_proposed' })
        .eq('id', id);
      if(error) throw error;
      return true;
    }catch(e){ console.error('propose schedule failed', describeCloudError(e)); return false; }
  }
  // Goes through the customer_confirm_service_request_schedule() RPC — see
  // srRespondFee's comment above for why (no customer UPDATE policy).
  async function srConfirmSchedule(id){
    if(!(await ensureCloud())) return false;
    try{
      const { data, error } = await db.rpc('customer_confirm_service_request_schedule', { p_request_id: id });
      if(error) throw error;
      return !!data;
    }catch(e){ console.error('confirm schedule failed', describeCloudError(e)); return false; }
  }

  // ---------- Cancellation ----------
  // Customer cancels with a required reason — allowed any time before the
  // job is actually dispatched. Status flips to 'cancelled' immediately;
  // cancel_acknowledged tracks whether admin has since seen it (a soft
  // "seen" flag, not an approval gate — the customer's cancellation takes
  // effect right away).
  // Goes through the customer_cancel_service_request() RPC — see
  // srRespondFee's comment above for why (no customer UPDATE policy).
  async function srCancel(id, reason){
    if(!reason || !reason.trim()) return false;
    if(!(await ensureCloud())) return false;
    try{
      const { data, error } = await db.rpc('customer_cancel_service_request', { p_request_id: id, p_reason: reason.trim() });
      if(error) throw error;
      return !!data;
    }catch(e){ console.error('cancel request failed', describeCloudError(e)); return false; }
  }
  async function srAcknowledgeCancel(id){
    if(!(await ensureCloud())) return false;
    try{
      const { error } = await db.from('service_requests').update({ cancel_acknowledged: true }).eq('id', id);
      if(error) throw error;
      return true;
    }catch(e){ console.error('acknowledge cancel failed', describeCloudError(e)); return false; }
  }
  function srIsCancellable(status){
    return ['new','acknowledged','fee_proposed','fee_accepted','schedule_proposed','schedule_confirmed'].includes(status);
  }

  // ---------- Per-request messaging ----------
  // Mirrors dispatch.js's dtLoadMessages/dtSendMessage pattern exactly,
  // scoped to service_request_messages/request_id instead of
  // dispatch_ticket_messages/ticket_id.
  async function srLoadMessages(requestId){
    if(!(await ensureCloud())) return [];
    try{
      const { data, error } = await db.from('service_request_messages')
        .select('*').eq('request_id', requestId).order('created_at', {ascending:true});
      if(error) throw error;
      return data || [];
    }catch(e){ console.error('load request messages failed', describeCloudError(e)); return []; }
  }
  function srRenderMessages(msgs){
    const list = $('srMsgList');
    if(!list) return;
    if(msgs.length===0){
      list.innerHTML = '<div class="empty-state">No messages yet — ask a question about this request here.</div>';
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
  async function srRefreshMessages(){
    if(!srOverlayRequest) return;
    const msgs = await srLoadMessages(srOverlayRequest.id);
    srRenderMessages(msgs);
  }
  async function srSendMessage(){
    if(!srOverlayRequest || !currentUser) return;
    const input = $('srMsgInput');
    const body = input.value.trim();
    if(!body) return;
    if(!(await ensureCloud())){ toast('This needs a connection — try again when online'); return; }
    $('srMsgSendBtn').disabled = true;
    try{
      const { error } = await db.from('service_request_messages').insert({
        request_id: srOverlayRequest.id, sender_id: currentUser.id,
        sender_name: currentUser.name, sender_role: currentUser.role==='admin' ? 'admin' : 'customer',
        body
      });
      if(error) throw error;
      input.value = '';
      await srRefreshMessages();
    }catch(e){ console.error('send request message failed', describeCloudError(e)); toast('Could not send — try again'); }
    $('srMsgSendBtn').disabled = false;
  }
  $('srMsgSendBtn').addEventListener('click', srSendMessage);
  $('srMsgInput').addEventListener('keydown', (e)=>{
    if(e.key==='Enter' && !e.shiftKey){ e.preventDefault(); srSendMessage(); }
  });

  // ---------- Shared detail overlay (both roles) ----------
  let srOverlayRequest = null;
  let srOverlayMsgChannel = null;

  function srCloseDetail(){
    const overlay = $('srDetailOverlay');
    if(overlay) overlay.classList.remove('open');
    if(srOverlayMsgChannel && db){ try{ db.removeChannel(srOverlayMsgChannel); }catch(e){} }
    srOverlayMsgChannel = null;
    srOverlayRequest = null;
  }
  $('closeSrDetailOverlay').addEventListener('click', srCloseDetail);

  function srAccessSummary(r){
    const items = [];
    if(r.accessGatePass) items.push('Gate Pass');
    if(r.accessLadder) items.push('Ladder');
    if(r.accessWorkPermit) items.push('Work Permit');
    if(r.accessOthers) items.push('Others'+(r.accessOthersDetail ? (' ('+escapeHtml(r.accessOthersDetail)+')') : ''));
    return items.length ? items.join(', ') : '—';
  }
  // Customer-side equipment label — uses cpEquipment (customer-portal.js),
  // which is only ever populated for whichever customer is currently
  // logged into the portal, so this path is only correct when the caller
  // IS that customer. Admin needs srFetchEquipmentLabelForAdmin below
  // instead, since cpEquipment means nothing in an admin session (it's
  // either empty or, worse, whichever customer an admin session happened
  // to view last via some other screen).
  function srEquipmentLabel(r){
    if(!r.equipmentId) return 'General inquiry';
    const eq = (typeof cpEquipment !== 'undefined' ? cpEquipment : []).find(e=> String(e.id)===String(r.equipmentId));
    return eq ? equipDisplayName(eq) : 'Selected equipment';
  }
  // Admin-side equipment label — looks the unit up directly by id rather
  // than relying on any pre-loaded cache, since admin has no reason to
  // have this particular customer's equipment already loaded when opening
  // a request from the queue.
  async function srFetchEquipmentLabelForAdmin(equipmentId){
    if(!equipmentId) return 'General inquiry';
    if(!(await ensureCloud())) return 'Selected equipment';
    try{
      const { data, error } = await db.from('customer_equipment').select('*').eq('id', equipmentId).maybeSingle();
      if(error) throw error;
      return data ? equipDisplayName(equipRowToObj(data)) : 'Selected equipment (no longer listed)';
    }catch(e){ console.error('load equipment label failed', describeCloudError(e)); return 'Selected equipment'; }
  }
  function srBuildSummaryHtml(r, custName, equipmentLabel){
    const rows = [];
    if(custName) rows.push(['Customer', escapeHtml(custName)]);
    rows.push(['Equipment', escapeHtml(equipmentLabel)]);
    rows.push(['Description', escapeHtml(r.description||'')]);
    rows.push(['Urgency', r.urgency==='urgent' ? '<span class="status-pill status-sr-urgent">Urgent</span>' : 'Normal']);
    if(r.requestedDate) rows.push(['Preferred date', fmtDate(r.requestedDate)]);
    rows.push(['Access requirements', srAccessSummary(r)]);
    if(r.contactPerson || r.contactNumber) rows.push(['Site contact', escapeHtml((r.contactPerson||'—')+' · '+(r.contactNumber||'—'))]);
    rows.push(['Filed', fmtDateTime(r.createdAt)]);
    return rows.map(([label,val])=> '<div style="margin-bottom:8px;"><div class="cp-row-sub" style="text-transform:uppercase; font-size:10.5px; letter-spacing:.3px;">'+label+'</div><div style="font-size:13.5px;">'+val+'</div></div>').join('');
  }
  // Horizontal step tracker — same idea for both roles, driven off status.
  // Only shown for statuses that are actually on this line (dispatched ->
  // in_progress -> completed). 'cancelled' is deliberately NOT included:
  // steps.indexOf('cancelled') would be -1, which used to make every
  // segment render as "not done" — an all-gray bar indistinguishable from
  // a request that simply hasn't started yet, instead of communicating
  // that it was cancelled. The status pill above this section already
  // conveys "Cancelled" clearly, so cancelled requests just skip this
  // widget entirely rather than showing a misleading one.
  function srProgressStepsHtml(status){
    const steps = ['dispatched','in_progress','completed'];
    const labels = {dispatched:'Dispatched', in_progress:'In Progress', completed:'Completed'};
    if(!steps.includes(status)) return '';
    const currentIdx = steps.indexOf(status);
    return '<div style="display:flex; align-items:center; gap:6px;">'+steps.map((s,i)=>{
      const done = currentIdx>=0 && i<=currentIdx;
      return '<div style="flex:1; text-align:center;">'+
        '<div style="height:6px; border-radius:3px; background:'+(done?'var(--green)':'var(--border)')+'; margin-bottom:4px;"></div>'+
        '<div style="font-size:10.5px; color:'+(done?'var(--green-dark)':'var(--text-muted)')+';">'+labels[s]+'</div>'+
      '</div>';
    }).join('')+'</div>';
  }

  async function srOpenDetail(request, custNameHint){
    const overlay = $('srDetailOverlay');
    if(!overlay) return;
    srOverlayRequest = request;
    const isAdmin = currentUser && currentUser.role==='admin';
    const custName = custNameHint || (isAdmin && typeof customersCache!=='undefined'
      ? (customersCache.find(c=>String(c.id)===String(request.customerId))||{}).name : null);
    // Equipment label needs a different source per role — see the two
    // functions' own comments for why cpEquipment can't be reused for admin.
    const equipmentLabel = isAdmin
      ? await srFetchEquipmentLabelForAdmin(request.equipmentId)
      : srEquipmentLabel(request);

    $('srDetailTitle').textContent = 'Service Request';
    $('srDetailStatusWrap').innerHTML = '<span class="status-pill '+ (typeof cpReqStatusPillClass==='function' ? cpReqStatusPillClass(request) : '') +'">'+escapeHtml(srStatusLabel(request.status))+'</span>';
    $('srDetailSummary').innerHTML = srBuildSummaryHtml(request, custName, equipmentLabel);

    // Fee section
    const feeEl = $('srDetailFeeSection');
    if(request.feeStatus){
      let html = '<div class="field"><label>Fee</label><div style="font-size:14px; font-weight:700;">₱'+Number(request.feeAmount||0).toLocaleString()+'</div>';
      html += '<div class="cp-row-sub">Status: '+escapeHtml(request.feeStatus)+'</div>';
      if(request.settlementMethod) html += '<div class="cp-row-sub">Settlement: '+escapeHtml(request.settlementMethod)+(request.settlementNote?(' — '+escapeHtml(request.settlementNote)):'')+'</div>';
      // Gated on status too, not just feeStatus — feeStatus stays
      // 'proposed' forever if the customer cancels before responding
      // (srCancel only touches status/cancel_reason), so checking
      // feeStatus alone would let them "accept" a fee on an already-
      // cancelled request.
      if(!isAdmin && request.status==='fee_proposed' && request.feeStatus==='proposed'){
        html += '<div style="margin-top:10px;">'+
          '<select id="srFeeSettlementMethod" style="margin-bottom:8px;"><option value="Cash">Cash on-site</option><option value="Bank Transfer">Bank Transfer</option><option value="GCash">GCash</option><option value="Other">Other</option></select>'+
          '<textarea id="srFeeSettlementNote" rows="2" placeholder="Optional note (e.g. reference number)"></textarea>'+
          '<div style="display:flex; gap:8px; margin-top:8px;">'+
            '<button type="button" class="btn btn-primary" id="srFeeAcceptBtn" style="flex:1;">Accept Fee</button>'+
            '<button type="button" class="btn btn-secondary" id="srFeeDeclineBtn" style="flex:1;">Decline</button>'+
          '</div></div>';
      }
      html += '</div>';
      feeEl.innerHTML = html; feeEl.style.display = '';
      if(!isAdmin && request.status==='fee_proposed' && request.feeStatus==='proposed'){
        $('srFeeAcceptBtn').onclick = async ()=>{
          const ok = await srRespondFee(request.id, true, $('srFeeSettlementMethod').value, $('srFeeSettlementNote').value.trim());
          if(ok){
            toast('Fee accepted'); srCloseDetail();
            if(typeof cpRenderMyRequests==='function') cpRenderMyRequests(currentUser.customerId);
            if(typeof cpRefreshRequestsBadge==='function') cpRefreshRequestsBadge(currentUser.customerId);
          } else toast('Could not send response — try again');
        };
        $('srFeeDeclineBtn').onclick = async ()=>{
          const ok = await srRespondFee(request.id, false);
          if(ok){
            toast('Fee declined — message us if you\'d like to discuss'); srCloseDetail();
            if(typeof cpRenderMyRequests==='function') cpRenderMyRequests(currentUser.customerId);
            if(typeof cpRefreshRequestsBadge==='function') cpRefreshRequestsBadge(currentUser.customerId);
          } else toast('Could not send response — try again');
        };
      }
    } else { feeEl.style.display = 'none'; feeEl.innerHTML=''; }

    // Schedule section
    const schedEl = $('srDetailScheduleSection');
    if(request.proposedScheduleDate){
      let html = '<div class="field"><label>Proposed Schedule</label><div style="font-size:14px; font-weight:700;">'+fmtDate(request.proposedScheduleDate)+(request.proposedScheduleTime?(' · '+escapeHtml(request.proposedScheduleTime)):'')+'</div>';
      if(request.status==='schedule_confirmed' || request.scheduleConfirmedAt){
        html += '<div class="cp-row-sub">Confirmed by customer'+(request.scheduleConfirmedAt?(' · '+fmtDateTime(request.scheduleConfirmedAt)):'')+'</div>';
      } else if(!isAdmin && request.status==='schedule_proposed'){
        html += '<button type="button" class="btn btn-primary" id="srScheduleConfirmBtn" style="margin-top:8px; width:100%;">Confirm This Schedule</button>';
      }
      html += '</div>';
      schedEl.innerHTML = html; schedEl.style.display = '';
      if(!isAdmin && request.status==='schedule_proposed'){
        $('srScheduleConfirmBtn').onclick = async ()=>{
          const ok = await srConfirmSchedule(request.id);
          if(ok){
            toast('Schedule confirmed'); srCloseDetail();
            if(typeof cpRenderMyRequests==='function') cpRenderMyRequests(currentUser.customerId);
            if(typeof cpRefreshRequestsBadge==='function') cpRefreshRequestsBadge(currentUser.customerId);
          } else toast('Could not confirm — try again');
        };
      }
    } else { schedEl.style.display = 'none'; schedEl.innerHTML=''; }

    // Progress tracker
    const progEl = $('srDetailProgressSection');
    const progHtml = srProgressStepsHtml(request.status);
    if(progHtml){ progEl.innerHTML = '<div class="field"><label>Progress</label>'+progHtml+'</div>'; progEl.style.display=''; }
    else { progEl.style.display='none'; progEl.innerHTML=''; }

    // Admin actions
    const adminEl = $('srDetailAdminActions');
    if(isAdmin){
      // Build just the action content first (no wrapper yet) so we can
      // tell afterward whether any status branch actually matched. Some
      // statuses (dispatched, in_progress, completed, or an already-
      // acknowledged cancellation) have nothing for admin to do here —
      // for those we hide the whole section instead of showing an empty
      // "Admin Actions" box with no buttons in it.
      let actionsHtml = '';
      // Fee proposal — also reachable after a decline (status stays
      // 'fee_proposed' with fee_status:'declined' — see srRespondFee),
      // otherwise a declined fee would be a dead end with no way for
      // admin to come back with a different amount (or waive it outright).
      if(request.status==='new' || (request.status==='fee_proposed' && request.feeStatus==='declined')){
        actionsHtml += '<div style="margin-bottom:10px;">'+
          '<input type="number" id="srAdminFeeAmount" placeholder="Fee amount (₱)" style="margin-bottom:6px;">'+
          '<button type="button" class="btn btn-primary" id="srAdminProposeFeeBtn" style="width:100%; margin-bottom:6px;">'+(request.feeStatus==='declined' ? 'Propose New Fee' : 'Propose Fee')+'</button>'+
          '<button type="button" class="btn btn-secondary" id="srAdminNoFeeBtn" style="width:100%;">No Fee — Acknowledge</button>'+
        '</div>';
      }
      if(request.status==='acknowledged' || request.status==='fee_accepted'){
        actionsHtml += '<div style="margin-bottom:10px;">'+
          '<input type="date" id="srAdminScheduleDate" style="margin-bottom:6px;">'+
          '<input type="text" id="srAdminScheduleTime" placeholder="Time (e.g. 2:00 PM)" style="margin-bottom:6px;">'+
          '<button type="button" class="btn btn-primary" id="srAdminProposeScheduleBtn" style="width:100%;">Propose Schedule</button>'+
        '</div>';
      }
      if(request.status==='schedule_confirmed'){
        actionsHtml += '<button type="button" class="btn btn-primary" id="srAdminConvertBtn" style="width:100%; margin-bottom:6px;">Create Dispatch Ticket</button>';
      }
      if(request.status==='cancelled' && !request.cancelAcknowledged){
        actionsHtml += '<div class="cp-row-sub" style="margin-bottom:6px;">Cancellation reason: '+escapeHtml(request.cancelReason||'—')+'</div>'+
          '<button type="button" class="btn btn-secondary" id="srAdminAckCancelBtn" style="width:100%;">Acknowledge Cancellation</button>';
      }
      if(actionsHtml){
        adminEl.innerHTML = '<div class="field"><label>Admin Actions</label>'+actionsHtml+'</div>';
        adminEl.style.display = '';
      } else {
        adminEl.innerHTML = '';
        adminEl.style.display = 'none';
      }
      if($('srAdminProposeFeeBtn')) $('srAdminProposeFeeBtn').onclick = async ()=>{
        const amt = parseFloat($('srAdminFeeAmount').value);
        if(!amt || amt<=0){ toast('Enter a valid fee amount'); return; }
        const ok = await srProposeFee(request.id, amt);
        if(ok){ toast('Fee proposed'); srCloseDetail(); srRenderQueueList(); } else toast('Could not save — try again');
      };
      if($('srAdminNoFeeBtn')) $('srAdminNoFeeBtn').onclick = async ()=>{
        const ok = await srAcknowledgeNoFee(request.id);
        if(ok){ toast('Acknowledged'); srCloseDetail(); srRenderQueueList(); } else toast('Could not save — try again');
      };
      if($('srAdminProposeScheduleBtn')) $('srAdminProposeScheduleBtn').onclick = async ()=>{
        const date = $('srAdminScheduleDate').value;
        if(!date){ toast('Pick a date'); return; }
        const ok = await srProposeSchedule(request.id, date, $('srAdminScheduleTime').value.trim());
        if(ok){ toast('Schedule proposed'); srCloseDetail(); srRenderQueueList(); } else toast('Could not save — try again');
      };
      if($('srAdminConvertBtn')) $('srAdminConvertBtn').onclick = async ()=>{
        srCloseDetail();
        await srConvertToTicket(request);
      };
      if($('srAdminAckCancelBtn')) $('srAdminAckCancelBtn').onclick = async ()=>{
        const ok = await srAcknowledgeCancel(request.id);
        if(ok){ toast('Acknowledged'); srCloseDetail(); srRenderQueueList(); } else toast('Could not save — try again');
      };
    } else { adminEl.style.display = 'none'; adminEl.innerHTML = ''; }

    // Cancel (customer-only)
    const cancelEl = $('srDetailCancelSection');
    if(!isAdmin && srIsCancellable(request.status)){
      cancelEl.innerHTML = '<div class="field"><label>Change of mind?</label>'+
        '<textarea id="srCancelReason" rows="2" placeholder="Let us know why you\'re cancelling…"></textarea>'+
        '<button type="button" class="btn btn-secondary" id="srCancelSubmitBtn" style="width:100%; margin-top:8px; color:var(--danger);">Cancel This Request</button>'+
      '</div>';
      cancelEl.style.display = '';
      $('srCancelSubmitBtn').onclick = async ()=>{
        const reason = $('srCancelReason').value.trim();
        if(!reason){ toast('Please tell us why, so we can note it'); return; }
        const ok = await srCancel(request.id, reason);
        if(ok){ toast('Request cancelled'); srCloseDetail(); if(typeof cpRenderMyRequests==='function') cpRenderMyRequests(currentUser.customerId); if(typeof cpRefreshRequestsBadge==='function') cpRefreshRequestsBadge(currentUser.customerId); }
        else toast('Could not cancel — try again');
      };
    } else { cancelEl.style.display = 'none'; cancelEl.innerHTML = ''; }

    // Messages
    $('srMsgList').innerHTML = '<div class="empty-state">Loading…</div>';
    await srRefreshMessages();
    if(srOverlayMsgChannel && db){ try{ db.removeChannel(srOverlayMsgChannel); }catch(e){} }
    if(db){
      srOverlayMsgChannel = db.channel('sr-messages-'+request.id)
        .on('postgres_changes', { event:'INSERT', schema:'public', table:'service_request_messages', filter:'request_id=eq.'+request.id }, ()=> srRefreshMessages())
        .subscribe();
    }

    overlay.classList.add('open');
  }

  // ---------- Admin queue screen ----------
  function srStatusLabel(status){
    return { new:'New', acknowledged:'Acknowledged', fee_proposed:'Fee Proposed',
      fee_accepted:'Fee Accepted', schedule_proposed:'Schedule Proposed',
      schedule_confirmed:'Schedule Confirmed', dispatched:'Dispatched',
      in_progress:'In Progress', completed:'Completed', cancelled:'Cancelled' }[status] || status;
  }
  function srRowHtml(r){
    const cust = (typeof customersCache !== 'undefined' ? customersCache : []).find(c=> String(c.id)===String(r.customerId));
    const custName = cust ? cust.name : ('Customer #'+r.customerId);
    const urgentTag = r.urgency==='urgent' ? ' <span class="status-pill status-sr-urgent">Urgent</span>' : '';
    // Dispatch-ticket creation is only offered once the customer has
    // confirmed a proposed schedule (see the v2 workflow comment on
    // srConvertToTicket above) — everything before that (proposing a fee,
    // proposing a schedule, acknowledging a cancellation) lives inside the
    // detail overlay instead of as a quick action here, since each of
    // those needs its own input (an amount, a date) rather than a single
    // tap.
    const canConvert = r.status==='schedule_confirmed';
    return (
      '<div class="cp-row" style="align-items:flex-start;" data-req-id="'+r.id+'">'+
        '<div class="cp-row-icon">🛠️</div>'+
        '<div class="cp-row-body">'+
          '<div class="cp-row-title">'+escapeHtml(custName)+urgentTag+'</div>'+
          '<div class="cp-row-sub">'+escapeHtml(r.description||'')+'</div>'+
          '<div class="cp-row-sub">'+escapeHtml(srStatusLabel(r.status))+' · '+escapeHtml(fmtDateTime(r.createdAt))+'</div>'+
        '</div>'+
        (canConvert ? '<button type="button" class="btn btn-secondary sr-convert-btn" data-req-id="'+r.id+'" style="margin-left:8px;">Create Ticket</button>' : '')+
      '</div>'
    );
  }
  async function srRenderQueueList(){
    const list = $('srQueueList');
    if(!list) return;
    const rows = await srListAll();
    if(rows.length===0){ list.innerHTML = '<div class="empty-state">No service requests yet.</div>'; return; }
    list.innerHTML = rows.map(srRowHtml).join('');
    $$('.cp-row', list).forEach(row=>{
      row.style.cursor = 'pointer';
      row.onclick = ()=>{
        const req = rows.find(r=> String(r.id)===row.dataset.reqId);
        if(req) srOpenDetail(req);
      };
    });
    $$('.sr-convert-btn', list).forEach(btn=>{
      btn.onclick = async (e)=>{
        e.stopPropagation(); // don't also trigger the row's own click-to-open-detail
        const req = rows.find(r=> String(r.id)===btn.dataset.reqId);
        if(!req) return;
        await srConvertToTicket(req);
      };
    });
  }
  $('srFlagToggleBtn').addEventListener('click', ()=>{
    const body = $('srFlagFormBody');
    const opening = body.style.display === 'none';
    body.style.display = opening ? '' : 'none';
    if(opening && typeof customersCache !== 'undefined'){
      $('srFlagCustomer').innerHTML = '<option value="">Select customer…</option>' +
        customersCache.slice().sort((a,b)=> (a.name||'').localeCompare(b.name||''))
          .map(c=> '<option value="'+c.id+'">'+escapeHtml(c.name||'')+'</option>').join('');
    }
  });
  $('srFlagCustomer').addEventListener('change', async function(){
    const sel = $('srFlagEquipment');
    sel.innerHTML = '<option value="">Not tied to a specific unit</option>';
    const customerId = this.value;
    if(!customerId || !(await ensureCloud())) return;
    try{
      const { data, error } = await db.from('customer_equipment').select('id, equip_type, equip_location').eq('customer_id', customerId);
      if(error) throw error;
      (data||[]).forEach(eq=>{
        const label = [eq.equip_type, eq.equip_location].filter(Boolean).join(' — ') || ('Unit '+eq.id);
        sel.innerHTML += '<option value="'+eq.id+'">'+escapeHtml(label)+'</option>';
      });
    }catch(e){ console.error('load equipment for flag form failed', describeCloudError(e)); }
  });
  $('srFlagSubmitBtn').addEventListener('click', async ()=>{
    const customerId = $('srFlagCustomer').value;
    const issueSummary = $('srFlagSummary').value.trim();
    if(!customerId){ toast('Select a customer'); return; }
    if(!issueSummary){ toast('Describe what was found'); return; }
    $('srFlagSubmitBtn').disabled = true; $('srFlagSubmitBtn').textContent = 'Creating…';
    const result = await srFlagIssue({ customerId, equipmentId: $('srFlagEquipment').value || null, issueSummary });
    $('srFlagSubmitBtn').disabled = false; $('srFlagSubmitBtn').textContent = 'Create Flagged Request';
    if(!result){ toast('Could not create — check your connection'); return; }
    toast('Flagged request created — the customer will see it on their home screen');
    $('srFlagSummary').value = '';
    $('srFlagEquipment').innerHTML = '<option value="">Not tied to a specific unit</option>';
    $('srFlagCustomer').value = '';
    $('srFlagFormBody').style.display = 'none';
    srRenderQueueList();
  });

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
    // Also close the detail overlay if it happened to be open — otherwise
    // its own message-thread channel (srOverlayMsgChannel) would keep
    // running past logout too.
    srCloseDetail();
  }

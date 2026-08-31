// ---------- Header title (changes per feature page) ----------
  function setHeaderTitle(title, sub){
    $('brandName').textContent = title;
    $('brandSub').textContent = sub || '';
  }

  async function showDtrView(){
    document.body.classList.remove('dashboard-active');
    $('homeScreen').style.display = 'none';
    $('serviceReportView').style.display = 'none';
    $('leaveView').style.display = 'none';
    $('cashAdvanceView').style.display = 'none';
    $('dispatchView').style.display = 'none';
    $('equipmentManagerView').style.display = 'none';
    $('customersManagerView').style.display = 'none';
    $('serviceReportsManagerView').style.display = 'none';
    $('messagesView').style.display = 'none';
    $('documentsView').style.display = 'none';
    $('dtrView').style.display = '';
    $('footerBar').style.display = 'none';
    $('metaBar').style.display = 'none';
    $('homeBtn').style.display = '';
    setHeaderTitle('Online DTR', 'Daily Time Record');
    window.scrollTo({top:0});
    if(currentUser && currentUser.role==='admin'){
      // Admin has no DTR of their own — DTR is per-technician. Land on the
      // attendance table (today's status for everyone); "View DTR" on a
      // row drills into that one technician's read-only history below.
      $('dtrTechCard').style.display = 'none';
      $('dtrAdminTableCard').style.display = '';
      $('dtrAdminViewingCard').style.display = 'none';
      $('dtrHistoryCard').style.display = 'none';
      dtrViewingUser = null;
      $('dtrHistoryList').innerHTML = '<div class="empty-state">Select a technician to view their DTR.</div>';
      dtrRenderAdminTable();
    }else if(currentUser){
      $('dtrTechCard').style.display = '';
      $('dtrAdminTableCard').style.display = 'none';
      $('dtrAdminViewingCard').style.display = 'none';
      $('dtrHistoryCard').style.display = '';
      $('dtrTechName').textContent = currentUser.name;
      dtrViewingUser = null;
      await dtrRenderDeviceBanner();
      await dtrRenderTodayStatus();
      await dtrRenderHistory();
    }
  }

  // ---------- Manage Equipment List — full page (admin-only), reached via
  // the "Equipment" sidebar nav item. Was previously a popup sheet; now its
  // own dedicated page, same pattern as the other full-page views above. ----------
  async function showEquipmentManagerView(){
    document.body.classList.remove('dashboard-active');
    $('homeScreen').style.display = 'none';
    $('serviceReportView').style.display = 'none';
    $('leaveView').style.display = 'none';
    $('cashAdvanceView').style.display = 'none';
    $('dispatchView').style.display = 'none';
    $('dtrView').style.display = 'none';
    $('equipmentManagerView').style.display = '';
    $('customersManagerView').style.display = 'none';
    $('serviceReportsManagerView').style.display = 'none';
    $('messagesView').style.display = 'none';
    $('documentsView').style.display = 'none';
    $('footerBar').style.display = 'none';
    $('metaBar').style.display = 'none';
    $('homeBtn').style.display = '';
    setHeaderTitle('Equipment', 'Manage Equipment List');
    window.scrollTo({top:0});
    await openEquipmentManagerPage();
  }
  $('menuManageEquipment').addEventListener('click', async ()=>{
    closeMainMenu();
    setSidebarActive('menuManageEquipment');
    if(!(await ensureAdminAuthenticated())) return;
    showEquipmentManagerView();
  });

  // ---------- Manage Customers — full page (admin-only), reached via the
  // "Customers" sidebar nav item. Was previously a popup sheet; now its own
  // dedicated page, same pattern as the other full-page views above. ----------
  async function showCustomersManagerView(){
    document.body.classList.remove('dashboard-active');
    $('homeScreen').style.display = 'none';
    $('serviceReportView').style.display = 'none';
    $('leaveView').style.display = 'none';
    $('cashAdvanceView').style.display = 'none';
    $('dispatchView').style.display = 'none';
    $('dtrView').style.display = 'none';
    $('equipmentManagerView').style.display = 'none';
    $('customersManagerView').style.display = '';
    $('serviceReportsManagerView').style.display = 'none';
    $('messagesView').style.display = 'none';
    $('documentsView').style.display = 'none';
    $('footerBar').style.display = 'none';
    $('metaBar').style.display = 'none';
    $('homeBtn').style.display = '';
    setHeaderTitle('Customers', 'Manage Customers');
    window.scrollTo({top:0});
    await openCustomersManagerPage();
  }

  // ---------- Manage Service Reports — full page (admin-only), reached via
  // the "Service Reports" sidebar nav item. Was previously the "Saved
  // Reports" popup sheet; now its own dedicated page with All / Draft /
  // Completed tabs and a search bar. ----------
  async function showServiceReportsManagerView(){
    document.body.classList.remove('dashboard-active');
    $('homeScreen').style.display = 'none';
    $('serviceReportView').style.display = 'none';
    $('leaveView').style.display = 'none';
    $('cashAdvanceView').style.display = 'none';
    $('dispatchView').style.display = 'none';
    $('dtrView').style.display = 'none';
    $('equipmentManagerView').style.display = 'none';
    $('customersManagerView').style.display = 'none';
    $('serviceReportsManagerView').style.display = '';
    $('messagesView').style.display = 'none';
    $('documentsView').style.display = 'none';
    $('footerBar').style.display = 'none';
    $('metaBar').style.display = 'none';
    $('homeBtn').style.display = '';
    setHeaderTitle('Service Reports', 'Saved Reports');
    window.scrollTo({top:0});
    await openServiceReportsManagerPage();
  }

  // ---------- Home screen greeting (technicians only) ----------
  async function renderHomeGreeting(){
    const card = $('homeGreetingCard');
    if(!currentUser || currentUser.role==='admin'){ card.style.display = 'none'; return; }
    card.style.display = '';
    $('homeGreetingText').innerHTML = '<div class="empty-state">Loading…</div>';

    const now = new Date();
    const dateStr = now.toLocaleDateString('en-PH', {weekday:'long', year:'numeric', month:'long', day:'numeric'});
    const timeStr = now.toLocaleTimeString('en-PH', {hour:'2-digit', minute:'2-digit'});
    const todayDtr = await dtrGetDay(currentUser.id, todayISO()).catch(()=>null);
    const alreadyTimedIn = !!(todayDtr && todayDtr.timeIn);

    let html =
      '<p class="greet-line">Good day, <b>'+escapeHtml(currentUser.name)+'</b>!</p>'+
      '<p class="greet-date">Today is '+dateStr+', '+timeStr+'.</p>';
    if(!alreadyTimedIn){
      html += '<div class="greet-reminder">⏰ Don\'t forget to tap "Time-In" to officially register your attendance.</div>';
    }
    html += '<p class="greet-thanks">Thank you!</p>';
    $('homeGreetingText').innerHTML = html;
  }

  // ---------- Home screen overview (technician only) ----------
  // Same visual language as the admin Overview below, scoped to just this
  // technician's own numbers. Job Order's subtitle lists whichever teammates
  // share at least one of this technician's own open tickets — pulled from
  // assignedWorkerNames on those tickets, not a separate lookup.
  async function renderHomeTechOverview(){
    const card = $('homeTechOverviewCard');
    if(!currentUser || currentUser.role==='admin'){ card.style.display = 'none'; return; }
    card.style.display = '';

    const [tickets, reports, cashAdvances, leaves, todayDtr, unreadCount] = await Promise.all([
      dtListForWorker(currentUser.id).catch(()=>[]),
      cloudListReports().catch(()=>null),
      caListForUser(currentUser.id).catch(()=>[]),
      leaveListForUser(currentUser.id).catch(()=>[]),
      dtrGetDay(currentUser.id, todayISO()).catch(()=>null),
      dtCountUnreadMessages().catch(()=>0)
    ]);

    // Job Order — open tickets (not yet Completed or Closed), plus whichever
    // teammates are on those same tickets with me.
    const openTickets = (tickets||[]).filter(t=> !['completed','closed'].includes(dtEffectiveStatus(t)));
    const mateNames = new Set();
    openTickets.forEach(t=> (t.assignedWorkerNames||[]).forEach(n=>{
      if(n && n!==currentUser.name) mateNames.add(n);
    }));
    $('ovMyJoValue').textContent = String(openTickets.length);
    $('ovMyJoSub').textContent = openTickets.length===0
      ? 'No open job orders'
      : (mateNames.size>0 ? ('With '+Array.from(mateNames).join(', ')) : 'Solo assignment');

    // Pending Service Reports — my own drafts not yet completed.
    const draftReportCount = reports===null ? 0 : reports.filter(r=> r.technicianId===currentUser.id && !r.completed).length;
    $('ovMyReportsValue').textContent = String(draftReportCount);
    $('ovMyReportsSub').textContent = draftReportCount+' Saved Report'+(draftReportCount===1?'':'s')+' to Complete';

    // Pending Requisitions — my own Cash Advance / Leave requests still
    // awaiting an admin decision (separate from Liquidation below).
    const pendingCA = (cashAdvances||[]).filter(r=> r.status==='pending').length;
    const pendingLeave = (leaves||[]).filter(r=> r.status==='pending').length;
    $('ovMyReqValue').textContent = String(pendingCA+pendingLeave);
    $('ovMyReqSub').textContent = pendingCA+' Cash Advance'+(pendingCA===1?'':'s')+' · '+pendingLeave+' Leave Form'+(pendingLeave===1?'':'s');

    // Pending Liquidation — my own approved Cash Advances still needing one.
    const liqCount = (cashAdvances||[]).filter(caNeedsLiquidation).length;
    $('ovMyLiqValue').textContent = String(liqCount);
    $('ovMyLiqSub').textContent = liqCount===0 ? 'Nothing to liquidate' : liqCount+' Cash Advance'+(liqCount===1?'':'s')+' to Liquidate';

    // Today's Attendance — straight from Online DTR, no separate storage.
    if(todayDtr && todayDtr.timeIn){
      const inTime = new Date(todayDtr.timeIn);
      const endTime = todayDtr.timeOut ? new Date(todayDtr.timeOut) : new Date();
      const mins = Math.max(0, Math.round((endTime-inTime)/60000));
      const hrs = Math.floor(mins/60), rem = mins%60;
      $('ovMyDtrValue').textContent = inTime.toLocaleTimeString('en-PH', {hour:'2-digit', minute:'2-digit'});
      $('ovMyDtrSub').textContent = todayDtr.timeOut
        ? ('Timed out — worked '+hrs+'h '+rem+'m')
        : (hrs+'h '+rem+'m so far today');
    }else{
      $('ovMyDtrValue').textContent = '—';
      $('ovMyDtrSub').textContent = 'Not timed in yet';
    }

    // Next Job Order — the soonest-dated open ticket, so a technician sees
    // what's coming up without opening My Job Order and scanning the list.
    const nextJo = openTickets.filter(t=>t.date).slice()
      .sort((a,b)=> a.date.localeCompare(b.date) || (a.expectedTime||'').localeCompare(b.expectedTime||''))[0];
    if(nextJo){
      $('ovMyNextJoValue').textContent = nextJo.jobOrderNo || nextJo.id;
      $('ovMyNextJoSub').textContent = (nextJo.custName||'')+' — '+leaveFmtDate(nextJo.date)+(nextJo.expectedTime ? (' at '+nextJo.expectedTime) : '');
    }else{
      $('ovMyNextJoValue').textContent = '—';
      $('ovMyNextJoSub').textContent = 'Nothing scheduled';
    }

    // Completed This Month — a light productivity snapshot, from tickets I
    // marked Completed or Closed with a timestamp falling in the current
    // calendar month (falls back to the ticket's own date for older records
    // saved before completedAt/closedAt existed).
    const monthPrefix = todayISO().slice(0,7);
    const doneThisMonth = (tickets||[]).filter(t=>{
      if(t.status!=='completed' && t.status!=='closed') return false;
      const stamp = t.closedAt || t.completedAt || t.date || '';
      return stamp.slice(0,7)===monthPrefix;
    }).length;
    $('ovMyDoneValue').textContent = String(doneThisMonth);
    $('ovMyDoneSub').textContent = doneThisMonth+' Job Order'+(doneThisMonth===1?'':'s')+' finished this month';

    // Job Order Messages — unread count across every ticket's inquiry
    // thread (see dtCountUnreadMessages in dispatch.js). Device-local read
    // tracking, so this can differ across a technician's own phone/tablet.
    $('ovMyUnreadValue').textContent = String(unreadCount);
    $('ovMyUnreadSub').textContent = unreadCount===0 ? 'No unread messages' : unreadCount+' new message'+(unreadCount===1?'':'s')+' on your Job Orders';

    // Leave Days Used (This Year) — approved leave days so far this
    // calendar year. Deliberately labeled "Used", not "Balance" — the app
    // doesn't track an annual leave allotment/credit anywhere, so a true
    // remaining-balance figure isn't something this can honestly show yet.
    const yearPrefix = todayISO().slice(0,4);
    const leaveDaysUsed = (leaves||[])
      .filter(r=> r.status==='approved' && (r.dateFrom||'').slice(0,4)===yearPrefix)
      .reduce((sum,r)=> sum+(r.days||0), 0);
    $('ovMyLeaveValue').textContent = String(leaveDaysUsed);
    $('ovMyLeaveSub').textContent = leaveDaysUsed+' approved leave day'+(leaveDaysUsed===1?'':'s')+' taken in '+yearPrefix;

    // The dashboard top bar's greeting + notification bell are shared with
    // admin (see renderDashboardGreeting/renderHomeOverview) — technicians
    // get the same greeting, and their bell reflects their own unread Job
    // Order messages instead of admin's pending-approvals count.
    renderDashboardGreeting();
    const notifEl = $('notifBadge');
    if(notifEl){
      notifEl.textContent = unreadCount > 99 ? '99+' : String(unreadCount);
      notifEl.style.display = unreadCount > 0 ? '' : 'none';
    }
    const sidebarBadgeEl = $('sidebarMsgBadge');
    if(sidebarBadgeEl){ sidebarBadgeEl.style.display = unreadCount>0 ? '' : 'none'; sidebarBadgeEl.textContent = String(unreadCount); }
  }

  // ---------- Home screen overview (admin only) ----------
  // A management snapshot shown above the feature tiles once logged in as
  // admin — technician check-ins, requests awaiting a decision, dispatch
  // ticket load, and reports still short of a customer sign-off. Every
  // number here is a best-effort read of data other screens already own
  // (DTR, Cash Advance, Leave, Dispatch, Service Reports); nothing new is
  // stored just for this panel.
  async function renderHomeOverview(){
    const card = $('homeOverviewCard');
    if(!currentUser || currentUser.role!=='admin'){
      card.style.display = 'none';
      const trackerCard = $('homeTrackerCard');
      if(trackerCard) trackerCard.style.display = 'none';
      const actCard = $('homeActivityCard');
      if(actCard) actCard.style.display = 'none';
      return;
    }
    card.style.display = '';
    renderDashboardGreeting();

    const [users, dtrToday, tickets, cashAdvances, leaves, reports] = await Promise.all([
      cloudListUsers().catch(()=>[]),
      dtrListAllForDate(todayISO()).catch(()=>[]),
      dtListAll().catch(()=>[]),
      caListAll().catch(()=>[]),
      leaveListAll().catch(()=>[]),
      (async ()=>{
        // Mirrors loadHistory()'s cloud-first / local-fallback read, without
        // scoping to one technician's device-only drafts.
        if(await ensureCloud()){
          const cloudRows = await cloudListReports().catch(()=>null);
          if(cloudRows) return cloudRows;
        }
        const out = [];
        try{
          const res = await window.storage.list('report:', false);
          for(const key of (res.keys||[])){
            try{ const item = await window.storage.get(key, false); out.push(JSON.parse(item.value)); }catch(e){}
          }
        }catch(e){}
        return out;
      })()
    ]);

    // Active Technicians — how many of today's active roster have clocked in.
    const activeUsers = (users||[]).filter(u=> u.active!==false);
    const checkedInIds = new Set((dtrToday||[]).filter(d=> d && d.timeIn).map(d=> d.technicianId));
    const totalTech = activeUsers.length;
    const checkedInCount = activeUsers.filter(u=> checkedInIds.has(u.id)).length;
    const pct = totalTech>0 ? Math.round((checkedInCount/totalTech)*100) : 0;
    $('ovTechValue').textContent = checkedInCount+' / '+totalTech;
    $('ovTechBar').style.width = pct+'%';
    $('ovTechSub').textContent = pct+'% Check-in Rate (from Online DTR)';

    // Pending Requisitions — Cash Advance / Leave requests awaiting a decision.
    const pendingCA = (cashAdvances||[]).filter(r=> r.status==='pending').length;
    const pendingLeave = (leaves||[]).filter(r=> r.status==='pending').length;
    $('ovReqValue').textContent = String(pendingCA+pendingLeave);
    $('ovReqSub').textContent = pendingCA+' Cash Advance'+(pendingCA===1?'':'s')+' · '+pendingLeave+' Leave Form'+(pendingLeave===1?'':'s');

    // Dispatch Status — open tickets, split into assigned/unassigned.
    const openTickets = (tickets||[]).filter(t=> t.status!=='completed');
    const unassigned = openTickets.filter(t=> !(t.assignedWorkerIds && t.assignedWorkerIds.length)).length;
    const inProgress = openTickets.length - unassigned;
    $('ovDispatchValue').textContent = String(openTickets.length);
    $('ovDispatchSub').textContent = inProgress+' In Progress · '+unassigned+' Unassigned';

    // Unreviewed Reports — completed drafts still waiting to be finished
    // (which is where the customer's acknowledgment sign-off happens).
    const draftReports = (reports||[]).filter(r=> !r.completed).length;
    $('ovReportsValue').textContent = String(draftReports);
    $('ovReportsSub').textContent = draftReports+' Service Report'+(draftReports===1?'':'s')+' Pending Sign-off';

    // Notification bell in the dashboard top bar — total items anywhere in
    // the app that are waiting on an admin decision or sign-off.
    const notifTotal = pendingCA + pendingLeave + draftReports;
    const notifEl = $('notifBadge');
    if(notifEl){
      notifEl.textContent = notifTotal > 99 ? '99+' : String(notifTotal);
      notifEl.style.display = notifTotal > 0 ? '' : 'none';
    }

    // Live map of every technician currently sharing a location — see tracker.js.
    trackerAdminInit();
    const actCard = $('homeActivityCard');
    if(actCard){ actCard.style.display = ''; renderRecentActivity(cashAdvances, leaves, tickets); }
  }

  // ---------- Dashboard top bar greeting (admin only) ----------
  function renderDashboardGreeting(){
    const el = $('dtGreetingTitle');
    if(!el) return;
    const hour = new Date().getHours();
    const part = hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
    const name = (currentUser && currentUser.name) ? currentUser.name : 'Admin';
    el.textContent = 'Good '+part+', '+name+'! 👋';
  }

  // ---------- Recent Activity (admin dashboard, next to the live tracker) ----------
  // A lightweight, best-effort feed built from data other screens already
  // own (Cash Advance, Leave, Dispatch) — nothing new is stored just for
  // this panel. Service reports aren't included since they don't carry a
  // submission timestamp to sort by.
  function timeAgo(iso){
    if(!iso) return '';
    const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime())/60000));
    if(mins < 1) return 'Just now';
    if(mins < 60) return mins+'m ago';
    const hrs = Math.round(mins/60);
    if(hrs < 24) return hrs+'h ago';
    return Math.round(hrs/24)+'d ago';
  }
  function renderRecentActivity(cashAdvances, leaves, tickets){
    const list = $('recentActivityList');
    if(!list) return;
    const statusDot = (status)=> status==='pending' ? 'amber' : (status==='approved' ? 'green' : 'gray');
    const items = [];
    (cashAdvances||[]).forEach(r=> items.push({
      name: r.userName || 'Technician', desc: 'Filed a cash advance request',
      time: r.submittedAt, dot: statusDot(r.status)
    }));
    (leaves||[]).forEach(r=> items.push({
      name: r.userName || 'Technician', desc: 'Filed a leave request',
      time: r.submittedAt, dot: statusDot(r.status)
    }));
    (tickets||[]).forEach(t=> items.push({
      name: (t.assignedWorkerNames && t.assignedWorkerNames[0]) || t.custName || 'Dispatch',
      desc: 'Dispatch ticket '+(t.jobOrderNo||'')+' — '+(t.status||'updated'),
      time: t.createdAt, dot: 'blue'
    }));
    items.sort((a,b)=> (b.time||'').localeCompare(a.time||''));
    const top = items.slice(0,6);
    if(top.length===0){ list.innerHTML = '<div class="empty-state">No recent activity yet.</div>'; return; }
    list.innerHTML = top.map(it=>
      '<div class="activity-row"><span class="activity-dot activity-'+it.dot+'"></span>'+
      '<div class="activity-body"><div class="activity-name">'+escapeHtml(it.name)+'</div>'+
      '<div class="activity-desc">'+escapeHtml(it.desc)+'</div></div>'+
      '<div class="activity-time">'+timeAgo(it.time)+'</div></div>'
    ).join('');
  }

  // ---------- Sidebar nav (admin dashboard shell) ----------
  function setSidebarActive(id){
    $$('.sidebar-link').forEach(el=> el.classList.toggle('active', el.id===id));
  }
  $('sbNavDashboard').addEventListener('click', ()=>{ closeMainMenu(); showHome(); });
  $('sbNavTechnicians').addEventListener('click', ()=>{ closeMainMenu(); setSidebarActive('sbNavTechnicians'); showDtrView(); });
  $('sbNavRequisitions').addEventListener('click', ()=>{ closeMainMenu(); setSidebarActive('sbNavRequisitions'); showCashAdvanceView(); });
  $('sbNavDispatch').addEventListener('click', ()=>{ closeMainMenu(); setSidebarActive('sbNavDispatch'); showDispatchView(); });
  $('menuManageReports').addEventListener('click', ()=>{
    closeMainMenu();
    setSidebarActive('menuManageReports');
    showServiceReportsManagerView();
  });
  $('menuManageCustomers').addEventListener('click', async ()=>{
    closeMainMenu();
    setSidebarActive('menuManageCustomers');
    if(!(await ensureAdminAuthenticated())) return;
    showCustomersManagerView();
  });
  $('menuManageUsers').addEventListener('click', ()=> setSidebarActive('menuManageUsers'));
  $('menuManageDropdowns').addEventListener('click', ()=> setSidebarActive('menuManageDropdowns'));

  // ---------- Technician sidebar nav ----------
  // Same closeMainMenu()/setSidebarActive() convention as the admin nav
  // above — this just points each item at the technician's own version of
  // that screen instead of the admin's management view.
  $('techNavDispatch').addEventListener('click', ()=>{ closeMainMenu(); setSidebarActive('techNavDispatch'); showDispatchView(); });
  $('techNavServiceReport').addEventListener('click', ()=>{ closeMainMenu(); setSidebarActive('techNavServiceReport'); showServiceReport(); });
  $('techNavRequisition').addEventListener('click', ()=>{ closeMainMenu(); setSidebarActive('techNavRequisition'); showCashAdvanceView(); });
  $('techNavLiquidation').addEventListener('click', async ()=>{
    closeMainMenu(); setSidebarActive('techNavLiquidation');
    await showCashAdvanceView();
    if(currentUser && currentUser.role!=='admin') caShowTab('liquidate');
  });
  $('techNavDtr').addEventListener('click', ()=>{ closeMainMenu(); setSidebarActive('techNavDtr'); showDtrView(); });
  $('techNavLeave').addEventListener('click', ()=>{ closeMainMenu(); setSidebarActive('techNavLeave'); showLeaveView(); });
  $('techNavMessages').addEventListener('click', ()=>{ closeMainMenu(); setSidebarActive('techNavMessages'); showMessagesView(); });
  $('techNavDocuments').addEventListener('click', ()=>{ closeMainMenu(); setSidebarActive('techNavDocuments'); showDocumentsView(); });
  $('techNavSettings').addEventListener('click', ()=>{ closeMainMenu(); showChangePasswordScreen(false); });

  // ---------- Messages hub (every Job Order thread, one screen) ----------
  async function showMessagesView(){
    document.body.classList.remove('dashboard-active');
    $('homeScreen').style.display = 'none';
    $('serviceReportView').style.display = 'none';
    $('dtrView').style.display = 'none';
    $('leaveView').style.display = 'none';
    $('cashAdvanceView').style.display = 'none';
    $('dispatchView').style.display = 'none';
    $('equipmentManagerView').style.display = 'none';
    $('customersManagerView').style.display = 'none';
    $('serviceReportsManagerView').style.display = 'none';
    $('documentsView').style.display = 'none';
    $('messagesView').style.display = '';
    $('footerBar').style.display = 'none';
    $('metaBar').style.display = 'none';
    $('homeBtn').style.display = '';
    setHeaderTitle('Job Order Messages', 'Every thread in one place');
    window.scrollTo({top:0});
    await dtRenderMessagesHub();
  }
  async function dtRenderMessagesHub(){
    const list = $('messagesHubList');
    if(!list) return;
    list.innerHTML = '<div class="empty-state">Loading…</div>';
    if(!currentUser){ list.innerHTML = ''; return; }
    if(!(await ensureCloud())){ list.innerHTML = '<div class="empty-state">Connect to the internet to see Job Order messages.</div>'; return; }
    const tickets = currentUser.role==='admin' ? await dtListAll().catch(()=>[]) : await dtListForWorker(currentUser.id).catch(()=>[]);
    let allMsgs = [];
    try{
      const { data, error } = await db.from('dispatch_ticket_messages').select('*').order('created_at', {ascending:false});
      if(error) throw error;
      allMsgs = data || [];
    }catch(e){ console.error('messages hub load failed', describeCloudError(e)); }
    const byTicket = {};
    allMsgs.forEach(m=>{ (byTicket[m.ticket_id] = byTicket[m.ticket_id] || []).push(m); });
    const withMsgs = tickets.filter(t=> byTicket[t.id] && byTicket[t.id].length>0)
      .sort((a,b)=> new Date(byTicket[b.id][0].created_at) - new Date(byTicket[a.id][0].created_at));
    if(withMsgs.length===0){ list.innerHTML = '<div class="empty-state">No Job Order messages yet.</div>'; return; }
    list.innerHTML = withMsgs.map(t=>{
      const msgs = byTicket[t.id];
      const last = msgs[0];
      const lastRead = dtGetLastRead(t.id);
      const unread = msgs.filter(m=> m.sender_id!==currentUser.id && (!lastRead || new Date(m.created_at)>new Date(lastRead))).length;
      const preview = last.body.length>70 ? last.body.slice(0,70)+'…' : last.body;
      return '<div class="dt-msghub-row" data-jo-open="'+escapeHtml(t.id)+'">'+
        '<div class="dt-msghub-main">'+
          '<div class="u-name">'+escapeHtml(t.jobOrderNo)+' — '+escapeHtml(t.custName)+'</div>'+
          '<div class="u-status">'+escapeHtml(last.sender_name)+': '+escapeHtml(preview)+'</div>'+
        '</div>'+
        (unread>0 ? '<span class="sidebar-badge">'+unread+'</span>' : '')+
      '</div>';
    }).join('');
  }
  $('messagesHubList').addEventListener('click', (e)=>{
    const row = e.target.closest('[data-jo-open]');
    if(row) dtOpenTicketOverlay(row.dataset.joOpen);
  });

  // ---------- Documents (a technician's own completed Service Reports) ----------
  async function showDocumentsView(){
    document.body.classList.remove('dashboard-active');
    $('homeScreen').style.display = 'none';
    $('serviceReportView').style.display = 'none';
    $('dtrView').style.display = 'none';
    $('leaveView').style.display = 'none';
    $('cashAdvanceView').style.display = 'none';
    $('dispatchView').style.display = 'none';
    $('equipmentManagerView').style.display = 'none';
    $('customersManagerView').style.display = 'none';
    $('serviceReportsManagerView').style.display = 'none';
    $('messagesView').style.display = 'none';
    $('documentsView').style.display = '';
    $('footerBar').style.display = 'none';
    $('metaBar').style.display = 'none';
    $('homeBtn').style.display = '';
    setHeaderTitle('My Documents', 'Completed Service Reports');
    window.scrollTo({top:0});
    const onlyMe = currentUser && currentUser.role!=='admin' ? currentUser.id : null;
    await loadHistory('documentsList', 'completed', onlyMe);
  }

  // ---------- Home screen (feature tiles) ----------
  // Admin's homepage reads "Field Operations Portal" / "Management &
  // Administration" instead of the technician's "Technician's Homepage" /
  // "Field digital form" — shared by showHome() and the coming-soon flash
  // below so both stay in sync for whichever role is logged in.
  function homeHeaderTitle(){
    return (currentUser && currentUser.role==='admin')
      ? ['Field Operations Portal', 'Management & Administration']
      : ["Technician's Homepage", 'Field digital form'];
  }
  function showHome(){
    document.body.classList.add('dashboard-active');
    setSidebarActive('sbNavDashboard');
    $('homeScreen').style.display = '';
    $('serviceReportView').style.display = 'none';
    $('dtrView').style.display = 'none';
    $('leaveView').style.display = 'none';
    $('cashAdvanceView').style.display = 'none';
    $('dispatchView').style.display = 'none';
    $('equipmentManagerView').style.display = 'none';
    $('customersManagerView').style.display = 'none';
    $('serviceReportsManagerView').style.display = 'none';
    $('messagesView').style.display = 'none';
    $('documentsView').style.display = 'none';
    $('footerBar').style.display = 'none';
    $('metaBar').style.display = 'none';
    $('homeBtn').style.display = 'none';
    setHeaderTitle(...homeHeaderTitle());
    $('tile_dispatch_label').textContent = (currentUser && currentUser.role==='admin') ? 'Service Dispatch Ticket' : 'My Job Order';
    renderHomeGreeting();
    renderHomeTechOverview();
    renderHomeOverview();
    renderHomeAnnouncements();
    window.scrollTo({top:0});
  }
  // ---------- Service Report: Create New / Saved Draft / Completed / All tabs ----------
  // `opts.skipReset` lets a caller switch to the New panel without wiping the
  // form — used by openReport() (Continue), which already populated the form
  // with a draft's data and just needs the panel switched, not cleared again.
  function srShowTab(which, opts){
    opts = opts || {};
    $('srTabNewBtn').classList.toggle('active', which==='new');
    $('srTabDraftBtn').classList.toggle('active', which==='draft');
    $('srTabCompletedBtn').classList.toggle('active', which==='completed');
    $('srTabAllBtn').classList.toggle('active', which==='all');
    const isHistoryTab = which!=='new';
    $('srNewPanel').style.display = which==='new' ? '' : 'none';
    $('srHistoryPanel').style.display = isHistoryTab ? '' : 'none';
    // The footer (Save Draft / Generate Report) and the SR-No./status meta
    // bar only make sense while actively filling out a report.
    $('footerBar').style.display = which==='new' ? 'flex' : 'none';
    $('metaBar').style.display = which==='new' ? '' : 'none';
    if(which==='new'){
      // "Create New" is a hard reset, not just a tab switch — same convention
      // as the Dispatch admin's "New" tab (dtShowAdminTab). Any in-progress
      // report (blank or partly filled, saved or not) is discarded every time
      // this tab is opened this way, and the flow always starts over from the
      // Job Order picker rather than resuming whatever was on screen before.
      if(!opts.skipReset){
        resetForm();
        // Without this, a technician who had scrolled down a long form (or a
        // long Saved Draft / Completed list) still sees whatever part of the
        // page they were on after the reset — the panel underneath did switch
        // and clear, but it looks like nothing happened until they scroll up.
        window.scrollTo({top:0, behavior:'smooth'});
      }
      srRenderJobOrderPicker();
    }
    if(isHistoryTab){
      $('srHistoryPanelTitle').textContent =
        which==='draft' ? 'Saved Draft Reports' : which==='completed' ? 'Completed Reports' : 'All Reports';
      loadHistory('srHistoryList', which);
    }
  }
  $('srTabNewBtn').addEventListener('click', ()=> srShowTab('new'));
  $('srTabDraftBtn').addEventListener('click', ()=> srShowTab('draft'));
  $('srTabCompletedBtn').addEventListener('click', ()=> srShowTab('completed'));
  $('srTabAllBtn').addEventListener('click', ()=> srShowTab('all'));

  function showServiceReport(){
    document.body.classList.remove('dashboard-active');
    $('homeScreen').style.display = 'none';
    $('dtrView').style.display = 'none';
    $('leaveView').style.display = 'none';
    $('cashAdvanceView').style.display = 'none';
    $('dispatchView').style.display = 'none';
    $('equipmentManagerView').style.display = 'none';
    $('customersManagerView').style.display = 'none';
    $('serviceReportsManagerView').style.display = 'none';
    $('messagesView').style.display = 'none';
    $('documentsView').style.display = 'none';
    $('serviceReportView').style.display = '';
    $('homeBtn').style.display = '';
    setHeaderTitle('Service Report', 'Field digital form');
    if(currentUser && currentUser.role==='admin'){
      // Admin can't author a blank report — the "Create New" tab is hidden
      // for this role — so land on "All" instead of the now-inaccessible
      // Create New panel. Admin still reaches the same form panel to edit
      // an existing report by opening it from a history list.
      srShowTab('all');
    }else{
      // Just entering the section, not the explicit "Create New" tab action —
      // don't discard whatever the technician was already filling out.
      srShowTab('new', {skipReset:true});
    }
    window.scrollTo({top:0});
  }
  function enterApp(){
    // A technician's device only ever broadcasts its own position while
    // that technician is actually signed in — see tracker.js. Admin gets a
    // 15-minute idle-timeout watch instead (see startAdminIdleWatch in
    // auth.js) — technician sessions are never auto-logged-out this way.
    if(currentUser && currentUser.role==='tech'){
      trackerStartBroadcasting();
      stopAdminIdleWatch();
    }else if(currentUser && currentUser.role==='admin'){
      trackerStopBroadcasting();
      startAdminIdleWatch();
    }else{
      trackerStopBroadcasting();
      stopAdminIdleWatch();
    }
    showHome();
  }
  $('tile_serviceReport').addEventListener('click', showServiceReport);
  $('tile_dtr').addEventListener('click', showDtrView);
  // Coming-soon tiles don't navigate to a real page yet, so the header title
  // change is shown briefly alongside the toast, then reverts to the home
  // title once the toast fades (avoids leaving a mismatched header behind
  // on a screen that's still showing the home tile grid).
  function flashComingSoonHeader(title, message){
    setHeaderTitle(title, 'Field digital form');
    toast(message);
    setTimeout(()=>{ if($('homeScreen').style.display !== 'none') setHeaderTitle(...homeHeaderTitle()); }, 2200);
  }
  $('tile_cashAdvance').addEventListener('click', showCashAdvanceView);
  $('tile_dispatch').addEventListener('click', showDispatchView);
  $('tile_leave').addEventListener('click', showLeaveView);
  $('tile_materialRequest').addEventListener('click', ()=> flashComingSoonHeader('Material Request Form', 'Material Request Form — coming soon'));
  $('tile_changePassword').addEventListener('click', ()=> showChangePasswordScreen(false));
  $('homeBtn').addEventListener('click', showHome);

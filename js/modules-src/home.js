// ---------- Header title (changes per feature page) ----------
  function setHeaderTitle(title, sub){
    $('brandName').textContent = title;
    $('brandSub').textContent = sub || '';
  }

  async function showDtrView(){
    $('homeScreen').style.display = 'none';
    $('serviceReportView').style.display = 'none';
    $('leaveView').style.display = 'none';
    $('cashAdvanceView').style.display = 'none';
    $('dispatchView').style.display = 'none';
    $('dtrView').style.display = '';
    $('footerBar').style.display = 'none';
    $('metaBar').style.display = 'none';
    $('homeBtn').style.display = '';
    setHeaderTitle('Online DTR', 'Daily Time Record');
    window.scrollTo({top:0});
    if(currentUser && currentUser.role==='admin'){
      // Admin has no DTR of their own — DTR is per-technician, so ask which one.
      $('dtrTechCard').style.display = 'none';
      $('dtrAdminViewingCard').style.display = '';
      dtrViewingUser = null;
      $('dtrHistoryList').innerHTML = '<div class="empty-state">Select a technician to view their DTR.</div>';
      dtrOpenAdminPicker();
    }else if(currentUser){
      $('dtrTechCard').style.display = '';
      $('dtrAdminViewingCard').style.display = 'none';
      $('dtrTechName').textContent = currentUser.name;
      dtrViewingUser = null;
      await dtrRenderDeviceBanner();
      await dtrRenderTodayStatus();
      await dtrRenderHistory();
    }
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

    const [tickets, reports, cashAdvances, leaves, todayDtr] = await Promise.all([
      dtListForWorker(currentUser.id).catch(()=>[]),
      cloudListReports().catch(()=>null),
      caListForUser(currentUser.id).catch(()=>[]),
      leaveListForUser(currentUser.id).catch(()=>[]),
      dtrGetDay(currentUser.id, todayISO()).catch(()=>null)
    ]);

    const jobOrderCount = (tickets||[]).filter(t=> t.status!=='completed').length;
    const draftReportCount = reports===null ? 0 : reports.filter(r=> r.technicianId===currentUser.id && !r.completed).length;
    const cashAdvanceCount = (cashAdvances||[]).filter(caNeedsLiquidation).length;
    const leaveCount = (leaves||[]).filter(r=> r.status==='pending').length;
    const alreadyTimedIn = !!(todayDtr && todayDtr.timeIn);

    const items = [];
    if(jobOrderCount>0) items.push({icon:'📋', count:jobOrderCount, label:'Job Order'+(jobOrderCount===1?'':'s')+' to accomplish'});
    if(draftReportCount>0) items.push({icon:'🧾', count:draftReportCount, label:'Saved Service Report'+(draftReportCount===1?'':'s')+' to complete'});
    if(cashAdvanceCount>0) items.push({icon:'💵', count:cashAdvanceCount, label:'Cash Advance'+(cashAdvanceCount===1?'':'s')+' to Liquidate'});
    if(leaveCount>0) items.push({icon:'📅', count:leaveCount, label:'Leave Form Request'+(leaveCount===1?'':'s')+' pending'});

    let html =
      '<p class="greet-line">Good day, <b>'+escapeHtml(currentUser.name)+'</b>!</p>'+
      '<p class="greet-date">Today is '+dateStr+', '+timeStr+'.</p>';
    if(items.length>0){
      html += '<div class="greet-summary-label">You have</div><div class="greet-summary-list">'+
        items.map(i=>
          '<div class="greet-summary-item">'+
            '<span class="greet-summary-icon">'+i.icon+'</span>'+
            '<span class="greet-summary-count">'+i.count+'</span>'+
            '<span class="greet-summary-text">'+i.label+'</span>'+
          '</div>'
        ).join('')+
      '</div>';
    }else{
      html += '<p class="greet-allclear">You have no pending job orders, reports, or requests right now — nice and clear!</p>';
    }
    if(!alreadyTimedIn){
      html += '<div class="greet-reminder">⏰ Don\'t forget to tap "Time-In" to officially register your attendance.</div>';
    }
    html += '<p class="greet-thanks">Thank you!</p>';
    $('homeGreetingText').innerHTML = html;
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
      return;
    }
    card.style.display = '';

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

    // Live map of every technician currently sharing a location — see tracker.js.
    trackerAdminInit();
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
    $('homeScreen').style.display = '';
    $('serviceReportView').style.display = 'none';
    $('dtrView').style.display = 'none';
    $('leaveView').style.display = 'none';
    $('cashAdvanceView').style.display = 'none';
    $('dispatchView').style.display = 'none';
    $('footerBar').style.display = 'none';
    $('metaBar').style.display = 'none';
    $('homeBtn').style.display = 'none';
    setHeaderTitle(...homeHeaderTitle());
    $('tile_dispatch_label').textContent = (currentUser && currentUser.role==='admin') ? 'Service Dispatch Ticket' : 'My Job Order';
    renderHomeGreeting();
    renderHomeOverview();
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
    $('homeScreen').style.display = 'none';
    $('dtrView').style.display = 'none';
    $('leaveView').style.display = 'none';
    $('cashAdvanceView').style.display = 'none';
    $('dispatchView').style.display = 'none';
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
    // that technician is actually signed in — see tracker.js.
    if(currentUser && currentUser.role==='tech') trackerStartBroadcasting();
    else trackerStopBroadcasting();
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

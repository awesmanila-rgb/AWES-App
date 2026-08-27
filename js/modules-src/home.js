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
    if(jobOrderCount>0) items.push(jobOrderCount+' Job Order'+(jobOrderCount===1?'':'s')+' to accomplish');
    if(draftReportCount>0) items.push(draftReportCount+' Saved Service Report'+(draftReportCount===1?'':'s')+' to complete');
    if(cashAdvanceCount>0) items.push(cashAdvanceCount+' Cash Advance'+(cashAdvanceCount===1?'':'s')+' to Liquidate');
    if(leaveCount>0) items.push(leaveCount+' Leave Form Request'+(leaveCount===1?'':'s')+' pending');

    let html = '<p style="margin:0 0 10px;">Good day, <b>'+escapeHtml(currentUser.name)+'</b>! Today is <b>'+dateStr+'</b>, '+timeStr+'.</p>';
    if(items.length>0){
      html += '<p style="margin:0 0 10px;">You have</p><ul style="margin:0 0 14px; padding-left:22px;">'+
        items.map(i=>'<li>'+i+'</li>').join('')+'</ul>';
    }else{
      html += '<p style="margin:0 0 14px;">You have no pending job orders, reports, or requests right now — nice and clear!</p>';
    }
    if(!alreadyTimedIn){
      html += '<p style="margin:0; color:var(--green-dark); font-weight:600;">⏰ Do not forget to tap "Time-In" to officially register your attendance.</p>';
    }
    html += '<p style="margin:10px 0 0;">Thank you!</p>';
    $('homeGreetingText').innerHTML = html;
  }

  // ---------- Home screen (feature tiles) ----------
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
    setHeaderTitle("Technician's Homepage", 'Field digital form');
    $('tile_dispatch_label').textContent = (currentUser && currentUser.role==='admin') ? 'Service Dispatch Ticket' : 'My Job Order';
    renderHomeGreeting();
    window.scrollTo({top:0});
  }
  // ---------- Service Report: Create New / Saved Draft / Completed / All tabs ----------
  function srShowTab(which){
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
    if(which==='new') srRenderJobOrderPicker();
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
    srShowTab('new');
    window.scrollTo({top:0});
  }
  function enterApp(){
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
    setTimeout(()=>{ if($('homeScreen').style.display !== 'none') setHeaderTitle("Technician's Homepage", 'Field digital form'); }, 2200);
  }
  $('tile_cashAdvance').addEventListener('click', showCashAdvanceView);
  $('tile_dispatch').addEventListener('click', showDispatchView);
  $('tile_leave').addEventListener('click', showLeaveView);
  $('tile_materialRequest').addEventListener('click', ()=> flashComingSoonHeader('Material Request Form', 'Material Request Form — coming soon'));
  $('tile_changePassword').addEventListener('click', ()=> showChangePasswordScreen(false));
  $('homeBtn').addEventListener('click', showHome);

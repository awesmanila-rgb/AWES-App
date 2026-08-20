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
    window.scrollTo({top:0});
  }
  // ---------- Service Report: Create New / View History tabs ----------
  function srShowTab(which){
    $('srTabNewBtn').classList.toggle('active', which==='new');
    $('srTabHistoryBtn').classList.toggle('active', which==='history');
    $('srNewPanel').style.display = which==='new' ? '' : 'none';
    $('srHistoryPanel').style.display = which==='history' ? '' : 'none';
    // The footer (Save Draft / Generate Report) and the SR-No./status meta
    // bar only make sense while actively filling out a report.
    $('footerBar').style.display = which==='new' ? 'flex' : 'none';
    $('metaBar').style.display = which==='new' ? '' : 'none';
    if(which==='new') srRenderJobOrderPicker();
    if(which==='history') loadHistory('srHistoryList');
  }
  $('srTabNewBtn').addEventListener('click', ()=> srShowTab('new'));
  $('srTabHistoryBtn').addEventListener('click', ()=> srShowTab('history'));

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

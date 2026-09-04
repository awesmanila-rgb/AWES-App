// ---------- Customer Equipment Detail / Service History ----------
// The "complete patient record" screen for a single piece of equipment:
// its info, plus every service visit ever recorded against it, each
// expandable to the full findings/recommendations/materials/services-done
// detail — not just a list of dates.
//
// Depends on customer-portal.js having already run loadCustomerPortalData(),
// which attaches eq.reportHistory (full, sorted, most-recent-first) to each
// equipment object in cpEquipment.

  let cpDetailEquip = null; // the equipment currently shown on this screen

  function cpFmtList(arr){
    if(!arr || !arr.length) return '<div class="cp-visit-empty">None recorded for this visit.</div>';
    return '<ul class="cp-visit-list">' + arr.map(item => {
      // findings/recommendations/servicesDone rows are usually {text} or
      // plain strings depending on how service-report.js stored them;
      // materials rows carry qty/unit/description. Handle both shapes.
      if(typeof item === 'string') return '<li>'+escapeHtml(item)+'</li>';
      if(item && typeof item === 'object'){
        if('description' in item){
          const qty = item.qty ? escapeHtml(String(item.qty))+' '+escapeHtml(item.unit||'')+' — ' : '';
          return '<li>'+qty+escapeHtml(item.description||'')+'</li>';
        }
        return '<li>'+escapeHtml(item.text || JSON.stringify(item))+'</li>';
      }
      return '';
    }).join('') + '</ul>';
  }

  function cpVisitCardHtml(r, idx){
    const statusLabel = r.completed ? 'Completed' : 'In progress';
    const statusClass = r.completed ? 'status-ok' : 'status-flag';
    const title = escapeHtml((r.trouble_call && r.trouble_call.trim()) ? r.trouble_call : 'Scheduled maintenance visit');
    return (
      '<div class="cp-visit-card">'+
        '<div class="cp-visit-head" data-visit-idx="'+idx+'">'+
          '<div class="cp-visit-dot"></div>'+
          '<div class="cp-visit-head-body">'+
            '<div class="cp-visit-title">'+title+'</div>'+
            '<div class="cp-visit-meta">'+escapeHtml(fmtDate(r.date))+' · '+escapeHtml(r.sr_no||'')+
              (r.technician_name ? ' · '+escapeHtml(r.technician_name) : '')+'</div>'+
          '</div>'+
          '<span class="status-pill '+statusClass+'">'+statusLabel+'</span>'+
          '<span class="cp-visit-chevron">▾</span>'+
        '</div>'+
        '<div class="cp-visit-body" id="cpVisitBody'+idx+'" style="display:none;">'+
          (r.remarks ? '<div class="cp-visit-remarks">'+escapeHtml(r.remarks)+'</div>' : '')+
          '<div class="cp-visit-section"><b>Findings / Evaluation</b>'+cpFmtList(r.findings)+'</div>'+
          '<div class="cp-visit-section"><b>Recommendations</b>'+cpFmtList(r.recommendations)+'</div>'+
          '<div class="cp-visit-section"><b>Services Done</b>'+cpFmtList(r.services_done)+'</div>'+
          '<div class="cp-visit-section"><b>Materials Used</b>'+cpFmtList(r.materials)+'</div>'+
          '<button type="button" class="cp-visit-pdf-btn" data-sr-no="'+escapeHtml(r.sr_no||'')+'">🗎 View Full Report (PDF)</button>'+
        '</div>'+
      '</div>'
    );
  }

  function renderCustomerEquipmentDetail(eq){
    cpDetailEquip = eq;
    $('cpDetailName').textContent = eq.equipType || 'Equipment';
    $('cpDetailLoc').textContent = eq.equipLocation || '—';

    const specs = [
      ['Brand', eq.brand], ['Mount type', eq.mountType], ['Cooling capacity', eq.coolCap],
      ['Model (CU)', eq.modelCU], ['Serial (CU)', eq.serialCU],
      ['Model (FCU)', eq.modelFCU], ['Serial (FCU)', eq.serialFCU],
    ].filter(([,v]) => v);
    $('cpDetailSpecs').innerHTML = specs.map(([k,v]) =>
      '<div class="cp-spec-row"><span class="cp-spec-k">'+escapeHtml(k)+'</span><span class="cp-spec-v">'+escapeHtml(String(v))+'</span></div>'
    ).join('');

    const history = eq.reportHistory || [];
    $('cpDetailVisitCount').textContent = String(history.length);
    $('cpDetailFirstVisit').textContent = history.length ? fmtDate(history[history.length-1].date) : '—';
    $('cpDetailLastVisit').textContent = history.length ? fmtDate(history[0].date) : '—';

    $('cpVisitTimeline').innerHTML = history.length
      ? history.map(cpVisitCardHtml).join('')
      : '<div class="empty-state">No service visits recorded yet for this unit.</div>';

    // Expand/collapse each visit
    $$('.cp-visit-head', $('customerEquipmentDetailScreen')).forEach(head => {
      head.onclick = () => {
        const idx = head.dataset.visitIdx;
        const body = $('cpVisitBody'+idx);
        const open = body.style.display !== 'none';
        body.style.display = open ? 'none' : '';
        head.querySelector('.cp-visit-chevron').textContent = open ? '▾' : '▴';
      };
    });

    // "View Full Report (PDF)" reuses your existing buildPdf()/preview flow
    // from pdf.js — same one history.js already uses for completed reports.
    $$('.cp-visit-pdf-btn', $('customerEquipmentDetailScreen')).forEach(btn => {
      btn.onclick = async (e) => {
        e.stopPropagation();
        const sr = btn.dataset.srNo;
        const full = cpReports.find(r => r.sr_no === sr);
        if(full && typeof openCustomerReportPreview === 'function') openCustomerReportPreview(sr);
      };
    });
  }

  // Called from customer-portal.js when an equipment card is tapped.
  // Swap #customerHomeScreen for #customerEquipmentDetailScreen — adjust
  // ids here to match whatever your screen-switching helper is called.
  function openCustomerEquipmentDetail(eq){
    $('customerHomeScreen').style.display = 'none';
    $('customerEquipmentDetailScreen').style.display = '';
    renderCustomerEquipmentDetail(eq);
  }

  function closeCustomerEquipmentDetail(){
    $('customerEquipmentDetailScreen').style.display = 'none';
    $('customerHomeScreen').style.display = '';
  }

  // ---------- Customer Portal wiring ----------
  // Routes a customer session to the customer home screen, hiding every
  // other view the same way showHome() does for admin/tech — but kept as
  // its own function so admin/tech's showHome() only needs a one-line
  // branch pointing here, with no other changes to its existing logic.
  function showCustomerHome(){
    document.body.classList.add('dashboard-active');
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
    $('customerHistoryView').style.display = 'none';
    $('homeScreen').style.display = 'none';
    $('customerEquipmentDetailScreen').style.display = 'none';
    $('footerBar').style.display = 'none';
    $('metaBar').style.display = 'none';
    $('homeBtn').style.display = 'none';
    setSidebarActive('custNavHome');
    setHeaderTitle('Customer Portal', "Your equipment & service history");
    $('customerHomeScreen').style.display = '';
    initCustomerHomeScreen();
    window.scrollTo({top:0});
  }

  $('custNavHome').addEventListener('click', ()=>{ closeMainMenu(); showCustomerHome(); });
  $('custNavEquipment').addEventListener('click', ()=>{
    closeMainMenu(); setSidebarActive('custNavEquipment'); showCustomerHome();
    const el = $('cpEquipGrid'); if(el) el.scrollIntoView({behavior:'smooth', block:'start'});
  });
  $('custNavReports').addEventListener('click', ()=>{
    closeMainMenu(); setSidebarActive('custNavReports'); showCustomerHome();
    const el = $('cpReportsList'); if(el) el.scrollIntoView({behavior:'smooth', block:'start'});
  });
  // No dedicated screens shipped yet for these two — same "coming soon"
  // convention already used elsewhere in the app (see tile_materialRequest
  // in home.js) rather than linking to something that doesn't exist.
  $('custNavRequests').addEventListener('click', ()=>{ closeMainMenu(); setSidebarActive('custNavRequests'); toast('Service Requests — coming soon'); });
  $('custNavAccount').addEventListener('click', ()=>{ closeMainMenu(); setSidebarActive('custNavAccount'); toast('Account settings — coming soon'); });
  $('cpRequestServiceBtn').addEventListener('click', ()=> toast('Request Service — coming soon'));
  $('cpViewAllReportsBtn').addEventListener('click', ()=> toast('Full report list — coming soon'));
  $('cpDetailBackBtn').addEventListener('click', closeCustomerEquipmentDetail);

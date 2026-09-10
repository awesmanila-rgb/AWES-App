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

  // ---------- Customer: name their own equipment ----------
  // The label is the customer's own call — set here, on their own device,
  // via customer_set_equipment_label() (security-definer RPC, see
  // 20260909_03_customer_equipment_label_customer_write.sql), which checks
  // this login is actually linked to the unit's customer_id before writing
  // anything. Admin sees the result (equipDetailRowsHtml in admin.js) but
  // has no editable field for it there — naming a unit is the customer's,
  // not admin's, to do.
  async function cloudSetEquipmentLabelAsCustomer(equipmentId, label){
    if(!equipmentId || !(await ensureCloud())) return false;
    try{
      const { data, error } = await db.rpc('customer_set_equipment_label', {
        p_equipment_id: equipmentId, p_label: (label||'').trim()
      });
      if(error) throw error;
      return data === true;
    }catch(e){ console.error('set equipment label failed', describeCloudError(e)); return false; }
  }
  // Renders the "Unit Label" row as its own little inline editor rather
  // than a plain spec row (unlike everything else in specs below, this one
  // the customer can actually change) — tap "Rename"/"Add Label" to swap
  // in a text input with Save/Cancel, tap Save to write it and refresh
  // this screen plus the home screen grid so the new name shows up
  // everywhere immediately.
  //
  // Uses classes, not ids, for the elements inside — #cpDetailSpecs gets
  // fully replaced (innerHTML) every render, and this app's $() helper
  // caches an id to whichever DOM node it first resolved to (see core.js),
  // so a second render's same-id button would silently wire up a detached,
  // already-removed element. Querying by class scoped to the (persistent)
  // #cpDetailSpecs container each time avoids that.
  function cpLabelRowHtml(eq){
    const hasLabel = !!(eq.label||'').trim();
    const shown = hasLabel ? eq.label : equipShortId(eq);
    return (
      '<div class="cp-spec-row">'+
        '<span class="cp-spec-k">Unit Label</span>'+
        '<span class="cp-spec-v cp-label-view" style="display:flex; align-items:center; gap:8px; justify-content:flex-end;">'+
          '<span class="cp-label-text"'+(hasLabel?'':' style="color:var(--text-muted);"')+'>'+escapeHtml(shown)+'</span>'+
          '<button type="button" class="cp-label-edit-btn" style="font-size:11px; padding:2px 8px; border:1px solid var(--border); border-radius:6px; background:none; cursor:pointer;">'+(hasLabel?'Rename':'Add Label')+'</button>'+
        '</span>'+
      '</div>'
    );
  }
  function cpWireLabelEditor(eq){
    const wrap = $('cpDetailSpecs');
    const editBtn = wrap.querySelector('.cp-label-edit-btn');
    if(!editBtn) return;
    editBtn.onclick = () => {
      const view = wrap.querySelector('.cp-label-view');
      const current = (eq.label||'').trim();
      view.innerHTML =
        '<input type="text" class="cp-label-input" placeholder="e.g. Server Room AC" value="'+escapeHtml(current)+'" style="border:1px solid var(--border); border-radius:6px; padding:4px 6px; font-size:13px; text-align:right; max-width:150px;">'+
        '<button type="button" class="cp-label-save-btn" style="font-size:11px; padding:2px 8px; border:1px solid var(--border); border-radius:6px; background:none; cursor:pointer;">Save</button>'+
        '<button type="button" class="cp-label-cancel-btn" style="font-size:11px; padding:2px 8px; border:none; background:none; color:var(--text-muted); cursor:pointer;">Cancel</button>';
      const input = view.querySelector('.cp-label-input');
      input.focus(); input.select();
      view.querySelector('.cp-label-cancel-btn').onclick = () => renderCustomerEquipmentDetail(eq);
      const doSave = async () => {
        const next = input.value.trim();
        const saveBtn = view.querySelector('.cp-label-save-btn');
        saveBtn.disabled = true; saveBtn.textContent = 'Saving…';
        const ok = await cloudSetEquipmentLabelAsCustomer(eq.id, next);
        if(ok){
          eq.label = next; // same object reference as in cpEquipment — the
                            // home screen grid picks this up next render
          toast(next ? 'Label saved' : 'Label cleared');
          renderCustomerEquipmentDetail(eq);
          if(typeof renderCustomerHome === 'function') renderCustomerHome();
        }else{
          toast('Could not save — check your connection');
          saveBtn.disabled = false; saveBtn.textContent = 'Save';
        }
      };
      view.querySelector('.cp-label-save-btn').onclick = doSave;
      input.addEventListener('keydown', (e)=>{ if(e.key==='Enter'){ e.preventDefault(); doSave(); } });
    };
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
    // Next PM (preventive maintenance) date — admin-set, see
    // computeEquipmentStatus() in customer-portal.js. Always shown (unlike
    // the specs above, which drop blank fields) so a unit with nothing
    // scheduled yet still says so rather than silently omitting the row.
    specs.push(['Next PM', eq.nextPmDate
      ? fmtDate(eq.nextPmDate) + (eq.status && eq.status.key==='overdue' ? ' (overdue)' : '')
      : 'Not scheduled yet']);
    // Unit Label leads, and is its own editable row — see cpLabelRowHtml
    // above — everything after it is the plain, read-only spec list.
    $('cpDetailSpecs').innerHTML = cpLabelRowHtml(eq) + specs.map(([k,v]) =>
      '<div class="cp-spec-row"><span class="cp-spec-k">'+escapeHtml(k)+'</span><span class="cp-spec-v">'+escapeHtml(String(v))+'</span></div>'
    ).join('');
    cpWireLabelEditor(eq);
    renderCustomerEquipmentPhotos(eq);

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
    // Clear the photo grid BEFORE the screen becomes visible, not after —
    // renderCustomerEquipmentPhotos() below does overwrite it synchronously
    // too, but doing it here as well means there is no DOM state, even for
    // a single frame, where this screen is visible AND still showing a
    // previously-viewed unit's photos (whether from this customer's own
    // last-viewed unit, or — had doLogout() not been fixed to reset this —
    // a previous customer's session).
    $('cpDetailPhotoGrid').innerHTML = '';
    $('customerHomeScreen').style.display = 'none';
    $('customerEquipmentDetailScreen').style.display = '';
    renderCustomerEquipmentDetail(eq);
  }

  // ---------- Photos (read-only) ----------
  // Same photos admin uploads/organizes from the Manage Equipment List
  // detail overlay (admin.js) — this just displays them, grouped by the
  // same folder tags, with no upload/delete/cover controls. See
  // equipment-photos.js for cloudListEquipmentPhotos()/signed URLs.
  async function renderCustomerEquipmentPhotos(eq){
    const grid = $('cpDetailPhotoGrid');
    grid.innerHTML = '<div class="empty-state">Loading…</div>';
    const photos = await cloudListEquipmentPhotos(eq.id);
    // Guard against the customer having tapped into a different unit (or
    // back out) while this was still in flight.
    if(cpDetailEquip !== eq) return;
    if(photos.length===0){
      grid.innerHTML = '<div class="empty-state">No photos on file for this unit yet.</div>';
      return;
    }
    const byFolder = {};
    photos.forEach(p=>{ const f = p.folder || 'Uncategorized'; (byFolder[f] = byFolder[f]||[]).push(p); });
    const folderNames = Object.keys(byFolder).sort((a,b)=> a==='Uncategorized' ? 1 : b==='Uncategorized' ? -1 : a.localeCompare(b));
    grid.innerHTML = folderNames.map(f=>
      '<div style="flex-basis:100%; margin-bottom:8px;">'+
        '<div style="font-size:11px; font-weight:700; color:var(--text-muted); text-transform:uppercase; letter-spacing:.4px; margin-bottom:6px;">'+escapeHtml(f)+'</div>'+
        '<div style="display:flex; flex-wrap:wrap; gap:8px;">'+byFolder[f].map(p=>
          '<div class="cp-photo-thumb" data-photo-id="'+p.id+'" style="width:100px; height:100px; border-radius:8px; overflow:hidden; cursor:'+(p.signedUrl?'pointer':'default')+'; background:var(--bg-alt,#eee); display:flex; align-items:center; justify-content:center;">'+
            (p.signedUrl ? '<img src="'+p.signedUrl+'" style="width:100%; height:100%; object-fit:cover;">' : '<span style="font-size:11px; color:var(--text-muted);">—</span>')+
          '</div>'
        ).join('')+
      '</div>'
    ).join('');
    // Swipeable lightbox (equipment-photos.js) instead of window.open() —
    // opening each photo in a new tab meant closing it just to see the
    // next one; this lets the customer swipe/arrow through every photo on
    // this unit without leaving the gallery.
    $$('.cp-photo-thumb', grid).forEach(el=>{
      const photo = photos.find(p=> String(p.id)===el.dataset.photoId);
      if(photo && photo.signedUrl) el.addEventListener('click', ()=> openEquipmentPhotoLightbox(photos, photo));
    });
  }

  function closeCustomerEquipmentDetail(){
    $('customerEquipmentDetailScreen').style.display = 'none';
    $('customerHomeScreen').style.display = '';
  }

  // Opens a completed report as a PDF preview for a customer — same
  // preview overlay history.js's "View" action uses for admin/tech, just
  // reached from the customer portal instead. cpReports only carries the
  // summary columns customer-portal.js selected (findings/recs/etc. as
  // plain text lists), not the full row shape buildPdf() needs (before/
  // after readings, install data, signatures), so this re-fetches the
  // report fresh via cloudGetReport() rather than reusing the cpReports
  // entry directly.
  async function openCustomerReportPreview(sr){
    try{
      const d = await cloudGetReport(sr);
      if(!d){ toast('Could not open this report'); return; }
      const doc = await buildPdf(d);
      $('previewOverlay').querySelector('h3').textContent = d.custName ? d.custName : 'Report';
      $('previewOkBtn').textContent = 'Close';
      $('previewOverlay').classList.add('open');
      await renderPdfPreview(doc);
    }catch(err){
      console.error('view customer report failed', err);
      toast('Could not open this report');
    }
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

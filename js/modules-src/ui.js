// ---------- meta bar live update ----------
  $('svcDate').addEventListener('change', ()=> $('metaDate').textContent = fmtDate($('svcDate').value));

  // ---------- init defaults ----------
  // Which dispatch ticket + equipment line item (if any) the report
  // currently being filed is tied to — set by srApplyJobOrder (dispatch.js)
  // when a technician picks a piece of equipment off a Job Order, read by
  // the save handler in pdf.js to mark that item "reported" once the report
  // goes through. Declared here because resetForm() below runs once at load
  // time, before dispatch.js's own module code has executed.
  let srCurrentTicketId = null;
  let srCurrentEquipId = null;
  // Set instead of srCurrentEquipId when a technician has picked MULTIPLE
  // equipment items off one Job Order to batch-sign — see
  // srApplyJobOrderBatch() (dispatch.js) and the submit loop in pdf.js.
  // Each entry is one equipment item off the ticket's equipmentList.
  let srBatchEquipItems = null;
  function resetForm(){
    // Scoped to the Service Report view only. This used to select every text,
    // number, textarea and checkbox on the page, so starting a new report also
    // wiped whatever the user had typed into the Dispatch, Leave, Cash Advance,
    // Customers and Admin forms — all of which live in the same document.
    const scope = $('serviceReportView') || document;
    scope.querySelectorAll('input[type=text], input[type=number], textarea').forEach(el=>el.value='');
    scope.querySelectorAll('input[type=checkbox]').forEach(el=>{ el.checked=false; el.closest('.chk')?.classList.remove('checked'); });
    $('svcDate').value = todayISO();
    $('timeIn').value=''; $('timeOut').value='';
    $('findingsList').innerHTML=''; $('recsList').innerHTML=''; $('servicesDoneList').innerHTML='';
    addListRow('findingsList'); addListRow('recsList'); addListRow('servicesDoneList');
    $('materialsBody').innerHTML=''; materialRowCount=0;
    $('isInstallToggle').checked=false; $('installSection').classList.remove('open');
    loadCustomerEquipment(null);
    setEquipTab(null);
    $('custDetailsWrap').style.display = 'none';
    // Technicians must pick an authorized Job Order before Customer's Info
    // (and everything after it) appears — admin has no Job Order gate and
    // always sees it directly. srRenderJobOrderPicker/srApplyJobOrder
    // re-confirm this on their own paths too; this just sets the sane
    // default whenever the form is reset from anywhere else.
    const sec1 = $('sec1Card');
    if(sec1) sec1.style.display = (currentUser && currentUser.role==='admin') ? '' : 'none';
    ['sec2Card','sec3Card','sec4Card','sec5Card','sec6Card','sec7Card','sec8Card'].forEach(id=>{
      const el = $(id); if(el) el.style.display = 'none';
    });
    $('materialsTableWrap').style.display = 'none';
    collapseAllSections();
    toggleCollapsibleSection($('sec1Head'), true); // keep section 1 (Customer's Info) open — it's the entry point
    if($('srJobOrderHead')) toggleCollapsibleSection($('srJobOrderHead'), true); // keep the Job Order picker open too
    if(sigCustomerPad) sigCustomerPad.clear();
    if(sigTechPad) sigTechPad.clear();
    unlockSignature('sigCustomer'); unlockSignature('sigTech');
    $('sigCustomerPh').style.display='flex'; $('sigTechPh').style.display='flex';
    $('metaDate').textContent = fmtDate($('svcDate').value);
    $('statusPill').textContent='Draft'; $('statusPill').className='status-pill status-draft';
    currentSrNo = null;
    currentTechnicianId = null;
    srCurrentTicketId = null;
    srCurrentEquipId = null;
    srBatchEquipItems = null;
    if($('srBatchBanner')) $('srBatchBanner').style.display = 'none';
    $('metaSrNo').textContent='—';
    clearInvalid();
    applyTechNameDefault();
    srRenderStepper();
  }
  resetForm();
  // ---------- progressive step tracker ----------
  // Same jo-stepper visual language as the Job Order / Cash Advance
  // trackers. Re-rendered at every state change below rather than on every
  // keystroke — resetForm, applying a Job Order (single or batch), signing,
  // and submitting all call this directly.
  function srRenderStepper(){
    const container = $('srStepperContainer');
    if(!container) return;
    const isAdmin = currentUser && currentUser.role==='admin';
    const step1Done = isAdmin || !!srCurrentTicketId;
    const step2Done = step1Done && !!$('custName').value.trim() && !!$('svcDate').value;
    const custSigned = !!(sigCustomerPad && !sigCustomerPad.isEmpty());
    const techSigned = !!(sigTechPad && !sigTechPad.isEmpty());
    const step3Done = step2Done && custSigned && techSigned;
    const step4Done = step3Done && $('statusPill').textContent==='Completed';
    let stage = 0;
    if(step1Done) stage = 1;
    if(step2Done) stage = 2;
    if(step3Done) stage = 3;
    if(step4Done) stage = 4;
    const isBatch = srBatchEquipItems && srBatchEquipItems.length > 1;
    const labels = isBatch
      ? ['Job Order Selected','Details Filled','Signed Once','All Reports Submitted']
      : ['Job Order Selected','Details Filled','Signed','Submitted'];
    const stepsHtml = labels.map((label,i)=>{
      const state = i<stage ? 'done' : (i===stage ? 'current' : 'upcoming');
      return '<div class="jo-step '+state+'">'+
          '<span class="jo-step-line"></span>'+
          '<span class="jo-step-dot">'+(i<stage ? '\u2713' : (i+1))+'</span>'+
          '<span class="jo-step-label">'+label+'</span>'+
        '</div>';
    }).join('');
    let nextText;
    if(step4Done) nextText = isBatch ? 'All reports for this batch were generated.' : 'Report submitted.';
    else if(step3Done) nextText = 'Tap "Generate & Share Report" below to submit'+(isBatch ? ' every report in this batch.' : '.');
    else if(step2Done) nextText = 'Sign in Section 8 to continue (both customer and technician).';
    else if(step1Done) nextText = "Fill in Customer's Information and the sections below.";
    else nextText = 'Select a Job Order above to get started.';
    container.innerHTML = '<div class="jo-stepper">'+
      '<div class="jo-stepper-track">'+stepsHtml+'</div>'+
      '<div class="jo-stepper-next"><b>Next:</b> '+nextText+'</div>'+
    '</div>';
  }
  ['custName','svcDate'].forEach(id=>{ const el = $(id); if(el){ el.addEventListener('input', srRenderStepper); el.addEventListener('change', srRenderStepper); } });
  srRenderStepper();
  // Auto-fills the Technician Name field from the logged-in account (still
  // editable, in case a different technician actually performed the work).
  function applyTechNameDefault(){
    if(currentUser && currentUser.name) $('techName').value = currentUser.name;
  }

  // ---------- validation ----------
  function clearInvalid(){
    document.querySelectorAll('.field.invalid').forEach(f=>f.classList.remove('invalid'));
  }
  function validate(){
    clearInvalid();
    let ok = true;
    if(!$('custName').value.trim()){ $('f_custName').classList.add('invalid'); ok=false; }
    if(!$('svcDate').value){ $('f_date').classList.add('invalid'); ok=false; }
    const email = $('custEmail').value.trim();
    if(!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){ $('f_custEmail').classList.add('invalid'); ok=false; }
    return ok;
  }

  // ---------- gather form data ----------
  function gatherData(){
    const findings = Array.from($('findingsList').querySelectorAll('textarea')).map(t=>t.value.trim()).filter(Boolean);
    const recs = Array.from($('recsList').querySelectorAll('textarea')).map(t=>t.value.trim()).filter(Boolean);
    const servicesDone = Array.from($('servicesDoneList').querySelectorAll('textarea')).map(t=>t.value.trim()).filter(Boolean);
    const materials = Array.from($('materialsBody').querySelectorAll('tr')).map(tr=>({
      description: tr.querySelector('.m-desc').value.trim(),
      qty: tr.querySelector('.m-qty').value.trim(),
      unit: tr.querySelector('.m-unit').value.trim()
    })).filter(r=>r.description||r.qty||r.unit);

    return {
      srNo: currentSrNo,
      technicianId: currentTechnicianId || (currentUser ? currentUser.id : null),
      date: $('svcDate').value,
      custName: $('custName').value.trim(),
      custAddress: $('custAddress').value.trim(),
      contactNo: $('contactNo').value.trim(),
      contactPerson: $('contactPerson').value.trim(),
      equipType: $('equipType').value.trim(), modelCU:$('modelCU').value.trim(), serialCU:$('serialCU').value.trim(),
      modelFCU:$('modelFCU').value.trim(), serialFCU:$('serialFCU').value.trim(),
      coolCap:$('coolCap').value.trim(), mountType:$('mountType').value.trim(),
      brand:$('brand').value.trim(), refrigerantType:$('refrigerantType').value.trim(),
      compressorType:$('compressorType').value.trim(), equipLocation:$('equipLocation').value.trim(),
      troubleCall:$('troubleCall').value.trim(), findings, recs, materials, servicesDone,
      before:{
        amp:[$('b_amp_l1').value,$('b_amp_l2').value,$('b_amp_l3').value],
        volt:[$('b_volt_l12').value,$('b_volt_l23').value,$('b_volt_l31').value],
        pressure:[$('b_press_suction').value,$('b_press_discharge').value],
        temp:$('b_temp').value, airflow:$('b_airflow').value
      },
      after:{
        amp:[$('a_amp_l1').value,$('a_amp_l2').value,$('a_amp_l3').value],
        volt:[$('a_volt_l12').value,$('a_volt_l23').value,$('a_volt_l31').value],
        pressure:[$('a_press_suction').value,$('a_press_discharge').value],
        temp:$('a_temp').value, airflow:$('a_airflow').value
      },
      isInstall: $('isInstallToggle').checked,
      install:{
        pd:[$('pd_suction').value,$('pd_discharge').value,$('pd_drain').value],
        pl:[$('pl_refline').value,$('pl_drain').value],
        ws:[$('ws_feeder').value,$('ws_control').value],
        breaker:$('circuit_breaker').value,
        pi:[$('pi_refline').value,$('pi_drain').value],
        riser:$('riser_height').value, ptrap:$('ptrap').value, bracketType:$('bracketType').value
      },
      timeIn:$('timeIn').value, timeOut:$('timeOut').value, remarks:$('remarks').value.trim(),
      custPrintedName:$('custPrintedName').value.trim(), techName:$('techName').value.trim(),
      custEmail: $('custEmail').value.trim(),
      sigCustomerRaw: sigCustomerPad.isEmpty() ? null : sigCustomerPad.toDataURL('image/png'),
      sigTechRaw: sigTechPad.isEmpty() ? null : sigTechPad.toDataURL('image/png')
    };
  }
  async function gatherDataForOutput(){
    await ensureSignaturePads();
    const data = gatherData();
    data.sigCustomer = data.sigCustomerRaw ? await downscaleDataUrl(data.sigCustomerRaw, 400) : null;
    data.sigTech = data.sigTechRaw ? await downscaleDataUrl(data.sigTechRaw, 400) : null;
    return data;
  }

  // ---------- save draft ----------
  // Returns SAVE_CLOUD / SAVE_QUEUED / SAVE_FAILED so callers stop telling the
  // user "saved" when the write actually failed and nothing was retained.
  // Drafts save locally first when there is no signal, then upload on their
  // own via the outbox (see registerOutboxHandler('report', ...) below) —
  // triggered automatically on 'online', on the app coming back to the
  // foreground, and by the periodic safety-net timer in core.js. "Sync now"
  // just runs that same flush immediately on demand.
  async function saveReport(srNo, data){
    // Resolve (or create) this customer's equipment record FIRST, so its id
    // can be stamped onto the report as equipment_id below — a stable link
    // that survives later edits to the equipment record's own serial/
    // location/etc. fields. Matching by field-value equality (serial number,
    // or location+type when no serial is on file) is fragile: editing a
    // typo'd serial, or adding one for the first time to a unit that had
    // none, silently orphans every report saved before that point (see
    // matchReportHistoryForEquipment in core.js). equipment_id fixes that
    // for every report saved going forward.
    const matchedCustomer = customersCache.find(c=> c.name.toLowerCase() === (data.custName||'').trim().toLowerCase());
    if(matchedCustomer) data.equipmentId = await cloudAddCustomerEquipment(matchedCustomer.id, data);
    let result = SAVE_FAILED;
    if(await ensureCloud() && await cloudSaveReport(srNo, data)) result = SAVE_CLOUD;
    // Keep only the downscaled signatures on disk: the full-resolution raw
    // canvas exports are several hundred KB each and were being persisted for
    // no reason, filling local storage and bloating every upload.
    const persisted = Object.assign({}, data);
    delete persisted.sigCustomerRaw;
    delete persisted.sigTechRaw;
    try{ await window.storage.set('report:'+srNo, JSON.stringify(persisted), false); }
    catch(e){ console.error('local report save failed', e); }
    if(result!==SAVE_CLOUD){
      // Queue it so it uploads by itself the next time there is a connection,
      // instead of living only on this phone until someone reopens it.
      if(await outboxQueue('report', srNo, persisted)) result = SAVE_QUEUED;
    }
    return result;
  }
  registerOutboxHandler('report', async (srNo, payload)=>{
    let finalSr = srNo;
    // A report numbered offline gets a real sequential SR number now that the
    // server is reachable, so provisional ids never reach the shared history.
    if(isProvisionalSrNo(srNo)){
      const real = await cloudNextSrNo((payload.date || todayISO()).replace(/-/g,''));
      if(real) finalSr = real;
    }
    payload.srNo = finalSr;
    const ok = await cloudSaveReport(finalSr, payload);
    if(!ok) throw new Error('report upload failed');
    if(finalSr !== srNo){
      try{
        await window.storage.set('report:'+finalSr, JSON.stringify(payload), false);
        await window.storage.delete('report:'+srNo);
      }catch(e){}
    }
  });
  $('saveDraftBtn').addEventListener('click', async ()=>{
    if(!$('custName').value.trim()){ toast('Add a customer name before saving'); $('f_custName').classList.add('invalid'); return; }
    if(!currentSrNo){ currentSrNo = await nextSrNo(); $('metaSrNo').textContent = currentSrNo; }
    const data = await gatherDataForOutput();
    const res = await saveReport(currentSrNo, data);
    if(res===SAVE_FAILED){ toast('Could not save '+currentSrNo+' — nothing was stored, please try again'); return; }
    toast(res===SAVE_CLOUD
      ? ('Draft saved to shared cloud: '+currentSrNo)
      : ('Draft saved on this device — it will upload automatically when you are online'));
    resetForm();
  });

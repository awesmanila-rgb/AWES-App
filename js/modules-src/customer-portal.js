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
  let cpMyRequestsCache = []; // this customer's service_requests, kept fresh by
                              // cpRefreshRequestsBadge() — feeds the home hero,
                              // the notif bell, and the History screen's
                              // Requests segment so none of them re-fetch it
                              // separately on every render.

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
          .select('id, sr_no, date, cust_name, equipment_id, equip_type, equip_location, model_cu, serial_cu, model_fcu, serial_fcu, trouble_call, remarks, completed, technician_name, findings, recommendations, materials, services_done')
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
    const idTag = escapeHtml(equipDisplayName(eq)) + (eq.photoCount ? ' &nbsp;<span style="display:inline-flex; width:11px; height:11px; vertical-align:-1px;">'+CP_ICON.camera+'</span> '+eq.photoCount : '');
    return (
      '<div class="cp-equip-card" data-equip-id="'+eq.id+'">'+
        '<div class="cp-equip-card-top">'+
          '<div class="cp-equip-icon">'+CP_ICON.unit+'</div>'+
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
      '<div class="cp-row" data-sr-no="'+escapeHtml(r.sr_no||'')+'" data-report-id="'+escapeHtml(r.id||'')+'">'+
        '<div class="cp-row-icon">📄</div>'+
        '<div class="cp-row-body">'+
          '<div class="cp-row-title">'+title+'</div>'+
          '<div class="cp-row-sub">'+sub+'</div>'+
        '</div>'+
        '<div class="cp-row-chev">›</div>'+
      '</div>'
    );
  }

  // ---------- Icons ----------
  // Inline SVG only (no emoji, no icon font) so the redesigned screens read
  // as one consistent system — stroke="currentColor" so each icon just
  // picks up whatever color its container sets.
  const CP_ICON = {
    chat:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>',
    home:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9.5 12 3l9 6.5V21a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z"/></svg>',
    grid:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>',
    clock:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>',
    tools:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2-2z"/></svg>',
    person:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>',
    check:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
    calendar:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/></svg>',
    alert:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 2 20h20L12 3z"/><path d="M12 10v4M12 17h.01"/></svg>',
    unit:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="18" height="9" rx="1.5"/><path d="M7 15v3M17 15v3M3 9h18M6 9V7M10 9V7"/></svg>',
    receipt:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/></svg>',
    history:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5M12 7v5l4 2"/></svg>',
    bolt:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 4 14h6l-1 8 9-12h-6z"/></svg>',
    ruler:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8h18v8H3z"/><path d="M7 8v3M11 8v3M15 8v3"/></svg>',
    piggy:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12a6 6 0 0 1 6-6h4a6 6 0 0 1 0 12v3l-3-2H10a6 6 0 0 1-6-6z"/><circle cx="15" cy="10" r=".6" fill="currentColor"/></svg>',
    leaf:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 21c9 0 14-5 14-14V5h-2C8 5 3 10 3 19z"/></svg>',
    book:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z"/><path d="M19 19H6a2 2 0 0 1 0-4h13"/></svg>',
    chevron:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>',
    pin:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/></svg>',
    search:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>',
    camera:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h3l2-2h6l2 2h3v11H4z"/><circle cx="12" cy="13.5" r="3.5"/></svg>'
  };

  // ---------- Unit card (photo-led, vertical stack) ----------
  // Same card is used on Home (capped list) and the Units screen (full
  // list) — one visual design instead of two, matching this theme's
  // layout. photoMap is an optional {equipmentId: url} lookup (see
  // cpFetchCoverPhotoMap in equipment-photos.js); falls back to the
  // generic tinted unit icon when nothing comes back for a given unit
  // (no cover photo set, or none uploaded yet).
  function cpUnitStateClass(eq){
    if(eq.status.key==='overdue') return 'state-danger';
    if(eq.status.key==='due-soon') return 'state-active';
    if(eq.status.key==='scheduled') return 'state-teal';
    return 'state-good';
  }
  function cpUnitCardHtml(eq, photoMap){
    const stateClass = cpUnitStateClass(eq);
    const name = escapeHtml(equipDisplayName(eq));
    const badgeLabel = eq.status.key==='overdue' ? 'Needs attention' : eq.status.key==='due-soon' ? 'Due soon' : eq.status.key==='scheduled' ? 'Scheduled' : 'Operating well';
    const specLine = [eq.brand, eq.equipType, eq.coolCap].filter(Boolean).map(escapeHtml).join(' · ') || escapeHtml(eq.equipLocation||'—');
    const lastLine = eq.lastReport ? 'Last service '+escapeHtml(fmtDate(eq.lastReport.date)) : 'No service on record yet';
    const photoUrl = photoMap && photoMap[eq.id];
    return (
      '<div class="cp-unit-card '+stateClass+'" data-equip-id="'+eq.id+'">'+
        '<div class="img-wrap">'+
          (photoUrl
            ? '<img src="'+escapeHtml(photoUrl)+'" alt="" loading="lazy">'
            : '<div class="fallback-ic">'+CP_ICON.unit+'</div>')+
          '<span class="cp-unit-badge-corner '+stateClass+'">'+badgeLabel+'</span>'+
        '</div>'+
        '<div class="body">'+
          '<p class="name">'+name+'</p>'+
          '<p class="meta">'+specLine+' · '+lastLine+'</p>'+
          '<div class="foot">'+
            '<span class="cp-unit-badge '+stateClass+'">'+badgeLabel+'</span>'+
            '<a class="view-link">View unit →</a>'+
          '</div>'+
        '</div>'+
      '</div>'
    );
  }

  // ---------- Home hero (state engine) ----------
  // One hero card, one of six looks depending on what's true right now,
  // in this priority order (highest first): a technician-flagged issue
  // (D2/D3) > an overdue unit with no request open yet (D1) > active
  // on-site work (C) > a confirmed upcoming visit (B) > nothing pending (A).
  // Many units + many flagged issues collapses to a summary card instead of
  // picking just one. `rows` is this customer's service_requests (may be
  // empty on the very first paint, before cpRefreshRequestsBadge's fetch
  // resolves — the hero just reflects equipment status alone until then,
  // then re-renders with the fuller picture a moment later).
  function cpEquipLabel(eq){ return eq ? escapeHtml(equipDisplayName(eq)) : 'your unit'; }

  function cpHeroAllClear(){
    return (
      '<div class="cp-hero-allclear">'+
        '<div class="ic">'+CP_ICON.check+'</div>'+
        '<div><p class="cp-hero-name">All clear</p><p class="cp-hero-sub">Nothing needs your attention right now.</p></div>'+
      '</div>'
    );
  }
  function cpHeroScheduled(req, eq){
    const dateStr = req.proposedScheduleDate ? fmtDate(req.proposedScheduleDate) : 'a date to be confirmed';
    const timeStr = req.proposedScheduleTime ? ' · '+escapeHtml(req.proposedScheduleTime) : '';
    return (
      '<div class="cp-hero-scheduled" data-req-id="'+req.id+'">'+
        '<div style="display:flex; align-items:center; gap:12px;">'+
          '<div class="ic">'+CP_ICON.calendar+'</div>'+
          '<div><p class="cp-hero-eyebrow teal">Scheduled</p><p class="cp-hero-name">'+cpEquipLabel(eq)+'</p>'+
          '<p class="cp-hero-sub">'+dateStr+timeStr+'</p></div>'+
        '</div>'+
        '<a data-action="reschedule" style="font-size:12px; font-weight:600; color:var(--teal); cursor:pointer;">Details</a>'+
      '</div>'
    );
  }
  // Deterministic small color per technician so the same person's avatar
  // is always the same color across renders (not random each time).
  const CP_AVATAR_COLORS = ['#154D34','#1F6F7A','#B9791F','#6B4FA0','#2A6FDB'];
  function cpAvatarColor(name){
    let h = 0; for(let i=0;i<name.length;i++) h = (h*31 + name.charCodeAt(i)) >>> 0;
    return CP_AVATAR_COLORS[h % CP_AVATAR_COLORS.length];
  }
  function cpTechAvatarsHtml(names){
    if(!names || !names.length) return '';
    const shown = names.slice(0,2);
    const extra = names.length - shown.length;
    return '<div class="cp-hero-techs">' +
      shown.map(n=> '<div class="cp-hero-tech-avatar" style="background:'+cpAvatarColor(n)+'" title="'+escapeHtml(n)+'">'+escapeHtml((n||'?').trim().charAt(0).toUpperCase())+'</div>').join('') +
      (extra>0 ? '<div class="cp-hero-tech-avatar" style="background:var(--text-muted)">+'+extra+'</div>' : '') +
      '</div>';
  }
  function cpHeroActive(req, eq, techNames){
    const label = srStatusLabel(req.status);
    const techLine = techNames && techNames.length
      ? (techNames.length===1 ? techNames[0]+' is on the way' : techNames.length+' technicians assigned')
      : 'A technician is on the way';
    return (
      '<div data-req-id="'+req.id+'">'+
        '<div class="cp-hero-head">'+
          '<div>'+
            '<p class="cp-hero-eyebrow amber">Active service · '+escapeHtml(label)+'</p>'+
            '<p class="cp-hero-name">'+cpEquipLabel(eq)+'</p>'+
            '<p class="cp-hero-sub">'+escapeHtml(req.description||'Technician assigned')+'</p>'+
          '</div>'+
        '</div>'+
        (techNames && techNames.length ? cpTechAvatarsHtml(techNames) : '')+
        (typeof srProgressStepsHtml === 'function' ? srProgressStepsHtml(req.status) : '')+
        '<div class="cp-hero-foot">'+
          '<span class="loc">'+CP_ICON.pin+' '+escapeHtml(techLine)+'</span>'+
          '<a data-action="message">'+CP_ICON.chat+' Message</a>'+
        '</div>'+
      '</div>'
    );
  }
  function cpHeroDanger(kind, req, eq){
    // kind: 'overdue' (D1, no request open yet) | 'pending' (D2) | 'ready' (D3)
    const cfg = {
      overdue:{ title:'Overdue for service', sub:cpEquipLabel(eq)+' — overdue for preventive maintenance.', cta:'Book service now' },
      pending:{ title:'Issue flagged during last visit', sub:(req&&req.flaggedIssueSummary) || (req&&req.description) || 'A technician noted an issue on '+cpEquipLabel(eq)+'.', cta:null },
      ready:{ title:'Quotation ready for review', sub:'A quote is ready for '+cpEquipLabel(eq)+'.', cta:'Review quotation' }
    }[kind];
    return (
      '<div data-req-id="'+(req?req.id:'')+'" data-equip-id="'+(eq?eq.id:'')+'" data-kind="'+kind+'">'+
        '<div class="cp-hero-danger-body">'+
          '<div class="ic">'+CP_ICON.alert+'</div>'+
          '<div><p class="cp-hero-eyebrow danger">Needs attention</p><p class="cp-hero-name">'+cfg.title+'</p>'+
          '<p class="cp-hero-sub">'+escapeHtml(cfg.sub)+'</p></div>'+
        '</div>'+
        (cfg.cta
          ? '<div class="cp-hero-danger-cta"><button type="button" class="cp-hero-btn danger" data-action="'+kind+'">'+cfg.cta+'</button></div>'
          : '<div class="cp-hero-muted-note">We\'ll notify you as soon as a quotation is ready.</div>')+
      '</div>'
    );
  }
  function cpHeroSummary(count, kind){
    // Many units flagged at once (property-management scale case) — link
    // out to Units (filtered mentally by the person, no separate filtered
    // view built yet) rather than trying to pick just one to feature.
    const label = kind==='danger' ? count+' units need attention' : count+' units in service today';
    const eyebrowClass = kind==='danger' ? 'danger' : 'amber';
    return (
      '<div data-action="viewUnits">'+
        '<div class="cp-hero-danger-body">'+
          '<div class="ic">'+CP_ICON.alert+'</div>'+
          '<div><p class="cp-hero-eyebrow '+eyebrowClass+'">Across your units</p><p class="cp-hero-name">'+label+'</p>'+
          '<p class="cp-hero-sub">Tap to see which units and what\'s needed.</p></div>'+
        '</div>'+
      '</div>'
    );
  }

  function cpFindEquip(id){ return cpEquipment.find(e=> String(e.id)===String(id)); }

  async function renderCustomerHero(rows){
    const hero = $('cpHero');
    if(!hero) return;
    rows = rows || [];

    const flagged = rows.filter(r=> r.origin==='technician_flag' && !['completed','cancelled','dispatched','in_progress'].includes(r.status));
    const active = rows.filter(r=> r.status==='dispatched' || r.status==='in_progress');
    const overdueNoRequest = cpEquipment.filter(eq=>{
      if(eq.status.key!=='overdue') return false;
      return !rows.some(r=> String(r.equipmentId)===String(eq.id) && r.status!=='completed' && r.status!=='cancelled');
    });
    const scheduled = rows.filter(r=> r.status==='schedule_confirmed');

    let html, danger = false;
    if(flagged.length > 1 || overdueNoRequest.length + flagged.length > 1){
      // More than one thing needs attention at once — summarize rather
      // than arbitrarily feature one unit over another.
      html = cpHeroSummary(flagged.length + overdueNoRequest.length, 'danger'); danger = true;
    } else if(flagged.length === 1){
      const req = flagged[0];
      const ready = req.feeStatus === 'proposed';
      html = cpHeroDanger(ready ? 'ready' : 'pending', req, cpFindEquip(req.equipmentId)); danger = true;
    } else if(overdueNoRequest.length === 1){
      html = cpHeroDanger('overdue', null, overdueNoRequest[0]); danger = true;
    } else if(active.length > 0){
      // Technician names live on the linked dispatch ticket, not the
      // request row itself — a separate fetch, so the hero shows without
      // them for a moment on first paint, then fills in.
      const techNames = (active[0].linkedDispatchTicketId && typeof dtFetchTicketTechNames==='function')
        ? await dtFetchTicketTechNames(active[0].linkedDispatchTicketId) : [];
      html = cpHeroActive(active[0], cpFindEquip(active[0].equipmentId), techNames);
    } else if(scheduled.length > 0){
      html = cpHeroScheduled(scheduled[0], cpFindEquip(scheduled[0].equipmentId));
    } else {
      html = cpHeroAllClear();
    }

    hero.className = 'cp-hero' + (danger ? ' cp-hero-danger' : '');
    hero.innerHTML = html;
    hero.onclick = (e)=>{
      const actionEl = e.target.closest('[data-action]');
      const action = actionEl ? actionEl.dataset.action : null;
      if(action==='overdue'){ const eq = overdueNoRequest[0]; if(eq) cpRequestServiceForEquip(eq); return; }
      if(action==='ready'){ if(flagged[0] && typeof srOpenDetail==='function') srOpenDetail(flagged[0]); return; }
      if(action==='message'){ if(active[0] && typeof srOpenDetail==='function') srOpenDetail(active[0]); return; }
      if(action==='reschedule'){ if(scheduled[0] && typeof srOpenDetail==='function') srOpenDetail(scheduled[0]); return; }
      if(action==='viewUnits'){ cpShowScreen('Units'); return; }
      // Tap anywhere else on the card: open whichever single job it
      // represents, if any (all-clear has nothing to open).
      if(active[0] && typeof srOpenDetail==='function') srOpenDetail(active[0]);
      else if(scheduled[0] && typeof srOpenDetail==='function') srOpenDetail(scheduled[0]);
      else if(flagged[0] && typeof srOpenDetail==='function') srOpenDetail(flagged[0]);
    };
  }

  function renderCustomerHome(){
    // Header
    $('cpGreetSub').textContent = cpEquipment.length
      ? cpEquipment.length+' unit'+(cpEquipment.length===1?'':'s')+' enrolled'
      : 'No units enrolled yet';
    const initials = (currentUser && currentUser.name ? currentUser.name.trim().charAt(0) : '?').toUpperCase();
    if($('cpAvatarBtn')) $('cpAvatarBtn').textContent = initials;

    // Hero — initial pass off equipment status alone; cpRefreshRequestsBadge
    // (fired below) re-renders it a moment later with request data too.
    renderCustomerHero(cpMyRequestsCache);

    // Unit stack — most-attention-needed first, capped at 3 on Home with a
    // "Manage units" link into the full Units screen (see
    // cpUnitsSectionTitle below for the many-units retitle). Cover photos
    // are fetched in one batch and swapped in once they arrive — the
    // stack renders immediately with icon fallbacks so photos loading
    // slowly never blocks the rest of the screen.
    const sorted = cpEquipment.slice().sort((a,b)=>{
      const rank = { overdue:0, 'due-soon':1, scheduled:2, none:3 };
      return (rank[a.status.key]??3) - (rank[b.status.key]??3);
    });
    const shown = sorted.slice(0,3);
    const flaggedCount = cpEquipment.filter(e=> e.status.key==='overdue' || e.status.key==='due-soon').length;
    $('cpUnitsSectionTitle').textContent = flaggedCount>1 ? 'Units needing attention' : 'Your units';
    function paintUnitStack(photoMap){
      $('cpUnitScroll').innerHTML = shown.length
        ? shown.map(eq=> cpUnitCardHtml(eq, photoMap)).join('')
        : '<div class="empty-state">No equipment enrolled yet.</div>';
      $$('.cp-unit-card', $('cpUnitScroll')).forEach(card=>{
        card.onclick = ()=>{ const eq = cpFindEquip(card.dataset.equipId); if(eq) openCustomerEquipmentDetail(eq); };
      });
    }
    paintUnitStack({});
    if(shown.length && typeof cpFetchCoverPhotoMap === 'function'){
      cpFetchCoverPhotoMap(shown.map(eq=>eq.id)).then(paintUnitStack);
    }

    // Quick actions — four real destinations only; nothing here is
    // fabricated (no separate "Invoices" tile, since there's no invoicing
    // feature distinct from the fee already shown on a request/billing
    // card — see cpQuickQuotes below).
    $('cpQuickUnits').innerHTML = ''+CP_ICON.grid+'<p class="t">My units</p><p class="s">'+cpEquipment.length+' enrolled</p>';
    $('cpQuickUnits').onclick = ()=> cpShowScreen('Units');
    const quoteCount = cpMyRequestsCache.filter(r=> r.feeAmount!=null).length;
    $('cpQuickQuotes').innerHTML = ''+CP_ICON.receipt+'<p class="t">Quotes &amp; invoices</p><p class="s">'+(quoteCount ? quoteCount+' on file' : 'None yet')+'</p>';
    $('cpQuickQuotes').onclick = ()=> cpShowScreen('History', 'Requests');
    $('cpQuickHistory').innerHTML = ''+CP_ICON.history+'<p class="t">Full history</p><p class="s">'+(cpReports.length ? cpReports.length+' visits' : 'No visits yet')+'</p>';
    $('cpQuickHistory').onclick = ()=> cpShowScreen('History', 'Visits');
    $('cpQuickHelp').innerHTML = ''+CP_ICON.chat+'<p class="t">Get help</p><p class="s">Message us</p>';
    // No standalone support inbox exists yet (see the chat-model note on
    // cpNotifBell) — "Get help" opens the same request form as "Book a
    // service" so a person can describe their situation either way,
    // rather than promising a contact channel that isn't built.
    $('cpQuickHelp').onclick = ()=>{ if(typeof cpShowRequestsScreen === 'function') cpShowRequestsScreen(); };

    // Billing — a real fee amount if one exists (accepted or awaiting the
    // customer's response), never a fabricated invoice. Hidden entirely
    // otherwise; "Pay now" is a placeholder since no payment gateway is
    // wired up.
    const billed = cpMyRequestsCache.find(r=> r.feeAmount!=null && r.status!=='completed' && r.status!=='cancelled');
    const billingCard = $('cpBillingCard');
    if(billed){
      $('cpBillingLabel').textContent = '₱'+billed.feeAmount;
      $('cpBillingSub').textContent = billed.feeStatus==='proposed' ? 'Awaiting your review' : 'Service fee';
      billingCard.style.display = '';
      billingCard.onclick = null;
      $('cpBillingPayBtn').onclick = (e)=>{ e.stopPropagation(); toast('Online payments — coming soon'); };
    } else {
      billingCard.style.display = 'none';
    }

    // Recent activity — last 3 reports, newest first (already sorted by
    // loadCustomerPortalData's query).
    $('cpActivityFullHistoryLink').onclick = ()=> cpShowScreen('History', 'Visits');
    $('cpRecentActivity').innerHTML = cpReports.length
      ? cpReports.slice(0,3).map(r=>{
          const title = escapeHtml((r.trouble_call && r.trouble_call.trim()) ? r.trouble_call : (r.equip_type||'Service visit'));
          const warn = !!(r.trouble_call && r.trouble_call.trim());
          return '<div class="cp-activity-row" data-sr-no="'+escapeHtml(r.sr_no||'')+'" data-report-id="'+escapeHtml(r.id||'')+'">'+
            '<span class="cp-activity-dot'+(warn?' warn':'')+'"></span>'+
            '<div><p class="t">'+title+'</p><p class="s">'+escapeHtml(r.equip_location||'')+'</p></div>'+
            '<span class="date">'+fmtDate(r.date)+'</span>'+
          '</div>';
        }).join('')
      : '<div class="empty-state">No activity yet.</div>';
    $$('.cp-activity-row', $('cpRecentActivity')).forEach(row=>{
      row.onclick = ()=>{
        const sr = row.dataset.srNo, reportId = row.dataset.reportId;
        if((sr||reportId) && typeof openCustomerReportPreview==='function') openCustomerReportPreview(sr, reportId);
      };
    });

    if(cpCustomer && cpCustomer.id) cpRefreshRequestsBadge(cpCustomer.id);
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
    $('cpUnitScroll').innerHTML = '<div class="empty-state">Loading…</div>';
    $('cpRecentActivity').innerHTML = '<div class="empty-state">Loading…</div>';
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
    // The service-request detail overlay is shared with admin (see
    // srOpenDetail/srCloseDetail in service-requests.js) and can be left
    // open on logout too — close it so its own message-thread channel
    // doesn't keep running past this session.
    if(typeof srCloseDetail === 'function') srCloseDetail();
  }

  // "My Requests" data refresh — feeds the notif bell, the home hero, and
  // (when that screen is open) the History screen's Requests segment.
  async function cpRefreshRequestsBadge(customerId){
    const rows = await srListForCustomer(customerId);
    cpMyRequestsCache = rows;
    cpRefreshNotifBell(rows);
    renderCustomerHero(rows);
  }

  // Header chat/notification icon — doubles as the entry point into
  // messaging, since every job's thread lives inside its service_request's
  // detail overlay (srOpenDetail/srMsgList) rather than a separate global
  // inbox — there's no messaging model in this app that isn't tied to a
  // specific request yet. Badged whenever something is waiting on the
  // customer specifically (a fee proposed, or a schedule proposed).
  function cpRefreshNotifBell(rows){
    const bell = $('cpNotifBell');
    if(!bell) return;
    const needsAttention = rows.filter(r=> r.feeStatus==='proposed' || r.status==='schedule_proposed').length;
    bell.style.display = '';
    bell.innerHTML = CP_ICON.chat + (needsAttention>0 ? '<span class="cp-badge-dot"></span>' : '');
  }
  $('cpNotifBell').addEventListener('click', ()=> cpShowScreen('History', 'Requests'));
  $('cpAvatarBtn').addEventListener('click', ()=> cpShowScreen('Profile'));

  // ---------- Request Service (customer-side) ----------
  // New Request form + My Requests history, reached via custNavRequests or
  // cpRequestServiceBtn (see customer-equipment-history.js wiring). Backend
  // functions (srCreate, srListForCustomer, srStatusLabel) live in
  // service-requests.js — this is just the customer-facing screen.
  function cpShowRequestsScreen(){
    $('customerHomeScreen').style.display = 'none';
    $('customerEquipmentDetailScreen').style.display = 'none';
    $('customerUnitsScreen').style.display = 'none';
    $('customerHistoryScreen').style.display = 'none';
    $('customerToolsScreen').style.display = 'none';
    $('customerCalcScreen').style.display = 'none';
    $('customerProfileScreen').style.display = 'none';
    $('customerRequestsScreen').style.display = '';
    cpReqShowTab('new');
    cpPopulateReqEquipmentOptions();
    cpRenderMyRequests(currentUser.customerId);
    window.scrollTo({top:0});
  }
  // Opens the New Request form with a specific unit already selected —
  // called from the "＋ Request Service for This Unit" button on the
  // equipment detail page (customer-equipment-history.js).
  function cpRequestServiceForEquip(eq){
    cpShowRequestsScreen();
    $('cpReqEquipment').value = eq.id;
  }
  $('cpDetailRequestServiceBtn').addEventListener('click', ()=>{
    if(cpDetailEquip && typeof cpRequestServiceForEquip === 'function') cpRequestServiceForEquip(cpDetailEquip);
  });
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
  // Takes the full request (not just .status) because a fee_proposed row
  // reads very differently depending on feeStatus: 'proposed' means a price
  // is genuinely waiting on the customer to review (needs-attention red,
  // same as home-screen state D3), while 'declined' just means it looped
  // back to admin to try again (same "in the queue" teal as a brand-new
  // request). Colors follow the same rule as the home screen hero:
  //   teal   = in the queue / waiting, nothing wrong yet
  //   red    = the customer specifically needs to do something now
  //   amber  = a technician is actively on the job right now
  //   green  = done
  //   gray   = closed (cancelled) — not a problem for the customer anymore
  function cpReqStatusPillClass(r){
    if(r.status==='completed') return 'status-sr-done';
    if(r.status==='cancelled') return 'status-sr-cancelled';
    if(r.status==='dispatched' || r.status==='in_progress') return 'status-sr-active';
    if(r.status==='fee_proposed' && r.feeStatus==='proposed') return 'status-sr-urgent';
    return 'status-sr-open'; // new, acknowledged, fee_accepted, schedule_proposed/confirmed, or a declined fee back with admin
  }
  function cpReqRowHtml(r){
    // "General inquiry" only when the customer genuinely didn't pick a
    // unit (equipmentId null). If they did pick one but it's not found in
    // cpEquipment (e.g. it was later merged/removed), say so distinctly —
    // showing "General inquiry" in that case would misrepresent what they
    // actually submitted.
    let eqLabel;
    if(!r.equipmentId){
      eqLabel = 'General inquiry';
    } else {
      const eq = cpEquipment.find(e=> String(e.id)===String(r.equipmentId));
      eqLabel = eq ? escapeHtml(equipDisplayName(eq)) : 'Selected equipment';
    }
    return (
      '<div class="cp-row" style="align-items:flex-start;" data-req-id="'+r.id+'">'+
        '<div class="cp-row-icon">🛠️</div>'+
        '<div class="cp-row-body">'+
          '<div class="cp-row-title">'+eqLabel+'</div>'+
          '<div class="cp-row-sub">'+escapeHtml(r.description||'')+'</div>'+
          '<div class="cp-row-sub">'+fmtDateTime(r.createdAt)+
            (r.feeAmount!=null ? ' · Quote: ₱'+escapeHtml(String(r.feeAmount)) : '')+'</div>'+
        '</div>'+
        '<span class="status-pill '+cpReqStatusPillClass(r)+'">'+escapeHtml(srStatusLabel(r.status))+'</span>'+
      '</div>'
    );
  }
  async function cpRenderMyRequests(customerId, targetId){
    const list = $(targetId || 'cpReqHistoryList');
    if(!list || !customerId) return;
    const rows = await srListForCustomer(customerId);
    cpMyRequestsCache = rows;
    list.innerHTML = rows.length
      ? rows.map(cpReqRowHtml).join('')
      : '<div class="empty-state">No service requests yet.</div>';
    $$('.cp-row', list).forEach(row=>{
      row.style.cursor = 'pointer';
      row.onclick = ()=>{
        const req = rows.find(r=> String(r.id)===row.dataset.reqId);
        if(req && typeof srOpenDetail === 'function') srOpenDetail(req);
      };
    });
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
      requestedDate: $('cpReqDate').value || null,
      accessGatePass: $('cpReqAccessGatePass').checked,
      accessLadder: $('cpReqAccessLadder').checked,
      accessWorkPermit: $('cpReqAccessWorkPermit').checked,
      accessOthers: $('cpReqAccessOthers').checked,
      accessOthersDetail: $('cpReqAccessOthersDetail').value.trim() || null,
      contactPerson: $('cpReqContactPerson').value.trim() || null,
      contactNumber: $('cpReqContactNumber').value.trim() || null
    });
    $('cpReqSubmitBtn').disabled = false; $('cpReqSubmitBtn').textContent = 'Submit Request';
    if(!result){ toast('Could not submit — check your connection and try again'); return; }
    toast('Request submitted — we\'ll be in touch');
    $('cpReqDescription').value = '';
    $('cpReqUrgency').value = 'normal';
    $('cpReqDate').value = '';
    $('cpReqEquipment').value = '';
    ['cpReqAccessGatePass','cpReqAccessLadder','cpReqAccessWorkPermit','cpReqAccessOthers'].forEach(id=> $(id).checked=false);
    $('cpReqAccessOthersDetail').value = '';
    $('cpReqAccessOthersDetailWrap').style.display = 'none';
    $('cpReqContactPerson').value = '';
    $('cpReqContactNumber').value = '';
    cpReqShowTab('history');
    cpRenderMyRequests(currentUser.customerId);
    cpRefreshRequestsBadge(currentUser.customerId);
  }
  $('cpReqBackBtn').addEventListener('click', ()=>{ if(typeof showCustomerHome === 'function') showCustomerHome(); });
  $('cpReqTabNew').addEventListener('click', ()=> cpReqShowTab('new'));
  $('cpReqTabHistory').addEventListener('click', ()=>{ cpReqShowTab('history'); cpRenderMyRequests(currentUser.customerId); });
  $('cpReqSubmitBtn').addEventListener('click', cpSubmitRequest);
  $('cpReqAccessOthers').addEventListener('change', function(){
    $('cpReqAccessOthersDetailWrap').style.display = this.checked ? '' : 'none';
  });

  // ---------- Shared nav (bottom tabs mobile / top bar desktop) ----------
  const CP_NAV_ITEMS = [
    { screen:'Home', id:'cpNavHome', icon:'home' },
    { screen:'Units', id:'cpNavUnits', icon:'grid' },
    { screen:'History', id:'cpNavHistory', icon:'clock' },
    { screen:'Tools', id:'cpNavTools', icon:'tools' },
    { screen:'Profile', id:'cpNavProfile', icon:'person' }
  ];
  function cpInitNav(){
    CP_NAV_ITEMS.forEach(item=>{
      const btn = $(item.id);
      if(!btn) return;
      btn.innerHTML = CP_ICON[item.icon]+'<span>'+item.screen+'</span>';
      btn.addEventListener('click', ()=> cpShowScreen(item.screen));
    });
  }
  function cpSetNavActive(screen){
    CP_NAV_ITEMS.forEach(item=> { const btn = $(item.id); if(btn) btn.classList.toggle('active', item.screen===screen); });
  }

  // Central router for the five redesigned screens. `sub` is an optional
  // sub-selection some screens understand (History's 'Visits'/'Requests'
  // segment). Always routes through showCustomerHome() first so the very
  // long "hide every other view" list only needs to live in one place
  // (customer-equipment-history.js) — this just re-shows a different
  // screen than Home immediately after.
  function cpShowScreen(screen, sub){
    showCustomerHome();
    if(screen==='Home') return;
    $('customerHomeScreen').style.display = 'none';
    cpSetNavActive(screen);
    if(screen==='Units'){ $('customerUnitsScreen').style.display = ''; renderCustomerUnitsScreen(); }
    else if(screen==='History'){ $('customerHistoryScreen').style.display = ''; renderCustomerHistoryScreen(sub); }
    else if(screen==='Tools'){ $('customerToolsScreen').style.display = ''; renderCustomerToolsScreen(); }
    else if(screen==='Profile'){ $('customerProfileScreen').style.display = ''; renderCustomerProfileScreen(); }
    window.scrollTo({top:0});
  }

  // ---------- Units screen (full grid) ----------
  function renderCustomerUnitsScreen(){
    $('cpUnitsScreenSub').textContent = cpEquipment.length+' unit'+(cpEquipment.length===1?'':'s')+' enrolled';
    function paint(photoMap){
      $('cpUnitsGrid').innerHTML = cpEquipment.length
        ? cpEquipment.map(eq=> cpUnitCardHtml(eq, photoMap)).join('')
        : '<div class="empty-state">No equipment enrolled yet.</div>';
      $$('.cp-unit-card', $('cpUnitsGrid')).forEach(card=>{
        card.onclick = ()=>{ const eq = cpFindEquip(card.dataset.equipId); if(eq) openCustomerEquipmentDetail(eq); };
      });
    }
    paint({});
    if(cpEquipment.length && typeof cpFetchCoverPhotoMap === 'function'){
      cpFetchCoverPhotoMap(cpEquipment.map(eq=>eq.id)).then(paint);
    }
  }

  // ---------- History screen (segmented Visits / Requests) ----------
  function cpHistShowSeg(seg){
    $('cpHistTabVisits').classList.toggle('active', seg==='Visits');
    $('cpHistTabRequests').classList.toggle('active', seg==='Requests');
    $('cpHistVisitsPanel').style.display = seg==='Visits' ? '' : 'none';
    $('cpHistRequestsPanel').style.display = seg==='Requests' ? '' : 'none';
  }
  function renderCustomerHistoryScreen(sub){
    cpHistShowSeg(sub==='Requests' ? 'Requests' : 'Visits');
    $('cpHistVisitsList').innerHTML = cpReports.length
      ? cpReports.map(cpReportRowHtml).join('')
      : '<div class="empty-state">No service reports yet.</div>';
    $$('.cp-row', $('cpHistVisitsList')).forEach(row=>{
      row.style.cursor = 'pointer';
      row.onclick = ()=>{
        const sr = row.dataset.srNo, reportId = row.dataset.reportId;
        if((sr||reportId) && typeof openCustomerReportPreview==='function') openCustomerReportPreview(sr, reportId);
      };
    });
    if(currentUser && currentUser.customerId) cpRenderMyRequests(currentUser.customerId, 'cpHistRequestsList');
  }
  $('cpHistTabVisits').addEventListener('click', ()=> cpHistShowSeg('Visits'));
  $('cpHistTabRequests').addEventListener('click', ()=> cpHistShowSeg('Requests'));

  // ---------- Tools & learning ----------
  // Kept intentionally simple v1 calculators — real formulas, no account
  // data required — plus a short reference-guide article list. Both lists
  // are static content owned here; extend CP_CALCULATORS/CP_ARTICLES to add
  // more without touching the screen-rendering code below.
  const CP_CALCULATORS = [
    { id:'electricity', icon:'bolt', title:'Electricity cost', desc:'Estimate monthly running cost from your unit\'s capacity and hours used.' },
    { id:'capacity', icon:'ruler', title:'Capacity guide', desc:'How many HP/kW you need for a room of a given size.' },
    { id:'savings', icon:'piggy', title:'Maintenance savings', desc:'What regular PM saves you vs. reactive repairs over a year.' }
  ];
  const CP_ARTICLES = [
    { id:'filter', icon:'leaf', title:'Cleaning your air filter', desc:'A simple monthly habit that keeps your unit efficient.' },
    { id:'signs', icon:'alert', title:'Signs your unit needs service', desc:'What to watch and listen for between PM visits.' },
    { id:'pm', icon:'calendar', title:'Why preventive maintenance matters', desc:'What a PM visit actually covers, and how often you need one.' }
  ];
  function renderCustomerToolsScreen(){
    $('cpCalcGrid').innerHTML = CP_CALCULATORS.map(c=>
      '<button type="button" class="cp-tool-card" data-calc="'+c.id+'">'+
        '<div class="ic">'+CP_ICON[c.icon]+'<p class="t">'+c.title+'</p><p class="d">'+c.desc+'</p>'+
      '</button>'
    ).join('');
    $$('.cp-tool-card', $('cpCalcGrid')).forEach(btn=> btn.onclick = ()=> cpOpenCalc(btn.dataset.calc));
    $('cpArticleList').innerHTML = CP_ARTICLES.map(a=>
      '<button type="button" class="cp-article-row" data-article="'+a.id+'">'+
        '<div class="ic">'+CP_ICON[a.icon]+'</div>'+
        '<div><p class="t">'+a.title+'</p><p class="d">'+a.desc+'</p></div>'+
        '<span class="chev">'+CP_ICON.chevron+'</span>'+
      '</button>'
    ).join('');
    $$('.cp-article-row', $('cpArticleList')).forEach(btn=> btn.onclick = ()=> cpOpenArticle(btn.dataset.article));
  }
  $('cpToolsSearch').addEventListener('input', function(){
    const q = this.value.trim().toLowerCase();
    $$('.cp-tool-card', $('cpCalcGrid')).forEach(el=> el.style.display = el.textContent.toLowerCase().includes(q) ? '' : 'none');
    $$('.cp-article-row', $('cpArticleList')).forEach(el=> el.style.display = el.textContent.toLowerCase().includes(q) ? '' : 'none');
  });

  function cpShowCalcScreen(){
    $('customerToolsScreen').style.display = 'none';
    $('customerCalcScreen').style.display = '';
    window.scrollTo({top:0});
  }
  $('cpCalcBackBtn').addEventListener('click', ()=>{
    $('customerCalcScreen').style.display = 'none';
    $('customerToolsScreen').style.display = '';
  });

  function cpOpenArticle(id){
    const a = CP_ARTICLES.find(x=> x.id===id);
    if(!a) return;
    $('cpCalcBody').innerHTML =
      '<h2 style="font-size:15px; margin:0 0 10px;">'+a.title+'</h2>'+
      '<p style="font-size:13px; color:var(--text-muted); line-height:1.6;">'+a.desc+'</p>'+
      '<p style="font-size:13px; line-height:1.6; margin-top:12px;">Full guide content — coming soon. In the meantime, if you\'re unsure about anything with your unit, request a visit and a technician can walk you through it on-site.</p>';
    cpShowCalcScreen();
  }

  // Every calculator follows the same shape: render inputs + a live
  // result, recompute on any input change. Kept as one function per tool
  // rather than a generic config-driven form, since each one's inputs and
  // formula are different enough that a generic version would be harder
  // to read than just writing the three out.
  function cpOpenCalc(id){
    if(id==='electricity') return cpCalcElectricity();
    if(id==='capacity') return cpCalcCapacity();
    if(id==='savings') return cpCalcSavings();
  }
  function cpCalcElectricity(){
    $('cpCalcBody').innerHTML =
      '<h2 style="font-size:15px; margin:0 0 12px;">Electricity cost</h2>'+
      '<div class="field"><label>Unit capacity (HP)</label><input type="number" id="ceHp" value="1.5" step="0.5" min="0.5"></div>'+
      '<div class="field"><label>Hours used per day</label><input type="number" id="ceHours" value="8" min="0"></div>'+
      '<div class="field"><label>Rate (₱ per kWh)</label><input type="number" id="ceRate" value="12" step="0.5" min="0"></div>'+
      '<div class="cp-calc-result"><p class="n" id="ceResult">—</p><p class="l">Estimated cost per month</p></div>'+
      '<p style="font-size:11px; color:var(--text-muted); margin-top:10px;">Rough estimate — actual draw varies by brand, inverter type, and set temperature.</p>';
    const calc = ()=>{
      const hp = parseFloat($('ceHp').value)||0, hours = parseFloat($('ceHours').value)||0, rate = parseFloat($('ceRate').value)||0;
      const kw = hp * 0.746; // approx kW per HP
      const monthly = kw * hours * 30 * rate;
      $('ceResult').textContent = '₱'+monthly.toLocaleString(undefined,{maximumFractionDigits:0});
    };
    ['ceHp','ceHours','ceRate'].forEach(id=> $(id).addEventListener('input', calc));
    calc();
    cpShowCalcScreen();
  }
  function cpCalcCapacity(){
    $('cpCalcBody').innerHTML =
      '<h2 style="font-size:15px; margin:0 0 12px;">Capacity guide</h2>'+
      '<div class="field"><label>Room floor area (sqm)</label><input type="number" id="ccArea" value="15" min="1"></div>'+
      '<div class="cp-calc-result"><p class="n" id="ccResult">—</p><p class="l">Suggested capacity</p></div>'+
      '<p style="font-size:11px; color:var(--text-muted); margin-top:10px;">General guide only — ceiling height, sun exposure, and occupancy change the ideal size. A technician can confirm on-site.</p>';
    const calc = ()=>{
      const area = parseFloat($('ccArea').value)||0;
      let hp;
      if(area<=10) hp = 0.75; else if(area<=15) hp = 1.0; else if(area<=20) hp = 1.5; else if(area<=28) hp = 2.0; else if(area<=35) hp = 2.5; else hp = 3.0;
      $('ccResult').textContent = hp+' HP';
    };
    $('ccArea').addEventListener('input', calc);
    calc();
    cpShowCalcScreen();
  }
  function cpCalcSavings(){
    $('cpCalcBody').innerHTML =
      '<h2 style="font-size:15px; margin:0 0 12px;">Maintenance savings</h2>'+
      '<div class="field"><label>Number of units</label><input type="number" id="csUnits" value="'+(cpEquipment.length||1)+'" min="1"></div>'+
      '<div class="field"><label>PM visits per year, per unit</label><input type="number" id="csVisits" value="2" min="1"></div>'+
      '<div class="field"><label>Typical PM cost per visit (₱)</label><input type="number" id="csPmCost" value="1500" min="0"></div>'+
      '<div class="field"><label>Typical reactive repair cost (₱)</label><input type="number" id="csRepairCost" value="8000" min="0"></div>'+
      '<div class="cp-calc-result"><p class="n" id="csResult">—</p><p class="l">Estimated yearly savings vs. skipping PM</p></div>'+
      '<p style="font-size:11px; color:var(--text-muted); margin-top:10px;">Assumes one avoided major repair per unit per year without regular PM — a common, conservative rule of thumb, not a guarantee.</p>';
    const calc = ()=>{
      const units = parseFloat($('csUnits').value)||0, visits = parseFloat($('csVisits').value)||0;
      const pmCost = parseFloat($('csPmCost').value)||0, repairCost = parseFloat($('csRepairCost').value)||0;
      const pmTotal = units * visits * pmCost;
      const avoidedRepairs = units * repairCost;
      const savings = avoidedRepairs - pmTotal;
      $('csResult').textContent = '₱'+Math.max(0,savings).toLocaleString(undefined,{maximumFractionDigits:0});
    };
    ['csUnits','csVisits','csPmCost','csRepairCost'].forEach(id=> $(id).addEventListener('input', calc));
    calc();
    cpShowCalcScreen();
  }

  // ---------- Profile screen ----------
  function renderCustomerProfileScreen(){
    const name = (currentUser && currentUser.name) || 'there';
    $('cpProfileAvatar').textContent = name.trim().charAt(0).toUpperCase() || '?';
    $('cpProfileName').textContent = name;
    $('cpProfileSub').textContent = (cpCustomer && cpCustomer.name) ? cpCustomer.name : '';
    const field = $('cpProfileSwitcherField');
    const sel = $('cpProfileSwitcher');
    const list = (currentUser && currentUser.customerList) || [];
    if(list.length > 1){
      field.style.display = '';
      sel.innerHTML = list.map(c=> '<option value="'+c.id+'" '+(String(c.id)===String(currentUser.customerId)?'selected':'')+'>'+escapeHtml(c.name)+'</option>').join('');
      sel.onchange = (e)=> cpSwitchActiveCustomer(e.target.value);
    } else {
      field.style.display = 'none';
    }
  }
  $('cpProfileRowRequests').addEventListener('click', ()=> cpShowScreen('History', 'Requests'));
  $('cpProfileRowLogout').addEventListener('click', ()=>{ if(typeof doLogout==='function') doLogout(); });

  // ---------- Wire the pieces the old sidebar used to own ----------
  $('cpRequestServiceBtn').addEventListener('click', ()=>{
    if(typeof cpShowRequestsScreen === 'function') cpShowRequestsScreen();
  });
  $('cpUnitsViewAllLink').addEventListener('click', (e)=>{ e.preventDefault(); cpShowScreen('Units'); });
  cpInitNav();

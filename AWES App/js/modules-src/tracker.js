// ---------- Real-time technician location tracker (table: technician_locations) ----------
  // Two halves living in one module:
  //   1. Technician side — while timed in (regular shift or overtime — see
  //      dtrIsOnClock() in history.js), the device pushes its own position
  //      (never anyone else's; RLS ties every write to auth.uid()). Starts on
  //      DTR Time In / OT Time In, stops on DTR Time Out / OT Time Out, and
  //      always stops on logout as a backstop. Nothing is tracked before
  //      time-in, between a regular time-out and an overtime time-in, or
  //      after the day's final time-out.
  //   2. Admin side — a live map on the Home → Overview screen showing every
  //      technician currently sharing a position, refreshed by Supabase
  //      Realtime the instant a row changes, with a 20s poll as a fallback
  //      for a flaky connection. Tapping a technician's name also draws
  //      their movement trail for the day from technician_location_history.

  // ---- Technician: broadcast my position ----
  let trackerWatchId = null;
  let trackerLastSentAt = 0;
  let trackerLastSentPos = null; // {lat,lng}
  const TRACKER_MIN_INTERVAL_MS = 20000; // never push more than once per 20s...
  const TRACKER_MIN_MOVE_METERS = 25;    // ...unless the technician has moved at least this far

  function trackerHaversineMeters(a, b){
    if(!a || !b) return Infinity;
    const R = 6371000;
    const toRad = d => d * Math.PI / 180;
    const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
    const s = Math.sin(dLat/2)**2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng/2)**2;
    return 2 * R * Math.asin(Math.sqrt(s));
  }

  async function trackerPushLocation(pos){
    // Re-check the role on every callback, not just at watch-start — a stale
    // watcher left running past a role change should never write as someone
    // it no longer is.
    if(!currentUser || currentUser.role !== 'tech') return;
    const now = Date.now();
    const here = { lat: pos.coords.latitude, lng: pos.coords.longitude };
    const moved = trackerHaversineMeters(trackerLastSentPos, here);
    if(now - trackerLastSentAt < TRACKER_MIN_INTERVAL_MS && moved < TRACKER_MIN_MOVE_METERS) return;
    trackerLastSentAt = now;
    trackerLastSentPos = here;

    const point = {
      technician_id: currentUser.id,
      lat: here.lat, lng: here.lng,
      accuracy: pos.coords.accuracy != null ? pos.coords.accuracy : null,
      heading: (pos.coords.heading == null || isNaN(pos.coords.heading)) ? null : pos.coords.heading,
      speed: (pos.coords.speed == null || isNaN(pos.coords.speed)) ? null : pos.coords.speed,
      recorded_at: new Date(now).toISOString()
    };

    if(await ensureCloud()){
      try{ await trackerWritePoint(point); return; }
      catch(e){ console.error('tracker push failed, queuing instead', describeCloudError(e)); }
    }
    // No signal (or the write above failed): queue it instead of dropping it.
    // `recorded_at` is the phone's own clock at capture time and travels
    // with the point, so once this reaches the server the admin's trail
    // shows where the technician actually was, not just when the phone
    // next caught a signal.
    await outboxQueue('geo', currentUser.id+'|'+point.recorded_at, point);
    updateOutboxBadge();
  }

  // Shared by the live (online) path above and the outbox replay below —
  // writes one point to both the append-only trail and the "latest
  // position" row the live dot reads from.
  async function trackerWritePoint(point){
    const { error: histErr } = await db.from('technician_location_history').insert(point);
    if(histErr) throw histErr;
    const { error: posErr } = await db.from('technician_locations').upsert({
      technician_id: point.technician_id,
      lat: point.lat, lng: point.lng,
      accuracy: point.accuracy, heading: point.heading, speed: point.speed,
      updated_at: point.recorded_at
    }, { onConflict: 'technician_id' });
    if(posErr) throw posErr;
  }
  // Outbox replays items oldest-first (see outboxList), so when a batch of
  // queued points flushes, the last one applied is genuinely the most
  // recent — the "latest position" row ends up correct without any extra
  // bookkeeping here.
  registerOutboxHandler('geo', async (key, payload)=>{ await trackerWritePoint(payload); });

  function trackerStartBroadcasting(){
    if(!navigator.geolocation || trackerWatchId != null) return; // already running, or no browser support
    trackerWatchId = navigator.geolocation.watchPosition(
      trackerPushLocation,
      (err)=> console.warn('tracker geolocation unavailable:', err && err.message),
      { enableHighAccuracy: true, maximumAge: 15000, timeout: 20000 }
    );
    // One-time heads up — the browser's own permission prompt is the real
    // consent step; this just explains what it's for.
    toast('📍 Location sharing is on while you\'re timed in');
  }
  function trackerStopBroadcasting(){
    if(trackerWatchId != null && navigator.geolocation){ navigator.geolocation.clearWatch(trackerWatchId); }
    trackerWatchId = null;
    trackerLastSentAt = 0;
    trackerLastSentPos = null;
  }

  // ---- Admin: live map ----
  let trackerMap = null;
  let trackerMarkers = Object.create(null); // technician_id -> L.Marker
  let trackerRealtimeChannel = null;
  let trackerPollTimer = null;
  let trackerHasFitBounds = false;

  // ---- Admin: movement trail for one selected technician at a time ----
  // (drawing every technician's trail at once on a small phone map is just
  // noise; picking one from the list is enough to answer "where did they
  // actually go", and switching technicians is one tap away.)
  let trackerTrailTid = null;
  let trackerTrailLayer = null;

  async function trackerLoadHistory(technicianId, sinceIso){
    if(!(await ensureCloud())) return [];
    try{
      const { data, error } = await db.from('technician_location_history')
        .select('lat,lng,recorded_at')
        .eq('technician_id', technicianId)
        .gte('recorded_at', sinceIso)
        .order('recorded_at', { ascending: true });
      if(error) throw error;
      return data || [];
    }catch(e){ console.error('tracker history load failed', describeCloudError(e)); return []; }
  }

  function trackerTodayStartIso(){
    // Local midnight, not UTC midnight — same reasoning as todayISO() in
    // core.js: a technician's "today" is their own calendar day.
    const d = new Date();
    d.setHours(0,0,0,0);
    return d.toISOString();
  }

  async function trackerShowTrail(technicianId, name){
    if(!trackerMap || !window.L) return;
    trackerTrailTid = technicianId;
    trackerHighlightActiveRow();
    const points = await trackerLoadHistory(technicianId, trackerTodayStartIso());
    if(trackerTrailTid !== technicianId) return; // admin switched selection mid-fetch
    if(trackerTrailLayer){ trackerMap.removeLayer(trackerTrailLayer); trackerTrailLayer = null; }
    if(points.length < 2){
      toast(points.length ? 'Not enough points yet to draw a path for '+name : 'No movement recorded yet today for '+name);
      return;
    }
    trackerTrailLayer = window.L.polyline(points.map(p=>[p.lat,p.lng]), {
      color: '#2A6FDB', weight: 3, opacity: 0.75
    }).addTo(trackerMap);
    trackerMap.fitBounds(trackerTrailLayer.getBounds().pad(0.2), { maxZoom: 16 });
  }

  function trackerHideTrail(){
    trackerTrailTid = null;
    if(trackerTrailLayer && trackerMap){ trackerMap.removeLayer(trackerTrailLayer); }
    trackerTrailLayer = null;
    trackerHighlightActiveRow();
  }

  function trackerHighlightActiveRow(){
    const list = $('trackerList');
    if(!list) return;
    $$('.tracker-list-item', list).forEach(el=>{
      el.classList.toggle('active', el.dataset.tid === trackerTrailTid);
    });
  }

  const TRACKER_DOT = { live: '#1F7A50', idle: '#B9791F', stale: '#8A8F8A' };

  function trackerFmtAgo(iso){
    if(!iso) return 'never';
    const ms = Date.now() - new Date(iso).getTime();
    if(ms < 0) return 'just now';
    const s = Math.floor(ms/1000);
    if(s < 60) return s+'s ago';
    const m = Math.floor(s/60);
    if(m < 60) return m+'m ago';
    const h = Math.floor(m/60);
    if(h < 24) return h+'h ago';
    return Math.floor(h/24)+'d ago';
  }
  function trackerFreshness(iso){
    if(!iso) return 'stale';
    const min = (Date.now() - new Date(iso).getTime()) / 60000;
    if(min <= 5) return 'live';
    if(min <= 30) return 'idle';
    return 'stale';
  }

  async function trackerEnsureLeaflet(){
    if(window.L) return;
    if(window.loadAwesCss && window.awesCss && window.awesCss.leaflet) window.loadAwesCss('leaflet', window.awesCss.leaflet);
    await loadAwesScript('leaflet', awesLibs.leaflet);
  }

  async function trackerLoadRows(){
    if(!(await ensureCloud())) return [];
    try{
      const { data, error } = await db.from('technician_locations').select('*');
      if(error) throw error;
      return data || [];
    }catch(e){ console.error('tracker load failed', describeCloudError(e)); return []; }
  }

  function trackerDotIcon(status){
    const color = TRACKER_DOT[status] || TRACKER_DOT.stale;
    return window.L.divIcon({
      className: 'tracker-marker',
      html: '<span style="display:block;width:16px;height:16px;border-radius:50%;background:'+color+';border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.4);"></span>',
      iconSize: [16,16], iconAnchor: [8,8]
    });
  }
  function trackerPopupHtml(name, row){
    return '<div style="font:13px -apple-system,BlinkMacSystemFont,sans-serif;">'+
      '<b>'+escapeHtml(name)+'</b><br>'+
      '<span style="color:#5C6B62;">Updated '+trackerFmtAgo(row.updated_at)+'</span>'+
      (row.accuracy != null ? '<br><span style="color:#5C6B62;">±'+Math.round(row.accuracy)+'m accuracy</span>' : '')+
    '</div>';
  }

  function trackerRenderList(rows, usersById){
    const list = $('trackerList');
    if(!list) return;
    if(rows.length === 0){
      list.innerHTML = '<div class="empty-state">No technicians are sharing their location right now.</div>';
      return;
    }
    const sorted = rows.slice().sort((a,b)=> new Date(b.updated_at) - new Date(a.updated_at));
    list.innerHTML = sorted.map(r=>{
      const name = (usersById[r.technician_id] && usersById[r.technician_id].name) || 'Unknown technician';
      const status = trackerFreshness(r.updated_at);
      return '<div class="tracker-list-item" data-tid="'+escapeHtml(r.technician_id)+'" data-name="'+escapeHtml(name)+'">'+
        '<span class="tracker-dot" style="background:'+TRACKER_DOT[status]+'"></span>'+
        '<span class="tracker-list-name">'+escapeHtml(name)+'</span>'+
        '<span class="tracker-list-time">'+trackerFmtAgo(r.updated_at)+'</span>'+
      '</div>';
    }).join('');
    trackerHighlightActiveRow();
    $$('.tracker-list-item', list).forEach(el=>{
      el.addEventListener('click', ()=>{
        const marker = trackerMarkers[el.dataset.tid];
        if(marker && trackerMap){ trackerMap.setView(marker.getLatLng(), 16); marker.openPopup(); }
        // Tap the same technician again to hide their path; tap another to switch to it.
        if(trackerTrailTid === el.dataset.tid) trackerHideTrail();
        else trackerShowTrail(el.dataset.tid, el.dataset.name);
      });
    });
  }

  // Runs on a 20s interval while the tracker card is visible, and stops
  // itself (rather than being stopped from elsewhere) the moment it notices
  // the admin has navigated away from Home — see the check at the top.
  async function trackerRefresh(){
    const card = $('homeTrackerCard');
    if(!card || card.style.display === 'none' || !currentUser || currentUser.role !== 'admin'){
      if(trackerPollTimer){ clearInterval(trackerPollTimer); trackerPollTimer = null; }
      return;
    }
    if(!trackerMap) return; // map still loading

    const [rows, users] = await Promise.all([ trackerLoadRows(), cloudListUsers().catch(()=>[]) ]);
    const usersById = Object.create(null);
    (users||[]).forEach(u=> usersById[u.id] = u);

    const seen = new Set();
    rows.forEach(r=>{
      seen.add(r.technician_id);
      const name = (usersById[r.technician_id] && usersById[r.technician_id].name) || 'Unknown technician';
      const status = trackerFreshness(r.updated_at);
      const latlng = [r.lat, r.lng];
      let marker = trackerMarkers[r.technician_id];
      if(!marker){
        marker = window.L.marker(latlng, { icon: trackerDotIcon(status) }).addTo(trackerMap);
        trackerMarkers[r.technician_id] = marker;
      }else{
        marker.setLatLng(latlng);
        marker.setIcon(trackerDotIcon(status));
      }
      marker.bindPopup(trackerPopupHtml(name, r));
    });
    // Drop markers for rows that disappeared (e.g. admin deleted a technician).
    Object.keys(trackerMarkers).forEach(tid=>{
      if(!seen.has(tid)){ trackerMap.removeLayer(trackerMarkers[tid]); delete trackerMarkers[tid]; }
    });

    const countEl = $('trackerCount');
    if(countEl) countEl.textContent = rows.length + (rows.length===1 ? ' sharing' : ' sharing');
    trackerRenderList(rows, usersById);

    // Keep a selected technician's path current as new points come in,
    // without re-fitting the map every cycle (that would fight the admin
    // zooming/panning to inspect the trail).
    if(trackerTrailTid && seen.has(trackerTrailTid)){
      const points = await trackerLoadHistory(trackerTrailTid, trackerTodayStartIso());
      if(trackerTrailTid && points.length >= 2){
        const latlngs = points.map(p=>[p.lat,p.lng]);
        if(trackerTrailLayer) trackerTrailLayer.setLatLngs(latlngs);
        else trackerTrailLayer = window.L.polyline(latlngs, { color: '#2A6FDB', weight: 3, opacity: 0.75 }).addTo(trackerMap);
      }
    }

    // Only auto-fit the very first time markers appear, so the admin panning
    // or zooming manually afterward isn't fought on every refresh cycle.
    if(!trackerHasFitBounds && rows.length > 0){
      const markerList = Object.values(trackerMarkers);
      if(markerList.length === 1){
        trackerMap.setView(markerList[0].getLatLng(), 15);
      }else{
        trackerMap.fitBounds(window.L.featureGroup(markerList).getBounds().pad(0.25), { maxZoom: 15 });
      }
      trackerHasFitBounds = true;
    }
  }

  // Called every time the admin's Home Overview renders. Cheap to call
  // repeatedly — the map, tile layer and realtime channel are each set up
  // once and reused; this just makes sure the polling loop is (re)running.
  async function trackerAdminInit(){
    if(!currentUser || currentUser.role !== 'admin') return;
    const card = $('homeTrackerCard');
    if(!card) return;
    card.style.display = '';

    if(!trackerMap){
      try{ await trackerEnsureLeaflet(); }
      catch(e){
        console.error('leaflet load failed', e);
        const mapEl = $('trackerMapEl');
        if(mapEl) mapEl.innerHTML = '<div class="empty-state">Map could not load — check your connection.</div>';
        return;
      }
      const mapEl = $('trackerMapEl');
      if(!mapEl || !window.L) return;
      trackerMap = window.L.map(mapEl, { attributionControl: true }).setView([14.5995, 120.9842], 11); // Metro Manila, until real markers arrive
      window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
      }).addTo(trackerMap);
    }

    // Realtime push: an update lands the instant a technician's row changes.
    // The 20s poll below is the offline-safe fallback, not the primary path.
    if(!trackerRealtimeChannel && db){
      trackerRealtimeChannel = db.channel('technician-locations-admin')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'technician_locations' }, ()=> trackerRefresh())
        .subscribe();
    }

    await trackerRefresh();
    if(!trackerPollTimer) trackerPollTimer = setInterval(trackerRefresh, 20000);
    setTimeout(()=>{ if(trackerMap) trackerMap.invalidateSize(); }, 200);
  }

  // Full teardown — called on logout so a signed-out session doesn't keep an
  // open realtime channel or a background poll running.
  function trackerAdminTeardown(){
    if(trackerPollTimer){ clearInterval(trackerPollTimer); trackerPollTimer = null; }
    if(trackerRealtimeChannel && db){ try{ db.removeChannel(trackerRealtimeChannel); }catch(e){} }
    trackerRealtimeChannel = null;
    trackerTrailTid = null;
    trackerTrailLayer = null; // the map instance itself is torn down with the view; nothing to remove it from
  }

// ---------- Announcements (table: announcements) ----------
  // Simple broadcast content: admin writes, everyone reads. No per-user
  // read-tracking — these are posts, not a conversation to mark unread.
  function annFmtDate(iso){
    if(!iso) return '';
    return new Date(iso).toLocaleDateString('en-PH', {year:'numeric', month:'short', day:'numeric'});
  }
  async function annLoadAll(){
    if(!(await ensureCloud())) return [];
    try{
      const { data, error } = await db.from('announcements').select('*')
        .order('pinned', {ascending:false}).order('created_at', {ascending:false});
      if(error) throw error;
      return data || [];
    }catch(e){ console.error('announcements load failed', describeCloudError(e)); return []; }
  }
  function annItemHtml(a){
    return '<div class="ann-item">'+
      '<div class="ann-item-head">'+
        (a.pinned ? '<span class="ann-badge-pinned">Pinned</span>' : '')+
        '<span class="ann-date">'+annFmtDate(a.created_at)+'</span>'+
      '</div>'+
      '<div class="ann-title">'+escapeHtml(a.title)+'</div>'+
      '<div class="ann-body">'+escapeHtml(a.body)+'</div>'+
    '</div>';
  }

  // ---- Technician Dashboard card (top 3) + View All overlay ----
  async function renderHomeAnnouncements(){
    const card = $('homeAnnouncementsCard');
    if(!currentUser || currentUser.role==='admin'){ if(card) card.style.display='none'; return; }
    if(card) card.style.display = '';
    const list = $('homeAnnouncementsList');
    if(!list) return;
    const all = await annLoadAll();
    if(all.length===0){ list.innerHTML = '<div class="empty-state">No announcements yet.</div>'; return; }
    list.innerHTML = all.slice(0,3).map(annItemHtml).join('');
  }
  async function annOpenViewAll(){
    $('announcementsViewAllOverlay').classList.add('open');
    const list = $('announcementsViewAllList');
    list.innerHTML = '<div class="empty-state">Loading…</div>';
    const all = await annLoadAll();
    list.innerHTML = all.length===0
      ? '<div class="empty-state">No announcements yet.</div>'
      : all.map(annItemHtml).join('');
  }
  $('homeAnnViewAllBtn').addEventListener('click', annOpenViewAll);
  $('closeAnnViewAll').addEventListener('click', ()=> $('announcementsViewAllOverlay').classList.remove('open'));
  $('announcementsViewAllOverlay').addEventListener('click', (e)=>{
    if(e.target.id==='announcementsViewAllOverlay') $('announcementsViewAllOverlay').classList.remove('open');
  });

  // ---- Admin authoring + management ----
  async function annRenderAdminList(){
    const list = $('announcementsAdminList');
    list.innerHTML = '<div class="empty-state">Loading…</div>';
    const all = await annLoadAll();
    if(all.length===0){ list.innerHTML = '<div class="empty-state">No announcements posted yet.</div>'; return; }
    list.innerHTML = all.map(a=>
      '<div class="ann-admin-row">'+
        '<div>'+
          (a.pinned ? '<span class="ann-badge-pinned">Pinned</span> ' : '')+
          '<b>'+escapeHtml(a.title)+'</b>'+
          '<div class="u-status">'+annFmtDate(a.created_at)+' · '+escapeHtml(a.body.length>80?a.body.slice(0,80)+'…':a.body)+'</div>'+
        '</div>'+
        '<button type="button" class="btn" style="color:#B3402D; border-color:#B3402D; flex-shrink:0;" data-ann-delete="'+a.id+'">Delete</button>'+
      '</div>'
    ).join('');
  }
  $('menuManageAnnouncements').addEventListener('click', async ()=>{
    closeMainMenu();
    if(!(await ensureAdminAuthenticated())) return;
    $('announcementsAdminOverlay').classList.add('open');
    $('annTitleInput').value = '';
    $('annBodyInput').value = '';
    $('annPinnedInput').checked = false;
    annRenderAdminList();
  });
  $('closeAnnAdmin').addEventListener('click', ()=> $('announcementsAdminOverlay').classList.remove('open'));
  $('announcementsAdminOverlay').addEventListener('click', (e)=>{
    if(e.target.id==='announcementsAdminOverlay') $('announcementsAdminOverlay').classList.remove('open');
  });
  $('annPostBtn').addEventListener('click', async ()=>{
    const title = $('annTitleInput').value.trim();
    const body = $('annBodyInput').value.trim();
    const pinned = $('annPinnedInput').checked;
    if(!title || !body){ toast('Add a title and message'); return; }
    if(!currentUser){ toast('Please sign in again'); return; }
    if(!(await ensureCloud())){ toast('This needs a connection — try again when online'); return; }
    $('annPostBtn').disabled = true;
    try{
      const { error } = await db.from('announcements').insert({
        title, body, pinned, created_by: currentUser.id, created_by_name: currentUser.name
      });
      if(error) throw error;
      $('annTitleInput').value = ''; $('annBodyInput').value = ''; $('annPinnedInput').checked = false;
      toast('Announcement posted');
      annRenderAdminList();
    }catch(e){ console.error('post announcement failed', describeCloudError(e)); toast('Could not post — please try again'); }
    $('annPostBtn').disabled = false;
  });
  $('announcementsAdminList').addEventListener('click', async (e)=>{
    const btn = e.target.closest('[data-ann-delete]');
    if(!btn) return;
    if(!confirm('Delete this announcement?')) return;
    if(!(await ensureCloud())){ toast('This needs a connection — try again when online'); return; }
    try{
      const { error } = await db.from('announcements').delete().eq('id', btn.dataset.annDelete);
      if(error) throw error;
      annRenderAdminList();
    }catch(e){ console.error('delete announcement failed', describeCloudError(e)); toast('Could not delete — please try again'); }
  });

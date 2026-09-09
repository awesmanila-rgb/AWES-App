// ---------- Equipment Photos ----------
// Storage: private bucket 'equipment-photos', private because every other
// table in this app is scoped per-customer via RLS (see
// 20260910_01_equipment_photos.sql) — a public bucket would break that
// model. Photos are shown via short-lived signed URLs (equipPhotoSignedUrls
// below), generated on demand, never a permanent public link.
//
// Design: ADMIN uploads/organizes (folder, cover photo, delete); the
// linked CUSTOMER can only view. See admin.js (upload UI, inside the
// equipment detail overlay) and customer-equipment-history.js (read-only
// gallery). This module holds the shared cloud calls + the compression
// step both sides' counts rely on — neither UI talks to Storage directly.

  const EQUIP_PHOTO_BUCKET = 'equipment-photos';

  // ---------- Client-side compression ----------
  // Runs before every upload so storage cost stays bounded no matter what
  // a phone camera produces (a raw shot can be 5-10MB). Downscales to
  // maxDim on the longer side, then re-encodes as JPEG, stepping quality
  // down until the result is at or under targetBytes — or, if quality
  // alone can't get there, shrinking the dimensions further and repeating.
  // Always returns SOME blob (best effort) rather than throwing just
  // because an unusually busy/detailed photo won't quite hit the target.
  function loadImageBitmapFromFile(file){
    if(window.createImageBitmap){
      return createImageBitmap(file).catch(()=> loadImageViaElement(file));
    }
    return loadImageViaElement(file);
  }
  function loadImageViaElement(file){
    return new Promise((resolve, reject)=>{
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = ()=>{ URL.revokeObjectURL(url); resolve(img); };
      img.onerror = (e)=>{ URL.revokeObjectURL(url); reject(e); };
      img.src = url;
    });
  }
  function canvasToBlob(canvas, quality){
    return new Promise(resolve=> canvas.toBlob(resolve, 'image/jpeg', quality));
  }
  async function compressImageForUpload(file, opts){
    const targetBytes = (opts && opts.targetBytes) || 150*1024; // ~150KB
    let maxDim = (opts && opts.maxDim) || 1600;
    const bitmap = await loadImageBitmapFromFile(file);
    const srcW = bitmap.width, srcH = bitmap.height;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    let blob = null;
    for(let resizeRound=0; resizeRound<4; resizeRound++){
      const scale = Math.min(1, maxDim / Math.max(srcW, srcH));
      canvas.width = Math.max(1, Math.round(srcW*scale));
      canvas.height = Math.max(1, Math.round(srcH*scale));
      ctx.clearRect(0,0,canvas.width,canvas.height);
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const qualitySteps = [0.82, 0.72, 0.62, 0.52, 0.42, 0.35];
      for(const q of qualitySteps){
        blob = await canvasToBlob(canvas, q);
        if(blob && blob.size <= targetBytes) return blob;
      }
      maxDim = Math.round(maxDim * 0.8); // still too big — shrink and retry
    }
    if(bitmap.close) bitmap.close();
    return blob; // best effort — smaller than the original either way
  }

  // ---------- Upload / list / manage ----------
  // Path convention enforced by the storage INSERT policy:
  // {customer_id}/{equipment_id}/{timestamp}-{filename} — see the
  // migration's comments for why this layout matters for RLS.
  async function cloudUploadEquipmentPhoto(equipmentId, customerId, file, folder){
    if(!equipmentId || !customerId || !file || !(await ensureCloud())) return null;
    let blob;
    try{ blob = await compressImageForUpload(file); }
    catch(e){ console.error('compress photo failed', e); return null; }
    if(!blob) return null;
    const safeName = (file.name||'photo.jpg').replace(/[^a-zA-Z0-9._-]/g, '_');
    const path = customerId+'/'+equipmentId+'/'+Date.now()+'-'+safeName;
    try{
      const { error: upErr } = await db.storage.from(EQUIP_PHOTO_BUCKET).upload(path, blob, {
        contentType: 'image/jpeg', upsert: false
      });
      if(upErr) throw upErr;
      const { data, error } = await db.from('equipment_photos').insert({
        equipment_id: equipmentId, customer_id: customerId, storage_path: path,
        folder: (folder||'').trim() || 'Uncategorized', file_size_bytes: blob.size,
        uploaded_by: currentUser ? currentUser.id : null
      }).select('*').single();
      if(error) throw error;
      return data;
    }catch(e){
      console.error('upload equipment photo failed', describeCloudError(e));
      // Best-effort cleanup: don't leave an orphaned Storage object behind
      // if the metadata insert failed after a successful upload.
      try{ await db.storage.from(EQUIP_PHOTO_BUCKET).remove([path]); }catch(e2){}
      return null;
    }
  }
  async function cloudListEquipmentPhotos(equipmentId){
    if(!equipmentId || !(await ensureCloud())) return [];
    try{
      const { data, error } = await db.from('equipment_photos')
        .select('*').eq('equipment_id', equipmentId).order('created_at', {ascending:false});
      if(error) throw error;
      const rows = data || [];
      const urls = await equipPhotoSignedUrls(rows.map(r=>r.storage_path));
      rows.forEach(r=> r.signedUrl = urls[r.storage_path] || null);
      return rows;
    }catch(e){ console.error('list equipment photos failed', describeCloudError(e)); return []; }
  }
  // Per-customer photo counts, keyed by equipment_id — powers the small
  // "📷 N" badge on equipment list cards (admin master list, customer
  // portal grid) without those views having to load full photo rows just
  // to know whether a unit has any.
  async function cloudGetEquipmentPhotoCounts(customerId){
    if(!customerId || !(await ensureCloud())) return {};
    try{
      const { data, error } = await db.from('equipment_photos')
        .select('equipment_id').eq('customer_id', customerId);
      if(error) throw error;
      const counts = {};
      (data||[]).forEach(r=> counts[r.equipment_id] = (counts[r.equipment_id]||0)+1);
      return counts;
    }catch(e){ console.error('load equipment photo counts failed', describeCloudError(e)); return {}; }
  }
  // Distinct folder names already in use — populates the admin upload
  // form's datalist so folders get reused ("2026 Site Survey") instead of
  // drifting into near-duplicate one-off names.
  async function cloudListEquipmentPhotoFolders(){
    if(!(await ensureCloud())) return ['Uncategorized'];
    try{
      const { data, error } = await db.from('equipment_photos').select('folder');
      if(error) throw error;
      const set = new Set(['Uncategorized']);
      (data||[]).forEach(r=> { if(r.folder) set.add(r.folder); });
      return Array.from(set).sort();
    }catch(e){ console.error('load photo folders failed', describeCloudError(e)); return ['Uncategorized']; }
  }
  async function cloudSetEquipmentPhotoFolder(photoId, folder){
    if(!photoId || !(await ensureCloud())) return false;
    try{
      const { error } = await db.from('equipment_photos').update({ folder: (folder||'').trim() || 'Uncategorized' }).eq('id', photoId);
      if(error) throw error;
      return true;
    }catch(e){ console.error('set photo folder failed', describeCloudError(e)); return false; }
  }
  // Renames a folder tag in one query, scoped to a single equipment unit —
  // NOT a global rename across every unit that happens to share the same
  // folder name. Folder tags are meant to be reused across units ("2026
  // Site Survey"), so a rename triggered from one unit's photo gallery
  // (admin.js) should only ever touch that unit's own photos, never
  // silently relabel unrelated equipment elsewhere in the system.
  async function cloudRenameEquipmentPhotoFolder(equipmentId, oldFolder, newFolder){
    const next = (newFolder||'').trim() || 'Uncategorized';
    if(!equipmentId || !oldFolder || !(await ensureCloud())) return false;
    if(next === oldFolder) return true; // no-op
    try{
      const { error } = await db.from('equipment_photos')
        .update({ folder: next })
        .eq('equipment_id', equipmentId)
        .eq('folder', oldFolder);
      if(error) throw error;
      return true;
    }catch(e){ console.error('rename equipment photo folder failed', describeCloudError(e)); return false; }
  }
  // Only one cover photo per unit — clear the others first, then set the
  // chosen one. Two round-trips rather than a DB trigger/partial-unique-
  // index: simple, and a photo count small enough per unit that the race
  // window (two admins re-covering the same unit at the same instant)
  // isn't worth the extra migration complexity.
  async function cloudSetEquipmentPhotoCover(equipmentId, photoId){
    if(!equipmentId || !photoId || !(await ensureCloud())) return false;
    try{
      const { error: clearErr } = await db.from('equipment_photos').update({ is_cover:false }).eq('equipment_id', equipmentId);
      if(clearErr) throw clearErr;
      const { error } = await db.from('equipment_photos').update({ is_cover:true }).eq('id', photoId);
      if(error) throw error;
      return true;
    }catch(e){ console.error('set cover photo failed', describeCloudError(e)); return false; }
  }
  async function cloudDeleteEquipmentPhoto(photo){
    if(!photo || !(await ensureCloud())) return false;
    try{
      const { error: rmErr } = await db.storage.from(EQUIP_PHOTO_BUCKET).remove([photo.storage_path]);
      if(rmErr) throw rmErr;
      const { error } = await db.from('equipment_photos').delete().eq('id', photo.id);
      if(error) throw error;
      return true;
    }catch(e){ console.error('delete equipment photo failed', describeCloudError(e)); return false; }
  }
  // Batch signed-URL fetch — one round trip per gallery render instead of
  // one per photo. Returns a { storage_path: url } map; a path that fails
  // to sign (e.g. the object was removed out from under us) is simply
  // absent from the map rather than failing the whole batch.
  async function equipPhotoSignedUrls(paths, expiresInSeconds){
    const list = (paths||[]).filter(Boolean);
    if(list.length===0 || !(await ensureCloud())) return {};
    try{
      const { data, error } = await db.storage.from(EQUIP_PHOTO_BUCKET).createSignedUrls(list, expiresInSeconds||3600);
      if(error) throw error;
      const map = {};
      (data||[]).forEach(d=> { if(d && d.signedUrl && !d.error) map[d.path] = d.signedUrl; });
      return map;
    }catch(e){ console.error('sign equipment photo urls failed', describeCloudError(e)); return {}; }
  }

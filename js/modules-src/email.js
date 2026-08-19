// ---------- EmailJS settings ----------
  let emailCfg = {publicKey:'', serviceId:'', templateId:'', officeEmail:''};
  async function loadEmailCfg(){
    if(await ensureCloud()){
      const doc = await cloudGetDoc('settings/emailjs');
      if(doc){ emailCfg = doc; if(emailCfg.publicKey && window.emailjs){ try{ emailjs.init({publicKey: emailCfg.publicKey}); }catch(e){} } return; }
    }
    try{
      const res = await window.storage.get('settings:emailjs', false);
      if(res) emailCfg = JSON.parse(res.value);
    }catch(e){ /* not set yet */ }
    if(emailCfg.publicKey && window.emailjs){ try{ emailjs.init({publicKey: emailCfg.publicKey}); }catch(e){} }
  }
  loadEmailCfg();

  $('settingsBtn').addEventListener('click', ()=>{
    $('cfgPublicKey').value = emailCfg.publicKey||'';
    $('cfgServiceId').value = emailCfg.serviceId||'';
    $('cfgTemplateId').value = emailCfg.templateId||'';
    $('cfgOfficeEmail').value = emailCfg.officeEmail||'';
    $('settingsOverlay').classList.add('open');
  });
  $('closeSettings').addEventListener('click', ()=> $('settingsOverlay').classList.remove('open'));
  $('settingsOverlay').addEventListener('click', (e)=>{ if(e.target.id==='settingsOverlay') $('settingsOverlay').classList.remove('open'); });
  $('settingsHelpBtn').addEventListener('click', ()=>{
    toast('Ask your Claude chat for the step-by-step EmailJS setup guide');
  });
  $('saveSettingsBtn').addEventListener('click', async ()=>{
    emailCfg = {
      publicKey: $('cfgPublicKey').value.trim(),
      serviceId: $('cfgServiceId').value.trim(),
      templateId: $('cfgTemplateId').value.trim(),
      officeEmail: $('cfgOfficeEmail').value.trim()
    };
    if(emailCfg.publicKey && window.emailjs){ try{ emailjs.init({publicKey: emailCfg.publicKey}); }catch(e){} }
    if(await ensureCloud()){
      const ok = await cloudSetDoc('settings/emailjs', emailCfg);
      if(ok){ toast('Email settings saved for all devices'); $('settingsOverlay').classList.remove('open'); return; }
    }
    try{
      await window.storage.set('settings:emailjs', JSON.stringify(emailCfg), false);
      toast('Email settings saved on this device');
      $('settingsOverlay').classList.remove('open');
    }catch(e){ toast('Could not save settings'); }
  });
  function emailConfigured(){
    return !!(emailCfg.publicKey && emailCfg.serviceId && emailCfg.templateId && (emailCfg.officeEmail));
  }

  // downscale a signature dataURL so PDFs/email attachments stay small
  function downscaleDataUrl(dataUrl, maxWidth){
    return new Promise((resolve)=>{
      const img = new Image();
      img.onload = ()=>{
        const scale = Math.min(1, maxWidth / img.width);
        const c = document.createElement('canvas');
        c.width = img.width*scale; c.height = img.height*scale;
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL('image/png'));
      };
      img.onerror = ()=> resolve(dataUrl);
      img.src = dataUrl;
    });
  }

  // send the generated PDF via EmailJS as a dynamic attachment
  async function sendEmailWithPdf(doc, data, filename){
    await loadAwesScript('emailjs', awesLibs.emailjs);
    if(!emailConfigured()) return {ok:false, reason:'not_configured'};
    try{ emailjs.init({publicKey: emailCfg.publicKey}); }catch(e){}
    const base64 = doc.output('datauristring').split(',')[1];
    // rough size check — most free/personal EmailJS plans cap attachments around 500KB
    const approxBytes = base64.length * 0.75;
    if(approxBytes > 480000){
      return {ok:false, reason:'too_large'};
    }
    const toEmail = (data.custEmail || '').trim();
    const recipients = toEmail ? (toEmail+','+emailCfg.officeEmail) : emailCfg.officeEmail;
    const templateParams = {
      to_email: recipients,
      sr_no: data.srNo || '',
      customer_name: data.custName || '',
      service_date: data.date || '',
      pdf_attachment: base64,
      pdf_filename: filename
    };
    try{
      await emailjs.send(emailCfg.serviceId, emailCfg.templateId, templateParams);
      return {ok:true};
    }catch(err){
      console.error('EmailJS error', err);
      return {ok:false, reason:'send_failed'};
    }
  }

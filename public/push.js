(() => {
  const button=document.getElementById('enable-push');
  const status=document.getElementById('push-status');
  if(!button||!status)return;
  const supported=('serviceWorker' in navigator)&&('PushManager' in window)&&('Notification' in window)&&location.protocol==='https:';
  if(!supported){status.textContent='Push notifications need HTTPS and a browser that supports service workers and push. In-dashboard updates may still work.';button.disabled=true;return;}
  const decodeKey=value=>{const padding='='.repeat((4-value.length%4)%4);const base=(value+padding).replace(/-/g,'+').replace(/_/g,'/');const raw=atob(base);return Uint8Array.from(raw,c=>c.charCodeAt(0));};
  async function state(){try{const reg=await navigator.serviceWorker.ready;const sub=await reg.pushManager.getSubscription();if(sub){status.textContent='Push notifications are enabled on this device.';button.textContent='Notifications enabled';} }catch(e){}}
  button.addEventListener('click',async()=>{
    button.disabled=true;status.textContent='Setting up notifications…';
    try{
      const keyResponse=await fetch('/api/push/public-key',{cache:'no-store'});const keyData=await keyResponse.json();
      if(!keyResponse.ok||!keyData.enabled)throw new Error(keyData.error||'Push notifications are not configured yet.');
      const permission=await Notification.requestPermission();if(permission!=='granted')throw new Error('Notification permission was not granted. Enable notifications in your browser settings and try again.');
      const reg=await navigator.serviceWorker.register('/service-worker.js');await navigator.serviceWorker.ready;
      let sub=await reg.pushManager.getSubscription();if(!sub)sub=await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:decodeKey(keyData.publicKey)});
      const save=await fetch('/api/push/subscribe',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({subscription:sub.toJSON()})});const saved=await save.json();if(!save.ok)throw new Error(saved.error||'Could not save notification settings.');
      status.textContent='Push notifications are enabled on this device. You can receive ride alerts even when SMART RIDE is in the background.';button.textContent='Notifications enabled';
    }catch(e){status.textContent=e.message||'Could not enable notifications.';button.textContent='Try again';button.disabled=false;}
  });
  state();
})();

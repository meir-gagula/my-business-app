const V='biz-v2';
const FILES=['./','index.html','style.css','app.js','manifest.webmanifest','icon.svg','lib/tesseract.min.js','lib/worker.min.js','lib/tesseract-core-simd-lstm.wasm.js','lib/tesseract-core-lstm.wasm.js','lib/lang/heb.traineddata.gz','lib/lang/eng.traineddata.gz'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(V).then(c=>c.addAll(FILES)).then(()=>self.skipWaiting()))});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==V).map(x=>caches.delete(x)))).then(()=>self.clients.claim()))});
self.addEventListener('fetch',e=>{
  if(e.request.method!=='GET')return;
  if(e.request.url.includes('/lib/')){e.respondWith(caches.match(e.request).then(r=>r||fetch(e.request)));return;}
  // קבצי האפליקציה: קודם הרשת (כדי לקבל עדכונים), ואם אין קליטה - מהמטמון
  e.respondWith(fetch(e.request).then(r=>{const c=r.clone();caches.open(V).then(x=>x.put(e.request,c));return r;}).catch(()=>caches.match(e.request)));
});

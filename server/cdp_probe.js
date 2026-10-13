const http = require('http');
const WebSocket = require('ws');
function getJson(path){return new Promise((res,rej)=>{http.get({host:'127.0.0.1',port:9223,path},(r)=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>res(JSON.parse(d)));}).on('error',rej);});}
(async()=>{
  const targets = await getJson('/json/list');
  const page = targets.find(t=>t.type==='page' && /\/player/.test(t.url));
  if(!page) throw new Error('no player page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id=0; const pend=new Map();
  const send=(m,p={})=>new Promise(r=>{const i=++id;pend.set(i,r);ws.send(JSON.stringify({id:i,method:m,params:p}))});
  ws.on('message',raw=>{const m=JSON.parse(raw); if(m.id&&pend.has(m.id)){const fn=pend.get(m.id);pend.delete(m.id);fn(m.result);}});
  await new Promise(r=>ws.on('open',r));
  const expr = `JSON.stringify({
    url: location.href,
    sess: (typeof state!=='undefined')? state.sessionId : null,
    inst: (typeof state!=='undefined')? state.instanceId : null,
    pcState: (typeof state!=='undefined' && state.pc)? state.pc.connectionState : null,
    ice: (typeof state!=='undefined' && state.pc)? state.pc.iceConnectionState : null,
    video: (()=>{const v=document.querySelector('video'); if(!v) return null;
      const tr = v.srcObject? v.srcObject.getVideoTracks() : [];
      return {rs:v.readyState, w:v.videoWidth, t:v.currentTime, rect: v.getBoundingClientRect(), vis: getComputedStyle(v).visibility, disp: getComputedStyle(v).display, opa: getComputedStyle(v).opacity,
        tracks: tr.map(t=>({enabled:t.enabled, readyState:t.readyState, muted:t.muted}))};})(),
    ov: (()=>{const o=document.getElementById('overlay'); return o? {disp:getComputedStyle(o).display, opa:getComputedStyle(o).opacity, text:o.textContent.slice(0,60)}:null;})()
  })`;
  const r = await send('Runtime.evaluate',{expression:expr, returnByValue:true});
  console.log(r.result.value);
  ws.close(); process.exit(0);
})().catch(e=>{console.error('FAIL',e.message);process.exit(1);});

const http = require('http');
const WebSocket = require('ws');
function getJson(path){return new Promise((res,rej)=>{http.get({host:'127.0.0.1',port:9224,path},r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>{try{res(JSON.parse(d))}catch(e){rej(e)}})}).on('error',rej)})}
(async()=>{
  const targets = await getJson('/json/list');
  const page = targets.find(t=>t.type==='page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id=0; const pend=new Map();
  const send=(m,p={})=>new Promise(r=>{const i=++id;pend.set(i,r);ws.send(JSON.stringify({id:i,method:m,params:p}))});
  ws.on('message',raw=>{const m=JSON.parse(raw); if(m.id&&pend.has(m.id)){pend.get(m.id)(m.result);pend.delete(m.id)}});
  await new Promise(r=>ws.on('open',r));
  await send('Runtime.enable');
  const st = await send('Runtime.evaluate',{expression:`JSON.stringify({tag:document.getElementById('stateTag')?.textContent, ov:document.getElementById('ovTitle')?.textContent, v:(()=>{const v=document.querySelector('video');return v?{rs:v.readyState,w:v.videoWidth,t:v.currentTime,err:v.error&&v.error.code}:null})(), sess: typeof state!=='undefined'? {hasSess:!!state.session, hasPc:!!state.pc} : 'no-state'})`,returnByValue:true});
  console.log(st.result.value);
  process.exit(0);
})().catch(e=>{console.error('ERR',e.message);process.exit(1)});

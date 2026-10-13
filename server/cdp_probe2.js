const http = require('http');
const WebSocket = require('ws');
function getJson(path){return new Promise((res,rej)=>{http.get({host:'127.0.0.1',port:9223,path},(r)=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>res(JSON.parse(d)));}).on('error',rej);});}
(async()=>{
  const targets = await getJson('/json/list');
  const page = targets.find(t=>t.type==='page' && /\/player/.test(t.url));
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id=0; const pend=new Map();
  const send=(m,p={})=>new Promise(r=>{const i=++id;pend.set(i,r);ws.send(JSON.stringify({id:i,method:m,params:p}))});
  ws.on('message',raw=>{const m=JSON.parse(raw); if(m.id&&pend.has(m.id)){const fn=pend.get(m.id);pend.delete(m.id);fn(m.result);}});
  await new Promise(r=>ws.on('open',r));
  const expr = `(async()=>{
    const v=document.querySelector('video');
    const p=(typeof state!=='undefined'&&state.pc)?state.pc:null;
    const t1=v?v.currentTime:-1;
    let fr1=-1,fd1=-1,bytes1=-1;
    if(p){const r=await p.getStats();r.forEach(s=>{if(s.type==='inbound-rtp'&&s.kind==='video'){fr1=s.framesReceived;fd1=s.framesDecoded;bytes1=s.bytesReceived;}});}
    await new Promise(rr=>setTimeout(rr,5000));
    const t2=v?v.currentTime:-1;
    let fr2=-1,fd2=-1,bytes2=-1;
    if(p){const r=await p.getStats();r.forEach(s=>{if(s.type==='inbound-rtp'&&s.kind==='video'){fr2=s.framesReceived;fd2=s.framesDecoded;bytes2=s.bytesReceived;}});}
    return JSON.stringify({curT:[t1,t2],framesRecv:[fr1,fr2],framesDec:[fd1,fd2],bytes:[bytes1,bytes2],paused:v?v.paused:null,rs:v?v.readyState:null});
  })()`;
  const r = await send('Runtime.evaluate',{expression:expr, returnByValue:true, awaitPromise:true});
  console.log(r.result.value || JSON.stringify(r));
  ws.close(); process.exit(0);
})().catch(e=>{console.error('FAIL',e.message);process.exit(1);});

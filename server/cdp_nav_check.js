const http = require('http');
const WebSocket = require('ws');
function getJson(path){return new Promise((res,rej)=>{http.get({host:'127.0.0.1',port:9223,path},r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>{try{res(JSON.parse(d))}catch(e){rej(e)}})}).on('error',rej)})}
(async()=>{
  const targets = await getJson('/json/list');
  console.log('targets:', targets.map(t=>({type:t.type,url:t.url})));
  const page = targets.find(t=>t.type==='page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id=0; const pend=new Map();
  const send=(m,p={})=>new Promise(r=>{const i=++id;pend.set(i,r);ws.send(JSON.stringify({id:i,method:m,params:p}))});
  const events=[];
  ws.on('message',raw=>{const m=JSON.parse(raw); if(m.id&&pend.has(m.id)){pend.get(m.id)(m.result);pend.delete(m.id)} else if(m.method) events.push(m.method);});
  await new Promise(r=>ws.on('open',r));
  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.navigate',{url:'http://10.3.18.189:3100/player?template=2'});
  await new Promise(r=>setTimeout(r,8000));
  const st = await send('Runtime.evaluate',{expression:'JSON.stringify({href:location.href, title:document.title, ready:document.readyState, bodyLen:document.body?document.body.innerHTML.length:-1, tag:document.getElementById("stateTag")?document.getElementById("stateTag").textContent:"none"})',returnByValue:true});
  console.log('page:', st.result.value);
  console.log('events:', events.slice(0,15));
  process.exit(0);
})().catch(e=>{console.error('ERR',e.message);process.exit(1)});

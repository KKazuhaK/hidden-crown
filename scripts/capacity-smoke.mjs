// Disposable 100-player benchmark. TEST_DATABASE_URL selects a fresh PostgreSQL test database.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { mkdir, writeFile } from 'node:fs/promises';
import WebSocket from 'ws';
import pg from 'pg';
const external = process.env.HIDDEN_CROWN_URL;
const base=external ?? 'http://127.0.0.1:8802', directory=`test-artifacts/capacity-${randomUUID()}`;
await mkdir(directory,{recursive:true});
let databaseUrl = '', postgresName = '';
if (process.env.TEST_DATABASE_URL && !external) {
  postgresName = 'hc_capacity_' + randomUUID().replaceAll('-', '');
  const admin = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL }); await admin.connect();
  try { await admin.query(`CREATE DATABASE ${postgresName}`); } finally { await admin.end(); }
  const url = new URL(process.env.TEST_DATABASE_URL); url.pathname = '/' + postgresName; databaseUrl = url.href;
}
const server=external ? null : spawn(process.execPath,['dist/server.mjs'],{env:{...process.env,PORT:'8802',HOST:'127.0.0.1',PUBLIC_ORIGIN:base,DATABASE_PATH:`${directory}/test.sqlite`,DATABASE_URL:databaseUrl,ADMIN_PASSWORD:'isolated-capacity-test-password',TRUSTED_PROXIES:'127.0.0.1,::ffff:127.0.0.1'},stdio:['ignore','pipe','pipe']});
const sockets=[], latencies=[], health=[]; let output='', timer, healthError = null;
server?.stdout.on('data',c=>output+=c); server?.stderr.on('data',c=>output+=c);
function quantile(values,f){ const s=[...values].sort((a,b)=>a-b);return Math.round(s[Math.min(s.length-1,Math.floor(f*s.length))]*100)/100; }
async function wait(predicate, label){const deadline=Date.now()+15000;while(Date.now()<deadline){const result=predicate();if(result)return result;await new Promise(r=>setTimeout(r,5));}throw Error(`Timeout: ${label}`);}
async function connect(room,role,ip){
  const ws=new WebSocket(`${base.replace('http','ws')}/ws/${room.roomId}`,{headers:{Origin:base,'X-Forwarded-For':ip}}), client={ws,view:null,error:null};sockets.push(ws);
  ws.on('error',e=>client.error=e); ws.on('message',b=>{const m=JSON.parse(b.toString());if(m.type==='state')client.view=m.view;if(m.type==='error')client.error=Error(m.code);});
  ws.on('open',()=>ws.send(JSON.stringify({type:'hello',token:new URL(room.links[role],base).hash.slice(3)})));
  await wait(()=>client.error||client.view,`connect ${role}`);if(client.error)throw client.error;return client;
}
let healthInFlight=false;
try{
  if (server) await wait(()=>output.includes('listening on'),'server startup');
  const rooms=[];
  for(let i=0;i<50;i++){
    const r=await fetch(base+'/api/rooms',{method:'POST',headers:{'X-Forwarded-For':`198.18.0.${i+1}`}});
    if(!r.ok)throw Error(`Create ${i}: ${r.status} ${await r.text()}`);rooms.push(await r.json());
  }
  const games=await Promise.all(rooms.map(async(room,i)=>{
    const white=await connect(room,'white',`198.18.1.${i*2+1}`),black=await connect(room,'black',`198.18.1.${i*2+2}`);
    await wait(()=>white.view.phase==='crown_select'&&black.view.phase==='crown_select','selection');
    white.ws.send(JSON.stringify({type:'select_crown',pieceId:'wK'}));black.ws.send(JSON.stringify({type:'select_crown',pieceId:'bK'}));
    await wait(()=>white.view.phase==='playing'&&black.view.phase==='playing','start');
    return {white,black};
  }));
  console.log('Connected 100 players in 50 live games. Running 4000 moves in paced synchronized bursts.');
  timer=setInterval(async()=>{if(healthInFlight)return;healthInFlight=true;const at=performance.now();try{const r=await fetch(base+'/healthz',{signal:AbortSignal.timeout(15000)});if(!r.ok)throw Error('Health failed');health.push(performance.now()-at);}catch(error){healthError=error;}finally{healthInFlight=false;}},1000);
  const moves=[[6,21],[62,45],[21,6],[45,62]], started=performance.now();
  for(let ply=0;ply<80;ply++){
    await Promise.all(games.map(async game=>{
      const client=ply%2?game.black:game.white,at=performance.now();
      client.ws.send(JSON.stringify({type:'move',from:moves[ply%4][0],to:moves[ply%4][1]}));
      await wait(()=>client.error||(game.white.view.moves.length===ply+1&&game.black.view.moves.length===ply+1),'move');
      if(client.error)throw client.error;latencies.push(performance.now()-at);
    }));
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  if (healthError) throw healthError;
  const login = await fetch(base+'/api/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:external ? process.env.HIDDEN_CROWN_ADMIN_USERNAME ?? 'admin' : 'admin',password:external ? process.env.HIDDEN_CROWN_ADMIN_PASSWORD : 'isolated-capacity-test-password'})});
  if (!login.ok) throw Error('Metrics login failed');
  const metrics = await (await fetch(base+'/api/admin/metrics',{headers:{Cookie:login.headers.get('set-cookie').split(';')[0]}})).json();
  const result={database:metrics.database,players:100,games:50,completedMoves:latencies.length,durationSeconds:Math.round((performance.now()-started)/10)/100,moveRoundTripMs:{p50:quantile(latencies,.5),p95:quantile(latencies,.95),p99:quantile(latencies,.99)},memoryRssMiB:Math.round(metrics.memoryRssBytes/1048576),eventLoopP95Ms:metrics.eventLoopP95Ms,healthSamples:health.length,healthP95Ms:health.length?quantile(health,.95):null,notes:`Synthetic benchmark with a ${process.platform} client, ${server ? 'disposable local' : 'externally configured'} runtime; 80-ply games, 50 simultaneous moves every 100ms. Report server CPU/memory limits separately; not a production capacity guarantee.`};
  await writeFile(`${directory}/result.json`,JSON.stringify(result,null,2));console.log(JSON.stringify(result)); console.log(`Results saved to ${directory}/result.json`);
}finally{
  clearInterval(timer);for(const ws of sockets)ws.terminate();server?.kill('SIGTERM');
  if (server && server.exitCode === null && server.signalCode === null) await Promise.race([new Promise(resolve=>server.once('exit',resolve)),new Promise(resolve=>setTimeout(resolve,3000))]);
  if (postgresName) { const admin = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL }); await admin.connect(); try { await admin.query(`DROP DATABASE ${postgresName}`); } finally { await admin.end(); } }
}



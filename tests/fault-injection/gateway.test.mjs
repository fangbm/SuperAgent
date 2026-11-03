import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { QQGateway } from '@superagent/qq-official';

class Socket extends EventTarget {
  readyState=WebSocket.OPEN;
  constructor(onSend){super();this.onSend=onSend;queueMicrotask(()=>this.message({op:10,d:{heartbeat_interval:1000}}));}
  message(value){this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(value)}));}
  send(raw){this.onSend(JSON.parse(raw),this);}
  close(){this.readyState=WebSocket.CLOSED;}
  disconnect(){const event=new Event('close');Object.defineProperty(event,'code',{value:1006});this.dispatchEvent(event);}
}
const api={gateway:async()=> 'ws://fixture.invalid',accessToken:async()=> 'fixture-token'};
async function until(check){const deadline=Date.now()+3000;while(!check()){if(Date.now()>deadline)throw new Error('FAULT_TEST_TIMEOUT');await delay(5);}}

test('M6 gateway flood closes at its bounded queue and replays only after the last durable commit',{timeout:8000},async t=>{
  let saved=null,connections=0,release,entered=false;const gate=new Promise(r=>release=r),commits=[],auth=[],health=[],sockets=[],controller=new AbortController();
  const gateway=new QQGateway(api,{intents:1<<25,maxPendingDispatches:2,backoffMs:1,maxFailures:3,loadSession:async()=>saved,invalidateSession:async()=>{saved=null;},health:async reason=>health.push(reason),dispatch:async(p,session)=>{if(p.s===2&&connections===1){entered=true;await gate;}commits.push(p.s);saved=session;},createSocket:()=>{const n=++connections;const socket=new Socket((p,ws)=>{if(p.op===1)ws.message({op:11});if(p.op===2||p.op===6){auth.push(p);if(n===1)ws.message({op:0,t:'READY',s:1,d:{session_id:'session-fixture'}});else{ws.message({op:0,t:'RESUMED',s:3,d:{}});ws.message({op:0,t:'GROUP_AT_MESSAGE_CREATE',s:4,d:{}});}}});sockets.push(socket);return socket;}});
  const run=gateway.run(controller.signal);t.after(async()=>{release();controller.abort();await run.catch(()=>{});});await until(()=>saved?.seq===1);sockets[0].message({op:0,t:'GROUP_AT_MESSAGE_CREATE',s:2,d:{}});await until(()=>entered);
  sockets[0].message({op:0,t:'GROUP_AT_MESSAGE_CREATE',s:3,d:{}});sockets[0].message({op:0,t:'GROUP_AT_MESSAGE_CREATE',s:4,d:{}});await until(()=>sockets[0].readyState===WebSocket.CLOSED);assert.equal(connections,1);assert.equal(saved.seq,1);
  release();await until(()=>saved.seq===4);controller.abort();await run;assert.deepEqual(commits,[1,2,3,4]);assert.deepEqual(auth.map(p=>p.op),[2,6]);assert.equal(auth[1].d.seq,2);assert.ok(health.some(r=>r.includes('QQ_GATEWAY_DISPATCH_BACKPRESSURE')));
});

test('M6 duplicate and old gateway sequences cannot be dispatched twice',{timeout:8000},async t=>{
  let saved=null,socket;const commits=[],controller=new AbortController();const gateway=new QQGateway(api,{intents:1<<25,maxPendingDispatches:128,loadSession:async()=>saved,invalidateSession:async()=>{},dispatch:async(p,s)=>{saved=s;commits.push(p.s);},createSocket:()=>socket=new Socket((p,ws)=>{if(p.op===2)ws.message({op:0,t:'READY',s:10,d:{session_id:'fixture'}});if(p.op===1)ws.message({op:11});})});
  const run=gateway.run(controller.signal);t.after(async()=>{controller.abort();await run;});await until(()=>saved?.seq===10);
  for(let n=0;n<100;n++)socket.message({op:0,t:'GROUP_AT_MESSAGE_CREATE',s:n%2?10:9,d:{}});socket.message({op:0,t:'GROUP_AT_MESSAGE_CREATE',s:11,d:{}});await until(()=>saved.seq===11);assert.deepEqual(commits,[10,11]);
});

test('M6 shutdown waits for an active durable dispatch and validates dispatch limits',{timeout:8000},async()=>{
  for(const value of [0,-1,1.5,NaN])assert.throws(()=>new QQGateway(api,{intents:1,maxPendingDispatches:value}),/QQ_INVALID_DISPATCH_LIMIT/);
  let entered=false,release,finished=false,committed=false;const gate=new Promise(r=>release=r),controller=new AbortController();const gateway=new QQGateway(api,{intents:1,loadSession:async()=>null,invalidateSession:async()=>{},dispatch:async()=>{entered=true;await gate;committed=true;},createSocket:()=>new Socket((p,ws)=>{if(p.op===2)ws.message({op:0,t:'READY',s:1,d:{session_id:'fixture'}});})});
  const run=gateway.run(controller.signal).finally(()=>{finished=true;});try{await until(()=>entered);controller.abort();await delay(10);assert.equal(finished,false);}finally{release();controller.abort();await run;}assert.equal(committed,true);
});

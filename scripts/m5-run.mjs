import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { createConsoleServer } from '@superagent/web-console';
import { createM5 } from './m5-runtime.mjs';
const {values}=parseArgs({options:{database:{type:'string'},project:{type:'string'},port:{type:'string',default:'8787'},source:{type:'string'},'access-config':{type:'string',default:'.artifacts/m5-access.dpapi'},'protected-config':{type:'string'},'qq-configured':{type:'boolean',default:false},'qq-source':{type:'boolean',default:false},'qq-write':{type:'boolean',default:false},'qq-readonly':{type:'boolean',default:false},'github-write':{type:'boolean',default:false},'max-sends':{type:'string'},once:{type:'boolean',default:false}}});
const port=Number(values.port);if(!Number.isInteger(port)||port<0||port>65535)throw new Error('INVALID_PORT');if(values['max-sends']!==undefined&&(!Number.isSafeInteger(Number(values['max-sends']))||Number(values['max-sends'])<0))throw new Error('INVALID_SEND_LIMIT');if(values['qq-write']&&!values['qq-configured']||values['qq-source']&&!values['qq-configured'])throw new Error('QQ_CONFIGURATION_REQUIRED');
const controller=new AbortController();const stop=()=>controller.abort();process.once('SIGINT',stop);process.once('SIGTERM',stop);process.on('message',m=>{if(m?.type==='stop')stop();});
const app=await createM5(values,controller.signal);const server=createConsoleServer(app.control);
try{
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});console.log(JSON.stringify({status:'listening',url:`http://127.0.0.1:${server.address().port}`,projectId:values.project,qqWrites:values['qq-write'],githubWrites:values['github-write'],backup:app.backupFile,accessKeyStorage:'local DPAPI or explicit environment; key is not logged'}));
  do{const result=await app.tick();if(values.once||result.report.processed||result.delivery.processed||result.github.processed)console.log(JSON.stringify(result));if(values.once||controller.signal.aborted)break;try{await delay(500,undefined,{signal:controller.signal});}catch{if(controller.signal.aborted)break;}}while(!controller.signal.aborted);
}finally{controller.abort();await new Promise(resolve=>{server.close(resolve);server.closeIdleConnections();});await app.close();if(process.connected)process.disconnect();}

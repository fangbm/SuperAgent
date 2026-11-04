import { readFileSync } from 'node:fs';
import { createApplication } from '../../scripts/application.mjs';
import { sourceDouble,access } from './application-helpers.mjs';
const config=JSON.parse(readFileSync(process.argv[2],'utf8')),entry=config.sources[0],controller=new AbortController();let attempts=0;
process.once('SIGTERM',()=>controller.abort());
process.on('message',message=>{if(message?.type==='test-sigterm')process.emit('SIGTERM');});
const app=await createApplication(config,{access,signal:controller.signal,log:event=>{if(event.state==='recovery_wait')process.send({state:event.state});},sourceFactories:{'qq-official':()=>sourceDouble(entry,{start:()=>{attempts++;throw new Error('TRANSIENT_NETWORK');}})}});
try{await app.run();}finally{await app.close();process.send({closed:true,attempts,state:app.plugins.status()[entry.id].state});process.disconnect();}

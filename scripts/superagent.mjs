import { parseArgs } from 'node:util';
import { loadApplicationConfig } from './application-config.mjs';
import { createApplication } from './application.mjs';
import { ApplicationPlugins,createDelivery,validatePlugin } from './application-plugins.mjs';

const {values}=parseArgs({options:{config:{type:'string',default:'config/superagent.json'},'check-config':{type:'boolean',default:false},'run-for-ms':{type:'string'}}});
const controller=new AbortController(),stop=()=>controller.abort();
process.once('SIGINT',stop);process.once('SIGTERM',stop);
const control=message=>{if(message?.type==='stop')stop();};process.on('message',control);
let app,timer;
try{
  const config=loadApplicationConfig(values.config);
  if(values['check-config']){
    new ApplicationPlugins(null,config,null);
    for(const entry of config.deliveries.filter(e=>e.enabled))validatePlugin(createDelivery(entry.config),entry,'delivery');
    console.log(JSON.stringify({state:'config_valid',enabledSources:config.sources.filter(e=>e.enabled).map(e=>e.id)}));
  }else{
    const ms=values['run-for-ms']===undefined?null:Number(values['run-for-ms']);
    if(ms!==null&&(!Number.isInteger(ms)||ms<1||ms>3600000))throw new Error('INVALID_RUN_WINDOW');
    app=await createApplication(config,{signal:controller.signal,log:event=>console.log(JSON.stringify(event))});
    await app.start();if(ms!==null)timer=setTimeout(stop,ms);
    await app.run();
  }
}catch(error){console.error(error instanceof Error&&/^[A-Z][A-Z0-9_]+$/.test(error.message)?error.message:'APPLICATION_FAILED');process.exitCode=1;}
finally{clearTimeout(timer);await app?.close();process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);process.removeListener('message',control);if(process.connected)process.disconnect();}

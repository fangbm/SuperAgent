import { parseArgs } from 'node:util';
import { loadM5Access } from './m5-local-access.mjs';
const {values}=parseArgs({options:{config:{type:'string',default:'.artifacts/m5-access.dpapi'},show:{type:'boolean',default:false}}});
if(values.show)console.log(loadM5Access(values.config).accessKey);else console.log('Use --show in your own local terminal to display the Web access key.');

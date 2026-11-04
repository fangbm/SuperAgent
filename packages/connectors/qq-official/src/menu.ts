export interface QQMenuItem {name:string;type:'switch'|'send_message'|'link'|'menu';send_message?:string;link?:string;switch?:{switch_id:string;default:boolean};sub_menu_items?:QQMenuItem[]}
export interface QQMenu {items:QQMenuItem[]}
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const length=(s:string)=>[...s].reduce((n,c)=>n+(/[^\x00-\xff]/u.test(c)?2:1),0);
export function validateQQMenu(input:unknown):QQMenu {
  if(!object(input)||Object.keys(input).some(k=>k!=='items')||!Array.isArray(input.items)||input.items.length>10)throw new Error('QQ_MENU_INVALID');
  const item=(value:unknown,sub=false):QQMenuItem=>{
    if(!object(value)||typeof value.name!=='string'||!value.name.trim()||length(value.name)>(sub?14:10)||Object.keys(value).some(k=>!['name','type','send_message','link','switch','sub_menu_items'].includes(k)))throw new Error('QQ_MENU_INVALID');
    const t=value.type;if(!['send_message','link',...(sub?[]:['switch','menu'])].includes(String(t)))throw new Error('QQ_MENU_INVALID_TYPE');
    const field=t==='send_message'?'send_message':t==='link'?'link':t==='menu'?'sub_menu_items':'switch';
    if(Object.keys(value).some(k=>!['name','type',field].includes(k)))throw new Error('QQ_MENU_INVALID');
    if(t==='send_message'&&(typeof value.send_message!=='string'||!value.send_message.trim()||value.send_message.length>512))throw new Error('QQ_MENU_INVALID');
    if(t==='link'){
      if(typeof value.link!=='string'||!URL.canParse(value.link))throw new Error('QQ_MENU_INVALID_URL');const url=new URL(value.link);
      if(url.protocol!=='https:'||url.username||url.password||url.hash||url.search)throw new Error('QQ_MENU_INVALID_URL');
    }
    if(t==='switch'&&(!object(value.switch)||Object.keys(value.switch).some(k=>!['switch_id','default'].includes(k))||typeof value.switch.switch_id!=='string'||!value.switch.switch_id.trim()||typeof value.switch.default!=='boolean'))throw new Error('QQ_MENU_INVALID');
    if(t==='menu'&&(!Array.isArray(value.sub_menu_items)||!value.sub_menu_items.length||value.sub_menu_items.length>5))throw new Error('QQ_MENU_INVALID');
    return{...value,...(t==='menu'?{sub_menu_items:(value.sub_menu_items as unknown[]).map(v=>item(v,true))}:{})} as unknown as QQMenuItem;
  };
  return{items:input.items.map(v=>item(v))};
}
export const qqMenuSchema={type:'object',additionalProperties:false,required:['enabled'],properties:{enabled:{type:'boolean'},autoDeploy:{const:false},defaultRecentHours:{type:'integer',minimum:1,maximum:168},webURL:{type:'string',format:'uri'}}};

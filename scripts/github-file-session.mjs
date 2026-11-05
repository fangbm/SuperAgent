import {existsSync,mkdirSync} from 'node:fs';
import {execFileSync,spawnSync} from 'node:child_process';
import {parseArgs} from 'node:util';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadApplicationConfig} from './application-config.mjs';
export function loadGitHubUploadSession(filename){
 if(!filename||!existsSync(filename))return undefined;
 if(process.platform!=='win32')throw new Error('GITHUB_UPLOAD_SESSION_REQUIRES_WINDOWS');
 const script='Add-Type -AssemblyName System.Security; $b=[IO.File]::ReadAllBytes($env:SA_GITHUB_UPLOAD_SESSION_FILE); $p=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Text.Encoding]::UTF8.GetString($p)';
 try{const value=execFileSync('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{encoding:'utf8',timeout:10000,windowsHide:true,maxBuffer:16384,env:{...process.env,SA_GITHUB_UPLOAD_SESSION_FILE:path.resolve(filename)},stdio:['ignore','pipe','pipe']}).trim();if(!/^[A-Za-z0-9_.%+/=-]{16,4096}$/.test(value))throw new Error();return value;}catch{throw new Error('GITHUB_UPLOAD_SESSION_UNAVAILABLE');}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{const {values}=parseArgs({options:{config:{type:'string',default:'config/superagent.json'},file:{type:'string'},check:{type:'boolean',default:false}}});
 const config=loadApplicationConfig(values.config),filename=path.resolve(values.file??config.github.attachmentUploads.sessionConfig??path.join(path.dirname(config.database),'github-upload-session.dpapi'));
 if(values.check){console.log(JSON.stringify({configured:!!loadGitHubUploadSession(filename),file:filename,contactsGitHub:false}));}
 else{
  if(process.platform!=='win32')throw new Error('GITHUB_UPLOAD_SESSION_REQUIRES_WINDOWS');mkdirSync(path.dirname(filename),{recursive:true});
  console.log('请粘贴你在 GitHub 开发者工具中复制的 user_session，输入不会显示。仅加密保存到本机，不读取浏览器、不访问 GitHub。');
  const script=`$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Security;$s=Read-Host 'user_session' -AsSecureString;$ptr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($s);try{$v=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr);if($v -notmatch '^[A-Za-z0-9_.%+/=-]{16,4096}$'){throw 'GITHUB_UPLOAD_SESSION_INVALID'};$p=[Text.Encoding]::UTF8.GetBytes($v);$b=[Security.Cryptography.ProtectedData]::Protect($p,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);$f=$env:SA_GITHUB_UPLOAD_SESSION_FILE;$tmp=$f+'.'+[Guid]::NewGuid().ToString()+'.tmp';[IO.File]::WriteAllBytes($tmp,$b);if([IO.File]::Exists($f)){[IO.File]::Replace($tmp,$f,$null)}else{[IO.File]::Move($tmp,$f)}}finally{[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)}`;
  const result=spawnSync('powershell.exe',['-NoLogo','-NoProfile','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{stdio:'inherit',env:{...process.env,SA_GITHUB_UPLOAD_SESSION_FILE:filename}});if(result.status!==0)throw new Error('GITHUB_UPLOAD_SESSION_NOT_SAVED');console.log(JSON.stringify({configured:true,file:filename,contactsGitHub:false}));
 }
 }catch(e){console.error(e instanceof Error&&/^[A-Z0-9_]+$/.test(e.message)?e.message:'GITHUB_UPLOAD_SESSION_COMMAND_FAILED');process.exitCode=1;}
}

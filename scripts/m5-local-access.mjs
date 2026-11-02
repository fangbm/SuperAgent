import { existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import path from 'node:path';
export function loadM5Access(filename='.artifacts/m5-access.dpapi'){
  if(process.env.SA_WEB_ACCESS_KEY){const accessKey=process.env.SA_WEB_ACCESS_KEY;if(accessKey.length<32)throw new Error('WEB_ACCESS_KEY_TOO_SHORT');return{accessKey,signingKey:process.env.SA_CURSOR_SIGNING_KEY??createHash('sha256').update('m5-cursors:'+accessKey).digest('hex')};}
  if(process.platform!=='win32')throw new Error('SA_WEB_ACCESS_KEY_REQUIRED');const target=path.resolve(filename);mkdirSync(path.dirname(target),{recursive:true});
  const run=(script,input='')=>execFileSync('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{input,encoding:'utf8',windowsHide:true,timeout:10_000,maxBuffer:16_384,env:{...process.env,SA_M5_ACCESS_FILE:target},stdio:['pipe','pipe','pipe']}).trim().replace(/^\uFEFF/,'');
  try{
    if(!existsSync(target)){
      const values={accessKey:randomBytes(32).toString('base64url'),signingKey:randomBytes(32).toString('base64url')};
      run("Add-Type -AssemblyName System.Security; $p=[Text.Encoding]::UTF8.GetBytes([Console]::In.ReadToEnd()); $b=[Security.Cryptography.ProtectedData]::Protect($p,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); $f=[IO.File]::Open($env:SA_M5_ACCESS_FILE,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write); try{$f.Write($b,0,$b.Length)}finally{$f.Close()}",JSON.stringify(values));
    }
    const value=JSON.parse(run("Add-Type -AssemblyName System.Security; $b=[IO.File]::ReadAllBytes($env:SA_M5_ACCESS_FILE); $p=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Text.Encoding]::UTF8.GetString($p)"));
    if(typeof value.accessKey!=='string'||value.accessKey.length<32||typeof value.signingKey!=='string'||value.signingKey.length<32)throw new Error();return value;
  }catch{throw new Error('M5_PROTECTED_ACCESS_UNAVAILABLE');}
}

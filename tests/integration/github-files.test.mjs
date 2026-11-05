import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {GitHubIssueAssets} from '@superagent/issue-tracker';
import {artifactType} from '@superagent/plugin-host';
const signal=()=>new AbortController().signal,session='fixture-session-value-123456',repo='owner/private-test',name='artifact-'+'c'.repeat(64)+'.txt',bytes=Buffer.from('ERROR loading failed\n'),href='https://github.com/user-attachments/files/123/'+name,storage='https://github-production-repository-file-5c1aeb.s3.amazonaws.com/';
function fixture(options={}){const calls=[];const port=new GitHubIssueAssets({repository:repo,token:'fixture-api-token',session,fetch:async(input,init={})=>{const u=new URL(input);calls.push({u,init});
 if(u.hostname==='github.com'&&u.pathname==='/'+repo){assert.ok(init.headers.Cookie.includes('user_session='+session));return new Response('embedded {"uploadToken":"csrf-policy"}',{headers:{'Set-Cookie':'_gh_sess=rotated-fixture; Path=/; Secure'}});}
 if(u.pathname==='/upload/policies/assets'){assert.equal(init.method,'POST');assert.equal(init.body.get('authenticity_token'),'csrf-policy');assert.equal(init.body.get('size'),String(bytes.length));assert.equal(init.body.get('repository_id'),'99');assert.equal(init.body.get('name'),name);assert.ok(init.headers.Cookie.includes('_gh_sess=rotated-fixture'));return Response.json({upload_url:options.storage??storage,asset:{id:123,size:bytes.length,content_type:'text/plain',href},form:{acl:options.acl??'private','Content-Type':'text/plain',key:'fixture-key',policy:'fixture-policy'},asset_upload_url:options.finalize??'/upload/repository-files/123',asset_upload_authenticity_token:'csrf-finalize'});}
 if(u.hostname.endsWith('.s3.amazonaws.com')||u.hostname==='objects-origin.githubusercontent.com'){assert.equal(init.headers.Cookie,undefined);assert.equal(init.headers.Authorization,undefined);if(init.method==='POST'){assert.equal(init.redirect,'error');assert.deepEqual(Buffer.from(await init.body.get('file').arrayBuffer()),bytes);assert.equal([...init.body.keys()].at(-1),'file');if(options.timeout)throw new Error('NETWORK_UNKNOWN');return new Response(null,{status:204});}return new Response(bytes);}
 if(u.pathname==='/upload/repository-files/123'){assert.equal(init.method,'PUT');assert.equal(init.body.get('authenticity_token'),'csrf-finalize');return Response.json({href});}
 if(u.pathname.startsWith('/user-attachments/files/'))return init.headers.Authorization?new Response(null,{status:302,headers:{Location:storage+'fixture-key?signature=temporary'}}):new Response(null,{status:404});
 throw new Error('UNEXPECTED_URL');}});return{port,calls};}
test('configured web-session file upload requests policy, posts original bytes without credentials, finalizes and verifies private reads',async()=>{
 const {port,calls}=fixture();assert.equal(port.canUpload('text/plain'),true);assert.equal(await port.upload(bytes,'text/plain',name,'99',signal()),href);assert.equal(await port.verify(href,createHash('sha256').update(bytes).digest('hex'),bytes.length,signal()),true);assert.equal(calls.filter(c=>c.u.hostname==='uploads.github.com').length,0);assert.equal(calls.filter(c=>c.init.method==='PUT').length,1);
});
test('file policy rejects public ACL, untrusted storage and forged finalize paths before any file bytes leave',async()=>{
 for(const options of [{acl:'public-read'},{storage:'https://attacker.example/upload'},{storage:'https://github-production-repository-file-5c1aeb.s3.amazonaws.com.evil.test/'},{finalize:'/upload/repository-files/999'},{finalize:'https://attacker.example/finalize'}]){const {port,calls}=fixture(options);await assert.rejects(port.upload(bytes,'text/plain',name,'99',signal()),/POLICY_INVALID/);assert.equal(calls.filter(c=>c.u.hostname.endsWith('s3.amazonaws.com')).length,0);}
});
test('the observed GitHub objects-origin gateway is allowed only for the exact approved bucket path',async()=>{
 const {port}=fixture({storage:'https://objects-origin.githubusercontent.com/github-production-repository-file-5c1aeb'});assert.equal(await port.upload(bytes,'text/plain',name,'99',signal()),href);
 const {port:bad}=fixture({storage:'https://objects-origin.githubusercontent.com/untrusted-bucket'});await assert.rejects(bad.upload(bytes,'text/plain',name,'99',signal()),/POLICY_INVALID/);
});
test('missing/expired file sessions do not post files, and interrupted S3 writes remain unknown without finalize or fallback',async()=>{
 let calls=0;const missing=new GitHubIssueAssets({repository:repo,token:'fixture',fetch:async()=>{calls++;throw new Error();}});assert.equal(missing.canUpload('application/zip'),false);await assert.rejects(missing.upload(bytes,'text/plain',name,'99',signal()),/SESSION_REQUIRED/);assert.equal(calls,0);
 const expired=new GitHubIssueAssets({repository:repo,token:'fixture',session,fetch:async()=>new Response(null,{status:302,headers:{Location:'https://github.com/login'}})});await assert.rejects(expired.upload(bytes,'text/plain',name,'99',signal()),/HTTP_302/);
 const {port,calls:requests}=fixture({timeout:true});await assert.rejects(port.upload(bytes,'text/plain',name,'99',signal()),/UPLOAD_UNKNOWN/);assert.equal(requests.filter(c=>c.init.method==='PUT').length,0);assert.equal(requests.filter(c=>c.u.hostname==='uploads.github.com').length,0);
});
test('PDF ZIP and minidump capture validates basic signatures without extracting or executing files',()=>{
 assert.equal(artifactType(Buffer.from('%PDF-1.7\nfixture\n%%EOF\n'),'application/pdf','report.pdf'),'application/pdf');const zip=Buffer.alloc(22);zip.writeUInt32LE(0x06054b50);assert.equal(artifactType(zip,'application/octet-stream','logs.zip'),'application/zip');const dump=Buffer.alloc(32);dump.write('MDMP');assert.equal(artifactType(dump,'application/octet-stream','crash.dmp'),'application/octet-stream');
 for(const file of ['bad.pdf','bad.zip','bad.dmp','run.exe'])assert.throws(()=>artifactType(Buffer.from('not a valid file'),'application/octet-stream',file),/TYPE_REJECTED/);
});

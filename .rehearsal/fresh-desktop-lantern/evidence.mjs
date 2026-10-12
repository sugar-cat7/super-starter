import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
if(process.argv[2]==='dump'){
  const directory=path.resolve(process.argv[3]),index=Number(process.argv[4]),manifest=JSON.parse(fs.readFileSync(path.join(directory,'manifest.json'),'utf8'));
  const part=manifest.parts.find(part=>part.index===index);assert(part,'requested part is present');
  const bytes=fs.readFileSync(path.join(directory,part.path));assert.equal(bytes.length,part.bytes);assert.equal(digest(bytes),part.sha256);
  console.log('ACTOR_TRANSPORT_MANIFEST '+JSON.stringify(manifest));
  const b64=bytes.toString('base64');
  for(let i=0;i<b64.length;i+=30000)console.log('ACTOR_TRANSPORT_CHUNK '+JSON.stringify({kind:manifest.kind,fullSha256:manifest.sha256,fullBytes:manifest.bytes,part:index,partSha256:part.sha256,partBytes:part.bytes,index:i/30000,total:Math.ceil(b64.length/30000),data:b64.slice(i,i+30000)}));
  console.log('ACTOR_TRANSPORT_VERIFIED '+JSON.stringify({kind:manifest.kind,index,sha256:part.sha256,bytes:bytes.length}));
}else if(process.argv[2]==='prepare'){
  const root=process.cwd(),kind=process.argv[3],directory=path.resolve(process.argv[4]);
  assert(!fs.existsSync(path.join(path.dirname(root),'_source')));assert(!fs.existsSync(path.join(path.dirname(root),'_mechanical')));
  const walk=dir=>fs.existsSync(dir)?fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(dir,e.name)):[path.join(dir,e.name)]):[];
  const files=walk('artifacts').filter(file=>!file.endsWith('evidence-transport.json')&&!file.endsWith('.bundle')).sort().map(file=>{const bytes=fs.readFileSync(file);return {path:file,bytes:bytes.length,sha256:digest(bytes),data:bytes.toString('base64')};});
  const payload=Buffer.from(JSON.stringify({schema:1,kind,os:process.platform,files})),partSize=512*1024,parts=[];
  fs.mkdirSync(directory,{recursive:true});
  for(let offset=0;offset<payload.length;offset+=partSize){
    const bytes=payload.subarray(offset,offset+partSize),index=parts.length,file='part-'+String(index).padStart(4,'0')+'.bin';
    fs.writeFileSync(path.join(directory,file),bytes);parts.push({index,path:file,sha256:digest(bytes),bytes:bytes.length});
  }
  assert(parts.length>0);
  const manifest={schema:1,kind,os:process.platform,sha256:digest(payload),bytes:payload.length,partSize,parts,files:files.map(({path,bytes,sha256})=>({path,bytes,sha256}))};
  fs.writeFileSync(path.join(directory,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
  fs.copyFileSync(process.argv[1],path.join(directory,'transport.mjs'));
  if(process.env.GITHUB_OUTPUT)fs.appendFileSync(process.env.GITHUB_OUTPUT,'matrix='+JSON.stringify({include:parts.map(part=>({index:part.index}))})+'\n');
  console.log('ACTOR_TRANSPORT_PREPARED '+JSON.stringify(manifest));
}else if(process.argv[2]==='plan'){
  const directory=path.resolve(process.argv[3]),include=[];
  for(const entry of fs.readdirSync(directory,{withFileTypes:true}).filter(entry=>entry.isDirectory())){
    const manifest=JSON.parse(fs.readFileSync(path.join(directory,entry.name,'manifest.json'),'utf8'));
    const os=entry.name.replace('lantern-native-transport-','');assert(['Linux','macOS','Windows'].includes(os));
    for(const part of manifest.parts)include.push({os,index:part.index});
  }
  assert(include.length>0);fs.appendFileSync(process.env.GITHUB_OUTPUT,'matrix='+JSON.stringify({include})+'\n');
  console.log('ACTOR_NATIVE_TRANSPORT_PLAN '+JSON.stringify({include}));
}else throw new Error('Expected prepare|dump|plan');

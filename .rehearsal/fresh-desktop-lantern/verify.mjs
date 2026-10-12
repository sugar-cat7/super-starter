import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
const sourceSHA='653abf13ae3a54b2434c422ab8dc6800822387c3';
const sourceCID='8a91208bf0be87ea59f830dd11d700618bfc46c75493dd9799b0c5c3815fff25';
const root=path.resolve(process.argv[3]);
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
if(process.argv[2]==='source'){
  assert.equal(execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),sourceSHA);
  assert.equal(execFileSync('git',['status','--porcelain','--untracked-files=all'],{cwd:root,encoding:'utf8'}),'');
  const {contentId}=await import(pathToFileURL(path.join(root,'tools/quality/gate.ts')).href);
  assert.equal(contentId(root),sourceCID);
  console.log('ACTOR_SOURCE_ASSERT '+JSON.stringify({sha:sourceSHA,contentId:sourceCID,clean:true,phase:process.argv[4]}));
}else if(process.argv[2]==='generated'){
  const state=JSON.parse(fs.readFileSync(path.join(root,'.template.json'),'utf8'));
  assert.equal(state.kind,'project');
  assert.deepEqual(state.options,{name:'desktop-counter-lantern',scope:'@lantern-lab',identifier:'dev.lantern.counter',preset:'desktop',features:[]});
  assert.equal(state.origin.sha,sourceSHA);
  assert.equal(state.origin.dirty,false);
  const digest=crypto.createHash('sha256');
  for(const [file,expected] of Object.entries(state.managed)){
    const target=path.resolve(root,file);
    assert(target.startsWith(root+path.sep),'managed path stays inside project');
    assert(fs.lstatSync(target).isFile(),'managed file is regular: '+file);
    const bytes=fs.readFileSync(target);
    assert.equal(hash(bytes),expected,'managed SHA: '+file);
    digest.update(file);digest.update('\0');digest.update(bytes);
  }
  assert.equal(digest.digest('hex'),state.origin.contentId);
  const selected=state.packages.map(pkg=>JSON.parse(fs.readFileSync(path.join(root,'packages',pkg,'package.json'),'utf8')));
  const applications=selected.filter(pkg=>(pkg.starter?.runtime??'library')!=='library');
  assert.equal(applications.length,1);
  assert.equal(applications[0].starter.runtime,'desktop');
  assert.equal(applications[0].name,'@lantern-lab/desktop');
  const tauri=JSON.parse(fs.readFileSync(path.join(root,'packages/desktop/src-tauri/tauri.conf.json'),'utf8'));
  assert.equal(tauri.identifier,'dev.lantern.counter');
  console.log('ACTOR_GENERATED_ASSERT '+JSON.stringify({options:state.options,origin:state.origin,managedFiles:Object.keys(state.managed).length,packages:state.packages}));
}else throw new Error('Expected source|generated');

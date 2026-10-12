import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
const sourceSHA='460ad19c970adaab7231795f3438943d9158b135';
const sourceCID='d674216f6fd7d5a03b3b0f2bbf3b54f0ee83f75779542f6b7d0a8eab62499337';
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

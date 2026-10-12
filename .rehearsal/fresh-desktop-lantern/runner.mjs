import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { setTimeout as pause } from 'node:timers/promises';
const root=process.cwd(),support=path.dirname(process.argv[1]);
assert(!fs.existsSync(path.resolve(root,'../_source')));
assert(!fs.existsSync(path.resolve(root,'../_mechanical')));
const {spawnOwned,stopTree,pnpmCommand}=await import(pathToFileURL(path.join(root,'tools/process.ts')).href);
let phaseGuard;
const phases=[];fs.mkdirSync('artifacts/actor/logs',{recursive:true});
const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',maxBuffer:64*1024*1024}).trim();
async function phase(id,command,args,timeout=30*60_000,ready=false,cwd=root){
  const inputIdentity=phaseGuard?phaseGuard('before '+id):null;
  const startedAt=new Date().toISOString(),started=performance.now(),log=fs.createWriteStream('artifacts/actor/logs/'+id+'.log');
  console.log('ACTOR_PHASE_START '+JSON.stringify({id,command,args,cwd,startedAt,sha:git('rev-parse','HEAD')}));
  const child=spawnOwned(command,args,{cwd,stdio:['ignore','pipe','pipe'],env:process.env});
  let output='',code=null,signal=null,spawnError;
  for(const [stream,owner] of [[child.stdout,process.stdout],[child.stderr,process.stderr]])stream.on('data',chunk=>{output+=chunk.toString();log.write(chunk);});
  const closed=new Promise(resolve=>child.once('close',(c,s)=>{code=c;signal=s;resolve();}));
  child.once('error',error=>{spawnError=error;});
  let failure;
  try{
    if(ready){
      while(!output.includes('READY @lantern-lab/desktop/native')&&performance.now()-started<timeout){
        if(child.exitCode!==null||child.signalCode!==null||spawnError)throw new Error('Development exited before native readiness');
        await pause(100);
      }
      assert(output.includes('READY @lantern-lab/desktop/native'),'actual native dev readiness');
      await stopTree(child);await closed;assert.equal(code,0,'development exits successfully after normal shutdown');
    }else{
      let timer;await Promise.race([closed,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Phase deadline exceeded')),timeout);})]).finally(()=>clearTimeout(timer));
      if(spawnError)throw spawnError;assert.equal(code,0,id+' failed');
    }
  }catch(error){failure=String(error);}
  finally{
    try{await stopTree(child);}catch(error){failure=[failure,String(error)].filter(Boolean).join('\n');}
    let outputIdentity=null;
    try{if(phaseGuard)outputIdentity=phaseGuard('after '+id);}catch(error){failure=[failure,String(error)].filter(Boolean).join('\n');}
    await new Promise(resolve=>log.end(resolve));
    phases.push({id,command,args,cwd,inputIdentity,outputIdentity,startedAt,milliseconds:Math.round(performance.now()-started),sha:git('rev-parse','HEAD'),exitCode:code,signal,status:failure?'failed':'passed',error:failure??null});
    fs.writeFileSync('artifacts/actor/phases-'+process.platform+'.json',JSON.stringify(phases,null,2)+'\n');
    console.log('ACTOR_PHASE_END '+JSON.stringify(phases.at(-1)));
  }
  if(failure)throw new Error(failure);
}
const pnpmPhase=(id,args,timeout,ready)=>{const c=pnpmCommand(args);return phase(id,c.command,c.args,timeout,ready);};
const finalReport={schema:1,actor:'fresh_460_desktop_context',independentContext:true,sourceSHA:'460ad19c970adaab7231795f3438943d9158b135',sourceReferenceCID:'d674216f6fd7d5a03b3b0f2bbf3b54f0ee83f75779542f6b7d0a8eab62499337',os:process.platform,status:'failed',phases};
try{
  const state=JSON.parse(fs.readFileSync('.template.json','utf8'));finalReport.sourceOrigin=state.origin;finalReport.pristine=git('rev-parse','HEAD');
  await pnpmPhase('cold-setup',['env:setup']);
  await pnpmPhase('cold-doctor',['env:doctor']);
  await phase('setup-stage','git',['add','.']);
  await phase('bootstrap-prepared-commit','git',['commit','-m','chore: prepare generated Desktop toolchain']);
  const baseline=git('rev-parse','HEAD');finalReport.baseline=baseline;
  const baselineState=JSON.parse(fs.readFileSync('.template.json','utf8'));
  const {createRequire}=await import('node:module');const require=createRequire(path.join(root,'package.json'));const {parse:parseYaml}=require('yaml');
  const baselineLock=parseYaml(fs.readFileSync('pnpm-lock.yaml','utf8'));
  const baselineFiles=Object.fromEntries(execFileSync('git',['ls-tree','-r','-z','HEAD'],{cwd:root,encoding:'utf8'}).split('\0').filter(Boolean).map(row=>{
    const [header,file]=row.split('\t');return [file,{mode:fs.statSync(file).mode&0o777,sha256:crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}];
  }));
  const {generatedErrors}=await import(pathToFileURL(path.join(root,'tools/errors/generate.ts')).href);
  const derivedPaths=[...generatedErrors(root).keys()];

  assert.equal(git('status','--porcelain'),'');
  const payload=JSON.parse(fs.readFileSync(path.join(support,'feature.json'),'utf8'));
  for(const file of payload.files){
    const target=path.resolve(root,file.path);assert(target.startsWith(root+path.sep));
    if(file.expectedSha256===null)assert(!fs.existsSync(target));
    else assert.equal(crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex'),file.expectedSha256,file.path+' baseline');
    fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,file.content);
  }
  await pnpmPhase('normal-dependency-install',['install','--no-frozen-lockfile']);
  await pnpmPhase('feature-dependency-setup',['env:setup']);
  await pnpmPhase('error-codegen',['errors:generate']);
  await pnpmPhase('format-authored',['format']);
  await phase('format-native','cargo',['fmt'],30*60_000,false,path.join(root,'packages/desktop/src-tauri'));
  await pnpmPhase('targeted-unit-before-commit',['--filter','@lantern-lab/desktop','test']);
  await pnpmPhase('check-before-commit',['check']);
  const allowed=new Set([...payload.files.map(file=>file.path),...derivedPaths,'pnpm-lock.yaml','.template.json']);
  const expectedInventory=new Set([...Object.keys(baselineFiles),...payload.files.map(file=>file.path)]);
  function assertScoped(){
    assert(!fs.existsSync(path.resolve(root,'../_source')));assert(!fs.existsSync(path.resolve(root,'../_mechanical')));
    const inventory=execFileSync('git',['ls-files','-z','--cached','--others','--exclude-standard'],{cwd:root,encoding:'utf8'}).split('\0').filter(Boolean);
    assert.deepEqual([...new Set(inventory)].sort(),[...expectedInventory].sort(),'exact final tracked/untracked inventory');
    for(const [file,expected] of Object.entries(baselineFiles)){
      assert(fs.lstatSync(file).isFile(),file+' remains regular');
      if(!allowed.has(file)){
        assert.equal(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),expected.sha256,file+' preserved');
        assert.equal(fs.statSync(file).mode&0o777,expected.mode,file+' mode preserved');
      }
    }
    const current=JSON.parse(fs.readFileSync('.template.json','utf8'));
    assert.deepEqual({...current,managed:undefined},{...baselineState,managed:undefined},'metadata limited to owning derived hashes');
    assert.deepEqual(Object.keys(current.managed),Object.keys(baselineState.managed));
    for(const [file,old] of Object.entries(baselineState.managed))
      assert.equal(current.managed[file],derivedPaths.includes(file)?crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'):old,file+' managed change limited to codegen');
    for(const [file,expected] of generatedErrors(root))assert(fs.readFileSync(file).equals(expected),file+' actual derived bytes');
    const lock=parseYaml(fs.readFileSync('pnpm-lock.yaml','utf8')),expected=structuredClone(baselineLock);
    for(const name of ['@testing-library/react','@testing-library/user-event','jsdom'])
      expected.importers['packages/desktop'].devDependencies[name]=baselineLock.importers['packages/ui'].devDependencies[name];
    assert.deepEqual(lock,expected,'lock changes only owning Desktop existing-catalog test dependencies');
  }
  assertScoped();
  await phase('feature-stage','git',['add',...allowed]);

  assert.notEqual(git('diff','--cached','--stat'),'');
  assert.equal(git('config','--get','core.hooksPath'),'tools/quality/git-hooks');
  await phase('feature-commit','git',['commit','-m','feat: add native Desktop counter with regression coverage']);
  const head=git('rev-parse','HEAD');assert.notEqual(head,baseline);assert.equal(git('rev-parse','HEAD^'),baseline);assert.equal(git('status','--porcelain'),'');finalReport.featureHEAD=head;
  assertScoped();
  const actualDelta=git('diff','--name-only',baseline,head).split('\n').filter(Boolean).sort();
  assert.deepEqual(actualDelta,[...allowed].sort(),'only the complete authenticated feature/codegen/lock delta committed');
  const {contentId}=await import(pathToFileURL(path.join(root,'tools/quality/gate.ts')).href);
  const {toolVersions}=await import(pathToFileURL(path.join(root,'tools/quality/evidence.ts')).href);
  finalReport.featureCID=contentId(root);
  phaseGuard=label=>{
    const identity={head:git('rev-parse','HEAD'),contentId:contentId(root),origin:JSON.parse(fs.readFileSync('.template.json','utf8')).origin,clean:git('status','--porcelain')==='',sourceAbsent:!fs.existsSync(path.resolve(root,'../_source'))&&!fs.existsSync(path.resolve(root,'../_mechanical'))};
    assert.equal(identity.head,head,label+' HEAD');assert.equal(identity.contentId,finalReport.featureCID,label+' CID');assert.deepEqual(identity.origin,state.origin,label+' SourceOrigin');assert.equal(identity.origin.sha,'460ad19c970adaab7231795f3438943d9158b135');assert.equal(identity.clean,true,label+' clean');assert.equal(identity.sourceAbsent,true,label+' Source absence');assertScoped();return identity;
  };
  phaseGuard('fixed feature input');
  finalReport.tools=toolVersions(root);finalReport.featureDelta=git('diff','--name-status',baseline,head);
  await pnpmPhase('standard-setup',['env:setup']);assert.equal(git('status','--porcelain'),'');assert.equal(contentId(root),finalReport.featureCID);
  await pnpmPhase('standard-doctor',['env:doctor']);
  await pnpmPhase('standard-dev',['dev','--','desktop'],30*60_000,true);
  await pnpmPhase('standard-check',['check']);
  await pnpmPhase('standard-test',['test']);
  await pnpmPhase('standard-pre-pr',['gate:pre-pr','--','--base',baseline],45*60_000);
  await pnpmPhase('standard-full',['gate:full'],45*60_000);
  await pnpmPhase('standard-ci',['gate:ci','--','--base',baseline],45*60_000);
  await pnpmPhase('standard-build',['build']);
  await pnpmPhase('standard-preflight',['deploy:preflight','--','--target','desktop','--environment','local']);
  const bare=path.join(path.dirname(root),'desktop-counter-lantern-owned-review.git');assert(!fs.existsSync(bare));
  await phase('owned-bare-init','git',['init','--bare','--template=',bare]);
  await phase('owned-bare-origin','git',['remote','add','review',bare]);
  await phase('genuine-feature-bare-push','git',['push','review','HEAD:refs/heads/feature/counter']);
  assert.equal(execFileSync('git',['--git-dir',bare,'rev-parse','refs/heads/feature/counter'],{encoding:'utf8'}).trim(),head);
  finalReport.barePush={remote:bare,ref:'refs/heads/feature/counter',head,normalHook:true};
  assert.equal(git('status','--porcelain'),'');assert.equal(contentId(root),finalReport.featureCID);
  finalReport.status='passed';finalReport.finalClean=true;
  fs.mkdirSync(path.join(path.dirname(root),'lantern-feature-transport'),{recursive:true});
  const transport=path.join(path.dirname(root),'lantern-feature-transport');
  await phase('bundle-actual-feature','git',['bundle','create',path.join(transport,'feature.bundle'),'--all']);
  fs.writeFileSync(path.join(transport,'handoff.json'),JSON.stringify({head,baseline,contentId:finalReport.featureCID,sourceOrigin:state.origin},null,2)+'\n');
  for(const name of ['native-runner.mjs','evidence.mjs','snapshot.mjs'])fs.copyFileSync(path.join(support,name),path.join(transport,name));
}catch(error){finalReport.status='failed';finalReport.error=String(error);process.exitCode=1;}
finally{
  fs.writeFileSync('artifacts/actor/actor-linux.json',JSON.stringify(finalReport,null,2)+'\n');
  console.log('ACTOR_REPORT '+JSON.stringify(finalReport));
}

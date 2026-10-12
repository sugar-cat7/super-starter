import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
const root=process.cwd(),support=path.dirname(process.argv[1]),handoff=JSON.parse(fs.readFileSync(path.join(support,'handoff.json'),'utf8'));
assert(!fs.existsSync(path.resolve(root,'../_source')));assert(!fs.existsSync(path.resolve(root,'../_mechanical')));
const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
assert.equal(git('rev-parse','HEAD'),handoff.head);assert.equal(git('rev-parse','HEAD^'),handoff.baseline);
const {run,pnpmCommand}=await import(pathToFileURL(path.join(root,'tools/process.ts')).href);
const phases=[];fs.mkdirSync('artifacts/actor/logs',{recursive:true});
const report={schema:1,actor:'fresh_460_desktop_context',nativeExecution:true,os:process.platform,head:handoff.head,baseline:handoff.baseline,contentId:handoff.contentId,sourceOrigin:handoff.sourceOrigin,status:'failed',phases};
for(const [id,args] of [['native-setup',['env:setup']],['native-doctor',['env:doctor']],['native-ci',['gate:ci','--','--base',handoff.baseline,'--checks','native']]]){
  const c=pnpmCommand(args),start=performance.now();let output='';const out=process.stdout.write.bind(process.stdout),err=process.stderr.write.bind(process.stderr);
  process.stdout.write=(chunk,...rest)=>{output+=String(chunk);return true;};process.stderr.write=(chunk,...rest)=>{output+=String(chunk);return true;};
  try{await run(c.command,c.args,{cwd:root,capture:true,timeout:45*60_000});phases.push({id,args,milliseconds:Math.round(performance.now()-start),status:'passed'});}
  catch(error){phases.push({id,args,milliseconds:Math.round(performance.now()-start),status:'failed',error:String(error)});report.error=String(error);process.exitCode=1;}
  finally{process.stdout.write=out;process.stderr.write=err;fs.writeFileSync('artifacts/actor/logs/'+id+'.log',output);fs.writeFileSync('artifacts/actor/actor-'+process.platform+'.json',JSON.stringify(report,null,2)+'\n');}
  if(process.exitCode)break;
}
if(!process.exitCode){
  const {contentId}=await import(pathToFileURL(path.join(root,'tools/quality/gate.ts')).href);assert.equal(contentId(root),handoff.contentId);assert.equal(git('status','--porcelain'),'');report.finalClean=true;report.status='passed';
}
fs.writeFileSync('artifacts/actor/actor-'+process.platform+'.json',JSON.stringify(report,null,2)+'\n');console.log('ACTOR_NATIVE_REPORT '+JSON.stringify(report));

from pathlib import Path
from datetime import datetime, timezone
import base64, hashlib, io, json, os, shutil, subprocess, sys, time, zipfile

carrier = Path.cwd().resolve()
manifest = json.loads((carrier / 'payload/manifest.json').read_text())
project = carrier / '.state/desktop-bootstrap/project'
evidence = project / 'artifacts/agent-desktop/bootstrap'
commands = []
expected_carrier = os.environ['GITHUB_SHA']
branch = manifest['ownBranch']
identity_script = "import {inputIdentity} from './.github/scripts/desktop-agent-input.ts'; console.log(JSON.stringify(inputIdentity()))"
pristine_identity_script = "import {contentId} from './tools/quality/gate.ts'; import {ownHeadSha} from './tools/quality/checkout.ts'; import {readFileSync} from 'node:fs'; console.log(JSON.stringify({featureSha:ownHeadSha(process.cwd()),contentId:contentId(process.cwd()),origin:JSON.parse(readFileSync('.template.json','utf8')).origin}))"

def git(*args, cwd=project):
    return subprocess.check_output(['git', *args], cwd=cwd).decode().strip()

def identity(feature=True):
    value = json.loads(subprocess.check_output(['node', '--input-type=module', '-e', identity_script if feature else pristine_identity_script], cwd=project))
    if value['origin'] != manifest['origin']:
        raise RuntimeError('Generation origin changed')
    return value

def run(phase, argv, feature=True, env=None):
    before = identity(feature)
    started = datetime.now(timezone.utc).isoformat()
    start = time.monotonic()
    filename = f'logs/{len(commands)+1:02}-{phase}.log'
    log = evidence / filename
    with log.open('wb') as output:
        output.write((json.dumps({'phase':phase, 'argv':argv, 'inputBefore':before})+'\n').encode())
        output.flush()
        result = subprocess.run(argv, cwd=project, stdout=output, stderr=subprocess.STDOUT, env=env)
    entry = {'phase':phase, 'argv':argv, 'exit':result.returncode, 'startedAt':started,
             'milliseconds':round((time.monotonic()-start)*1000), 'log':filename,
             'inputBefore':before, 'inputAfter':identity(feature), 'os':sys.platform,
             'execution':'hosted-tools', 'environment':{key:os.environ.get(key) for key in ['TMPDIR','TMP','TEMP']}}
    commands.append(entry)
    (evidence/'commands.json').write_text(json.dumps(commands,indent=2)+'\n')
    print(json.dumps(entry), flush=True)
    if result.returncode:
        raise RuntimeError(f'{phase} failed with exit {result.returncode}; original log retained')
    return entry

def protect_source():
    allowed = set(manifest['ownedFeaturePaths']) | set(manifest['allowedSetupMetadata'])
    mismatches = [name for name,digest in manifest['files'].items() if name not in allowed and hashlib.sha256((project/name).read_bytes()).hexdigest()!=digest]
    if mismatches:
        raise RuntimeError(f'Protected fresh source changed: {mismatches}')
    (evidence/'protected-source.json').write_text(json.dumps({'status':'passed','protectedFiles':len(set(manifest['files'])-allowed),'mismatches':mismatches,'origin':manifest['origin']},indent=2)+'\n')

report = {'schema':1, 'kind':'mechanical-generated-feature-bootstrap', 'execution':'hosted-tools',
          'status':'blocked', 'carrierSha':expected_carrier, 'ownBranch':branch,
          'origin':manifest['origin'], 'normalGitHubRpcSuccess':False, 'commands':commands}
try:
    if os.environ.get('GITHUB_REF') != 'refs/heads/'+branch or git('rev-parse','HEAD',cwd=carrier) != expected_carrier:
        raise RuntimeError('Unexpected carrier branch or checkout SHA')
    archive = base64.b64decode((carrier/'payload/project.zip.b64').read_bytes(), validate=False)
    patch = (carrier/'payload/feature.patch').read_bytes()
    if hashlib.sha256(archive).hexdigest()!=manifest['projectArchiveSha256'] or hashlib.sha256(patch).hexdigest()!=manifest['patchSha256']:
        raise RuntimeError('Pinned generated archive or authored patch digest mismatch')
    if project.exists():
        raise RuntimeError('Bootstrap requires a fresh owned project directory')
    project.mkdir(parents=True,mode=0o700)
    with zipfile.ZipFile(io.BytesIO(archive)) as source:
        names = source.namelist()
        if len(names)!=len(set(names)) or set(names)!=set(manifest['files']):
            raise RuntimeError('Generated archive inventory differs from the pinned manifest')
        for info in source.infolist():
            path = Path(info.filename)
            if path.is_absolute() or '..' in path.parts or ((info.external_attr>>16)&0o170000)!=0o100000:
                raise RuntimeError('Unsafe generated archive entry')
            data = source.read(info)
            if hashlib.sha256(data).hexdigest()!=manifest['files'][info.filename]:
                raise RuntimeError('Generated file digest mismatch')
            target = project/path
            target.parent.mkdir(parents=True,exist_ok=True)
            target.write_bytes(data)
    shutil.copytree(carrier/'.git',project/'.git')
    (evidence/'logs').mkdir(parents=True,mode=0o700)
    temporary = project/'.state/tmp'
    temporary.mkdir(parents=True,mode=0o700)
    for name in ['TMPDIR','TMP','TEMP']:
        os.environ[name]=str(temporary)
    os.environ.pop('GIT_CEILING_DIRECTORIES',None)
    git('config','--local','user.name','Independent Desktop Agent')
    git('config','--local','user.email','independent-desktop-agent@users.noreply.github.com')
    pristine = identity(False)
    if pristine['contentId']!=manifest['initialProjectContentId']:
        raise RuntimeError('Pristine generated-project content ID differs from delivered receipt')
    git('add','--all')
    tree = git('write-tree')
    baseline = subprocess.check_output(['git','commit-tree',tree,'-p',expected_carrier,'-m','Mechanical pristine generated Desktop baseline; no Agent commit claim'],cwd=project).decode().strip()
    git('update-ref','refs/heads/'+branch,baseline)
    git('symbolic-ref','HEAD','refs/heads/'+branch)
    report['mechanicalBaseline']={'sha':baseline,'tree':tree,'parent':expected_carrier,'pristine':pristine,'hookEvidence':False}
    patch_file = project/'.state/feature.patch'
    patch_file.write_bytes(patch)
    run('apply-check',['git','apply','--check',str(patch_file)],False)
    subprocess.run(['git','apply',str(patch_file)],cwd=project,check=True)
    report['beforeSetup']=identity()
    run('setup',['pnpm','env:setup'])
    report['afterSetup']=identity()
    protect_source()
    run('doctor',['pnpm','env:doctor'])
    run('targeted-test',['pnpm','--filter','@independent-native/desktop','test'])
    run('static',['pnpm','check'])
    rust_env=dict(os.environ,RUSTUP_TOOLCHAIN='1.99.0')
    run('rustfmt',['cargo','fmt','--manifest-path','packages/desktop/src-tauri/Cargo.toml','--','--check'],env=rust_env)
    git('add','--all')
    if not git('diff','--cached','--name-only'):
        raise RuntimeError('Feature commit must contain an actual nonempty authored change')
    report['pinnedBeforeCommit']=identity()
    run('commit',['git','commit','-m','Add native note count with accessible status and failure regressions on final generated source'])
    final=identity()
    if not final['clean'] or final['contentId']!=report['pinnedBeforeCommit']['contentId']:
        raise RuntimeError('Normal commit changed the pinned feature bytes or left dirty source')
    bare=project/'.state/normal-push.git'
    subprocess.run(['git','init','--bare',str(bare)],cwd=project,check=True)
    run('push',['git','push',str(bare),'HEAD:refs/heads/agent-feature'])
    transferred=git('--git-dir',str(bare),'rev-parse','refs/heads/agent-feature')
    if transferred!=final['featureSha']:
        raise RuntimeError('Actual normal Git push did not transfer the exact feature commit')
    protect_source()
    if identity()!=final:
        raise RuntimeError('Final feature identity changed during normal push')
    subprocess.run(['git','bundle','create',str(evidence/'feature.bundle'),'refs/heads/'+branch],cwd=project,check=True)
    subprocess.run(['git','archive','--format=tar','--output='+str(evidence/'feature.tar'),final['featureSha']],cwd=project,check=True)
    report.update(status='passed', feature=final, normalLocalBareGitPush={'status':'passed','remoteHead':transferred,'remote':str(bare),'normalGitRpcSuccess':True},
                  bundleSha256=hashlib.sha256((evidence/'feature.bundle').read_bytes()).hexdigest(),sourceArchiveSha256=hashlib.sha256((evidence/'feature.tar').read_bytes()).hexdigest())
except Exception as failure:
    report['error']=str(failure)
    print(str(failure),file=sys.stderr,flush=True)
    sys.exitcode=1
finally:
    evidence.mkdir(parents=True,exist_ok=True,mode=0o700)
    (evidence/'bootstrap-support.json').write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps({key:report.get(key) for key in ['status','carrierSha','feature','error']}),flush=True)
if report['status']!='passed':
    sys.exit(1)

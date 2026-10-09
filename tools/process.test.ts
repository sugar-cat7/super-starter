import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import type { ChildProcess } from 'node:child_process';
import { expect, it } from 'vitest';
import { run, spawnOwned, stopTree } from './process.ts';

it('cleans an orphaned descendant while preserving an unrelated server', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'owned-process-'));
  const server = path.join(root, 'server.mjs');
  const intermediate = path.join(root, 'intermediate.mjs');
  const parent = path.join(root, 'parent.mjs');
  const children: ChildProcess[] = [];
  writeFileSync(
    server,
    "import {createServer} from 'node:http'; const server=createServer((_,res)=>res.end('ready')); server.listen(0,'127.0.0.1',()=>console.log('http://127.0.0.1:'+server.address().port));",
  );
  writeFileSync(
    intermediate,
    "import {spawn} from 'node:child_process'; const child=spawn(process.execPath,[process.argv[2]],{stdio:['ignore','inherit','inherit']}); child.unref(); setTimeout(()=>process.exit(0),200);",
  );
  writeFileSync(
    parent,
    "import {spawn} from 'node:child_process'; const child=spawn(process.execPath,[process.argv[2],process.argv[3]],{stdio:['ignore','inherit','inherit']}); child.on('exit',()=>console.log('INTERMEDIATE_EXITED')); setInterval(()=>{},1000);",
  );
  const start = async (
    args: string[],
    waitForExit = false,
  ): Promise<{ child: ChildProcess; origin: string }> => {
    const child = spawnOwned(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    let output = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    const started = performance.now();
    while (
      (!/http:\/\/127\.0\.0\.1:\d+/u.test(output) ||
        (waitForExit && !output.includes('INTERMEDIATE_EXITED'))) &&
      performance.now() - started < 15000
    ) {
      if (child.exitCode !== null) throw new Error(`Process exited before ready: ${output}`);
      await pause(30);
    }
    const origin = /http:\/\/127\.0\.0\.1:\d+/u.exec(output)?.[0];
    if (!origin || (waitForExit && !output.includes('INTERMEDIATE_EXITED')))
      throw new Error(`Process readiness timeout: ${output}`);
    return { child, origin };
  };
  try {
    const sentinel = await start([server]);
    const orphan = await start([parent, intermediate, server], true);
    expect(await (await fetch(orphan.origin)).text()).toBe('ready');
    await stopTree(orphan.child);
    await expect(fetch(orphan.origin, { signal: AbortSignal.timeout(1000) })).rejects.toThrow(
      /fetch failed|aborted/iu,
    );
    expect(await (await fetch(sentinel.origin)).text()).toBe('ready');
  } finally {
    await Promise.all(children.map((child) => stopTree(child)));
    rmSync(root, { recursive: true, force: true });
  }
}, 40000);

it('reclaims descendants after the owned root exits successfully', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'owned-success-'));
  const address = path.join(root, 'address');
  const server = path.join(root, 'server.mjs');
  const parent = path.join(root, 'parent.mjs');
  writeFileSync(
    server,
    "import {createServer} from 'node:http'; import {writeFileSync} from 'node:fs'; const server=createServer((_,res)=>res.end('ready')); server.listen(0,'127.0.0.1',()=>writeFileSync(process.argv[2],'http://127.0.0.1:'+server.address().port));",
  );
  writeFileSync(
    parent,
    "import {spawn} from 'node:child_process'; import {existsSync} from 'node:fs'; const child=spawn(process.execPath,[process.argv[2],process.argv[3]],{stdio:'ignore'}); child.unref(); const timer=setInterval(()=>{if(existsSync(process.argv[3])) {clearInterval(timer); process.exit(0)}},20);",
  );
  try {
    await run(process.execPath, [parent, server, address], { timeout: 15000 });
    expect(existsSync(address)).toBe(true);
    await expect(
      fetch(readFileSync(address, 'utf8'), { signal: AbortSignal.timeout(1000) }),
    ).rejects.toThrow(/fetch failed|aborted/iu);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 20000);

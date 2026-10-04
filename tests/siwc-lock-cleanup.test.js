import {expect,test} from 'bun:test';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile,rm,stat,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {SiwcClient} from '../connector/siwc.mjs';

for(const stage of ['unpublished','published'])test('crashed '+stage+' lock owners do not retain private artifacts or remove live owners',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'relyless-lock-cleanup-'));let child,exit,timer,client;
  const bootstrap="const fs=require('node:fs/promises');let owner;const wait=()=>new Promise(()=>{});const open=fs.open.bind(fs);fs.open=async(...args)=>{const h=await open(...args);if(String(args[0]).includes('siwc.json.lock.')){owner=String(args[0]);if(process.argv[3]==='unpublished')h.writeFile=async()=>{process.send(owner);await wait();};}return h;};const rename=fs.rename.bind(fs);fs.rename=async(...args)=>{if(process.argv[3]==='published'){process.send(owner);await wait();}return rename(...args);};(async()=>{const {SiwcClient}=await import(process.argv[1]);await new SiwcClient({dataDir:process.argv[2]}).start();})().catch(e=>{console.error(e);process.exit(1);});";
  try{
    child=spawn(process.execPath,['-e',bootstrap,pathToFileURL(resolve('connector/siwc.mjs')).href,dir,stage],{stdio:['ignore','ignore','pipe','ipc']});exit=new Promise(done=>child.once('exit',done));
    const owner=await new Promise((done,fail)=>{timer=setTimeout(()=>fail(new Error('Owner publication did not reach gate')),5000);child.once('message',value=>{clearTimeout(timer);done(value);});});
    if(stage==='unpublished')expect((await stat(owner)).isFile()).toBe(true);else{expect((await stat(join(dir,'siwc.json.lock'))).isFile()).toBe(true);await expect(stat(owner)).rejects.toMatchObject({code:'ENOENT'});}
    child.kill('SIGKILL');await exit;
    const live=join(dir,'siwc.json.lock.'+process.pid+'.'+randomUUID()),guard=join(dir,'siwc.json.lock.recovery.12345'),unrelated=join(dir,'siwc.json.lock.notes');
    await Promise.all([writeFile(live,'live owner'),writeFile(guard,'unverifiable guard'),writeFile(unrelated,'unrelated')]);
    const refreshOwner=join(dir,'siwc.json.refresh.lock.'+child.pid+'.'+randomUUID());if(stage==='unpublished')await writeFile(refreshOwner,'');
    client=new SiwcClient({dataDir:dir});await client.start();
    if(stage==='unpublished')await expect(stat(refreshOwner)).rejects.toMatchObject({code:'ENOENT'});
    await expect(stat(owner)).rejects.toMatchObject({code:'ENOENT'});expect(await readFile(live,'utf8')).toBe('live owner');expect(await readFile(guard,'utf8')).toBe('unverifiable guard');expect(await readFile(unrelated,'utf8')).toBe('unrelated');expect(client.status().authenticated).toBe(false);
  }finally{clearTimeout(timer);if(child?.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await exit;await client?.close();await rm(dir,{recursive:true,force:true});}
},15000);

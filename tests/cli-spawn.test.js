import {describe,expect,test} from 'bun:test';
import {spawn,spawnSync} from 'node:child_process';
import {access,mkdir,mkdtemp,readFile,realpath,rm,stat,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {cliSpawnTarget,executableNames} from '../connector/cli-spawn.mjs';
import {NativeMessageDecoder,encodeNativeMessage} from '../connector/host.mjs';

const installer=fileURLToPath(new URL('../connector/install.mjs',import.meta.url));
const nodePath=spawnSync('node',['-p','process.execPath'],{encoding:'utf8'}).stdout.trim();
const extensionId='a'.repeat(32);
function install(args,env=process.env){return spawnSync(nodePath,[installer,...args],{env,encoding:'utf8',timeout:20000});}
function installedRoot(home,backend){
  const suffix=backend==='chatgpt'?'':backend==='grok'?' Grok':' Antigravity';
  return process.platform==='darwin'
    ? join(home,'Library/Application Support',`Shisui Translate${suffix}`)
    : join(home,'data',`shisui-translate${backend==='chatgpt'?'':`-${backend}`}`);
}
function isolatedEnv(home){return {...process.env,HOME:home,PATH:'',XDG_DATA_HOME:join(home,'data'),XDG_CONFIG_HOME:join(home,'config')};}

describe('cliSpawnTarget',()=>{
  test('passes executables through untouched on every platform',()=>{
    for(const platform of ['linux','darwin','win32']){
      expect(cliSpawnTarget('/opt/tools/agy',['--version'],{platform})).toEqual({command:'/opt/tools/agy',args:['--version'],options:{}});
    }
  });
  test('wraps .cmd and .bat shims through ComSpec on Windows',()=>{
    for(const extension of ['cmd','bat']){
      const target=cliSpawnTarget(`C:\\Users\\u\\AppData\\Roaming\\npm\\agy.${extension}`,['--version'],{platform:'win32',comspec:'C:\\Windows\\System32\\cmd.exe'});
      expect(target.command).toBe('C:\\Windows\\System32\\cmd.exe');
      expect(target.args.slice(0,3)).toEqual(['/d','/s','/c']);
      expect(target.args[3]).toContain(`agy.${extension}`);
      expect(target.args[3]).toContain('"--version"');
      expect(target.options.windowsHide).toBe(true);
    }
  });
  test('does not wrap .cmd off Windows and falls back to cmd.exe without ComSpec',()=>{
    expect(cliSpawnTarget('agy.cmd',['--version'],{platform:'linux'}).command).toBe('agy.cmd');
    expect(cliSpawnTarget('agy.cmd',[],{platform:'win32',comspec:''}).command).toBe('cmd.exe');
  });
  test('quotes arguments containing spaces and quotes',()=>{
    const target=cliSpawnTarget('a b\\tool.cmd',['say "hi"'],{platform:'win32'});
    expect(target.args[3]).toBe('""a b\\tool.cmd" "say ""hi""""');
  });
});

describe('executableNames',()=>{
  test('returns the bare name off Windows',()=>{
    expect(executableNames('agy',{platform:'linux'})).toEqual(['agy']);
  });
  test('expands through PATHEXT order on Windows',()=>{
    expect(executableNames('agy',{platform:'win32',pathext:'.COM;.EXE;.BAT;.CMD'})).toEqual(['agy.com','agy.exe','agy.bat','agy.cmd','agy']);
  });
  test('keeps an explicitly suffixed name as the only candidate',()=>{
    expect(executableNames('agy.cmd',{platform:'win32'})).toEqual(['agy.cmd']);
    expect(executableNames('agy.EXE',{platform:'win32'})).toEqual(['agy.EXE']);
  });
  test('defaults to the common extension list without PATHEXT',()=>{
    expect(executableNames('x',{platform:'win32',pathext:''})).toEqual(['x.com','x.exe','x.bat','x.cmd','x']);
  });
});


describe('subscription installer',()=>{
  for(const flag of ['--codex','--grok']){
    test(`rejects the removed ${flag} option`,()=>{
      const result=install([flag,'unused']);
      expect(result.status).toBe(1);
    });
  }
  for(const backend of ['chatgpt','grok']){
    test.skipIf(process.platform==='win32')(`installs and upgrades ${backend} without CLI discovery, preserving credentials`,async()=>{
      const home=await mkdtemp(join(tmpdir(),`relyless-${backend}-install-`));
      const root=installedRoot(home,backend),dataDir=join(root,'data');
      const origin=`chrome-extension://${extensionId}/`;
      const legacyDir=join(dataDir,backend==='grok'?'grok':'legacy');
      const legacyCredentials=JSON.stringify({access_token:'retained-legacy-token',refresh_token:'retained-legacy-refresh'});
      const userGrokCredentials=join(home,'.grok','auth.json');
      try{
        if(backend==='grok'){
          await mkdir(join(home,'.grok'),{recursive:true});
          await writeFile(userGrokCredentials,legacyCredentials,{mode:0o600});
        }
        for(let attempt=0;attempt<2;attempt++){
          if(attempt===1){
            await mkdir(legacyDir,{recursive:true});
            await writeFile(join(legacyDir,'auth.json'),legacyCredentials,{mode:0o600});
            await writeFile(join(root,'config.json'),JSON.stringify({backend,[backend==='grok'?'grokPath':'codexPath']:'/obsolete/cli',dataDir,extensionOrigin:origin}));
            if(backend==='chatgpt')await writeFile(join(root,'connector/codex.mjs'),'obsolete copied module');
          }
          const result=install(['--extension-id',extensionId,'--backend',backend,'--browser','chrome'],isolatedEnv(home));
          expect(result.stderr).toBe('');
          expect(result.status).toBe(0);
          expect(JSON.parse(await readFile(join(root,'config.json'),'utf8'))).toEqual({backend,dataDir,extensionOrigin:origin});
          expect((await stat(join(root,'config.json'))).mode&0o777).toBe(0o600);
          if(attempt===1)expect(await readFile(join(legacyDir,'auth.json'),'utf8')).toBe(legacyCredentials);
          if(backend==='grok')expect(await readFile(userGrokCredentials,'utf8')).toBe(legacyCredentials);
          else await expect(access(join(root,'connector/codex.mjs'))).rejects.toMatchObject({code:'ENOENT'});
          const manifestDir=process.platform==='darwin'?join(home,'Library/Application Support/Google/Chrome/NativeMessagingHosts'):join(home,'config/google-chrome/NativeMessagingHosts');
          const manifestPath=join(manifestDir,`${backend==='grok'?'cc.ss_data.shisui_grok':'cc.ss_data.shisui_translate'}.json`);
          const manifest=JSON.parse(await readFile(manifestPath,'utf8'));
          expect(manifest.allowed_origins).toEqual([origin]);
          expect(manifest.path).toBe(join(root,'launch'));
          expect(manifest.type).toBe('stdio');
          expect((await stat(manifest.path)).mode&0o777).toBe(0o700);
          const launched=spawn(manifest.path,[origin],{env:isolatedEnv(home),stdio:['pipe','pipe','pipe']});
          try{
            const reply=await new Promise((resolve,reject)=>{
              const timer=setTimeout(()=>reject(new Error('安装后的连接器没有响应')),3000);
              const fail=error=>{clearTimeout(timer);reject(error);};
              const decoder=new NativeMessageDecoder({onMessage:message=>{if(message.id===1){clearTimeout(timer);resolve(message);}},onError:fail});
              launched.stdout.on('data',chunk=>decoder.push(chunk));
              launched.on('error',fail);
              launched.on('exit',code=>fail(new Error(`连接器过早退出：${code}`)));
              launched.stdin.write(encodeNativeMessage({id:1,type:'status'}));
            });
            expect(reply).toMatchObject({id:1,ok:true,data:{connected:true,authenticated:false,loginPending:false}});
          }finally{launched.kill();}
          if(backend==='grok')await expect(access(join(dataDir,'grok-oauth.json'))).rejects.toMatchObject({code:'ENOENT'});
          if(attempt===1){
            expect(await readFile(join(legacyDir,'auth.json'),'utf8')).toBe(legacyCredentials);
            const removed=install(['--uninstall','--backend',backend,'--browser','chrome'],isolatedEnv(home));
            expect(removed.status).toBe(0);
            await expect(access(manifestPath)).rejects.toMatchObject({code:'ENOENT'});
            expect(await readFile(join(legacyDir,'auth.json'),'utf8')).toBe(legacyCredentials);
          }
        }
      }finally{await rm(home,{recursive:true,force:true});}
    });
  }
  test.skipIf(process.platform==='win32')('preserves Antigravity CLI installation and config',async()=>{
    const home=await mkdtemp(join(tmpdir(),'relyless-antigravity-install-'));
    try{
      const cliPath=join(home,'agy');
      await writeFile(cliPath,`#!/bin/sh\nprintf '%s\\n' 'agy 1.0.0'\n`,{mode:0o700});
      const result=install(['--extension-id',extensionId,'--backend','antigravity','--agy',cliPath,'--browser','chrome'],isolatedEnv(home));
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      const root=installedRoot(home,'antigravity');
      expect(JSON.parse(await readFile(join(root,'config.json'),'utf8'))).toEqual({backend:'antigravity',agyPath:await realpath(cliPath),dataDir:join(root,'data'),extensionOrigin:`chrome-extension://${extensionId}/`});
    }finally{await rm(home,{recursive:true,force:true});}
  });
});

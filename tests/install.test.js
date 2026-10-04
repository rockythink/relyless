import {afterEach,describe,expect,test} from 'bun:test';
import {mkdtemp,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {extensionId,findExecutable,locations} from '../connector/install.mjs';

const dirs=[];
afterEach(async()=>{await Promise.all(dirs.splice(0).map(dir=>rm(dir,{recursive:true,force:true})));});

describe('findExecutable',()=>{
  test('resolves a cli in extraDirs, honoring PATHEXT on Windows',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'relyless-install-'));dirs.push(dir);
    const name=process.platform==='win32'?'relyless-tool.cmd':'relyless-tool';
    await writeFile(join(dir,name),'');
    expect(await findExecutable('relyless-tool','',[dir])).toBeTruthy();
  });
  test('returns empty when nothing matches',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'relyless-install-'));dirs.push(dir);
    expect(await findExecutable('relyless-missing','',[dir],{PATH:dir,PATHEXT:'.CMD;.EXE'})).toBe('');
  });
  test('simulated Windows lookup uses PATHEXT and semicolon-separated PATH',async()=>{
    const first=await mkdtemp(join(tmpdir(),'relyless-empty-'));
    const second=await mkdtemp(join(tmpdir(),'relyless-win-'));
    dirs.push(first,second);
    await writeFile(join(second,'agy.cmd'),'');
    await writeFile(join(second,'agy.exe'),'');
    const env={PATH:`${first};${second}`,PATHEXT:'.EXE;.CMD'};
    expect(await findExecutable('agy','',[],env,'win32')).toBe(await realpath(join(second,'agy.exe')));
    expect(await findExecutable('agy','',[],{...env,PATHEXT:'.CMD;.EXE'},'win32')).toBe(await realpath(join(second,'agy.cmd')));
  });
});

describe('extensionId',()=>{
  test('accepts a 32-char a–p id and rejects malformed input',async()=>{
    await expect(extensionId('a'.repeat(32))).resolves.toBe('a'.repeat(32));
    await expect(extensionId('not-an-id')).rejects.toThrow('扩展 ID');
    await expect(extensionId('A'.repeat(32))).rejects.toThrow('扩展 ID');
  });
});

describe('locations',()=>{
  test('every backend resolves a root and at least one browser target',()=>{
    for(const backend of ['chatgpt','grok','antigravity']){
      const target=locations(backend);
      expect(target.root).toBeTruthy();
      const map=target.registry||target.browsers;
      expect(Object.keys(map)).toContain('chrome');
    }
  });
});

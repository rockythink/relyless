import {access,chmod,copyFile,mkdir,readFile,readdir,realpath,rm,writeFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {homedir} from 'node:os';
import {delimiter,dirname,join,resolve,win32} from 'node:path';
import {fileURLToPath} from 'node:url';
import {cliSpawnTarget,executableNames} from './cli-spawn.mjs';

const HOSTS = {
  chatgpt: 'cc.ss_data.shisui_translate',
  grok: 'cc.ss_data.shisui_grok',
  antigravity: 'cc.ss_data.shisui_antigravity',
};
const source = dirname(fileURLToPath(import.meta.url));
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;

function options(args) {
  const result = {browsers:['chrome','edge'],uninstall:false,backend:'chatgpt'};
  for (let i=0;i<args.length;i++) {
    const flag = args[i];
    if (flag === '--help') result.help = true;
    else if (flag === '--uninstall') result.uninstall = true;
    else if (['--extension-id','--agy','--browser','--backend'].includes(flag)) {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`${flag} 缺少参数。`);
      if (flag === '--extension-id') result.extensionId = value;
      if (flag === '--agy') result.agy = resolve(value);
      if (flag === '--browser') result.browsers = value.split(',');
      if (flag === '--backend') {
        if (!['chatgpt','grok','antigravity'].includes(value)) throw new Error('--backend 只能是 chatgpt、grok 或 antigravity。');
        result.backend = value;
      }
    } else throw new Error(`未知参数：${flag}。运行 --help 查看用法。`);
  }
  return result;
}

export async function findExecutable(name, explicit, extraDirs = [], env = process.env, platform = process.platform) {
  const names = executableNames(name, {platform,pathext: env.PATHEXT});
  const candidates = [];
  if (explicit) candidates.push(explicit);
  for (const dir of extraDirs) for (const exe of names) candidates.push(join(dir, exe));
  for (const path of (env.PATH || '').split(platform === 'win32' ? win32.delimiter : delimiter).filter(Boolean)) {
    for (const exe of names) candidates.push(join(path, exe));
  }
  const seen = new Set();
  for (const path of candidates) {
    if (!path || seen.has(path)) continue;
    seen.add(path);
    try { await access(path, constants.X_OK); return await realpath(path); }
    catch {
      try { await access(path, constants.F_OK); return await realpath(path); }
      catch { /* Continue lookup. */ }
    }
  }
  return '';
}

async function findAgy(explicit) {
  const extra = [
    join(homedir(), '.local', 'bin'),
    join(homedir(), '.gemini', 'bin'),
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'agy', 'bin') : '',
    process.env.APPDATA ? join(process.env.APPDATA, 'npm') : '',
  ].filter(Boolean);
  const path = await findExecutable('agy', explicit, extra) || await findExecutable('antigravity', explicit, extra);
  if (!path) throw new Error('未找到官方 Antigravity CLI。请先按 https://antigravity.google/docs/cli/install/ 安装 agy（macOS / Linux 运行 curl -fsSL https://antigravity.google/cli/install.sh | bash，Windows 运行 irm https://antigravity.google/cli/install.ps1 | iex），再重新安装连接器；也可使用 --agy 指定路径。');
  return path;
}

export async function extensionId(explicit) {
  if (!explicit && process.platform === 'win32') throw new Error('Windows 上路径推导的扩展 ID 不一定与浏览器一致，请显式传入 --extension-id（从扩展设置页复制安装命令）。');
  if (explicit) {
    if (!/^[a-p]{32}$/.test(explicit)) throw new Error('扩展 ID 必须是 32 位 a–p 字母；请从插件设置中的安装命令复制。');
    return explicit;
  }
  const extension = await realpath(join(source,'../extension'));
  const manifest = JSON.parse(await readFile(join(extension,'manifest.json'),'utf8'));
  const identity = manifest.key ? Buffer.from(manifest.key,'base64') : extension;
  return createHash('sha256').update(identity).digest('hex').slice(0,32).replace(/[0-9a-f]/g,char => String.fromCharCode(97+parseInt(char,16)));
}

export function locations(backend) {
  const home = homedir();
  const host = HOSTS[backend];
  const rootName = backend === 'grok' ? 'Shisui Translate Grok' : backend === 'antigravity' ? 'Shisui Translate Antigravity' : 'Shisui Translate';
  const rootSlug = backend === 'grok' ? 'shisui-translate-grok' : backend === 'antigravity' ? 'shisui-translate-antigravity' : 'shisui-translate';
  if (process.platform === 'darwin') {
    const support = join(home,'Library/Application Support');
    return {root:join(support, rootName), host, browsers:{
      chrome:join(support,'Google/Chrome/NativeMessagingHosts'),
      edge:join(support,'Microsoft Edge/NativeMessagingHosts'),
      chromium:join(support,'Chromium/NativeMessagingHosts'),
      'chrome-testing':join(support,'Google/Chrome for Testing/NativeMessagingHosts'),
    }};
  }
  if (process.platform === 'linux') {
    const config = process.env.XDG_CONFIG_HOME || join(home,'.config');
    return {root:join(process.env.XDG_DATA_HOME || join(home,'.local/share'), rootSlug), host, browsers:{
      chrome:join(config,'google-chrome/NativeMessagingHosts'),
      edge:join(config,'microsoft-edge/NativeMessagingHosts'),
      chromium:join(config,'chromium/NativeMessagingHosts'),
      'chrome-testing':join(config,'google-chrome-for-testing/NativeMessagingHosts'),
    }};
  }
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || join(home,'AppData/Local');
    return {root:join(local,rootName), host, windows:true, registry:{
      chrome:`HKCU\\SOFTWARE\\Google\\Chrome\\NativeMessagingHosts\\${host}`,
      edge:`HKCU\\SOFTWARE\\Microsoft\\Edge\\NativeMessagingHosts\\${host}`,
      chromium:`HKCU\\SOFTWARE\\Chromium\\NativeMessagingHosts\\${host}`,
      'chrome-testing':`HKCU\\SOFTWARE\\Google\\Chrome for Testing\\NativeMessagingHosts\\${host}`,
    }};
  }
  throw new Error('这个连接器安装程序支持 macOS、Linux 和 Windows。当前系统无法注册此连接器；未修改任何配置。');
}

async function compileWindowsLauncher(launcher, nodePath, hostPath, configPath) {
  const csc = [
    process.env.WINDIR && join(process.env.WINDIR,'Microsoft.NET','Framework64','v4.0.30319','csc.exe'),
    process.env.WINDIR && join(process.env.WINDIR,'Microsoft.NET','Framework','v4.0.30319','csc.exe'),
  ].find(path => path && spawnSync(path,['/nologo','/help'],{encoding:'utf8',timeout:8000,windowsHide:true}).status === 0);
  if (!csc) throw new Error('未找到 .NET csc.exe，无法在 Windows 上生成连接器启动器。请安装 .NET Framework 4.x 后重试。');
  const sourcePath = `${launcher}.cs`;
  const csharp = [
    'using System;',
    'using System.Runtime.InteropServices;',
    'using System.Text;',
    '[StructLayout(LayoutKind.Sequential)] struct STARTUPINFO { public int cb; public IntPtr lpReserved, lpDesktop, lpTitle; public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags; public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError; }',
    '[StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }',
    'class Program {',
    '  const uint CREATE_NO_WINDOW = 0x08000000;',
    '  const int STARTF_USESTDHANDLES = 0x00000100;',
    '  const int STD_INPUT_HANDLE = -10, STD_OUTPUT_HANDLE = -11, STD_ERROR_HANDLE = -12;',
    '  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcess(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string dir, ref STARTUPINFO si, out PROCESS_INFORMATION pi);',
    '  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int n);',
    '  [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr h, uint ms);',
    '  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr h, out uint code);',
    '  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr h);',
    '  static int Main(string[] args) {',
    '    var cmd = new StringBuilder();',
    `    cmd.Append('"').Append(${JSON.stringify(nodePath)}).Append('"');`,
    `    cmd.Append(' ').Append('"').Append(${JSON.stringify(hostPath)}).Append('"');`,
    '    cmd.Append(" --config ");',
    `    cmd.Append('"').Append(${JSON.stringify(configPath)}).Append('"');`,
    '    foreach (var arg in args) { cmd.Append(\' \').Append(\'"\').Append(arg.Replace("\\"", "\\\\\\"")).Append(\'"\'); }',
    '    var si = new STARTUPINFO(); si.cb = Marshal.SizeOf(typeof(STARTUPINFO)); si.dwFlags = STARTF_USESTDHANDLES; si.hStdInput = GetStdHandle(STD_INPUT_HANDLE); si.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE); si.hStdError = GetStdHandle(STD_ERROR_HANDLE);',
    '    PROCESS_INFORMATION pi;',
    '    if (!CreateProcess(null, cmd, IntPtr.Zero, IntPtr.Zero, true, CREATE_NO_WINDOW, IntPtr.Zero, null, ref si, out pi)) return 1;',
    '    WaitForSingleObject(pi.hProcess, 0xFFFFFFFF); uint code; GetExitCodeProcess(pi.hProcess, out code); CloseHandle(pi.hProcess); CloseHandle(pi.hThread); return (int)code;',
    '  }',
    '}',
    '',
  ].join('\r\n');
  await writeFile(sourcePath, csharp);
  const compiled = spawnSync(csc, ['/nologo', '/t:exe', `/out:${launcher}`, sourcePath], {encoding:'utf8', timeout:30000, windowsHide:true});
  await rm(sourcePath, {force:true}).catch(()=>{});
  if (compiled.status !== 0) throw new Error(`无法编译 Windows 启动器：${(compiled.stderr || compiled.stdout || '').trim() || 'csc 失败'}`);
}

function registryValue(key) {
  const result = spawnSync('reg', ['query', key, '/ve'], {encoding:'utf8', timeout:10000, windowsHide: true});
  if (result.status !== 0) return '';
  const match = String(result.stdout || '').match(/REG_(?:SZ|EXPAND_SZ)\s+(.*)$/m);
  return match ? match[1].trim() : '';
}

function registerWindowsHost(key, manifestPath) {
  const result = spawnSync('reg', ['add', key, '/ve', '/d', manifestPath, '/f'], {encoding:'utf8', timeout:10000, windowsHide: true});
  if (result.status !== 0) throw new Error(`无法写入注册表 ${key}：${(result.stderr || result.stdout || '').trim() || 'reg add 失败'}`);
}

function unregisterWindowsHost(key) {
  spawnSync('reg', ['delete', key, '/f'], {encoding:'utf8', timeout:10000, windowsHide: true});
}

async function main() {
  const opts = options(process.argv.slice(2));
  if (opts.help) {
    console.log('RelyLess · 订阅连接器\n\n安装：node connector/install.mjs --extension-id ID [--backend chatgpt|grok|antigravity] [--agy PATH]\n浏览器：--browser chrome,edge（默认）；另支持 chromium、chrome-testing\n卸载：node connector/install.mjs --uninstall --backend chatgpt|grok|antigravity [--browser chrome,edge]\n\nChatGPT 后端只需要 Node.js 20+，通过官方 Sign in with ChatGPT（OAuth）登录并直接调用 Responses API，无需安装 CLI，支持 macOS / Linux / Windows。\nGrok 后端只需要 Node.js 20+，通过兼容 OAuth 设备码直连，无需安装 CLI。复用官方 Grok CLI 公开 OAuth 客户端，不是 RelyLess 的官方注册，第三方使用不获保证，可能失效。\nGoogle（Antigravity）后端需要 Node.js 20+ 和官方 Antigravity CLI（agy），支持 macOS / Linux / Windows，使用 Google AI Pro / Ultra 订阅权益。注意：Antigravity FAQ 限制第三方工具使用；现有配置保留，不自动迁移。\n仅注册当前用户，不需要管理员权限。\n卸载只移除指定浏览器的连接器注册；保留本机登录数据。要退出账户，请先在插件中退出登录。');
    return;
  }
  if (Number(process.versions.node.split('.')[0]) < 20) throw new Error('需要 Node.js 20 或更新版本。');
  const backend = opts.backend;
  const host = HOSTS[backend];
  const {root,browsers,windows,registry} = locations(backend);
  const launcher = join(root, windows ? 'launch.exe' : 'launch');
  const manifestPath = join(root, `${host}.json`);
  const targets = windows
    ? [...new Set(opts.browsers)].map(name => {
        if (!registry[name]) throw new Error(`不支持的浏览器：${name}。`);
        return {name, key: registry[name]};
      })
    : [...new Set(opts.browsers)].map(name => {
        if (!browsers[name]) throw new Error(`不支持的浏览器：${name}。`);
        return join(browsers[name],`${host}.json`);
      });
  if (opts.uninstall) {
    if (windows) {
      for (const target of targets) {
        const existing = registryValue(target.key);
        if (!existing) continue;
        if (existing !== manifestPath) throw new Error(`注册项不属于此安装，未删除：${target.key}`);
        unregisterWindowsHost(target.key);
        console.log(`已移除注册：${target.key}`);
      }
    } else {
      for (const target of targets) {
        let existing;
        try { existing = JSON.parse(await readFile(target,'utf8')); }
        catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        if (existing.name !== host || existing.path !== launcher) throw new Error(`注册文件不属于此安装，未删除：${target}`);
        await rm(target);
        console.log(`已移除注册：${target}`);
      }
    }
    console.log('已卸载所选浏览器的连接器注册。本机登录数据保留；其他浏览器不受影响。');
    return;
  }
  const id = await extensionId(opts.extensionId);
  const cliPath = backend === 'antigravity' ? await findAgy(opts.agy) : '';
  let versionText = '';
  if (cliPath) {
    const versionTarget = cliSpawnTarget(cliPath, ['--version']);
    const version = spawnSync(versionTarget.command, versionTarget.args, {encoding:'utf8', timeout:10000, windowsHide: true, ...versionTarget.options});
    versionText = `${version.stdout || ''}\n${version.stderr || ''}`.trim();
    if (version.status !== 0) {
      throw new Error('无法运行官方 Antigravity CLI。请检查 agy 的安装（agy --version 应能正常输出）。');
    }
  }
  const installed = join(root,'connector');
  const dataDir = join(root,'data');
  const configPath = join(root,'config.json');
  const origin = `chrome-extension://${id}/`;
  if (windows) {
    for (const target of targets) {
      const existing = registryValue(target.key);
      if (existing && existing !== manifestPath) throw new Error(`此位置已有其他连接器，未覆盖：${target.key}`);
    }
  } else {
    for (const target of targets) {
      let existing;
      try { existing = JSON.parse(await readFile(target,'utf8')); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      if (existing.name !== host || existing.path !== launcher) throw new Error(`此位置已有其他连接器，未覆盖：${target}`);
    }
  }
  await mkdir(installed,{recursive:true,mode:0o700});
  await mkdir(dataDir,{recursive:true,mode:0o700});
  await chmod(root,0o700).catch(()=>{});
  await chmod(dataDir,0o700).catch(()=>{});
  const files = (await readdir(source,{withFileTypes:true})).filter(entry => entry.isFile() && entry.name.endsWith('.mjs') && entry.name !== 'install.mjs');
  if (!files.some(entry => entry.name === 'host.mjs')) throw new Error('连接器源文件不完整，缺少 host.mjs。');
  if (!files.some(entry => entry.name === 'siwc.mjs')) throw new Error('连接器源文件不完整，缺少 siwc.mjs。');
  if (backend === 'grok' && !files.some(entry => entry.name === 'grok.mjs')) throw new Error('连接器源文件不完整，缺少 grok.mjs。');
  if (backend === 'antigravity' && !files.some(entry => entry.name === 'antigravity.mjs')) throw new Error('连接器源文件不完整，缺少 antigravity.mjs。');
  for (const file of files) await copyFile(join(source,file.name),join(installed,file.name));
  await rm(join(installed,'codex.mjs'),{force:true});
  await mkdir(join(root,'extension'),{recursive:true,mode:0o700});
  await Promise.all([
    copyFile(join(source,'../extension/gloss.mjs'),join(root,'extension/gloss.mjs')),
    copyFile(join(source,'../extension/assistance-stream.mjs'),join(root,'extension/assistance-stream.mjs')),
    copyFile(join(source,'../extension/diagnostics.mjs'),join(root,'extension/diagnostics.mjs')),
    copyFile(join(source,'../extension/personalization.mjs'),join(root,'extension/personalization.mjs')),
    copyFile(join(source,'../extension/sentence-groups.mjs'),join(root,'extension/sentence-groups.mjs')),
  ]);
  const config = backend === 'grok'
    ? {backend:'grok', dataDir, extensionOrigin:origin}
    : backend === 'antigravity'
    ? {backend:'antigravity', agyPath:cliPath, dataDir, extensionOrigin:origin}
    : {backend:'chatgpt', dataDir, extensionOrigin:origin};
  await writeFile(configPath,JSON.stringify(config,null,2)+'\n',{mode:0o600});
  await chmod(configPath,0o600).catch(()=>{});
  if (windows) await compileWindowsLauncher(launcher, process.execPath, join(installed,'host.mjs'), configPath);
  else {
    await writeFile(launcher,`#!/bin/sh\nexec ${quote(process.execPath)} ${quote(join(installed,'host.mjs'))} --config ${quote(configPath)} "$@"\n`,{mode:0o700});
    await chmod(launcher,0o700);
  }
  const description = backend === 'grok' ? 'RelyLess Grok 订阅本地连接器' : backend === 'antigravity' ? 'RelyLess Google（Antigravity）订阅本地连接器' : 'RelyLess ChatGPT 订阅本地连接器';
  const manifest = JSON.stringify({name:host,description,path:launcher,type:'stdio',allowed_origins:[origin]},null,2)+'\n';
  if (windows) {
    await writeFile(manifestPath, manifest, {mode:0o600});
    for (const target of targets) {
      registerWindowsHost(target.key, manifestPath);
      console.log(`已注册：${target.key}`);
    }
  } else {
    for (const target of targets) {
      await mkdir(dirname(target),{recursive:true});
      await writeFile(target,manifest,{mode:0o600});
      console.log(`已注册：${target}`);
    }
  }
  const cliLabel = 'Antigravity CLI（agy）';
  const loginLabel = backend === 'grok' ? 'Grok' : backend === 'antigravity' ? 'Google' : 'ChatGPT';
  const loginHint = backend === 'antigravity'
    ? '首次使用前请先在终端运行 agy，按提示用 Google 账号（Google AI Pro / Ultra 订阅）完成登录，再回扩展刷新。'
    : backend === 'chatgpt'
    ? '使用官方 Sign in with ChatGPT 登录；首次切换到此连接器需重新授权，不复用旧 CLI 登录。已有 SIWC 登录数据保留，仅首次使用或登录失效时需要登录。'
    : 'Grok 为兼容直连：复用官方 Grok CLI 公开 OAuth 客户端，不是 RelyLess 的官方注册，第三方使用不获保证，可能失效。安装后请用设备码重新登录；不导入旧 CLI 凭证，也不删除旧数据。已有本机直连登录数据在更新时保留。';
  const runtimeInfo = backend === 'chatgpt' ? '认证：官方 Sign in with ChatGPT（OAuth）' : backend === 'grok' ? '认证：Grok 兼容 OAuth 设备码直连（无需 CLI）' : `${cliLabel}：${versionText.split(/\r?\n/)[0]}`;
  const upgradeLabel = backend === 'antigravity' ? `Node.js / ${cliLabel}` : 'Node.js';
  console.log(`\n扩展 ID：${id}\n${runtimeInfo}\n连接器：${root}\n后端：${backend}\n\n安装 / 更新完成。重新加载扩展，进入“服务”，选择“${loginLabel} 订阅”，点击“刷新账户与模型”。\n${loginHint}\n更新连接器源码后也需重新运行此安装命令；安装后刷新连接会重启连接器，以加载新代码。\n升级 ${upgradeLabel} 或移动扩展目录后，请重新运行此安装命令。`);
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(error => { console.error(`安装失败：${error.message}`); process.exitCode = 1; });
}

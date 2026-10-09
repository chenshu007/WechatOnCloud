import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PassThrough } from 'node:stream';
import Docker from 'dockerode';
import { validatePasteImage, withInstanceInput, IMAGE_PASTE_SCRIPT, PasteError } from '../src/image-paste.js';
// 先松开 xdotool 自己可能按住的修饰键、再不带 --clearmodifiers 地按（上游 31c5146：粘图后下一条文字变成「v」）
const RELEASE = 'keyup Control_L Control_R Shift_L Shift_R Alt_L Alt_R Meta_L Meta_R Super_L Super_R ISO_Level3_Shift';
import { installImagePasteBridge } from '../../web/src/image-paste-bridge.ts';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jV1kAAAAASUVORK5CYII=','base64');
test('image MIME, signatures, size and unsupported formats are checked',()=>{
 validatePasteImage('image/png',png);
 for(const [mime,data] of [['image/png',Buffer.from('fake')],['image/jpeg',png],['image/svg+xml',Buffer.from('<svg/>')],['image/png; touch /tmp/injected',png],['image/png',Buffer.alloc(0)],['image/png',Buffer.alloc(64*1024*1024+1)]])assert.throws(()=>validatePasteImage(mime,data),PasteError);
});
test('per-instance input exclusion rejects overlap and releases after failure',async()=>{
 let release!:()=>void;const p=withInstanceInput('a',()=>new Promise<void>(r=>release=r));
 await assert.rejects(withInstanceInput('a',async()=>{}),/正在处理输入/);await withInstanceInput('b',async()=>{});release();await p;
 await assert.rejects(withInstanceInput('a',async()=>{throw Error('failure')}));await withInstanceInput('a',async()=>{});
});
test('Docker adapter uses fixed argv, private directory, cleanup and no Return',async t=>{
 const calls:any[]=[];let fail=false;let uncertain=false;
 t.mock.method(Docker.prototype,'getContainer',()=>({
  putArchive:async(data:Buffer,opts:any)=>{calls.push({archive:opts.path});assert.equal(data.toString('utf8',0,5),'image')},
  exec:async(opts:any)=>{calls.push(opts.Cmd);const setup=opts.Cmd[0]==='mktemp',paste=opts.Cmd[0]==='bash';return {
   inspect:async()=>({ExitCode:paste&&uncertain?null:paste&&fail?1:0,Running:paste&&uncertain}),start:async()=>{const s=new PassThrough();setImmediate(()=>{if(setup){const b=Buffer.from('/tmp/woc-paste-ABCDEFGHIJKL\n'),h=Buffer.alloc(8);h[0]=1;h.writeUInt32BE(b.length,4);s.write(Buffer.concat([h,b]))}s.end()});return s}
  }}
 }));
 const {pasteImageInInstance}=await import('../src/docker.js');const inst={containerName:'test',appType:'wechat'} as any;
 await pasteImageInInstance(inst,'image/png',png);const cmd=calls.find(c=>Array.isArray(c)&&c[0]==='bash');
 assert.equal(cmd[2],IMAGE_PASTE_SCRIPT);assert.deepEqual(cmd.slice(3),['woc-image-paste','image/png','/tmp/woc-paste-ABCDEFGHIJKL/image']);assert.match(cmd[2],/cmp -s/);assert.match(cmd[2],/ctrl\+v/);assert.doesNotMatch(cmd[2],/Return/);
 assert.ok(calls.some(c=>Array.isArray(c)&&c[0]==='rmdir'));fail=true;
 await assert.rejects(pasteImageInInstance(inst,'image/png',png),(e:any)=>e.outcome==='unknown');assert.equal(calls.filter(c=>Array.isArray(c)&&c[0]==='rmdir').length,2);
 fail=false;uncertain=true;
 await assert.rejects(pasteImageInInstance(inst,'image/png',png),(e:any)=>e.outcome==='unknown');
 await assert.rejects(pasteImageInInstance({...inst,appType:'chromium'},'image/png',png));
});
class Surface{
 handlers=new Map<string,Set<(e:any)=>void>>();timers=new Map<number,()=>void>();n=0;
 addEventListener(n:string,f:(e:any)=>void){if(!this.handlers.has(n))this.handlers.set(n,new Set());this.handlers.get(n)!.add(f)}
 removeEventListener(n:string,f:(e:any)=>void){this.handlers.get(n)?.delete(f)}
 setTimeout(f:()=>void){this.timers.set(++this.n,f);return this.n}clearTimeout(n:number){this.timers.delete(n)}
 emit(n:string,e:any={}){for(const f of this.handlers.get(n)||[])f(e)}flush(){for(const f of this.timers.values())f();this.timers.clear()}
}
function setup(){const win=new Surface(),doc=new Surface(),top=new Surface(),calls:string[]=[];
 const cleanup=installImagePasteBridge(win as any,doc as any,top as any,{image:async f=>{calls.push('image:'+Buffer.from(await f.arrayBuffer()).toString())},plain:async()=>{calls.push('plain')},error:m=>calls.push('error:'+m)});
 const key=(k='v',extra={})=>win.emit('keydown',{isTrusted:true,key:k,code:'Key'+k.toUpperCase(),ctrlKey:true,metaKey:false,altKey:false,shiftKey:false,isComposing:false,repeat:false,preventDefault(){},stopImmediatePropagation(){},...extra});
 const paste=(data?:string)=>{let prevented=false;doc.emit('paste',{isTrusted:true,clipboardData:{items:data?[{kind:'file',type:'image/png',getAsFile:()=>new File([data],'test.png',{type:'image/png'})}]:[]},preventDefault(){prevented=true},stopImmediatePropagation(){}});return prevented};
 return {win,doc,top,calls,cleanup,key,paste};}
const tick=()=>new Promise(r=>setImmediate(r));
test('bridge: image, remote text, equal-size distinct image, remote-copy preference',async()=>{const b=setup();b.key();assert.ok(b.paste('one'));await tick();assert.deepEqual(b.calls,['image:one']);b.key('c');b.key();b.paste('one');await tick();assert.equal(b.calls.at(-1),'plain');b.key();b.paste('two');await tick();assert.equal(b.calls.at(-1),'image:two');b.key();assert.ok(b.paste());await tick();assert.equal(b.calls.at(-1),'plain');b.cleanup()});
test('bridge: late event cannot double paste, cleanup cancels timers/listeners',async()=>{const b=setup();b.key();b.win.flush();await tick();assert.equal(b.calls.length,1);assert.match(b.calls[0],/未读取到本机剪贴板/);assert.ok(b.paste('late'));await tick();assert.equal(b.calls.length,1);b.key();b.cleanup();b.win.flush();await tick();assert.equal(b.calls.length,1);assert.ok([...b.win.handlers.values()].every(s=>s.size===0));assert.ok([...b.doc.handlers.values()].every(s=>s.size===0))});
test('bridge: Cmd+V, repeat, composition, unmount while reading',async()=>{const b=setup();b.key('v',{ctrlKey:false,metaKey:true});b.paste('mac');await tick();assert.equal(b.calls.length,1);b.key('v',{repeat:true});b.win.flush();await tick();assert.equal(b.calls.length,1);b.key('v',{isComposing:true});b.win.flush();await tick();assert.equal(b.calls.length,1);b.key();b.paste('cancel');b.cleanup();await tick();assert.equal(b.calls.length,1)});

test('fixed X11 program verifies owned bytes, dispatches only Ctrl+V, and removes temp files on success/failure',()=>{
 const root=mkdtempSync(join(tmpdir(),'woc-image-shell-'));
 try {
  const bin=join(root,'bin');mkdirSync(bin);
  writeFileSync(join(bin,'timeout'),'#!/bin/sh\nshift\nexec "$@"\n',{mode:0o755});
  writeFileSync(join(bin,'xclip'),`#!/bin/sh
case " $* " in
 *" -i "*) for arg do input="$arg"; done; cp "$input" "$TEST_ROOT/selection";;
 *" -o "*) cat "$TEST_ROOT/selection";;
esac
`,{mode:0o755});
  writeFileSync(join(bin,'xdotool'),'#!/bin/sh\nprintf "%s\\n" "$*" >> "$TEST_ROOT/keys"\n[ "$1" != key ] || [ "${FAIL_KEY:-0}" != 1 ]\n',{mode:0o755});
  for(const fail of ['0','1']){
   const dir=join(root,'request-'+fail);mkdirSync(dir);writeFileSync(join(dir,'image'),png);
   const r=spawnSync('bash',['-c',IMAGE_PASTE_SCRIPT,'test','image/png',join(dir,'image')],{env:{...process.env,PATH:bin+':'+process.env.PATH,TEST_ROOT:root,FAIL_KEY:fail}});
   assert.equal(r.status,Number(fail),r.stderr.toString());assert.equal(existsSync(dir),false);
  }
  assert.deepEqual(readFileSync(join(root,'selection')),png);
  assert.deepEqual(readFileSync(join(root,'keys'),'utf8').trim().split('\n'),[RELEASE,'key ctrl+v',RELEASE,'key ctrl+v']);
 }finally{rmSync(root,{recursive:true,force:true})}
});

test('bridge preserves native editing in noVNC clipboard/settings inputs',async()=>{
 const b=setup();
 for(const target of [{tagName:'TEXTAREA',id:'noVNC_clipboard_text'},{tagName:'INPUT',id:'settings'},{tagName:'DIV',isContentEditable:true}]) {
  let stopped=false;
  b.key('v',{target,stopImmediatePropagation(){stopped=true}});b.win.flush();await tick();assert.equal(stopped,false);
 }
 assert.deepEqual(b.calls,[]);
 b.key('v',{target:{tagName:'TEXTAREA',id:'noVNC_keyboardinput'}});b.paste('image');await tick();assert.deepEqual(b.calls,['image:image']);b.cleanup();
});

test('HTTPS clipboard read works without native paste and native/read race dispatches once', async () => {
 const b=setup(); let resolve!: (items:any[])=>void; let reads=0;
 (b.win as any).navigator={clipboard:{read:()=>{reads++;return new Promise(r=>resolve=r)}}};
 b.key(); assert.equal(reads,1); resolve([{types:['image/png'],getType:async()=>new Blob(['direct'],{type:'image/png'})}]);
 await tick();await tick();assert.deepEqual(b.calls,['image:direct']);assert.ok(b.paste('late'));await tick();assert.equal(b.calls.length,1);
 b.key();b.paste('native');resolve([{types:['image/png'],getType:async()=>new Blob(['duplicate'],{type:'image/png'})}]);await tick();await tick();assert.deepEqual(b.calls,['image:direct','image:native']);b.cleanup();
});
test('clipboard permission denial retains native event paste; remote copy avoids local read',async()=>{
 const b=setup();let reads=0;(b.win as any).navigator={clipboard:{read:()=>{reads++;return Promise.reject(new Error('NotAllowedError'))}}};
 b.key();await tick();b.paste('native');await tick();assert.equal(b.calls[0],'image:native');
 b.key('c');b.key();b.win.flush();await tick();assert.equal(reads,1);assert.equal(b.calls.at(-1),'plain');b.cleanup();
});

test('remote image read checks PNG and uses bounded read without key dispatch',async t=>{
 let invalid=false;const calls:string[][]=[];
 t.mock.method(Docker.prototype,'getContainer',()=>({exec:async(opts:any)=>{calls.push(opts.Cmd);return {
 start:async()=>{const stream=new PassThrough();setImmediate(()=>stream.end((invalid ? Buffer.from('fake') : png).toString('base64')));return stream},
 inspect:async()=>({ExitCode:0,Running:false})
 }}}));
 t.mock.method((new Docker() as any).modem.constructor.prototype,'demuxStream',(stream:any,stdout:any)=>stream.on('data',(b:Buffer)=>stdout.write(b)));
 const {readClipboardImage}=await import('../src/docker.js');
 const inst:any={id:'aabbcc',containerName:'test',appType:'wechat'};
 assert.deepEqual(await readClipboardImage(inst),png);
 assert.equal(calls.length,1);assert.match(calls[0][2],/head -c 67108865/);assert.doesNotMatch(calls[0][2],/xdotool| -i /);
 invalid=true;await assert.rejects(readClipboardImage(inst),PasteError);
});

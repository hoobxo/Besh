import assert from 'node:assert/strict';
import { TransferQueue } from '../apps/web/src/lib/transfer-queue.ts';
const tick=()=>new Promise(r=>setTimeout(r,0));
let enteredResolve;const entered=new Promise(r=>enteredResolve=r);let rejectChunk;let first=true;const staged=new Map();let serial=0;let committed;
const q=new TransferQueue({
 beginUpload:async()=>{const id=String(++serial);staged.set(id,[]);return id;},
 writeChunk:async(_p,id,offset,data)=>{if(id==='1'&&offset===2&&first){first=false;enteredResolve();await new Promise((_r,reject)=>rejectChunk=reject);}const b=staged.get(id);if(!b)throw Error('upload aborted');for(let i=0;i<data.length;i++)b[offset+i]=data[i];},
 abortUpload:async(_p,id)=>{staged.delete(id);rejectChunk?.(Error('upload aborted'));},
 endUpload:async(_p,id)=>{committed=Uint8Array.from(staged.get(id));},readRange:async()=>new Uint8Array()
},{chunkSize:2,attempts:1,sleep:async()=>{}});
const [item]=q.addUploads([{name:'file',path:'/file',bytes:new TextEncoder().encode('abcdef')}]);await entered;await q.cancel(item.id);while(q.running)await tick();q.retry(item.id);while(q.running)await tick();
assert.deepEqual([...committed],[97,98,99,100,101,102]);console.log('PASS: canceled upload restarts without corrupting bytes');

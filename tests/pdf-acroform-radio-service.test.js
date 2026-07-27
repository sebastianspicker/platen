import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { DocumentStore } from '../scripts/host/document-store.mjs';
import { PdfAcroFormRadioService } from '../scripts/host/pdf-acroform-radio-service.mjs';

function source() { let c=['%PDF-1.7\n'];const o=[];const b=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Count 1 /Kids [3 0 R] >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /CropBox [0 0 612 792] /Resources << >> /Contents 4 0 R >>','<< /Length 0 >>\nstream\n\nendstream'];for(let i=0;i<b.length;i+=1){o.push(Buffer.byteLength(c.join(''),'latin1'));c.push(`${i+1} 0 obj\n${b[i]}\nendobj\n`);}const x=Buffer.byteLength(c.join(''),'latin1');c.push(`xref\n0 5\n0000000000 65535 f \n${o.map(v=>`${String(v).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`);return Buffer.from(c.join(''),'latin1'); }
function d(b){return createHash('sha256').update(b).digest('hex');} function req(s){return {profile:'local-pdf-acroform-radio-v1',sourceSha256:d(s),groupName:'Choice',options:[{label:'A',page:1,rect:{x:10,y:700,width:20,height:20}},{label:'B',page:1,rect:{x:40,y:700,width:20,height:20}}]};}
async function setup(t){const root=await mkdtemp('/private/tmp/pdf-acroform-radio-service-');const store=await new DocumentStore({root}).initialize();t.after(()=>store.dispose());const bytes=source();const document=await store.createDocument({stream:(async function*(){yield bytes;})(),displayName:'source.pdf'});return {store,bytes,document,service:new PdfAcroFormRadioService({store})};}
test('radio service stages, verifies, promotes, and cleans',async(t)=>{const s=await setup(t);const result=await s.service.add(s.document.id,req(s.bytes));assert.equal(result.artifact.documentId,s.document.id);assert.equal(result.proof.options.length,2);assert.deepEqual(await readdir(join(s.store.root,'jobs')),[]);});
test('radio service maps stale and cancellation',async(t)=>{const s=await setup(t);await assert.rejects(s.service.add(s.document.id,{...req(s.bytes),sourceSha256:'0'.repeat(64)}),{code:'SOURCE_VERSION_MISMATCH'});const c=new AbortController();c.abort();await assert.rejects(s.service.add(s.document.id,req(s.bytes),{signal:c.signal}),{code:'JOB_CANCELLED'});});

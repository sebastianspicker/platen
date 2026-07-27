/**
 * Local-deterministic AI professional delivery. No network providers.
 */
import { createHash } from 'node:crypto';
import {
  capabilityResult,
  freezeDeep,
  LOCAL_ONLY_LIMITATION,
  requirePlainObject,
  requireString,
  requireText,
  throwFail,
} from './capability-result.mjs';

export const AI_CAPABILITIES = Object.freeze([
  'ai.summarize', 'ai.ask-document', 'ai.extract-structured-data', 'ai.translate',
  'ai.rewrite-proofread', 'ai.explain', 'ai.source-citations', 'ai.multi-document-analysis',
  'ai.generate-images', 'ai.generate-bookmarks', 'ai.smart-redaction', 'ai.form-extraction',
  'ai.accessibility-suggestions', 'ai.annotation-assist', 'ai.provider-policy-controls',
]);

const STOP = new Set(['the','a','an','and','or','of','to','in','for','on','is','are','was','were','be','as','by','with','that','this','it','from','at']);
const DICT = Object.freeze({ document:'documento', page:'página', form:'formulario', signature:'firma', review:'revisión', accessibility:'accesibilidad', redaction:'redacción', print:'impresión', measurement:'medición', project:'proyecto', summary:'resumen', contract:'contrato', value:'valor', safety:'seguridad', valve:'válvula' });
const DEFAULT_POLICY = Object.freeze({ mode:'local-deterministic', allowNetwork:false, allowExternalProviders:false, allowedProviders:Object.freeze(['local-deterministic']), maxInputChars:2_000_000, maxDocuments:32 });
let activePolicy = { ...DEFAULT_POLICY, allowedProviders:[...DEFAULT_POLICY.allowedProviders] };
const LIMITATIONS = Object.freeze([LOCAL_ONLY_LIMITATION, 'Extractive/heuristic algorithms only; not a neural generative model.', 'Remote providers remain denied.']);

function tokenize(text){ return String(text).toLowerCase().replace(/[^a-z0-9\s.-]/g,' ').split(/\s+/).filter(Boolean); }
function sentences(text){ return String(text).split(/(?<=[.!?])\s+/).map(s=>s.trim()).filter(Boolean); }
function termFrequency(tokens){ const m=new Map(); for (const t of tokens){ if(STOP.has(t)||t.length<3) continue; m.set(t,(m.get(t)||0)+1);} return m; }
function scoreSentence(sentence,freq){ const tokens=tokenize(sentence).filter(t=>!STOP.has(t)); if(!tokens.length) return 0; return tokens.reduce((s,t)=>s+(freq.get(t)||0),0)/tokens.length; }
function enforcePolicy(chars){ if(activePolicy.mode==='excluded') throwFail('AI_PROVIDER_POLICY_DENIED','AI disabled by policy.',403); if(chars>activePolicy.maxInputChars) throwFail('AI_INPUT_TOO_LARGE','Input exceeds local AI char budget.',413); }
function sha(text){ return createHash('sha256').update(String(text)).digest('hex'); }

function extractiveSummary(text,{maxSentences=3}={}){
  const units=sentences(text); if(!units.length) throwFail('AI_EMPTY_DOCUMENT','No sentences.');
  const freq=termFrequency(tokenize(text));
  const ranked=units.map((sentence,index)=>({sentence,index,score:scoreSentence(sentence,freq)})).sort((a,b)=>b.score-a.score||a.index-b.index);
  const picked=ranked.slice(0,Math.min(maxSentences,units.length)).sort((a,b)=>a.index-b.index);
  return { summary:picked.map(i=>i.sentence).join(' '), sentenceCount:units.length, keyTerms:[...freq.entries()].sort((a,b)=>b[1]-a[1]).slice(0,12).map(([term,count])=>({term,count})) };
}
function askDocument(text,question){
  const q=new Set(tokenize(question).filter(t=>!STOP.has(t))); if(!q.size) throwFail('AI_INVALID_QUESTION','Empty question.');
  let best={sentence:'',score:-1};
  for(const sentence of sentences(text)){ const score=tokenize(sentence).reduce((s,t)=>s+(q.has(t)?1:0),0); if(score>best.score) best={sentence,score}; }
  return best.score<=0 ? {answer:null,confidence:0} : {answer:best.sentence,confidence:Math.min(1,best.score/q.size)};
}
function extractStructured(text){
  return {
    emails:[...new Set(String(text).match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)||[])].slice(0,50),
    dates:[...new Set(String(text).match(/\b\d{4}-\d{2}-\d{2}\b/g)||[])].slice(0,50),
    amounts:[...new Set(String(text).match(/\$\s?\d+(?:,\d{3})*(?:\.\d{2})?/g)||[])].slice(0,50),
    keywords:[...termFrequency(tokenize(text)).entries()].sort((a,b)=>b[1]-a[1]).slice(0,20).map(([term,count])=>({term,count})),
  };
}
function translateText(text,target='es'){ if(target!=='es') throwFail('AI_UNSUPPORTED_LANGUAGE','Only es supported.'); return tokenize(text).map(t=>DICT[t]??t).join(' '); }
function rewriteProofread(text){ return String(text).replace(/\s+/g,' ').replace(/\s+([,.!?;:])/g,'$1').replace(/\bi\b/g,'I').trim(); }
function smartRedaction(text){
  const rules=[[/email/i,/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi],[/ssn/i,/\b\d{3}-\d{2}-\d{4}\b/g],[/phone/i,/\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/g]];
  const findings=[];
  for(const [label,re] of [[ 'email',/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi],['ssn',/\b\d{3}-\d{2}-\d{4}\b/g],['phone',/\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/g]]){
    for(const value of (String(text).match(re)||[]).slice(0,50)) findings.push({label,sampleHash:sha(value).slice(0,16),length:value.length});
  }
  return {findings};
}
function formExtraction(text){
  const fields=[];
  for(const line of String(text).split(/\n+/).map(l=>l.trim()).filter(Boolean).slice(0,200)){
    const m=/^([A-Za-z][A-Za-z0-9 /_-]{1,40})\s*[:_]\s*(.*)$/.exec(line);
    if(m) fields.push({name:m[1].trim(),sampleValue:m[2].slice(0,80),kind:'text'});
  }
  return {fields:fields.slice(0,50)};
}
function accessibilitySuggestions(text){
  const suggestions=[];
  if(!/\blang(?:uage)?\b/i.test(text)) suggestions.push({id:'missing-language-cue',severity:'warning',message:'No language cue detected.'});
  if(!/^#|\bheading\b|\btitle\b/im.test(text)) suggestions.push({id:'missing-heading-cue',severity:'info',message:'No heading/title cues detected.'});
  if((text.match(/\[image\]|\[figure\]/gi)||[]).length) suggestions.push({id:'image-placeholders',severity:'warning',message:'Image placeholders present.'});
  return {suggestions};
}
function generateBookmarks(text){
  const lines=String(text).split(/\n+/).map(l=>l.trim()).filter(Boolean);
  const bookmarks=lines.filter(l=>/^chapter\b|^section\b|^#{1,6}\s|^[A-Z][A-Za-z0-9 ]{0,40}$/i.test(l)).slice(0,50).map((title,i)=>({title,pageHint:i+1}));
  if(!bookmarks.length) bookmarks.push({title:extractiveSummary(text,{maxSentences:1}).summary.slice(0,80),pageHint:1});
  return {bookmarks};
}
function multiDocumentAnalysis(documents){
  if(!Array.isArray(documents)||documents.length<2||documents.length>activePolicy.maxDocuments) throwFail('AI_INVALID_CORPUS','Provide 2–32 documents.');
  const normalized=documents.map((doc,index)=>{ const text=requireText(doc?.text??doc,`documents[${index}]`); return {id:String(doc?.id??index),summary:extractiveSummary(text,{maxSentences:2}).summary,text}; });
  const shared=new Map();
  for(const doc of normalized) for(const token of new Set(tokenize(doc.text).filter(t=>!STOP.has(t)&&t.length>3))) shared.set(token,(shared.get(token)||0)+1);
  return {documents:normalized.map(({id,summary})=>({id,summary})),commonTerms:[...shared.entries()].filter(([,c])=>c>=2).sort((a,b)=>b[1]-a[1]).slice(0,30).map(([term,documentCount])=>({term,documentCount}))};
}
function providerPolicyControls(body){
  const requested=body?.requestedProvider??body?.provider??null;
  const denied=['openai','anthropic','gemini','remote-any'];
  if(requested && denied.includes(String(requested).toLowerCase())){
    return {policy:activePolicy,defaults:DEFAULT_POLICY,decision:'deny',requestedProvider:requested};
  }
  if(body?.mode==='excluded'){ activePolicy={...activePolicy,mode:'excluded'}; }
  if(body?.mode==='local-deterministic'){ activePolicy={...DEFAULT_POLICY,allowedProviders:[...DEFAULT_POLICY.allowedProviders]}; }
  return {policy:activePolicy,defaults:DEFAULT_POLICY,decision:'allow-local-only',requestedProvider:requested};
}

export function resetAiPolicyForTests(){ activePolicy={...DEFAULT_POLICY,allowedProviders:[...DEFAULT_POLICY.allowedProviders]}; }
export function listAiCapabilities(){ return AI_CAPABILITIES; }

export function handleAiCapability(capabilityId, request={}){
  if(!AI_CAPABILITIES.includes(capabilityId)) throwFail('AI_CAPABILITY_UNKNOWN',`Unknown AI capability: ${capabilityId}`);
  const body=requirePlainObject(request,'request');
  if(capabilityId==='ai.provider-policy-controls') return capabilityResult(capabilityId, providerPolicyControls(body), {limitations:LIMITATIONS});
  if(activePolicy.mode==='excluded'||!activePolicy.allowedProviders.includes('local-deterministic')) throwFail('AI_PROVIDER_POLICY_DENIED','AI disabled by policy.',403);
  if(capabilityId==='ai.multi-document-analysis'){ const analysis=multiDocumentAnalysis(body.documents); return capabilityResult(capabilityId, analysis, {limitations:LIMITATIONS}); }
  if(capabilityId==='ai.generate-images'){
    const text=requireText(body.text??body.prompt,'text'); enforcePolicy(text.length);
    return capabilityResult(capabilityId,{method:'local-image-brief',promptHash:sha(text).slice(0,16),svgPlan:`<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><text x="4" y="32">${text.slice(0,24)}</text></svg>`},{limitations:LIMITATIONS});
  }
  if(capabilityId==='ai.source-citations'){
    const text=requireText(body.text,'text'); enforcePolicy(text.length);
    const claims=Array.isArray(body.claims)?body.claims:[body.claim??'claim'];
    const citations=claims.map(claim=>{ const hit=askDocument(text,String(claim)); return {claim,quote:hit.answer,confidence:hit.confidence}; });
    return capabilityResult(capabilityId,{citations},{limitations:LIMITATIONS});
  }
  if(capabilityId==='ai.translate'){ const text=requireText(body.text,'text'); enforcePolicy(text.length); return capabilityResult(capabilityId,{source:text,translated:translateText(text,body.target??'es'),targetLanguage:body.target??'es'},{limitations:LIMITATIONS}); }
  if(capabilityId==='ai.ask-document'){ const text=requireText(body.text,'text'); const question=requireString(body.question,'question',{max:4000}); enforcePolicy(text.length+question.length); return capabilityResult(capabilityId,{question,...askDocument(text,question)},{limitations:LIMITATIONS}); }
  const text=requireText(body.text,'text'); enforcePolicy(text.length);
  const map={
    'ai.summarize':()=>extractiveSummary(text,{maxSentences:body.maxSentences??3}),
    'ai.extract-structured-data':()=>extractStructured(text),
    'ai.rewrite-proofread':()=>({source:text,rewritten:rewriteProofread(text)}),
    'ai.explain':()=>({explanation:`Local explanation: ${extractiveSummary(text,{maxSentences:2}).summary}`}),
    'ai.generate-bookmarks':()=>generateBookmarks(text),
    'ai.smart-redaction':()=>smartRedaction(text),
    'ai.form-extraction':()=>formExtraction(text),
    'ai.accessibility-suggestions':()=>accessibilitySuggestions(text),
    'ai.annotation-assist':()=>({proposedMarkup:{type:'highlight',quote:extractiveSummary(text,{maxSentences:1}).summary.slice(0,240),note:String(body.instruction??'assist')}}),
  };
  return capabilityResult(capabilityId, map[capabilityId](), {limitations:LIMITATIONS});
}

export const AiLocalDeterministicService = Object.freeze({ handle:handleAiCapability, list:listAiCapabilities, resetPolicy:resetAiPolicyForTests });

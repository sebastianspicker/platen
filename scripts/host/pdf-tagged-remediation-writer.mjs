import { createHash } from 'node:crypto';
import { pdfDictionary } from './pdf-classic-syntax.mjs';
import { parseClassicPdfStructure, parsePdfStructure, resolvePdfObject } from './pdf-classic-structure.mjs';
import { resolvePdfPageTree } from './pdf-page-tree-resolver.mjs';
import { tokenizePdfContentStream } from './pdf-content-stream-tokenizer.mjs';
import { visitPdfObjects } from './pdf-structure-inspection.mjs';
import { pendingClassicObjectReference, planPdfObjectTransaction } from './pdf-classic-object-transaction.mjs';
import { normalizeTaggedPdfRemediationRequest, TAGGED_PDF_REMEDIATION_PROFILE } from './pdf-tagged-remediation-contract.mjs';
import { pdfUtf16BeString } from './pdf-classic-text-string.mjs';
import { writeExistingTaggedPdfRemediation } from './pdf-tagged-remediation-existing-writer.mjs';

const HAZARD_KEYS = new Set(['A','AA','AcroForm','AF','Annots','ByteRange','Collection','Dests','EF','EmbeddedFiles','JS','Metadata','Names','OC','OCG','OCGs','OCProperties','OpenAction','Perms','PieceInfo','PresSteps','RichMediaContent','StructTreeRoot','StructParents','StructParent','ParentTree','XFA']);
const HAZARD_TYPES = new Set(['Action','Annot','EmbeddedFile','Filespec','OCG','OCMD','Sig','StructElem','StructTreeRoot','XRef','ObjStm']);
const HAZARD_SUBTYPES = new Set(['3D','FileAttachment','Movie','PS','Projection','RichMedia','Screen','Sound','XML']);
function failure(code,message){const e=new Error(message);e.code=code;return e;} function unsupported(message='The PDF is outside the bounded tagged-PDF remediation subset.'){return failure('UNSUPPORTED_TAGGED_PDF_REMEDIATION_PDF',message);} function invalidOutput(){return failure('INVALID_TAGGED_PDF_REMEDIATION_OUTPUT','Tagged-PDF remediation output proof failed.');}
function ref(object,generation=0){return Object.freeze({type:'ref',object,generation});} function number(value){return Object.freeze({type:'number',value,integer:Number.isSafeInteger(value),raw:String(value)});} function name(value){return Object.freeze({type:'name',value});} function array(values){return Object.freeze({type:'array',values:Object.freeze(values)});} function dict(entries){return Object.freeze({type:'dict',entries:new Map(entries)});} function sameRef(a,b){return a?.object===b?.object&&a?.generation===b?.generation;} function sha256(bytes){return createHash('sha256').update(bytes).digest('hex');}
function forbiddenValue(value){if(value?.type==='array')return value.values.some(forbiddenValue);if(value?.type!=='dict')return false;if([...value.entries.keys()].some(k=>HAZARD_KEYS.has(k)))return true;const type=value.entries.get('Type'),sub=value.entries.get('Subtype'),field=value.entries.get('FT');if(type?.type==='name'&&HAZARD_TYPES.has(type.value))return true;if(sub?.type==='name'&&HAZARD_SUBTYPES.has(sub.value))return true;if(field?.type==='name'&&field.value==='Sig')return true;return [...value.entries.values()].some(forbiddenValue);}
function sourceState(sourceBytes,request){if(!Buffer.isBuffer(sourceBytes)||sha256(sourceBytes)!==request.sourceSha256)throw unsupported('The semantic plan is not bound to the source digest.');
 let structure;
 try{structure=parsePdfStructure(sourceBytes);
 }catch{throw unsupported('The source PDF structure is unsupported.');
 }if(structure.revisions.length>=32)throw unsupported('The source has too many revisions.');
 try{visitPdfObjects(structure,o=>{if(forbiddenValue(o.value))throw unsupported('The source contains active content, tags, forms, signatures, or layers.');
 });
 const catalog=resolvePdfObject(structure,structure.root),catalogEntries=pdfDictionary(catalog.value);
 if(catalog.stream||catalogEntries.get('Type')?.value!=='Catalog')throw unsupported();
 if(catalogEntries.has('Lang')&&request.language!==null)throw unsupported('Existing catalog language cannot be overwritten.');
 if(catalogEntries.has('StructTreeRoot')||catalogEntries.has('MarkInfo'))throw unsupported();
 const treeStructure=structure.xrefFlavor==='classic'?parseClassicPdfStructure(sourceBytes):structure,tree=resolvePdfPageTree({structure:treeStructure,limits:{maxPages:100}});
 if(tree.pageCount<1)throw unsupported('The source has no pages.');
 const contentUse=new Map();
 for(const page of tree.pages){const p=pdfDictionary(page.page.value);
 if(p.has('Annots')||p.has('AA')||p.has('A')||p.has('OC')||p.has('StructParents'))throw unsupported('The page has an unsupported hazard.');
 for(const content of page.contents){if(content.stream.value.entries.has('Filter')||content.stream.value.entries.has('DecodeParms'))throw unsupported('Filtered content streams are unsupported.');
 const len=content.stream.value.entries.get('Length');
 if(len?.type!=='number'||!len.integer||len.value!==content.streamLength)throw unsupported('Content stream length is ambiguous.');
 try{tokenizePdfContentStream({sourceBytes,stream:content.stream});
 }catch{throw unsupported('Content stream syntax is unsupported.');
 }const key=`${content.reference.object}:${content.reference.generation}`;
 contentUse.set(key,(contentUse.get(key)||0)+1);
 }}if([...contentUse.values()].some(c=>c!==1))throw unsupported('Content streams are shared or aliased.');
 const allReferences=new Map(),countReferences=v=>{if(v?.type==='ref'){const k=`${v.object}:${v.generation}`;
 if(contentUse.has(k))allReferences.set(k,(allReferences.get(k)||0)+1);
 return;
 }if(v?.type==='array')v.values.forEach(countReferences);
 else if(v?.type==='dict')v.entries.forEach(countReferences);
 };
 visitPdfObjects(structure,o=>countReferences(o.value));
 if([...allReferences.values()].some(c=>c!==1))throw unsupported('Content streams have aliased graph references.');
 return Object.freeze({structure,catalogEntries,tree,contentUse});
 }catch(e){if(e?.code==='UNSUPPORTED_TAGGED_PDF_REMEDIATION_PDF')throw e;
 throw unsupported();
 }}
function collectLeaves(plan,leaves=[],parent=null){if(plan.children)for(const child of plan.children)collectLeaves(child,leaves,plan);else leaves.push(Object.freeze({node:plan,parent}));return leaves;}
function expectedTargets(request,state){const pages=new Map(state.tree.pages.map(p=>[p.index+1,p])),leaves=collectLeaves(request.plan),targets=new Map(),mcids=new Map();for(const {node} of leaves){const page=pages.get(node.page);if(!page||node.contentIndex>=page.contents.length)throw unsupported('A semantic leaf targets a missing page content stream.');const content=page.contents[node.contentIndex],key=`${node.page}:${content.reference.object}:${content.reference.generation}`;if(targets.has(key))throw unsupported('A content stream is targeted more than once.');const mcid=node.role==='Artifact'?-1:(mcids.get(node.page)||0);if(node.role!=='Artifact')mcids.set(node.page,mcid+1);targets.set(key,Object.freeze({node,page,content,mcid}));}return Object.freeze({leaves:Object.freeze(leaves),targets,mcids});}
function changedId(sourceBytes,request){return createHash('sha256').update('Platen tagged remediation ID v1\0').update(sourceBytes).update(JSON.stringify(request)).digest().subarray(0,16);}
function append(sourceBytes,request,state,plan){const additions=[],addition=(id,value,streamBytes)=>{additions.push({id,value,...(streamBytes===undefined?{}:{streamBytes})});
 return pendingClassicObjectReference(id);
 },leavesByNode=new Map(),prefixRefs=new Map(),suffixRefs=new Map();
 for(const {node} of plan.leaves){const target=[...plan.targets.values()].find(c=>c.node.id===node.id),prefix=Buffer.from(node.role==='Artifact'?'/Artifact BMC\n':`/${node.role} <</MCID ${target.mcid}>> BDC\n`,'latin1'),suffix=Buffer.from('EMC\n','latin1');
 prefixRefs.set(node.id,addition(`prefix-${prefixRefs.size}`,dict([['Length',number(prefix.length)]]),prefix));
 suffixRefs.set(node.id,addition(`suffix-${suffixRefs.size}`,dict([['Length',number(suffix.length)]]),suffix));
 leavesByNode.set(node.id,target);
 }const structRefs=new Map(),all=[];
 const visit=(node,parent)=>{all.push({node,parent});
 for(const child of node.children||[])visit(child,node);
 };
 visit(request.plan,null);
 const structural=all.filter(x=>x.node.role!=='Artifact');
 for(let i=0;
 i<structural.length;
 i++)structRefs.set(structural[i].node.id,pendingClassicObjectReference(`struct-${i}`));
 const structRoot=pendingClassicObjectReference('struct-root'),structObjects=[];
 for(const {node,parent} of structural){const children=node.children?node.children.filter(c=>c.role!=='Artifact').map(c=>structRefs.get(c.id)):[dict([['Type',name('MCR')],['Pg',ref(leavesByNode.get(node.id).page.reference.object,leavesByNode.get(node.id).page.reference.generation)],['MCID',number(leavesByNode.get(node.id).mcid)]])];
 structObjects.push({id:`struct-${structObjects.length}`,value:dict([['Type',name('StructElem')],['S',name(node.role)],['P',parent?structRefs.get(parent.id):structRoot],['K',array(children)],...(node.children?[]:[['Pg',ref(leavesByNode.get(node.id).page.reference.object,leavesByNode.get(node.id).page.reference.generation)]])])});
 }for(const x of structObjects)additions.push(x);
 const parentArrays=new Map();
 for(const [p,count] of plan.mcids)parentArrays.set(p,Array.from({length:count},()=>null));
 for(const {node} of plan.leaves)if(node.role!=='Artifact'){const target=plan.targets.get(`${node.page}:${leavesByNode.get(node.id).content.reference.object}:${leavesByNode.get(node.id).content.reference.generation}`);
 parentArrays.get(node.page)[target.mcid]=structRefs.get(node.id);
 }const parentTree=addition('parent-tree',dict([['Nums',array([...parentArrays.entries()].sort((a,b)=>a[0]-b[0]).flatMap(([p,v])=>[number(p-1),array(v)]))]]));
 const root=addition('struct-root',dict([['Type',name('StructTreeRoot')],['K',array([structRefs.get(request.plan.id)])],['ParentTree',parentTree],['ParentTreeNextKey',number(state.tree.pageCount)],...(Object.keys(request.roleMap).length?[['RoleMap',dict(Object.entries(request.roleMap).map(([k,v])=>[k,name(v)]))]]:[])])),mark=addition('mark-info',dict([['Marked',{type:'boolean',value:true}]])),catalog=new Map(state.catalogEntries);
 catalog.set('StructTreeRoot',root);
 catalog.set('MarkInfo',mark);
 if(request.language!==null)catalog.set('Lang',pdfUtf16BeString(request.language));
 const updates=[{reference:state.structure.root,value:dict(catalog)}];
 for(const page of state.tree.pages){const pe=new Map(pdfDictionary(page.page.value)),contents=[];
 for(const content of page.contents){const target=[...plan.targets.values()].find(c=>c.page.index===page.index&&sameRef(c.content.reference,content.reference));
 if(target)contents.push(prefixRefs.get(target.node.id),ref(content.reference.object,content.reference.generation),suffixRefs.get(target.node.id));
 else contents.push(ref(content.reference.object,content.reference.generation));
 }pe.set('Contents',array(contents));
 const structuralTargets=[...plan.targets.values()].filter(c=>c.page.index===page.index&&c.node.role!=='Artifact');
 if(structuralTargets.length)pe.set('StructParents',number(page.index));
 if([...plan.targets.values()].some(c=>c.page.index===page.index))updates.push({reference:page.reference,value:dict(pe)});
 }let infoReference=state.structure.info;
 if(request.title!==null){if(state.structure.info){const io=resolvePdfObject(state.structure,state.structure.info),ie=new Map(pdfDictionary(io.value));
 if(ie.has('Title'))throw unsupported('Existing document title cannot be overwritten.');
 ie.set('Title',pdfUtf16BeString(request.title));
 updates.push({reference:state.structure.info,value:dict(ie)});
 }else{additions.push({id:'info',value:dict([['Title',pdfUtf16BeString(request.title)]])});
 infoReference=pendingClassicObjectReference('info');
 }}const transaction=planPdfObjectTransaction({sourceBytes,sourceStructure:state.structure,updates,additions,info:infoReference?(state.structure.info?{kind:'preserve'}:{kind:'set',additionId:'info'}):{kind:'preserve'},changingId:state.structure.id?changedId(sourceBytes,request):null});
 return Object.freeze({bytes:Buffer.concat([sourceBytes,transaction.revision.bytes]),transaction,plan,state});
 }
function proof(sourceBytes,outputBytes,state,built){let output;
 try{output=parsePdfStructure(outputBytes);
 }catch{throw invalidOutput();
 }if(!outputBytes.subarray(0,sourceBytes.length).equals(sourceBytes))throw invalidOutput();
 const tree=resolvePdfPageTree({structure:output.xrefFlavor==='classic'?parseClassicPdfStructure(outputBytes):output,limits:{maxPages:100}});
 if(tree.pageCount!==state.tree.pageCount)throw invalidOutput();
 const originals=[];
 for(const page of state.tree.pages)for(const content of page.contents){const out=resolvePdfObject(output,content.reference),bytes=sourceBytes.subarray(content.stream.streamStart,content.stream.streamStart+content.stream.streamLength);
 if(!out.stream||!output.buffer.subarray(out.streamStart,out.streamStart+out.streamLength).equals(bytes))throw invalidOutput();
 originals.push({page:page.index+1,contentIndex:page.contents.indexOf(content),sha256:sha256(bytes),bytes:content.streamLength});
 }const root=pdfDictionary(resolvePdfObject(output,output.root).value),sr=root.get('StructTreeRoot');
 if(sr?.type!=='ref')throw invalidOutput();
 return Object.freeze({profile:TAGGED_PDF_REMEDIATION_PROFILE,sourceSha256:sha256(sourceBytes),outputSha256:sha256(outputBytes),sourcePrefixPreserved:true,originalContentStreamsUnchanged:true,deterministic:true,pageCount:state.tree.pageCount,pageGeometry:state.tree.pages.map(p=>Object.freeze({mediaBox:[...p.mediaBox],cropBox:[...p.cropBox],rotate:p.rotate})),structureLinked:true,structTreeRootObjectNumber:sr.object,appendedBytes:built.bytes.length,revisionCount:output.revisions.length,originalContentStreams:Object.freeze(originals)});
 }
export function writeTaggedPdfRemediation(sourceBytes,requestValue){const request=normalizeTaggedPdfRemediationRequest(requestValue);if(request.plan.mode==='existing-structure-v1')return writeExistingTaggedPdfRemediation(sourceBytes,request);const state=sourceState(sourceBytes,request),plan=expectedTargets(request,state),built=append(sourceBytes,request,state,plan);return Object.freeze({bytes:built.bytes,proof:proof(sourceBytes,built.bytes,state,built)});}
export function inspectTaggedPdfRemediation(sourceBytes,outputBytes,requestValue){const expected=writeTaggedPdfRemediation(sourceBytes,requestValue);if(!Buffer.isBuffer(outputBytes)||!outputBytes.equals(expected.bytes))throw invalidOutput();return expected.proof;}
export const writeTaggedPdf=writeTaggedPdfRemediation; export const inspectTaggedPdf=inspectTaggedPdfRemediation;


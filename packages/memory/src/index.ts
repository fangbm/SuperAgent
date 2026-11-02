import { createHash } from 'node:crypto';
import { SqliteStore } from '@superagent/persistence';
import type { EvidenceAnchorV2, FeedbackItemV2 } from '@superagent/contracts';

export type WorkKind = 'defect' | 'suggestion';
export interface WorkSnapshot {
  id: string; projectId: string; kind: WorkKind; title: string; summary: string; status: string;
  version: number; reviewRequired: boolean; priority: number; feedbackCount: number;
  evidence: EvidenceAnchorV2[]; content: FeedbackItemV2;
}
export interface EmbeddingSource { readonly modelId: string; embed(texts: string[], signal: AbortSignal): Promise<number[][]> }
export const textHash = (text: string) => createHash('sha256').update(text).digest('hex');
export function tokens(text: string): string[] {
  const result: string[] = [];
  for (const part of text.normalize('NFKC').toLowerCase().match(/[\p{Script=Han}]+|[\p{L}\p{N}_]+/gu) ?? []) {
    if (/\p{Script=Han}/u.test(part)) { for (let i = 0; i < part.length - 1; i++) result.push(part.slice(i, i + 2)); if (part.length === 1) result.push(part); }
    else result.push(part);
  }
  return [...new Set(result)];
}
function cosine(a: number[], b: number[]): number {
  if (!a.length || a.length !== b.length || ![...a,...b].every(Number.isFinite)) return 0;
  let sum=0,aa=0,bb=0; for(let i=0;i<a.length;i++){sum+=a[i]!*b[i]!;aa+=a[i]!**2;bb+=b[i]!**2;}
  return aa && bb ? sum/Math.sqrt(aa*bb) : 0;
}
export class HybridMemory {
  constructor(readonly store: SqliteStore, readonly embeddings?: EmbeddingSource) {}
  index(work: WorkSnapshot): void {
    const text = `${work.title}\n${work.summary}`;
    this.store.run('DELETE FROM work_fts WHERE project_id=? AND work_kind=? AND work_id=?', work.projectId,work.kind,work.id);
    this.store.run('INSERT INTO work_fts(project_id,work_kind,work_id,tokens) VALUES(?,?,?,?)',work.projectId,work.kind,work.id,tokens(text).join(' '));
    this.store.run(`INSERT INTO embedding_outbox(project_id,work_kind,work_id,text_hash,text,state) VALUES(?,?,?,?,?,'pending')
      ON CONFLICT(project_id,work_kind,work_id) DO UPDATE SET text_hash=excluded.text_hash,text=excluded.text,state=CASE WHEN embedding_outbox.text_hash=excluded.text_hash THEN embedding_outbox.state ELSE 'pending' END`,work.projectId,work.kind,work.id,textHash(text),text);
  }
  get(projectId: string, kind: WorkKind, id: string): WorkSnapshot | undefined {
    const row=this.store.get<{content_json:string}>('SELECT content_json FROM work_metadata WHERE project_id=? AND work_kind=? AND work_id=? AND merged_into IS NULL',projectId,kind,id);
    return row ? JSON.parse(row.content_json) as WorkSnapshot : undefined;
  }
  async search(projectId: string,kind: WorkKind,query: string,limit=5,signal: AbortSignal=new AbortController().signal):Promise<{items:WorkSnapshot[];mode:'lexical'|'hybrid';semanticPoolTruncated:boolean}> {
    if(!Number.isInteger(limit)||limit<1||limit>20)throw new Error('INVALID_SEARCH_LIMIT');
    const terms=tokens(query).slice(0,32).map(term=>`"${term.replaceAll('"','""')}"`).join(' OR ');
    const scores=new Map<string,number>();
    if(terms){const rows=this.store.all<{work_id:string}>(`SELECT work_id FROM work_fts WHERE work_fts MATCH ? AND project_id=? AND work_kind=? ORDER BY bm25(work_fts) LIMIT ?`,terms,projectId,kind,limit*4);rows.forEach((r,i)=>scores.set(r.work_id,1/(60+i)));}
    let truncated=false;
    if(this.embeddings){
      const [vector]=await this.embeddings.embed([query],signal);if(!vector?.length||!vector.every(Number.isFinite))throw new Error('INVALID_QUERY_EMBEDDING');
      const rows=this.store.all<{work_id:string;vector_json:string}>(`SELECT v.work_id,v.vector_json FROM work_embeddings v JOIN embedding_outbox o
        ON o.project_id=v.project_id AND o.work_kind=v.work_kind AND o.work_id=v.work_id AND o.text_hash=v.text_hash
        WHERE v.project_id=? AND v.work_kind=? AND v.model_id=? ORDER BY v.work_id LIMIT 2049`,projectId,kind,this.embeddings.modelId);
      truncated=rows.length>2048;
      rows.slice(0,2048).map(r=>({id:r.work_id,score:cosine(vector,JSON.parse(r.vector_json) as number[])})).filter(r=>r.score>0).sort((a,b)=>b.score-a.score).slice(0,limit*4).forEach((r,i)=>scores.set(r.id,(scores.get(r.id)??0)+1/(60+i)));
    }
    const items=[...scores].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])).flatMap(([id])=>{const work=this.get(projectId,kind,id);return work?[work]:[];}).slice(0,limit);
    return {items,mode:this.embeddings?'hybrid':'lexical',semanticPoolTruncated:truncated};
  }
  async drainEmbeddings(signal:AbortSignal,limit=8):Promise<number>{
    if(!this.embeddings)return 0;
    const provider=this.embeddings;
    const rows=this.store.all<{project_id:string;work_kind:WorkKind;work_id:string;text_hash:string;text:string}>("SELECT * FROM embedding_outbox o WHERE state='pending' OR NOT EXISTS(SELECT 1 FROM work_embeddings v WHERE v.project_id=o.project_id AND v.work_kind=o.work_kind AND v.work_id=o.work_id AND v.model_id=? AND v.text_hash=o.text_hash) LIMIT ?",provider.modelId,limit);
    if(!rows.length)return 0;
    const vectors=await provider.embed(rows.map(r=>r.text),signal);
    if(vectors.length!==rows.length)throw new Error('INVALID_EMBEDDING_COUNT');
    return this.store.transaction(()=>{let n=0;for(const [i,row] of rows.entries()){
      const vector=vectors[i];if(!vector?.length||!vector.every(Number.isFinite))throw new Error('INVALID_EMBEDDING_VECTOR');
      const current=this.store.get<{text_hash:string}>('SELECT text_hash FROM embedding_outbox WHERE project_id=? AND work_kind=? AND work_id=?',row.project_id,row.work_kind,row.work_id);
      if(current?.text_hash!==row.text_hash)continue;
      this.store.run('INSERT INTO work_embeddings VALUES(?,?,?,?,?,?) ON CONFLICT(project_id,work_kind,work_id,model_id) DO UPDATE SET text_hash=excluded.text_hash,vector_json=excluded.vector_json',row.project_id,row.work_kind,row.work_id,provider.modelId,row.text_hash,JSON.stringify(vector));
      this.store.run("UPDATE embedding_outbox SET state='completed' WHERE project_id=? AND work_kind=? AND work_id=?",row.project_id,row.work_kind,row.work_id);n++;
    }return n;});
  }
}

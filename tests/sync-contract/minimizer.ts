/** Classic ddmin: returns a 1-minimal failing subsequence while preserving input order. */
export function minimize<T>(input:readonly T[],fails:(candidate:readonly T[])=>boolean):T[]{
  if(!fails(input))return [...input];
  let current=[...input],granularity=2;
  while(current.length>=2){
    const chunkSize=Math.ceil(current.length/granularity);let reduced=false;
    for(let start=0;start<current.length;start+=chunkSize){
      const candidate=current.filter((_,index)=>index<start||index>=start+chunkSize);
      if(candidate.length&&fails(candidate)){current=candidate;granularity=Math.max(2,granularity-1);reduced=true;break;}
    }
    if(reduced)continue;
    if(granularity>=current.length)break;
    granularity=Math.min(current.length,granularity*2);
  }
  return current;
}

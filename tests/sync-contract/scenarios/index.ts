import type { OperationKind, SyncEvent } from '../oracle.js';

export interface Scenario { id:string; title:string; events:SyncEvent[]; }
const w=(device:string,actor:string,objectId:string,content:string,kind:OperationKind='note'):SyncEvent=>({type:'localWrite',device,actor,objectId,content,kind});
const push=(device:string):SyncEvent=>({type:'deliver',device,direction:'push'});
const pull=(device:string):SyncEvent=>({type:'deliver',device,direction:'pull'});
export function catalogue():Scenario[]{
  const scenarios:Scenario[]=[
    {id:'RC-01',title:'online create edit delete restore',events:[w('d1','alice','a','one'),push('d1'),w('d1','alice','a','two'),push('d1'),{type:'localDelete',device:'d1',actor:'alice',objectId:'a'},push('d1'),{type:'restore',device:'d1',actor:'alice',objectId:'a',content:'restored'},push('d1'),pull('d1')]},
    {id:'RC-02',title:'different objects converge',events:[w('d1','alice','a','A'),w('d2','alice','b','B'),push('d1'),push('d2'),pull('d1'),pull('d2')]},
    {id:'RC-03',title:'disjoint edit candidates',events:[w('d1','alice','a','base\nleft\nend'),push('d1'),pull('d2'),w('d1','alice','a','base\nleft edit\nend'),w('d2','alice','a','base\nright edit\nend'),push('d1'),push('d2'),pull('d1'),pull('d2')]},
    {id:'RC-04',title:'overlapping edits preserve conflict',events:[w('d1','alice','a','base'),push('d1'),pull('d2'),w('d1','alice','a','left'),w('d2','alice','a','right'),push('d1'),push('d2')]},
    {id:'RC-05',title:'offline same-object edits reconnect orders',events:[{type:'partition',device:'d1'},{type:'partition',device:'d2'},w('d1','alice','a','left'),w('d2','alice','a','right'),{type:'heal',device:'d1'},push('d1'),{type:'heal',device:'d2'},push('d2')]},
    {id:'RC-06',title:'delete restore and same-id policy cases',events:[w('d1','alice','a','base'),push('d1'),{type:'localDelete',device:'d1',actor:'alice',objectId:'a'},push('d1'),{type:'restore',device:'d2',actor:'alice',objectId:'a',content:'restore'}]},
    {id:'RC-07',title:'duplicate push and reordered pages',events:[w('d1','alice','a','once'),{type:'deliver',device:'d1',direction:'push',duplicate:true},{type:'deliver',device:'d1',direction:'push',drop:true},pull('d2')]},
    {id:'RC-08',title:'retry stable op identity and retention',events:[w('d1','alice','a','retry'),{type:'deliver',device:'d1',direction:'push',drop:true},{type:'deliver',device:'d1',direction:'push'}]},
    {id:'RC-09',title:'all client crash boundaries',events:([...'B1 B2 B3 B4 B5 B6 B7'.split(' ')].flatMap(boundary=>[{type:'crash',target:'d1',boundary} as SyncEvent,{type:'localWrite',device:'d1',actor:'alice',objectId:'a',content:boundary} as SyncEvent]))},
    {id:'RC-10',title:'all server crash boundaries',events:'S1 S2 S3 S4 S5 S6'.split(' ').map(boundary=>({type:'crash',target:'server',boundary}))},
    {id:'RC-11',title:'partition flapping and bounded queue',events:[{type:'partition',device:'d1'},w('d1','alice','a','offline'),{type:'heal',device:'d1'},push('d1')]},
    {id:'RC-12',title:'ACL revoke quarantines pending write',events:[{type:'grant',actor:'bob',scope:'a'},w('d1','bob','a','private'),{type:'revoke',actor:'bob',scope:'a'},push('d1'),pull('d1')]},
    {id:'RC-13',title:'later grant invalidates scope view',events:[{type:'grant',actor:'bob',scope:'a'},w('d1','alice','a','visible'),push('d1'),{type:'grant',actor:'bob',scope:'a'},pull('d2')]},
    {id:'RC-14',title:'same actor devices with differing grants',events:[{type:'grant',actor:'bob',scope:'a'},w('d1','alice','a','a'),w('d1','alice','b','b'),push('d1'),pull('d2')]},
    {id:'RC-15',title:'selective five-object working set',events:Array.from({length:5},(_,i)=>w('d1','alice',`set-${i}`,`content-${i}`)).concat([push('d1'),pull('d1')])},
    {id:'RC-16',title:'cursor expiry foreign cursor and ancestry recovery',events:[w('d1','alice','a','first'),push('d1'),pull('d2'),w('d1','alice','a','second'),push('d1'),pull('d2')]},
    {id:'RC-17',title:'server backup restore changes epoch',events:[w('d1','alice','a','acknowledged'),push('d1'),{type:'restoreBackup'},pull('d1')]},
    {id:'RC-18',title:'purge removes bytes and blocks resurrection',events:[w('d1','alice','a','secret'),push('d1'),pull('d2'),{type:'purge',objectId:'a'},pull('d1'),w('d1','alice','a','stale')]},
    {id:'RC-19',title:'review gates reject every restricted kind',events:(['wiki-retire','insight-approve','dream-promote','acl-change','credential-change'] as const).map((kind,i)=>w('d1','alice',`gate-${i}`,kind,kind)).concat([push('d1')])},
    {id:'RC-20',title:'path id malformed and oversized content inputs',events:[w('d1','alice','../escape','safe'),w('d1','alice','binary','\0\xff'),w('d1','alice','oversized','x'.repeat(1024)),push('d1')]},
    {id:'RC-21',title:'schema and protocol version skew refusal boundary',events:[{type:'crash',target:'old-client',boundary:'schemaVersion>=2'}]},
    {id:'RC-22',title:'dashboard and offline agent divergence',events:[w('d1','alice','wiki-page','dashboard','wiki'),w('d2','alice','wiki-page','offline','wiki'),push('d1'),push('d2')]},
    {id:'RC-23',title:'large object population and rebuild sample',events:Array.from({length:200},(_,i)=>w('d1','alice',`scale-${i}`,`v-${i}`)).concat([push('d1'),pull('d1')])},
    {id:'RC-24',title:'disk full partial blob retry boundary',events:[{type:'crash',target:'d1',boundary:'disk-full-temp-blob'},w('d1','alice','a','durable'),push('d1')]},
    {id:'RC-25',title:'model-generated operations preserve gates',events:[w('d1','alice','preference','model note'),w('d1','alice','wiki','model proposal','wiki'),w('d1','alice','dream','promotion','dream-promote'),push('d1')]},
    {id:'RC-26',title:'random-seed convergence property',events:[w('d1','alice','a','v1'),push('d1'),pull('d2')]},
  ];
  return scenarios;
}

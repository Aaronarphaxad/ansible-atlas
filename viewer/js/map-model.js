/* ==========================================================================
 * Map model: trees and layout
 *
 * A "view" is one of the three maps. It holds the tree (V.root, V.nodes), which nodes are
 * expanded (V.expanded, a Set of node keys), the pan/zoom (tx, ty, k) and, after layout(),
 * the visible nodes in V.laid. The same entity can appear at several nodes (byEnt).
 * ========================================================================== */
// The three map views (playbooks, roles, inventory), built once at startup by buildView().
const VIEWS={};

// Turn a raw tree from the model ([entityId, children] pairs) into a map view.
// Each node gets a stable key ("0.2.1" = path of child indexes), parent/depth links and kids.
// Nodes shallower than defaultDepth start expanded.
function buildView(name,raw,defaultDepth){
  const nodes=[],byEnt=new Map();
  function norm(x,parent,depth,key){
    const n=typeof x==="string"?{e:x,c:[]}:{e:x[0],c:x[1]};
    n.key=key;n.parent=parent;n.depth=depth;n.kids=[];
    nodes.push(n);
    if(!byEnt.has(n.e))byEnt.set(n.e,[]);byEnt.get(n.e).push(n);
    n.kids=(n.c||[]).map((c,i)=>norm(c,n,depth+1,key+"."+i));delete n.c;
    return n;
  }
  const root=norm(raw,null,0,"0");
  const expanded=new Set();
  for(const n of nodes) if(n.depth<defaultDepth&&n.kids.length) expanded.add(n.key);
  VIEWS[name]={name,root,nodes,byEnt,expanded,tx:40,ty:60,k:1,laid:null,fitted:false};
}

// Off-screen canvas used only to measure text.
const measureCtx=document.createElement("canvas").getContext("2d");

// Measure text width in px (used to size node boxes).
function textW(s,f){measureCtx.font=f||"13px system-ui,-apple-system,Segoe UI,Roboto,sans-serif";return measureCtx.measureText(s).width;}

// The grey second line under a node's label.
function subOf(e,n){
  if(!e)return"";
  const T=TYPES[e.type]||{n:e.type};
  switch(e.type){
    case"task":case"handler":return (e.module?e.module.replace(/^ansible\.builtin\./,""):"")+(e.when?" · when":"")+(e.loop?" · loop":"")+(e.notify?" · notify":"");
    case"play":return "hosts: "+fmt(e.hosts);
    case"role":return e.external?"role · external":"role"+(e.deps&&e.deps.length?" · "+e.deps.length+" dep(s)":"");
    case"host":return "host"+(e.sub?" · "+e.sub:"");
    case"group":return "group · "+(e.all_hosts||[]).length+" host(s)";
    case"section":return T.n.toLowerCase()+" · "+(e.count??n.kids.length);
    case"inventory":return "inventory · "+e.counts.hosts+" hosts"+(e.default?" · default":"");
    case"playbook":return "playbook";
    case"include_tasks":case"import_tasks":return e.type+(e.unresolved?" · unresolved":"");
    case"include_role":case"import_role":return e.type;
    default:return T.n.toLowerCase();
  }
}

// Map geometry (px in map coordinates): node height, row pitch, column gap, node width limits.
const NODE_H=40,ROW=50,GAP_X=56,MAXW=320,MINW=120;

// Lay out the visible part of a view as a left-to-right tidy tree.
// Columns are tree depths; every visible leaf gets its own row; parents sit midway between
// their first and last child. Sets n.x, n.y, n.w on visible nodes and V.laid/width/height.
function layout(V){
  const vis=[];const colW=[];
  (function walk(n){vis.push(n);const e=ENT[n.e]||{label:n.e};
    n.label=short(e.label,48);n.sub=short(subOf(e,n),52);
    n.w=Math.max(MINW,Math.min(MAXW,Math.max(textW(n.label),textW(n.sub,"11px system-ui"))+46));
    colW[n.depth]=Math.max(colW[n.depth]||0,n.w);
    if(V.expanded.has(n.key))for(const k of n.kids)walk(k);})(V.root);
  const colX=[0];for(let i=1;i<colW.length;i++)colX[i]=colX[i-1]+colW[i-1]+GAP_X;
  let leaf=0;
  (function place(n){n.x=colX[n.depth];
    const open=V.expanded.has(n.key)&&n.kids.length;
    if(!open){n.y=leaf*ROW;leaf++;return;}
    for(const k of n.kids)place(k);
    n.y=(n.kids[0].y+n.kids[n.kids.length-1].y)/2;})(V.root);
  V.laid=vis;V.width=(colX[colX.length-1]||0)+(colW[colW.length-1]||0);V.height=leaf*ROW;
}

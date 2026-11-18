/* ==========================================================================
 * Search (header box, / to focus)
 *
 * Typing fills the dropdown and sets searchHits, the entity ids tinted on the map.
 * map-search.js adds the on-map match bar and N / Shift+N navigation.
 * ========================================================================== */
// Search index: one entry per entity/file with its searchable text.
const INDEX=[];

// task/play id → variable names it uses.
const USES_BY_OWNER=new Map();

// Build the search index once at startup (and the "variables used by" lookup).
function buildIndex(){
  const add=(eid,kind,label,ctx,text,extra)=>INDEX.push({eid,kind,label,ctx,text:text.toLowerCase(),ll:String(label).toLowerCase(),...extra});
  for(const e of Object.values(ENT)){
    if(e.type==="root"||e.type==="section")continue;
    if(e.type==="var"){
      for(const u of e.uses){if(!USES_BY_OWNER.has(u.o))USES_BY_OWNER.set(u.o,[]);const l=USES_BY_OWNER.get(u.o);if(!l.includes(e.label))l.push(e.label);}
      add(e.id,"var",e.label,ctxOf(e),[e.label,...e.defs.map(d=>fmt(d.v)+" "+d.src)].join(" ").slice(0,4000));continue;
    }
    if(e.type==="template"){add(e.id,"template",e.path,e.role?"template · role "+e.role:"template",e.path+" "+((D.files[e.path]||{}).text||"").slice(0,60000));continue;}
    if(e.type==="script"){add(e.id,"script",e.path,e.summary.join("; "),e.path+" "+((D.files[e.path]||{}).text||"").slice(0,30000));continue;}
    if(e.type==="file")continue;
    const kind=["include_tasks","import_tasks","include_role","import_role","block"].includes(e.type)?"task":e.type;
    add(e.id,kind,e.label,ctxOf(e),[e.label,e.module,e.desc,e.src,e.path,e.sub,fmt(e.hosts),fmt(e.when),fmt(e.tags),e.args?JSON.stringify(e.args).slice(0,600):""].filter(Boolean).join(" "));
  }
  for(const l of USES_BY_OWNER.values())l.sort();
  for(const p of Object.keys(D.files||{})){const f=D.files[p];INDEX.push({eid:"file:"+p,kind:"file",label:p,ctx:(f.kind||"file")+(f.lines?` · ${f.lines} lines`:""),text:p.toLowerCase(),ll:p.toLowerCase()});}
}

// Search ranking: lower kinds are listed first when scores tie.
const KIND_ORDER={var:0,host:1,group:2,role:3,play:4,playbook:5,task:6,handler:7,template:8,script:8,inventory:9,file:10,missing:11};
let hits=[],hi=0;

// Run a search as you type: score matches, fill the results dropdown and tint matching map nodes.
function doSearch(q){
  const box=$("#results");q=q.trim();
  if(!q){box.classList.remove("open");searchHits=new Set();matchIdx=-1;if(VIEWS[current])drawGraph();return;}
  let kind=null;const m=q.match(/^(host|group|var|task|role|play|playbook|handler|file|inventory|inv|template|tpl|script):\s*(.*)$/i);
  if(m){kind=m[1].toLowerCase();if(kind==="inv")kind="inventory";if(kind==="tpl")kind="template";q=m[2];}
  const terms=q.toLowerCase().split(/\s+/).filter(Boolean);
  const scored=[];
  for(const it of INDEX){
    if(kind&&it.kind!==kind)continue;
    if(!terms.every(t=>it.text.includes(t)))continue;
    const t0=terms[0]||"";let s=KIND_ORDER[it.kind]??9;
    const key=it.ll;
    if(key===q.toLowerCase())s-=30;else if(key.startsWith(t0))s-=20;else if(it.ll.includes(t0))s-=10;
    scored.push([s,it]);
    if(scored.length>4000)break;
  }
  scored.sort((a,b)=>a[0]-b[0]||a[1].label.length-b[1].label.length);
  // collapse duplicate var hits per (key,value) into first few
  hits=scored.slice(0,150).map(x=>x[1]);hi=0;matchIdx=-1;
  searchHits=new Set(hits.filter(h=>h.eid&&h.kind!=="var").map(h=>h.eid));
  box.replaceChildren();
  if(!hits.length)box.append(el("div",{class:"res-hint"},"No matches. Try fewer letters, or a prefix like var: or host:"));
  hits.forEach((h,i)=>box.append(el("div",{class:"res"+(i===0?" on":""),onmousedown:ev=>{ev.preventDefault();pick(i);}},
    badge(h.kind==="file"?"section":ENT[h.eid]?.type||h.kind),
    el("div",{class:"t"},el("div",{class:"l"},h.label),el("div",{class:"c"},h.ctx)))));
  box.append(el("div",{class:"res-hint"},`${scored.length>150?"Top 150 of "+scored.length:scored.length} result(s) · ↑↓ to move · Enter to open · matching nodes are tinted in the map · N / Shift+N steps through them`));
  box.classList.add("open");
  if(VIEWS[current])drawGraph();
}

// Open search result i.
function pick(i){
  const h=hits[i];if(!h)return;$("#results").classList.remove("open");
  if(h.kind==="file"){select(h.eid,{});return;}
  let hl=null;
  if(h.kind==="template"||h.kind==="script"){const t=($("#q").value.replace(/^\w+:\s*/,"").trim().split(/\s+/)[0]||"").toLowerCase();
    if(t){hl=[];((D.files[ENT[h.eid].path]||{}).text||"").split("\n").forEach((l,i)=>{if(l.toLowerCase().includes(t))hl.push(i+1);});}}
  select(h.eid,{search:true,hl:hl&&hl.length?hl:null});
}

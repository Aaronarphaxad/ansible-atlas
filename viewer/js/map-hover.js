/* ==========================================================================
 * Hover preview card
 *
 * Resting the pointer on a map node for a moment shows a small card with the key facts
 * about it (hosts, variables, module, conditions …) without changing the details panel.
 * The card ignores the pointer, and it hides as soon as you move off, click, drag or zoom.
 * ========================================================================== */
const HOVER_DELAY_MS=450;
let hoverTimer=null;

// Show the card for node n after the pointer has rested on its <g> for a moment.
function attachHover(g,n){
  g.addEventListener("pointerenter",()=>{clearTimeout(hoverTimer);hoverTimer=setTimeout(()=>showHover(g,n),HOVER_DELAY_MS);});
  g.addEventListener("pointerleave",hideHover);
}

function hideHover(){clearTimeout(hoverTimer);const c=$("#hovercard");if(c)c.style.display="none";}

// The [label, value] rows shown for each entity type. Empty values are dropped later.
function hoverFacts(e,n){
  const len=a=>(a||[]).length;
  const list=v=>v==null?null:Array.isArray(v)?v.map(fmt).join(", "):fmt(v);   // ["a","b"] → "a, b"
  switch(e.type){
    case"host":return[["ansible_host",e.sub],["Groups",len(e.all_groups)],["Targeted by plays",len(e.plays)],["Variables",len(e.vars)],["Inventory",invName(e.inventory)]];
    case"group":return[["Hosts (incl. child groups)",len(e.all_hosts)],["Child groups",len(e.children)],["Parent groups",len(e.parents)],["Variables",len(e.vars)]];
    case"inventory":return[["Path",e.path],["Groups",e.counts.groups],["Hosts",e.counts.hosts],["Default in ansible.cfg",e.default?"yes":null]];
    case"playbook":{const plan=D.plans[e.id]||[];
      return[["Path",e.path],["Plays",plan.length],["Steps when run",plan.reduce((a,p)=>a+p.steps.length,0)],["Imported by",len(e.imported_by)||null]];}
    case"play":{const roles=(e.sections||[]).filter(s=>s.roles).flatMap(s=>s.roles);
      return[["Hosts",fmt(e.hosts)],["Roles",roles.length],["Become",e.become?"yes":null],["Gather facts",e.gather_facts===false?"no":null],["Tags",list(e.tags)]];}
    case"role":return[["Dependencies",len(e.deps)],["Tasks (main)",len(e.tasks)],["Handlers",len(e.handlers)],["Defaults",len(e.defaults)],["Used by",len(e.used_by)],["Note",e.external?"external role":null]];
    case"task":case"handler":case"include_role":case"import_role":case"include_tasks":case"import_tasks":case"block":
      return[["Module",e.module],["When",list(e.when)],["Loop",e.loop!=null?fmt(e.loop):null],["Tags",list(e.tags)],
        ["Notifies",list(e.notify)],["Saves result as",e.register],["Role",e.role]];
    case"section":return[["Items",e.count??n.kids.length]];
    default:return[["",ctxOf(e)]];
  }
}

// Fill the card for node n and place it just below (or above) the node, inside the map area.
function showHover(g,n){
  const card=$("#hovercard"),view=$("#view");
  if(!card||!g.isConnected||$("#graph").classList.contains("drag"))return;
  const e=ENT[n.e]||{type:"missing",label:n.e};
  const rows=hoverFacts(e,n).filter(([,v])=>v!=null&&v!=="");
  const checks=(FIND_BY_ENT.get(e.id)||[]).length;
  card.replaceChildren(...[            // replaceChildren() would print null as text, hence the filter
    el("div",{class:"hc-head"},badge(e.type),el("b",null,e.label)),
    e.desc||e.note?el("div",{class:"hc-desc"},short(e.desc||e.note,220)):null,
    rows.length?el("table",{class:"kv"},rows.map(([k,v])=>el("tr",null,k?el("td",null,k):null,el("td",{colspan:k?null:2},short(String(v),90))))):null,
    checks?el("div",{class:"hc-warn"},`⚠ ${checks} check${checks>1?"s":""} — open for details`):null,
    srcText(e)?el("div",{class:"src"},srcText(e)):null,
    el("div",{class:"note hc-hint"},"Click for details"+(n.kids.length?" · double-click to "+(VIEWS[current].expanded.has(n.key)?"collapse":"expand"):""))].filter(Boolean));
  // Measure while invisible, then position.
  card.style.visibility="hidden";card.style.display="block";
  const r=g.getBoundingClientRect(),vr=view.getBoundingClientRect(),cw=card.offsetWidth,ch=card.offsetHeight,gap=8;
  let left=r.left-vr.left,top=r.bottom-vr.top+gap;
  if(top+ch>vr.height-gap)top=r.top-vr.top-ch-gap;                  // no room below: show above
  left=Math.max(gap,Math.min(left,vr.width-cw-gap));
  top=Math.max(gap,top);
  card.style.left=left+"px";card.style.top=top+"px";card.style.visibility="";
}

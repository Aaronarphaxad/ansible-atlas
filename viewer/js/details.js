/* ==========================================================================
 * Details panel: selection and shared building blocks
 *
 * select() is the single entry point for "show this thing": it updates history, the map
 * highlight and the panel. The helpers here (sec, kvTable, varsTable, chips…) build panel
 * sections; RENDER in details-renderers.js decides which sections each entity type gets.
 * ========================================================================== */
// Select an entity: remember history, update the map highlight and render the details panel.
// opt.node: the exact map node clicked · opt.reveal / opt.search: expand the map to show it
// opt.hl: lines to highlight in a file · opt.focusVar: variable row to scroll to.
function select(eid,opt={}){
  const e=ENT[eid];if(!e)return;
  if(selected&&selected!==eid&&!opt.noHistory){history.push(selected);if(history.length>60)history.shift();}
  selected=eid;
  if(opt.node){selectedNode=opt.node;markSelected();}
  else if(opt.reveal||opt.search){
    let vname=(VIEWS[current]&&VIEWS[current].byEnt.has(eid))?current:homeView(e);
    if(vname&&(VIEWS[current]||opt.search||opt.switchView)){
      if(vname!==current){selectedNode=revealIn(vname,eid);setTab(vname);}else{selectedNode=revealIn(vname,eid);drawGraph();}
      if(selectedNode)centerOn(selectedNode);
    }
    markSelected();
  }
  renderDetail(e,opt);
  if(current==="plan")for(const s of document.querySelectorAll(".step"))s.classList.toggle("on",s.dataset.t===eid);
}

// Go back to the previously selected item.
function back(){if(!history.length)return;const id=history.pop();select(id,{reveal:true,noHistory:true});}

// A titled details-panel section. Returns null when it has no content, so empty sections vanish.
function sec(title,...kids){const k=kids.flat().filter(x=>x!=null&&x!==false);if(!k.length)return null;return el("div",{class:"dsec"},el("h3",null,title),...k);}
/* collapsed-by-default section for less important details */

// Like sec(), but collapsed by default (for less important details).
function fold(title,...kids){const k=kids.flat().filter(x=>x!=null&&x!==false);if(!k.length)return null;return el("details",{class:"dsec"},el("summary",null,el("h3",null,title)),...k);}

// Chips for variable names; each opens that variable.
function varChips(names,max=60){if(!names||!names.length)return null;const C=el("div",{class:"chips"});
  const add=l=>l.forEach(n=>C.append(el("span",{class:"chip mono",title:ctxOf(ENT["var:"+n]),onclick:()=>select("var:"+n)},n)));
  add(names.slice(0,max));if(names.length>max){const m=el("span",{class:"chip",onclick:()=>{m.remove();add(names.slice(max));}},`+${names.length-max} more`);C.append(m);}return C;}

// Two-column key/value table. Rows with empty values are dropped.
function kvTable(rows){rows=rows.filter(r=>r&&r[1]!=null&&r[1]!==""&&!(Array.isArray(r[1])&&!r[1].length));if(!rows.length)return null;
  return el("table",{class:"kv"},rows.map(([k,v])=>el("tr",null,el("td",null,k),el("td",null,v&&v.nodeType?v:valNode(v)))));}

// Vertical list of entity links, with a "+N more" expander.
function linkList(ids,max=60){if(!ids||!ids.length)return null;const L=el("div",{class:"lnklist"});
  ids.slice(0,max).forEach(i=>L.append(lnk(i)));if(ids.length>max){const more=el("a",{class:"lnk",onclick:()=>{more.remove();ids.slice(max).forEach(i=>L.append(lnk(i)));}},`+${ids.length-max} more…`);L.append(more);}return L;}

// Compact chips for entity ids (hosts, groups…), with a "+N more" expander.
function chips(ids,max=80){if(!ids||!ids.length)return null;const C=el("div",{class:"chips"});
  const add=list=>list.forEach(i=>C.append(el("span",{class:"chip",title:ctxOf(ENT[i]),onclick:()=>select(i,{reveal:true})},ENT[i]?ENT[i].label:i)));
  add(ids.slice(0,max));if(ids.length>max){const m=el("span",{class:"chip",onclick:()=>{m.remove();add(ids.slice(max));}},`+${ids.length-max} more`);C.append(m);}return C;}

// Variables table with source file, precedence layer and what each value overrides.
// Adds a filter box when there are many rows. opt.focus: highlight and scroll to that variable.
function varsTable(vars,opt={}){
  if(!vars||!vars.length)return el("div",{class:"empty"},"None");
  const wrap=el("div");const tbl=el("table",{class:"kv vars"});
  const rows=vars.map(v=>{
    const extra=[];
    if(v.layer)extra.push(el("div",{class:"src"},v.layer));
    extra.push(el("div",null,srcLink(v.src,v.line)));
    if(v.overridden&&v.overridden.length){
      const d=el("details",{class:"ovr"},el("summary",null,`overrides ${v.overridden.length} lower-precedence value${v.overridden.length>1?"s":""}`),
        ...v.overridden.slice().reverse().map(o=>el("div",null,el("s",null,short(fmt(o.v),60))," — ",o.layer||"",": ",o.src+(o.line?":"+o.line:""))));
      extra.push(d);
    }
    const key=ENT["var:"+v.k]?el("a",{class:"lnk",title:"Where is this variable defined and used?",onclick:()=>select("var:"+v.k)},v.k):v.k;
    const tr=el("tr",{"data-k":v.k},el("td",null,key),el("td",null,valNode(v.v),...extra));
    if(opt.focus&&v.k===opt.focus)tr.classList.add("hlrow");
    return tr;
  });
  tbl.append(...rows);
  if(vars.length>8){const f=el("input",{class:"vfilter",placeholder:`Filter ${vars.length} variables…`,oninput:e=>{const q=e.target.value.toLowerCase();
    rows.forEach((r,i)=>r.style.display=(vars[i].k.toLowerCase().includes(q)||fmt(vars[i].v).toLowerCase().includes(q))?"":"none");}});wrap.append(f);}
  wrap.append(tbl);
  if(opt.focus)setTimeout(()=>{const r=tbl.querySelector(".hlrow");if(r)r.scrollIntoView({block:"center"});},30);
  return wrap;
}

// Breadcrumbs showing where a task appears in the playbooks map (playbook › play › role …).
function appearsIn(eid){
  const out=[];const V=VIEWS.playbooks;
  for(const n of (V.byEnt.get(eid)||[]).slice(0,25)){
    const chain=[];let p=n.parent;while(p&&p.parent){const e=ENT[p.e];if(e&&["playbook","play","role","include_role","import_role"].includes(e.type))chain.unshift(p);p=p.parent;}
    out.push(el("div",{class:"path"},chain.length?chain.map((c,i)=>[i?" › ":"",lnk(c.e,short(ENT[c.e].label,40))]):"(top level)"));
  }
  return out.length?out:null;
}

// Fill the details panel for an entity: header, checks, then the type-specific sections from RENDER.
function renderDetail(e,opt={}){
  if(document.body.classList.contains("nodetail")&&!restoring&&opt.fromUser!==false&&booted)setDetailHidden(false);
  const d=$("#detail");d.replaceChildren();d.scrollTop=0;if(!["file","script","template"].includes(e.type))d.classList.remove("wide");
  const head=el("div",{class:"dh"},
    el("div",{class:"nav"},history.length?el("button",{class:"btn",onclick:back,title:"Back"},"←"):null,badge(e.type),
      el("span",{style:"flex:1"}),el("button",{class:"iconbtn",title:"Hide this panel (])","aria-label":"Hide details panel",onclick:()=>setDetailHidden(true)},"⇥"),(homeView(e)&&current!==homeView(e)&&!(VIEWS[current]&&VIEWS[current].byEnt.has(e.id)))?el("button",{class:"btn",onclick:()=>select(e.id,{reveal:true,switchView:true,noHistory:true})},"Show in map"):null),
    el("h2",null,e.label),
    e.src?el("div",{class:"crumbs mono"},srcLink(e.src,e.line)):(e.path&&e.type!=="playbook"&&e.type!=="file"?el("div",{class:"crumbs mono"},srcLink(e.path)):null));
  if(["file","script","template"].includes(e.type)){d.classList.add("wide");d.style.width="";}
  d.append(head);
  const fs=(e.type==="file"||e.type==="script")?(FIND_BY_SRC.get(e.path)||[]):(FIND_BY_ENT.get(e.id)||[]);
  if(fs.length)d.append(sec(`Checks (${fs.length})`,findingList(fs,{hideEnt:e.type!=="file"&&e.type!=="script"})));
  const R=RENDER[e.type]||RENDER.default;
  for(const s of R(e,opt))if(s)d.append(s);
  saveState();
}

// Task keywords shown in "Conditions & behaviour", with friendly names.
const T_KEYS=[["when","Runs when"],["loop","Loop"],["tags","Tags"],["register","Saves result as"],["become","Become (sudo)"],["become_user","Become user"],
  ["delegate_to","Delegated to"],["run_once","Run once"],["changed_when","Changed when"],["failed_when","Failed when"],["ignore_errors","Ignore errors"],
  ["until","Retry until"],["retries","Retries"],["delay","Delay"],["no_log","No log"],["check_mode","Check mode"],["async","Async"],["poll","Poll"],["throttle","Throttle"],["environment","Environment"],["loop_control","Loop control"]];

// Details sections shared by tasks, handlers and include_role.
function taskSections(e){
  const rows=T_KEYS.map(([k,n])=>[n,e[k]]);
  const out=[];
  out.push(sec("What it does",el("p",{class:"desc"},e.desc||"—"),
    e.module?el("div",{class:"note",style:"margin-top:6px"},"Module: ",el("code",null,e.module)):null,
    e.type==="handler"?el("div",{class:"note",style:"margin-top:6px"},"Handlers run once at the end of the current section, and only if a task that notified them reported ‘changed’."):null));
  out.push(sec("Conditions & behaviour",kvTable(rows)));
  if(e.template_ref)out.push(sec("Template",lnk(e.template_ref,ENT[e.template_ref].path)));
  if(e.script_refs)out.push(sec("Script",linkList(e.script_refs)));
  out.push(sec("Uses variables",varChips(USES_BY_OWNER.get(e.id))));
  if(e.notify_ids)out.push(sec("Notifies handlers",...Object.entries(e.notify_ids).map(([n,ids])=>ids.length?linkList(ids):el("div",{class:"warnbox"},`No handler named “${n}” was found.`))));
  if(e.notified_by)out.push(sec("Notified by",linkList(e.notified_by)));
  if(e.listen)out.push(sec("Also listens for",el("div",null,[].concat(e.listen).map(x=>el("span",{class:"pill"},x)))));
  if(e.args&&Object.keys(e.args).length)out.push(sec("Module arguments",kvTable(Object.entries(e.args).map(([k,v])=>[k==="_raw_params"?"(free-form)":k,v]))));
  if(e.vars)out.push(fold("Task vars",kvTable(Object.entries(e.vars))));
  return out;
}

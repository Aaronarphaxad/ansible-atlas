/* ==========================================================================
 * Startup
 *
 * Runs last, after every component above has been defined.
 * ========================================================================== */
// Start the app: build the three map views and indexes, wire up the header, search,
// keyboard shortcuts and panel resizer, then restore the previous state or show the default view.
function boot(){
  if(!D){document.body.replaceChildren(el("p",{style:"padding:20px"},"No data embedded. Generate this page with atlas.py."));return;}
  $("#repoName").textContent=D.meta.repo;document.title="Ansible Atlas — "+D.meta.repo;
  buildView("playbooks",D.trees.playbooks,1);
  buildView("roles",D.trees.roles,1);
  buildView("inventory",D.trees.inventory,1);
  $("#themeBtn").addEventListener("click",toggleTheme);
  $("#helpBtn").addEventListener("click",showShortcuts);
  $("#showDetail").addEventListener("click",()=>setDetailHidden(false));
  try{if(localStorage.getItem("atlas-detail-hidden")==="1")document.body.classList.add("nodetail");
    const w=localStorage.getItem("atlas-detail-width");if(w)$("#detail").style.width=w;}catch(_){}
  const tabs=$("#tabs");TABS.forEach(([k,n],i)=>tabs.append(el("button",{"data-t":k,title:`${n} (${i+1})`,onclick:()=>setTab(k)},n)));
  for(const[p,f]of Object.entries(D.files||{}))ENT["file:"+p]={id:"file:"+p,type:"file",label:p.split("/").pop(),path:p,kind:f.kind};
  for(const e of Object.values(ENT)){if(e.src&&e.type!=="section"){if(!ENTS_BY_SRC.has(e.src))ENTS_BY_SRC.set(e.src,[]);ENTS_BY_SRC.get(e.src).push(e.id);}
    if((e.type==="template"||e.type==="script")&&e.path)SPECIAL_BY_PATH.set(e.path,e.id);}
  indexFindings();
  buildIndex();
  const q=$("#q");
  q.addEventListener("input",()=>doSearch(q.value));
  q.addEventListener("focus",()=>{if(q.value.trim())doSearch(q.value);});
  q.addEventListener("blur",()=>setTimeout(()=>$("#results").classList.remove("open"),120));
  q.addEventListener("keydown",e=>{
    const rs=[...document.querySelectorAll(".res")];
    if(e.key==="ArrowDown"||e.key==="ArrowUp"){e.preventDefault();hi=Math.max(0,Math.min(rs.length-1,hi+(e.key==="ArrowDown"?1:-1)));rs.forEach((r,i)=>r.classList.toggle("on",i===hi));rs[hi]?.scrollIntoView({block:"nearest"});}
    else if(e.key==="Enter"){e.preventDefault();pick(hi);}
    else if(e.key==="Escape"){q.value="";doSearch("");q.blur();}
  });
  document.addEventListener("keydown",e=>{
    if(e.key==="Escape"){
      const ov=document.querySelector(".overlay"),menus=document.querySelectorAll("details.menu[open]");
      const typing=["INPUT","SELECT","TEXTAREA"].includes(e.target.tagName);
      if(ov)ov.remove();menus.forEach(m=>m.open=false);
      if(!ov&&!menus.length&&!typing&&searchHits.size)clearSearch();   // Esc on the map clears search tinting
      hideHover();
    }
    if(e.target.tagName==="INPUT"||e.target.tagName==="SELECT"||e.target.tagName==="TEXTAREA")return;
    if(e.metaKey||e.ctrlKey)return;
    if(handleMapKey(e))return;                                         // arrows / Enter / Space on a map
    if((e.key==="n"||e.key==="N")&&VIEWS[current]&&searchHits.size&&!document.querySelector(".overlay")){stepMatch(e.shiftKey?-1:1);return;}
    if(e.altKey&&e.key==="ArrowLeft"&&history.length){e.preventDefault();back();return;}
    if(/^[1-6]$/.test(e.key)&&!e.altKey){setTab(TABS[+e.key-1][0]);return;}
    if(e.key==="?"){e.preventDefault();showShortcuts();return;}
    if(e.key==="]"){setDetailHidden(!document.body.classList.contains("nodetail"));return;}
    if(e.key==="/"){e.preventDefault();q.focus();q.select();}
    else if((e.key==="f"||e.key==="F")&&VIEWS[current])fit();
    else if(e.key==="t"||e.key==="T")toggleTheme();
    else if(e.key==="Backspace"&&history.length){e.preventDefault();back();}
  });
  // resizable detail panel
  const rz=$("#resizer"),det=$("#detail");
  rz.addEventListener("pointerdown",e=>{rz.setPointerCapture(e.pointerId);const sx=e.clientX,sw=det.offsetWidth;
    const mv=ev=>{det.style.width=Math.max(280,Math.min(window.innerWidth*0.7,sw-(ev.clientX-sx)))+"px";};
    const up=()=>{rz.removeEventListener("pointermove",mv);rz.removeEventListener("pointerup",up);try{localStorage.setItem("atlas-detail-width",det.style.width);}catch(_){}};
    rz.addEventListener("pointermove",mv);rz.addEventListener("pointerup",up);});
  window.addEventListener("resize",()=>{if(VIEWS[current])applyTransform();});
  window.addEventListener("pagehide",saveState);
  document.addEventListener("visibilitychange",()=>{if(document.hidden)saveState();});
  setupLive();
  const st=loadState();
  if(st&&restoreState(st)){booted=true;return;}
  if(!st)setTab("playbooks");
  const firstPb=VIEWS.playbooks.root.kids[0];
  renderDetail(firstPb?ENT[firstPb.e]:ENT["root:playbooks"]);if(firstPb){selected=firstPb.e;selectedNode=firstPb;markSelected();}
  booted=true;
}
boot();

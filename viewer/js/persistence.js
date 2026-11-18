/* ==========================================================================
 * Remember where you were
 *
 * Survives refreshes and --watch live reloads (sessionStorage, so it's per browser tab).
 * ========================================================================== */
let booted=false;
const STATE_KEY="atlas-state:"+(D?D.meta.repo_path:"");
let restoring=false;

// Save tab, selection, zoom and expanded nodes to sessionStorage.
function saveState(){
  if(restoring||!D)return;
  try{
    const views={};for(const[k,V]of Object.entries(VIEWS))views[k]={tx:V.tx,ty:V.ty,k:V.k,exp:[...V.expanded]};
    sessionStorage.setItem(STATE_KEY,JSON.stringify({tab:current,sel:selected,selKey:selectedNode&&selectedNode.key,plan:planState,files:fileState,views,
      scroll:$("#detail").scrollTop,pageScroll:(document.querySelector(".page")||{}).scrollTop||0}));
  }catch(_){}
}

// Read the saved state (or null).
function loadState(){try{return JSON.parse(sessionStorage.getItem(STATE_KEY)||"null");}catch(_){return null;}}

// Restore a saved state. Returns true if something was selected.
function restoreState(st){
  restoring=true;
  try{
    for(const[k,v]of Object.entries(st.views||{})){const V=VIEWS[k];if(!V)continue;
      const keys=new Set(V.nodes.map(n=>n.key));V.expanded=new Set((v.exp||[]).filter(x=>keys.has(x)));V.tx=v.tx;V.ty=v.ty;V.k=v.k;V.fitted=true;}
    Object.assign(planState,st.plan||{});Object.assign(fileState,st.files||{});
    setTab(TABS.some(t=>t[0]===st.tab)?st.tab:"playbooks");
    if(st.sel&&ENT[st.sel]){selected=st.sel;const V=VIEWS[current];selectedNode=V?(V.nodes.find(n=>n.key===st.selKey&&n.e===st.sel)||null):null;
      renderDetail(ENT[st.sel]);markSelected();$("#detail").scrollTop=st.scroll||0;}
    const pg=document.querySelector(".page");if(pg)pg.scrollTop=st.pageScroll||0;
  }finally{restoring=false;}
  return !!st.sel;
}
let lastInput=Date.now();

// --watch mode: reload the page periodically to pick up rebuilds, but never while you're interacting.
function setupLive(){
  const w=D.meta.watch;if(!w)return;
  let on=true;try{on=sessionStorage.getItem("atlas-live")!=="off";}catch(_){}
  const b=el("button",{class:"live"+(on?" on":""),title:"This map was generated with --watch. While on, the page reloads to pick up changes and keeps your place."});
  const label=()=>{b.textContent=(on?"● Live":"○ Live paused")+" · "+D.meta.generated.slice(11,19);b.classList.toggle("on",on);};
  b.onclick=()=>{on=!on;try{sessionStorage.setItem("atlas-live",on?"on":"off");}catch(_){}label();};
  label();$("header").insertBefore(b,$("#themeBtn"));
  for(const ev of ["pointerdown","keydown","wheel"])document.addEventListener(ev,()=>{lastInput=Date.now();},{passive:true});
  const every=Math.max(3,(w.interval||2)*2)*1000;
  setInterval(()=>{
    if(!on||document.hidden)return;
    if(Date.now()-lastInput<4000)return;                          // don't interrupt while you're interacting
    if(document.activeElement&&["INPUT","SELECT","TEXTAREA"].includes(document.activeElement.tagName))return;
    if(document.querySelector("details.menu[open]"))return;
    saveState();location.reload();
  },every);
}

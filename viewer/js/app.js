/* ==========================================================================
 * App state and tabs
 *
 * Global UI state shared by every component.
 * ========================================================================== */
let current="playbooks",selected=null,history=[],searchHits=new Set();
const ENTS_BY_SRC=new Map(),SPECIAL_BY_PATH=new Map();
const TABS=[["playbooks","Playbooks"],["roles","Roles"],["inventory","Inventory"],["plan","Run plan"],["files","Files"],["overview","Overview"]];
let planState={pb:null,inv:null,filter:""};

// Switch the main area to a tab and re-render it.
function setTab(t){
  current=t;
  for(const b of document.querySelectorAll("#tabs button"))b.classList.toggle("on",b.dataset.t===t);
  const v=$("#view");v.replaceChildren();
  if(VIEWS[t])renderGraphView(); else if(t==="plan")renderPlan(); else if(t==="files")renderFiles(); else renderOverview();
  saveState();
}

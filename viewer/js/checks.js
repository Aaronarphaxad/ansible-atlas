/* ==========================================================================
 * Checks (lint findings)
 *
 * Findings come precomputed from atlas.py (D.findings). This file indexes and renders them.
 * ========================================================================== */
// Lint findings looked up by entity id and by source file path.
const FIND_BY_ENT=new Map(),FIND_BY_SRC=new Map();

// Index lint findings by entity id and by source file, for quick lookups.
function indexFindings(){
  for(const f of D.findings||[]){
    if(f.e){if(!FIND_BY_ENT.has(f.e))FIND_BY_ENT.set(f.e,[]);FIND_BY_ENT.get(f.e).push(f);}
    if(f.src){if(!FIND_BY_SRC.has(f.src))FIND_BY_SRC.set(f.src,[]);FIND_BY_SRC.get(f.src).push(f);}
  }
}

// Render a list of findings with severity, message and source link.
function findingList(fs,opt={}){
  return el("div",null,fs.slice(0,opt.max||500).map(f=>el("div",{class:"finding"},el("span",{class:"sev "+f.sev},f.sev),
    el("div",{class:"fm"},el("div",null,f.msg),
      el("div",{class:"note"},opt.showRule?el("span",{class:"pill"},f.rule):null,!opt.hideEnt&&f.e&&ENT[f.e]?lnk(f.e):null," ",srcLink(f.src,f.line))))),
    fs.length>(opt.max||500)?el("div",{class:"note"},`… and ${fs.length-(opt.max||500)} more (run atlas.py --lint for the full list)`):null);
}

// The Overview's checks panel, grouped by rule with severity filter chips.
function checksBox(){
  const fs=D.findings||[];
  if(!fs.length)return el("div",{class:"box note"},"✓ No issues found.");
  const box=el("div");
  const counts={error:0,warning:0,info:0};fs.forEach(f=>counts[f.sev]++);
  const show=new Set(["error","warning"]);
  const body=el("div");
  const draw=()=>{
    body.replaceChildren();
    const byRule=new Map();
    for(const f of fs){if(!show.has(f.sev))continue;if(!byRule.has(f.rule))byRule.set(f.rule,[]);byRule.get(f.rule).push(f);}
    if(!byRule.size)body.append(el("div",{class:"note"},"Nothing at these levels."));
    for(const[rule,list]of byRule){
      const [sev,desc]=(D.rules||{})[rule]||[list[0].sev,rule];
      body.append(el("details",{class:"box",open:sev!=="info"?"":null},
        el("summary",{style:"cursor:pointer;display:flex;gap:8px;align-items:center"},el("span",{class:"sev "+sev},sev),el("b",null,desc),el("span",{class:"note"},`${rule} · ${list.length}`)),
        el("div",{style:"margin-top:6px"},findingList(list))));
    }
  };
  const chip=k=>{const c=el("span",{class:"chip"+(show.has(k)?" on":""),onclick:()=>{show.has(k)?show.delete(k):show.add(k);c.classList.toggle("on");draw();}},`${counts[k]} ${k}${counts[k]===1||k==="info"?"":"s"}`);return c;};
  box.append(el("div",{class:"chips",style:"margin-bottom:8px"},chip("error"),chip("warning"),chip("info")),body);
  draw();return box;
}

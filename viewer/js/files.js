/* ==========================================================================
 * Files tab
 *
 *
 * ========================================================================== */
// Human-readable file size.
const fmtSize=n=>n<1024?n+" B":n<1048576?(n/1024).toFixed(1)+" KB":(n/1048576).toFixed(1)+" MB";

// Files tab filters (kept across refreshes).
const fileState={q:"",only:"all"};

// The Files tab: folder tree (or flat filtered list) of every file, plus a Scripts view.
function renderFiles(){
  const view=$("#view");const page=el("div",{class:"page"});view.append(page);
  const paths=Object.keys(D.files||{}).sort();
  const scripts=Object.values(ENT).filter(e=>e.type==="script").sort((a,b)=>a.path.localeCompare(b.path));
  const KINDS=[["all","All"],["script",`Scripts (${scripts.length})`],["playbook","Playbooks"],["tasks","Tasks"],["template","Templates"],["vars","Vars"],["inventory","Inventory"]];
  const q=el("input",{type:"search",placeholder:`Filter ${paths.length} files…`,value:fileState.q,oninput:e=>{fileState.q=e.target.value;draw();}});
  const chipsBox=el("div",{class:"chips"});
  page.append(el("h1",null,"Files"),el("p",{class:"note"},"Every file in the repo. Click one to read it; secret-looking values are masked."+(D.meta.redacted?"":" (Redaction is OFF for this map.)")),
    el("div",{class:"filesbar"},q,chipsBox));
  const body=el("div",{class:"ftree"});page.append(body);
  function draw(){
    chipsBox.replaceChildren(...KINDS.map(([k,n])=>el("span",{class:"chip"+(fileState.only===k?" on":""),onclick:()=>{fileState.only=k;draw();}},n)));
    body.replaceChildren();
    const qq=fileState.q.toLowerCase();
    if(fileState.only==="script"){
      if(!scripts.length){body.append(el("p",{class:"empty"},"No scripts found (.sh, .bash, .ps1, files with a #! line, or .py/.pl/.rb in scripts/, bin/ or files/)."));return;}
      for(const sc of scripts.filter(x=>!qq||x.path.toLowerCase().includes(qq)))
        body.append(el("div",{class:"scriptcard",onclick:()=>select(sc.id,{})},
          el("div",{style:"display:flex;gap:8px;align-items:center"},badge("script"),el("b",{class:"mono"},sc.path),el("span",{class:"pill"},sc.interpreter)),
          el("div",{class:"note",style:"margin-top:4px"},sc.summary.join(" · ")+(sc.refs.length?` · ${sc.refs.length} task reference(s)`:""))));
      return;
    }
    const list=paths.filter(p=>(fileState.only==="all"||D.files[p].kind===fileState.only)&&(!qq||p.toLowerCase().includes(qq)));
    if(!list.length){body.append(el("p",{class:"empty"},"No matching files."));return;}
    const flat=qq||fileState.only!=="all";
    const row=p=>{const f=D.files[p];return el("div",{class:"frow"+(selected==="file:"+p?" on":""),onclick:()=>select("file:"+p,{})},
      el("span",{class:"fn mono"},flat?p:p.split("/").pop()),f.kind?el("span",{class:"fk"},f.kind):null,f.encrypted?el("span",{class:"fk"},"🔒"):null,el("span",{class:"fs"},fmtSize(f.size||0)));};
    if(flat){list.forEach(p=>body.append(row(p)));return;}
    // folder tree
    const tree={dirs:{},files:[]};
    for(const p of list){const parts=p.split("/");let n=tree;for(const d of parts.slice(0,-1))n=n.dirs[d]=n.dirs[d]||{dirs:{},files:[]};n.files.push(p);}
    const render=(n,host)=>{
      for(const d of Object.keys(n.dirs).sort()){const det=el("details",null,el("summary",null,d+"/"));render(n.dirs[d],det);host.append(det);}
      n.files.forEach(p=>host.append(row(p)));
    };
    render(tree,body);
  }
  draw();
}

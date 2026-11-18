/* ==========================================================================
 * Compare two hosts
 *
 * Side-by-side view of two hosts' merged inventory variables, groups and plays, with the
 * differences highlighted. Opened from the "Compare" section of a host's details panel,
 * which also suggests a likely counterpart (e.g. the staging twin of a production host).
 *
 * Variables are compared by their winning (merged) value. Redacted and vault-encrypted
 * values can't be compared, so they're marked "hidden" rather than shown as equal.
 * ========================================================================== */
const ENV_WORDS=/(production|prod|staging|stage|stg|preprod|development|dev|testing|test|qa|uat|sandbox)/gi;

// "engeai-production-mongodb" → "engeai-mongodb": a name with environment words removed.
const envless=s=>String(s).toLowerCase().replace(ENV_WORDS,"").replace(/[-_.]+/g,"-").replace(/^-+|-+$/g,"");

const allHosts=()=>Object.values(ENT).filter(e=>e.type==="host");

// Overlap of two sets, 0..1.
function jaccard(a,b){if(!a.size&&!b.size)return 0;let n=0;for(const x of a)if(b.has(x))n++;return n/(a.size+b.size-n);}

// Best guess at the host you'd want to compare h with: same name or same groups once
// environment words are stripped, but not simply an identical twin in the same groups.
function suggestPartner(h){
  const groupNames=x=>new Set((x.all_groups||[]).map(g=>ENT[g]?.label||g).filter(l=>l!=="all"));
  const raw=groupNames(h),norm=new Set([...raw].map(envless));
  let best=null,bestScore=-1;
  for(const o of allHosts()){
    if(o.id===h.id)continue;
    const oRaw=groupNames(o),oNorm=new Set([...oRaw].map(envless));
    const score=(envless(o.label)===envless(h.label)&&o.label!==h.label?2:0)
      +jaccard(norm,oNorm)-0.5*jaccard(raw,oRaw)+(o.inventory===h.inventory?0.05:0);
    if(score>bestScore){best=o;bestScore=score;}
  }
  return best;
}

// <select> of every host, grouped by inventory when there's more than one.
function hostSelect(selectedId,onchange){
  const byInv=new Map();
  for(const h of allHosts().sort((a,b)=>a.label.localeCompare(b.label))){
    if(!byInv.has(h.inventory))byInv.set(h.inventory,[]);byInv.get(h.inventory).push(h);
  }
  const opt=h=>el("option",{value:h.id,selected:h.id===selectedId?"":null},h.label);
  const s=el("select",{class:"cmp-sel",onchange:e=>onchange(e.target.value)},
    byInv.size>1?[...byInv].map(([inv,hs])=>el("optgroup",{label:invName(inv)},hs.map(opt))):[...byInv.values()].flat().map(opt));
  return s;
}

// Details-panel section for a host: pick another host and open the comparison.
function compareSection(h){
  if(allHosts().length<2)return null;
  let other=suggestPartner(h)?.id;
  const pick=hostSelect(other,v=>{other=v;});
  return sec("Compare",el("div",{class:"cmp-row"},el("span",{class:"note"},"with"),pick,
    el("button",{class:"btn",onclick:()=>openCompare(h.id,other)},"Compare")));
}

const isHidden=v=>typeof v==="string"&&(v.startsWith("•••• redacted")||v.startsWith("<vault encrypted"));

// Classify every variable of hosts a and b: "diff", "a" (only on A), "b" (only on B), "same" or "hidden".
function diffVars(a,b){
  const A=new Map((a.vars||[]).map(v=>[v.k,v])),B=new Map((b.vars||[]).map(v=>[v.k,v]));
  const keys=[...new Set([...A.keys(),...B.keys()])].sort();
  return keys.map(k=>{
    const va=A.get(k),vb=B.get(k);
    let status;
    if(!va)status="b";else if(!vb)status="a";
    else if(isHidden(va.v)||isHidden(vb.v))status="hidden";
    else status=JSON.stringify(va.v)===JSON.stringify(vb.v)?"same":"diff";
    return {k,a:va,b:vb,status};
  });
}

// The comparison overlay. Both hosts can be changed in place; Esc or a click outside closes it.
function openCompare(aId,bId){
  document.querySelector(".overlay")?.remove();
  const st={a:aId,b:bId,onlyDiff:true,q:""};
  const body=el("div");
  const sheet=el("div",{class:"sheet wide",role:"dialog","aria-label":"Compare hosts"});
  const ov=el("div",{class:"overlay",onclick:e=>{if(e.target===ov)ov.remove();}},sheet);
  // Following any link inside the comparison closes it, so you land on the thing you clicked.
  sheet.addEventListener("click",e=>{if(e.target.closest(".lnk,.srclink,.chip"))setTimeout(()=>ov.remove(),0);});

  const cell=v=>v?el("td",null,valNode(v.v),el("div",{class:"src"},v.layer?v.layer+" · ":"",srcLink(v.src,v.line))):el("td",{class:"empty"},"— not set");
  // Ids in x whose name isn't in y. Compared by name, because the same group in two
  // inventories has two different ids (group:<inventory>:web).
  const setDiff=(x,y)=>{const names=new Set([...y].map(i=>ENT[i]?.label??i));return [...x].filter(i=>!names.has(ENT[i]?.label??i));};

  function draw(){
    const a=ENT[st.a],b=ENT[st.b];
    const rows=diffVars(a,b);
    const n={diff:0,a:0,b:0,same:0,hidden:0};rows.forEach(r=>n[r.status]++);
    const q=st.q.toLowerCase();
    const shown=rows.filter(r=>(!st.onlyDiff||r.status!=="same")&&(!q||r.k.toLowerCase().includes(q)));
    const LABEL={diff:"differs",a:"only A",b:"only B",same:"same",hidden:"hidden"};
    const gA=new Set(a.all_groups||[]),gB=new Set(b.all_groups||[]);
    const pA=new Set(a.plays||[]),pB=new Set(b.plays||[]);
    const listRow=(title,x,y)=>{const onlyA=setDiff(x,y),onlyB=setDiff(y,x);
      return el("tr",null,el("td",null,title),el("td",null,onlyA.length?chips(onlyA):el("span",{class:"empty"},"—")),el("td",null,onlyB.length?chips(onlyB):el("span",{class:"empty"},"—")));};
    body.replaceChildren(
      el("p",{class:"sumline"},el("b",null,n.diff)," differ · ",el("b",null,n.a)," only on A · ",el("b",null,n.b)," only on B · ",
        el("b",null,n.same)," the same",n.hidden?[" · ",el("b",null,n.hidden)," hidden (redacted or vault)"]:""),
      el("h3",{class:"cmp-h"},"Groups and plays that differ"),
      el("table",{class:"cmp"},el("tr",null,el("th",null,""),el("th",null,"Only A"),el("th",null,"Only B")),
        listRow("Groups",gA,gB),listRow("Plays",pA,pB)),
      el("h3",{class:"cmp-h"},`Variables (${shown.length} shown)`),
      shown.length?el("table",{class:"cmp"},
        el("tr",null,el("th",null,"Variable"),el("th",null,"A · "+a.label),el("th",null,"B · "+b.label)),
        shown.map(r=>el("tr",{class:"st-"+r.status},
          el("td",null,ENT["var:"+r.k]?lnk("var:"+r.k,r.k):r.k,el("div",null,el("span",{class:"pill"},LABEL[r.status]))),
          cell(r.a),cell(r.b)))):el("p",{class:"empty"},st.onlyDiff?"No differences.":"No variables."));
  }

  const swap=el("button",{class:"btn",title:"Swap A and B",onclick:()=>{[st.a,st.b]=[st.b,st.a];rebuild();}},"⇄");
  const onlyDiff=el("input",{type:"checkbox",checked:"",onchange:e=>{st.onlyDiff=e.target.checked;draw();}});
  const filter=el("input",{type:"search",class:"vfilter",placeholder:"Filter variables…",oninput:e=>{st.q=e.target.value;draw();}});
  function rebuild(){
    sheet.replaceChildren(
      el("div",{class:"cmp-top"},el("h2",null,"Compare hosts"),el("span",{style:"flex:1"}),
        el("button",{class:"iconbtn",title:"Close (Esc)","aria-label":"Close",onclick:()=>ov.remove()},"✕")),
      el("div",{class:"cmp-row"},el("b",null,"A"),hostSelect(st.a,v=>{st.a=v;draw();}),swap,el("b",null,"B"),hostSelect(st.b,v=>{st.b=v;draw();})),
      el("div",{class:"cmp-row"},el("label",{class:"note",style:"display:flex;gap:6px;align-items:center"},onlyDiff,"Differences only"),filter),
      body,
      el("p",{class:"note"},"Merged inventory values (group vars → group_vars → host vars → host_vars). Play vars, role vars, facts and --extra-vars can still change them at runtime."));
    draw();
  }
  rebuild();
  document.body.append(ov);
}

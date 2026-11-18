/* ==========================================================================
 * Run plan tab
 *
 * Shows what ansible-playbook would do, step by step, for a playbook and inventory, and
 * previews --tags, --skip-tags and --limit. The step list itself comes from D.plans.
 * ========================================================================== */
// "a, b c" → ["a","b","c"]
const splitList=s=>String(s||"").split(/[,\s]+/).map(x=>x.trim()).filter(Boolean);
/* Ansible --tags / --skip-tags semantics, incl. the special tags always, never, tagged, untagged, all */

// Would a task with these tags run under --tags T and --skip-tags S? (Ansible's rules,
// including the special tags always, never, tagged, untagged and all.)
function tagSelected(tags,T,S){
  const has=t=>tags.includes(t);
  const m=t=>t==="all"?true:t==="tagged"?tags.length>0:t==="untagged"?tags.length===0:has(t);
  let run;
  if(!T.length)run=!has("never");
  else run=T.some(t=>t==="all"?!has("never"):m(t));
  if(has("always")&&!S.includes("always"))run=true;
  if(S.length&&S.some(t=>t==="always"?has("always"):m(t)))run=false;
  return run;
}

// Which steps (and handlers) of one play run for the given tags.
function selectSteps(P,T,S){
  const st=P.steps,n=st.length,sel=st.map(x=>tagSelected(x.tags||[],T,S));
  for(let i=0;i<n;i++){const g=st[i].gate;if(g!=null&&!sel[g])sel[i]=false;}
  // blocks and static imports are containers: shown when anything inside runs
  for(let i=n-1;i>=0;i--){const t=ENT[st[i].t]?.type;
    if(t==="block"||t==="import_tasks"||t==="import_role"){let any=false;for(let j=i+1;j<n&&st[j].depth>st[i].depth;j++)if(sel[j]){any=true;break;}sel[i]=any;}}
  const hsel=P.handlers.map(h=>(h.notified_by_steps||[]).some(i=>sel[i]));
  return {sel,hsel};
}
/* host pattern resolution for --limit, mirroring the parser's resolver */

// Resolve a --limit pattern to host ids for one inventory (groups, globs, ~regex, &, !).
function resolveLimit(inv,pattern){
  const toks=String(pattern).split(/[,:](?![^\[]*\])/).map(t=>t.trim()).filter(Boolean);
  const hostsOf=Object.values(ENT).filter(e=>e.type==="host"&&e.inventory===inv);
  const all=new Set(hostsOf.map(h=>h.id));
  const groupHosts=g=>new Set(ENT[`group:${inv}:${g}`]?.all_hosts||[]);
  const glob=t=>new RegExp("^"+t.replace(/[.+^${}()|\\]/g,"\\$&").replace(/\*/g,".*").replace(/\?/g,".")+"$");
  const match=t=>{
    if(t==="all"||t==="*")return new Set(all);
    if(ENT[`group:${inv}:${t}`])return groupHosts(t);
    let rx=null;try{rx=t.startsWith("~")?new RegExp(t.slice(1)):(/[*?[]/.test(t)?glob(t):null);}catch(_){return new Set();}
    if(rx){const out=new Set(hostsOf.filter(h=>rx.test(h.label)).map(h=>h.id));
      for(const g of Object.values(ENT))if(g.type==="group"&&g.inventory===inv&&rx.test(g.label))for(const h of g.all_hosts)out.add(h);return out;}
    return ENT[`host:${inv}:${t}`]?new Set([`host:${inv}:${t}`]):new Set();
  };
  let res=new Set();
  for(const t of toks)if(!/^[&!]/.test(t))for(const h of match(t))res.add(h);
  for(const t of toks)if(t.startsWith("&")){const m=match(t.slice(1));res=new Set([...res].filter(h=>m.has(h)));}
  for(const t of toks)if(t.startsWith("!")){const m=match(t.slice(1));for(const h of m)res.delete(h);}
  return res;
}

// The Run plan tab: the flattened, numbered execution order of a playbook.
function renderPlan(){
  const view=$("#view");const page=el("div",{class:"page"});view.append(page);
  const pbs=Object.keys(D.plans).sort((a,b)=>(ENT[b].root-ENT[a].root)||a.localeCompare(b));
  if(!pbs.length){page.append(el("h1",null,"Run plan"),el("p",{class:"empty"},"No playbooks found."));return;}
  if(!planState.pb||!D.plans[planState.pb])planState.pb=pbs.find(p=>/(^|\/)site\.ya?ml$/.test(p))||pbs[0];
  const invs=Object.values(ENT).filter(e=>e.type==="inventory").sort((a,b)=>(b.default-a.default)||a.label.localeCompare(b.label));
  if(!planState.inv&&invs.length)planState.inv=invs[0].id;
  for(const k of ["tags","skip","limit"])planState[k]=planState[k]||"";
  const plan=D.plans[planState.pb];
  const pbSel=el("select",{onchange:e=>{planState.pb=e.target.value;planState.focusPlay=null;setTab("plan");}},pbs.map(p=>el("option",{value:p,selected:p===planState.pb?"":null},ENT[p].label+(ENT[p].root?"":"  (imported)"))));
  const invSel=el("select",{onchange:e=>{planState.inv=e.target.value;draw();}},invs.map(i=>el("option",{value:i.id,selected:i.id===planState.inv?"":null},i.label+(i.default?" (default)":""))));
  const flt=el("input",{type:"search",placeholder:"Find a step…",value:planState.filter,oninput:e=>{planState.filter=e.target.value;applyText();}});
  const activeCount=()=>["tags","skip","limit"].filter(k=>planState[k].trim()).length;
  const fbtn=el("button",{class:"btn"});
  const setFbtn=()=>{const n=activeCount();fbtn.textContent=(planState.showFilters?"▾ ":"▸ ")+"Tags & limit"+(n?` (${n} active)`:"");};
  fbtn.onclick=()=>{planState.showFilters=!planState.showFilters;panel.style.display=planState.showFilters?"":"none";setFbtn();};
  // filters panel (hidden until asked for)
  const allTags=[...new Set([...plan.flatMap(P=>[...P.steps,...P.handlers].flatMap(s=>s.tags||[]))])].sort();
  const inTags=el("input",{type:"text",placeholder:"e.g. config,packages",value:planState.tags,oninput:e=>{planState.tags=e.target.value;draw();}});
  const inSkip=el("input",{type:"text",placeholder:"e.g. firewall",value:planState.skip,oninput:e=>{planState.skip=e.target.value;draw();}});
  const inLimit=el("input",{type:"text",placeholder:"e.g. web:!web02",value:planState.limit,oninput:e=>{planState.limit=e.target.value;draw();}});
  const showSkipped=el("input",{type:"checkbox",checked:planState.showSkipped?"":null,onchange:e=>{planState.showSkipped=e.target.checked;draw();}});
  const tagChips=el("div",{class:"chips"});
  const cmd=el("code");
  const copyBtn=el("button",{class:"btn",onclick:()=>{try{navigator.clipboard.writeText(cmd.textContent);copyBtn.textContent="Copied";setTimeout(()=>copyBtn.textContent="Copy",1200);}catch(_){const r=document.createRange();r.selectNodeContents(cmd);getSelection().removeAllRanges();getSelection().addRange(r);}}},"Copy");
  const panel=el("div",{class:"filters",style:planState.showFilters?"":"display:none"},
    el("div",{class:"row"},el("label",null,"--tags",inTags),el("label",null,"--skip-tags",inSkip),el("label",null,"--limit",inLimit),
      el("label",{style:"flex-direction:row;align-items:center;gap:6px"},showSkipped,"show skipped steps"),
      el("button",{class:"btn",onclick:()=>{planState.tags=planState.skip=planState.limit="";inTags.value=inSkip.value=inLimit.value="";draw();}},"Clear")),
    allTags.length?el("div",null,el("div",{class:"note",style:"margin-bottom:4px"},"Tags used in this playbook (click: add to --tags · shift-click: add to --skip-tags)"),tagChips):el("div",{class:"note"},"This playbook uses no tags."));
  const toggleIn=(field,input,t)=>{const l=splitList(planState[field]);const i=l.indexOf(t);if(i>=0)l.splice(i,1);else l.push(t);planState[field]=l.join(",");input.value=planState[field];draw();};
  page.append(el("h1",null,"What happens when you run it"),
    el("p",{class:"note"},"Steps in the order Ansible runs them. Imported playbooks are followed, role dependencies run before the role, and blocks and includes are expanded. ",el("span",{class:"cond"},"when"),"-conditions can still skip steps at runtime."),
    el("div",{class:"planbar"},el("label",null,"Playbook",pbSel),invs.length?el("label",null,"Inventory",invSel):null,fbtn,el("label",null,flt),
      el("button",{class:"btn",onclick:()=>select(planState.pb,{})},"Playbook details")),
    el("div",{class:"cmd",style:"margin:-4px 0 12px"},el("span",{class:"note",style:"white-space:nowrap"},"Command"),cmd,copyBtn),
    panel);
  const sum=el("p",{class:"sumline"});page.append(sum);
  const body=el("div");page.append(body);
  let stepEls=[];
  function applyText(){const q=planState.filter.toLowerCase();stepEls.forEach(r=>{if(r._hidden)return;r.style.display=!q||r._text.includes(q)?"":"none";});}
  function draw(){
    setFbtn();
    const T=splitList(planState.tags),S=splitList(planState.skip),L=planState.limit.trim();
    tagChips.replaceChildren(...allTags.map(t=>el("span",{class:"chip"+(T.includes(t)?" on":"")+(S.includes(t)?" off":""),
      onclick:ev=>toggleIn(ev.shiftKey?"skip":"tags",ev.shiftKey?inSkip:inTags,t)},t)));
    const inv=ENT[planState.inv];
    cmd.textContent=["ansible-playbook",inv?`-i ${inv.path}`:"",ENT[planState.pb].path,T.length?`--tags ${T.join(",")}`:"",S.length?`--skip-tags ${S.join(",")}`:"",L?`--limit '${L}'`:""].filter(Boolean).join(" ");
    const limitSet=L&&planState.inv?resolveLimit(planState.inv,L):null;
    body.replaceChildren();stepEls=[];
    let n=0,total=0,running=0,playsRun=0;
    for(const P of plan){
      const pe=ENT[P.play];const r=planState.inv&&pe.resolved[planState.inv];
      let hosts=r&&r.hosts?r.hosts:null;
      if(hosts&&limitSet)hosts=hosts.filter(h=>limitSet.has(h));
      const noHosts=hosts&&!hosts.length;
      const {sel,hsel}=selectSteps(P,T,S);
      const box=el("div",{class:"play",id:"pl-"+P.play});
      box.append(el("div",{class:"playhead"},
        el("div",{class:"ttl",onclick:()=>select(P.play,{})},badge("play"),pe.label,el("span",{class:"pill"},ENT[pe.playbook].label)),
        el("div",{class:"note"},"hosts: ",el("code",null,fmt(pe.hosts)),pe.become?el("span",{class:"pill"},"become"):null,pe.serial!=null?el("span",{class:"pill"},"serial "+fmt(pe.serial)):null,
          pe.gather_facts===false?el("span",{class:"pill"},"no facts"):el("span",{class:"pill"},"gathers facts first"),
          (P.play_tags||[]).length?el("span",{class:"pill"},"play tags: "+P.play_tags.join(", ")):null),
        r?(hosts?(hosts.length?chips(hosts,40):el("div",{class:"warnbox"},limitSet?"No hosts left after --limit: this play is skipped.":"Matches no hosts in this inventory: this play would be skipped.")):el("div",{class:"warnbox"},r.note)):null));
      if(!noHosts)playsRun++;
      total+=P.steps.length+P.handlers.length;
      const addStep=(s,phase,on)=>{
        const e=ENT[s.t];if(on&&!noHosts)running++;
        const visible=(on&&!noHosts)||planState.showSkipped;
        if(!visible)return;
        n++;
        const row=el("div",{class:"step"+(s.note?" dim":"")+(on&&!noHosts?"":" skip"),"data-t":s.t,style:`padding-left:${14+s.depth*18}px`,onclick:()=>select(s.t,{})},
          el("div",{class:"n"},on&&!noHosts?n:"–"),el("div",{class:"ph"},phase.replace("_","-")),
          el("div",{class:"main"},
            el("div",{class:"nm"},badge(e.type),el("span",null,e.label),e.module&&(e.type==="task"||e.type==="handler")?el("code",null,e.module.replace(/^ansible\.builtin\./,"")):null,
              ...(s.tags||[]).map(t=>el("span",{class:"tagp"},t))),
            s.via&&s.via.length?el("div",{class:"via"},"via role "+s.via.join(" › ")):null,
            e.desc?el("div",{class:"ds"},e.desc):null,
            e.when?el("div",{class:"cond"},"when: "+fmt(e.when)):null,
            s.notified_by?el("div",{class:"ds"},s.notified_by.length?["notified by: ",...s.notified_by.map((x,i)=>[i?", ":"",ENT[x].label])]:""):null,
            s.note?el("div",{class:"cond"},s.note):null));
        row._text=[e.label,e.module,e.desc,(s.via||[]).join(" "),fmt(e.when),(s.tags||[]).join(" ")].join(" ").toLowerCase();
        stepEls.push(row);box.append(row);
      };
      P.steps.forEach((s,i)=>addStep(s,s.phase,sel[i]));
      if(P.handlers.some((h,i)=>hsel[i])||planState.showSkipped&&P.handlers.length){
        box.append(el("div",{class:"step",style:"cursor:default"},el("div"),el("div"),el("div",{class:"note"},"Handlers: run at the end of each section, only if a notifying task changed something")));
        P.handlers.forEach((h,i)=>addStep(h,"handler",hsel[i]));
      }
      body.append(box);
    }
    const filtered=T.length||S.length||L;
    sum.replaceChildren(filtered?el("span",null,el("b",null,running)," of ",total," steps would run",limitSet?[" · ",el("b",null,playsRun)," of ",plan.length," plays have hosts"]:""):el("span",null,`${plan.length} play(s) · ${total} steps`));
    applyText();
  }
  draw();
  if(planState.focusPlay){const t=document.getElementById("pl-"+planState.focusPlay);if(t)t.scrollIntoView();}
}

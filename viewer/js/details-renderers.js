/* ==========================================================================
 * Details panel: per-type renderers
 *
 * RENDER[type](entity, opt) returns the list of sections for that entity type.
 * ========================================================================== */
// Details-panel renderers, one per entity type. Each returns a list of sections (null ones are skipped).
const RENDER={
  default:e=>[sec("Details",kvTable(Object.entries(e).filter(([k])=>!["id","type","label"].includes(k)).map(([k,v])=>[k,v])))],
  root:e=>[sec("About",el("p",{class:"note"},"Top of this map. Use the + / number badges on nodes to expand, drag to pan, scroll to zoom."))],
  section:e=>[sec("About",el("p",{class:"desc"},e.note||""),el("div",{class:"note"},`${e.count} item(s)`))],
  missing:e=>[sec("Problem",el("div",{class:"warnbox"},e.note))],
  var:e=>{
    const defs=e.defs||[],uses=e.uses||[];
    return [
      sec("Summary",el("p",{class:"desc"},`Defined in ${defs.length} place${defs.length===1?"":"s"}, used in ${uses.length}.`),
        !defs.length?el("div",{class:"note"},e.builtin?"Not defined in this repo: it's an Ansible built-in, magic variable or gathered fact.":"Not defined in this repo. It may come from facts, --extra-vars, an external role, vars_files / include_vars, or it may be a typo."):null,
        defs.length>1?el("div",{class:"note",style:"margin-top:6px"},"More than one definition: which value wins depends on precedence and on the host (role defaults < inventory vars < play vars < role vars < task vars < set_fact / register < --extra-vars). Open a host to see its merged inventory value."):null),
      sec(`Defined in (${defs.length})`,defs.length?el("table",{class:"kv vars"},defs.map(d=>el("tr",null,
        el("td",null,el("span",{class:"pill"},d.kind)),
        el("td",null,d.v!=null?valNode(d.v):el("span",{class:"empty"},"(set at runtime)"),
          el("div",{class:"lnklist",style:"margin-top:3px"},d.owners.slice(0,3).map(o=>lnk(o)),d.owners.length>3?el("span",{class:"note"},`+${d.owners.length-3} more`):null),
          el("div",null,srcLink(d.src,d.line)))))):null),
      sec(`Used by (${uses.length})`,uses.length?el("div",{class:"lnklist"},uses.slice(0,200).map(u=>el("div",{style:"margin-bottom:4px"},useLink(u,e.label)," ",el("span",{class:"pill"},u.ctx),
          el("div",null,srcLink(u.src,u.line,u.lines))))):el("div",{class:"empty"},"Not referenced anywhere in this repo."))];
  },
  template:(e,opt)=>{
    const names=Object.keys(e.refs||{}).sort();
    return [
      sec("About",el("div",{class:"mono path"},e.path),e.role&&ENT["role:"+e.role]?el("div",null,"Role: ",lnk("role:"+e.role)):null,
        el("div",{class:"note"},`${e.lines} lines · ${names.length} variable${names.length===1?"":"s"}`),
        wideBtn()),
      sec(`Rendered by (${e.used_by.length})`,e.used_by.length?linkList(e.used_by):el("div",{class:"empty"},"No task in this repo renders it directly (it may be referenced through a templated path).")),
      sec("Variables used",varChips(names)),
      sec("Source",fileSource(e.path,{...opt,refs:e.refs}))];
  },
  file:(e,opt)=>{
    const f=D.files[e.path]||{};
    const here=(ENTS_BY_SRC.get(e.path)||[]).filter(x=>!["section","root"].includes(ENT[x].type));
    const special=SPECIAL_BY_PATH.get(e.path);
    return [
      sec("About",el("div",{class:"mono path"},e.path),
        el("div",{class:"note"},[f.kind?f.kind:"file",f.lines?` · ${f.lines} lines`:"",` · ${fmtSize(f.size||0)}`].join("")),
        special?el("div",null,"Also shown as: ",lnk(special)):null,wideBtn()),
      here.length?fold(`Defined in this file (${here.length})`,linkList(here)):null,
      sec("Source",fileSource(e.path,opt))];
  },
  script:(e,opt)=>[
    sec("How it runs",el("ul",{class:"plain"},e.summary.map(x=>el("li",null,x))),
      el("div",{class:"note"},`Interpreter: ${e.interpreter}`+(e.shebang?` (#!${e.shebang})`:"")),wideBtn()),
    sec(`Referenced by (${e.refs.length})`,e.refs.length?el("div",{class:"lnklist"},e.refs.map(r=>el("div",null,lnk(r.t)," ",el("span",{class:"pill"},r.how)))):el("div",{class:"empty"},"No task references this script.")),
    sec("Source",fileSource(e.path,opt))],
  task:e=>[...taskSections(e),fold("Appears in",appearsIn(e.id))],
  handler:e=>[...taskSections(e),fold("Appears in",appearsIn(e.id))],
  block:e=>[sec("What it does",el("p",{class:"desc"},"Groups tasks so they share conditions and error handling. ",
      (e.parts||[]).map(p=>el("span",{class:"pill"},`${p.name}: ${p.tasks.length}`)))),
    sec("Conditions & behaviour",kvTable(T_KEYS.map(([k,n])=>[n,e[k]]))),
    ...(e.parts||[]).map(p=>sec(p.name+" — "+(ENT[p.sec]?.note||""),linkList(p.tasks))),fold("Appears in",appearsIn(e.id))],
  include_tasks:e=>incl(e),import_tasks:e=>incl(e),
  include_role:e=>[...taskSections(e),sec("Role",e.role_ref?lnk(e.role_ref):el("div",{class:"warnbox"},"Role name is templated; resolved at runtime."),
      e.tasks_from?el("div",{class:"note"},"tasks_from: ",el("code",null,e.tasks_from)):null),fold("Appears in",appearsIn(e.id))],
  play:(e,opt)=>{
    const invs=Object.entries(e.resolved||{});
    return [
      sec("Targets",el("div",null,"Host pattern: ",el("code",null,fmt(e.hosts))),
        ...invs.map(([iid,r])=>el("div",{style:"margin-top:8px"},el("div",{class:"note"},lnk(iid),ENT[iid]?.default?el("span",{class:"pill"},"default (ansible.cfg)"):null,
          r.hosts?` → ${r.hosts.length} host(s)`:""),r.hosts?(r.hosts.length?chips(r.hosts):el("div",{class:"empty"},"No matching hosts in this inventory")):el("div",{class:"warnbox"},r.note)))),
      sec("Run order",el("ol",{class:"plain"},(e.sections||[]).map(s=>el("li",null,lnk(s.sec,s.name.replace("_","-")),` (${(s.tasks||s.roles).length})`))),
        el("button",{class:"btn",onclick:()=>{planState.pb=e.playbook;planState.focusPlay=e.id;setTab("plan");}},"Open step-by-step run plan")),
      sec("Roles",linkList((e.sections||[]).filter(s=>s.roles).flatMap(s=>s.roles.map(r=>r.role)))),
      fold("Uses variables",varChips(USES_BY_OWNER.get(e.id))),
      fold("Play settings",kvTable([["become",e.become],["become_user",e.become_user],["gather_facts",e.gather_facts],["serial",e.serial],["strategy",e.strategy],
        ["tags",e.tags],["remote_user",e.remote_user],["connection",e.connection],["any_errors_fatal",e.any_errors_fatal],["max_fail_percentage",e.max_fail_percentage],
        ["vars_files",e.vars_files],["collections",e.collections],["environment",e.environment]])),
      fold(`Play vars (${(e.vars||[]).length})`,e.vars&&e.vars.length?varsTable(e.vars,{focus:opt.focusVar}):null),
      sec("Playbook",lnk(e.playbook))];
  },
  playbook:e=>{
    const plan=D.plans[e.id]||[];const n=plan.reduce((a,p)=>a+p.steps.length,0);
    return [sec("Summary",el("div",{class:"mono path"},e.path),el("p",{class:"desc"},`${plan.length} play(s), ${n} step(s) when run`+(e.imported_by.length?"; imported by another playbook.":".")),
        el("button",{class:"btn",onclick:()=>{planState.pb=e.id;planState.focusPlay=null;setTab("plan");}},"Open step-by-step run plan")),
      sec("Contents (in order)",linkList(e.items)),sec("Imported by",linkList(e.imported_by))];
  },
  role:(e,opt)=>[
    e.external?sec("Note",el("div",{class:"warnbox"},e.note)):null,
    sec("About",e.description?el("p",{class:"desc"},e.description):null,e.path?el("div",{class:"mono path"},e.path):null,
      el("div",{class:"note"},"When a play uses this role: meta dependencies run first, then tasks/main.yml. Handlers run only when notified.")),
    sec("Dependencies (run first)",linkList(e.deps)),
    sec("Used by",linkList(e.used_by)),
    sec("Tasks (main)",linkList(e.tasks)),
    fold("Task files",e.task_files&&Object.keys(e.task_files).length?el("ul",{class:"plain"},Object.entries(e.task_files).map(([k,v])=>el("li",{class:"mono"},k))):null),
    fold(`Handlers (${(e.handlers||[]).length})`,linkList(e.handlers)),
    fold(`Defaults (${(e.defaults||[]).length}) — lowest precedence`,(e.defaults||[]).length?varsTable(e.defaults,{focus:opt.focusVar}):null),
    fold(`Role vars (${(e.vars||[]).length}) — high precedence`,(e.vars||[]).length?varsTable(e.vars,{focus:opt.focusVar}):null),
    sec(`Templates (${(e.templates||[]).length})`,e.templates&&e.templates.length?linkList(e.templates.filter(t=>ENT[t])):null),
    fold("Files",e.files&&e.files.length?el("ul",{class:"plain"},e.files.map(t=>el("li",{class:"mono"},t))):null)],
  inventory:e=>[sec("Summary",kvTable([["Path",e.path],["Files",e.files.join(", ")],["Default in ansible.cfg",e.default?"yes":"no"],["Groups",e.counts.groups],["Hosts",e.counts.hosts],
      ["group_vars",e.group_vars.join(", ")],["host_vars",e.host_vars.join(", ")]])),
    sec("Top-level groups",linkList(ENT[`group:${e.id}:all`]?.children))],
  group:(e,opt)=>[
    sec("Membership",kvTable([["Inventory",lnk(e.inventory)],["Parent groups",e.parents.length?chips(e.parents):null],["Child groups",e.children.length?chips(e.children):null],
      ["Direct hosts",e.hosts.length?chips(e.hosts):null]])),
    fold(`All hosts incl. child groups (${e.all_hosts.length})`,chips(e.all_hosts)),
    sec(`Group variables (${e.vars.length})`,varsTable(e.vars,{focus:opt.focusVar}),el("div",{class:"note",style:"margin-top:6px"},"Defined directly on this group (inventory file and group_vars). Hosts also inherit parent-group variables; open a host to see the merged result.")),
    sec("Targeted by plays",linkList(playsForGroup(e)))],
  host:(e,opt)=>[
    sec("Connection",kvTable([["Inventory",lnk(e.inventory)],["ansible_host",e.sub]])),
    compareSection(e),                                    // compare.js
    sec("Groups",kvTable([["Direct",chips(e.groups)],["All (incl. parents)",chips(e.all_groups)]])),
    sec(`Plays that target this host (${e.plays.length})`,linkList(e.plays)),
    sec(`Effective variables (${e.vars.length})`,varsTable(e.vars,{focus:opt.focusVar}),
      el("div",{class:"note",style:"margin-top:6px"},"Merged by Ansible's inventory precedence: group vars (parents before children) → group_vars/all → group_vars/<group> → host vars → host_vars. The winning value is shown. Play vars, role vars, extra-vars and facts can still override these at runtime."))],
};

// Link for one "used by" entry of a variable (templates open at the right lines).
function useLink(u,name){
  const o=ENT[u.o];if(!o)return el("span",null,u.o);
  if(o.type==="template")return el("a",{class:"lnk",onclick:()=>select(u.o,{hl:u.lines,focusVar:name})},el("span",{class:"dot",style:`background:${tcol("template")}`}),o.path);
  return lnk(u.o);
}

// Button that toggles the details panel between normal and wide.
function wideBtn(){return el("button",{class:"btn",style:"margin-top:6px",onclick:()=>{const d=$("#detail");d.style.width="";d.classList.toggle("wide");}},"Toggle wide view");}

// Details for include_tasks / import_tasks.
function incl(e){return[sec("What it does",el("p",{class:"desc"},e.type==="import_tasks"?"Statically imports the tasks from another file; they are inserted here when the playbook is parsed.":"Dynamically includes tasks from another file when this point is reached at runtime."),
  e.include_src?el("div",{class:"mono path"},"→ "+e.include_src):el("div",{class:"warnbox"},e.unresolved||"")),
  sec("Conditions & behaviour",kvTable(T_KEYS.map(([k,n])=>[n,e[k]]))),sec("Included tasks",linkList(e.children)),fold("Appears in",appearsIn(e.id))];}

// Plays that target every host of a group.
function playsForGroup(g){const inv=g.inventory;const set=new Set();for(const h of g.all_hosts)for(const p of (ENT[h]?.plays||[]))set.add(p);
  return [...set].filter(p=>{const r=ENT[p].resolved[inv];return r&&r.hosts&&g.all_hosts.every(h=>r.hosts.includes(h));});}

/* ==========================================================================
 * Overview tab
 *
 *
 * ========================================================================== */
// The Overview tab: counts, checks, inventories, entry points and reference material.
function renderOverview(){
  const m=D.meta;const view=$("#view");const page=el("div",{class:"page"});view.append(page);
  const c=m.counts;const tasks=(c.task||0)+(c.handler||0);
  const card=(n,l,tab)=>el("div",{class:"card",style:tab?"cursor:pointer":"",onclick:tab?()=>setTab(tab):null},el("b",null,n||0),el("span",null,l));
  page.append(el("h1",null,m.repo),el("div",{class:"note mono"},m.repo_path),
    el("div",{class:"note"},`Generated ${m.generated} by ${m.tool} ${m.version} · ${m.scanned_files} files scanned · `+(m.redacted?"secret-looking values redacted":"redaction OFF")),
    el("div",{class:"cards"},card(c.playbook,"playbooks","playbooks"),card(c.play,"plays","playbooks"),card(c.role,"roles","roles"),card(tasks,"tasks & handlers"),
      card(c.inventory,"inventories","inventory"),card(c.group,"groups","inventory"),card(c.host,"hosts","inventory"),card(c.template,"templates"),card(c.script,"scripts","files"),card(c.var,"variables"),card((D.findings||[]).length,"checks")));
  page.append(el("h2",null,"Checks"),checksBox());
  const ofold=(title,...kids)=>el("details",{class:"box"},el("summary",{style:"cursor:pointer;font-weight:600"},title),el("div",{style:"margin-top:8px"},...kids));
  if(m.warnings.length)page.append(ofold(`⚠ Warnings (${m.warnings.length})`,el("ul",{class:"plain"},m.warnings.map(w=>el("li",{class:"note"},w)))));
  const invs=Object.values(ENT).filter(e=>e.type==="inventory");
  page.append(el("h2",null,"Inventories"),el("div",{class:"box"},invs.length?linkList(invs.map(i=>i.id)):el("span",{class:"empty"},"None found")));
  page.append(el("h2",null,"Entry-point playbooks"),el("div",{class:"box"},linkList(Object.values(ENT).filter(e=>e.type==="playbook"&&e.root).map(e=>e.id))||el("span",{class:"empty"},"None")));
  page.append(el("h2",null,"Reference"));
  page.append(ofold("ansible.cfg"+(m.cfg_path?" — "+m.cfg_path:""),Object.keys(m.cfg).length?Object.entries(m.cfg).map(([s,kv])=>el("div",null,el("h3",{class:"note"},"["+s+"]"),kvTable(Object.entries(kv)))):el("span",{class:"empty"},"No ansible.cfg found")));
  if(m.playbook_group_vars.length||m.playbook_host_vars.length)page.append(ofold("Playbook-level group_vars / host_vars",el("div",null,el("ul",{class:"plain"},[...m.playbook_group_vars,...m.playbook_host_vars].map(x=>el("li",{class:"mono"},x))),el("p",{class:"note"},"Applied to every inventory here when playbooks in the same directory are run."))));
  if(m.requirements.length)page.append(ofold("Requirements (Galaxy roles / collections)",...m.requirements.map(r=>el("div",null,el("div",{class:"mono note"},r.file),kvTable(r.items.map(i=>[i.kind,`${i.name}${i.version?" @ "+i.version:""}`]))))));
  if(m.encrypted_files.length)page.append(ofold("Vault-encrypted files",el("div",null,el("ul",{class:"plain"},m.encrypted_files.map(f=>el("li",{class:"mono"},f))),el("p",{class:"note"},"Contents are never decrypted. Variables inside them are not shown."))));
  page.append(ofold("How to read this",el("div",{class:"note"},el("ul",{class:"plain"},
    el("li",null,"Read-only and offline: generated from files on disk. Nothing was executed and this page makes no network requests."),
    el("li",null,"Playbooks map: playbook → plays → pre-tasks / roles / tasks / post-tasks / handlers. Roles expand into their dependencies, then their tasks."),
    el("li",null,"Run plan: the flattened order of execution for a playbook, with target hosts for the chosen inventory."),
    el("li",null,"Host variables are merged using Ansible's inventory precedence; runtime sources (extra-vars, set_fact, facts, play/role vars) can still change them."),
    el("li",null,"Click any variable name to see everywhere it is defined and used, including inside templates."),
    el("li",null,"Run plan → Tags & limit: preview what --tags, --skip-tags and --limit would run."),
    el("li",null,"Files: browse and read any file in the repo; the Scripts filter lists shell scripts and how they are run."),
    el("li",null,"Click any file:line reference to open that file at that line."),
    el("li",null,"Press ? for keyboard shortcuts: 1–6 switch tabs, ] hides the details panel, / searches."),
    el("li",null,"Search: type part of any name or value. Prefix with host:, group:, var:, task:, role:, play:, template: or file: to narrow. Press / to search, Esc to close, F to fit, T to switch light/dark.")))));
}

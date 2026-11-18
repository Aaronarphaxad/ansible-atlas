/* ==========================================================================
 * Code view: read-only file listing
 *
 * Used for templates, scripts and any repo file in the details panel.
 * ========================================================================== */
// Read-only code listing with line numbers, highlighted Jinja and clickable variable names.
function codeView(text,opt={}){
  const hl=new Set(opt.hl||(opt.focusVar&&opt.refs&&opt.refs[opt.focusVar])||[]);
  const box=el("div",{class:"code"});
  const lines=String(text).split("\n");
  const frag=document.createDocumentFragment();
  lines.forEach((ln,i)=>{
    const row=el("div",{class:"ln"+(hl.has(i+1)?" hit":""),"data-n":i+1},el("i",null,i+1));
    const span=el("span");
    for(const part of ln.split(/(\{\{.*?\}\}|\{%.*?%\}|\{#.*?#\})/)){
      if(!part)continue;
      if(/^\{[{%#]/.test(part)){
        const j=el("span",{class:"jj"});
        for(const tok of part.split(/([A-Za-z_][A-Za-z0-9_]*)/)){
          if(tok&&ENT["var:"+tok])j.append(el("span",{class:"vr",title:"Open variable",onclick:()=>select("var:"+tok)},tok));
          else if(tok)j.append(tok);
        }
        span.append(j);
      } else span.append(part);
    }
    row.append(span);frag.append(row);
  });
  box.append(frag);
  if(opt.truncated)box.append(el("div",{class:"note",style:"padding:6px 12px"},"… truncated (file is very large)"));
  if(hl.size)setTimeout(()=>{const h=box.querySelector(".hit");if(h)h.scrollIntoView({block:"center"});},40);
  return box;
}

// The embedded source of a repo file, or a note when it wasn't embedded.
function fileSource(path,opt={}){
  const f=D.files&&D.files[path];
  if(!f)return el("div",{class:"note"},"File not found in this map.");
  if(f.text==null)return el("div",{class:"note"},f.note||"Contents not embedded.");
  return codeView(f.text,{...opt,truncated:f.truncated});
}

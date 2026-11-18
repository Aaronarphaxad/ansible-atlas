/* ==========================================================================
 * Core: embedded data, DOM helpers and formatting
 *
 * D is the JSON model that atlas.py injects in place of the marker below. ENT maps every
 * entity id ("task:…", "host:inv:web01", "var:http_port" …) to its record.
 * Everything else in the viewer reads from these two constants.
 * ========================================================================== */
const D=/*__ATLAS_DATA__*/null;
const ENT=D?D.entities:{};
const $=s=>document.querySelector(s);
const SVGNS="http://www.w3.org/2000/svg";

// Create an HTML element. props: class, style, text, on<event> handlers, or plain attributes.
// kids may be nested arrays, strings, numbers or nodes; null/false are skipped.
function el(tag,props,...kids){
  const n=document.createElement(tag);
  if(props) for(const[k,v]of Object.entries(props)){
    if(v==null||v===false) continue;
    if(k==="class") n.className=v; else if(k==="style") n.style.cssText=v;
    else if(k.startsWith("on")) n.addEventListener(k.slice(2),v);
    else if(k==="text") n.textContent=v; else n.setAttribute(k,v);
  }
  for(const k of kids.flat(9)){ if(k==null||k===false) continue; n.append(k.nodeType?k:document.createTextNode(String(k))); }
  return n;
}

// Create an SVG element (same idea as el(), for the map).
function sv(tag,attrs,...kids){const n=document.createElementNS(SVGNS,tag);for(const[k,v]of Object.entries(attrs||{}))if(v!=null)n.setAttribute(k,v);for(const k of kids)if(k!=null)n.append(k.nodeType?k:document.createTextNode(String(k)));return n;}

// Every entity type: CSS colour variable, short icon and display name.
const TYPES={
  root:{c:"--c-root",i:"◎",n:"Root"}, playbook:{c:"--c-playbook",i:"PB",n:"Playbook"}, play:{c:"--c-play",i:"▶",n:"Play"},
  role:{c:"--c-role",i:"R",n:"Role"}, task:{c:"--c-task",i:"T",n:"Task"}, handler:{c:"--c-handler",i:"H",n:"Handler"},
  block:{c:"--c-block",i:"{}",n:"Block"}, include_tasks:{c:"--c-include",i:"⤷",n:"include_tasks"}, import_tasks:{c:"--c-include",i:"⤷",n:"import_tasks"},
  include_role:{c:"--c-role",i:"⤷R",n:"include_role"}, import_role:{c:"--c-role",i:"⤷R",n:"import_role"},
  section:{c:"--c-section",i:"§",n:"Section"}, inventory:{c:"--c-inventory",i:"INV",n:"Inventory"}, group:{c:"--c-group",i:"G",n:"Group"},
  host:{c:"--c-host",i:"⌂",n:"Host"}, missing:{c:"--c-missing",i:"!",n:"Missing"}, var:{c:"--c-var",i:"$",n:"Variable"}, template:{c:"--c-template",i:"J2",n:"Template"}, file:{c:"--c-file",i:"F",n:"File"}, script:{c:"--c-script",i:"$_",n:"Script"}
};

// Read a CSS custom property.
const css=v=>getComputedStyle(document.documentElement).getPropertyValue(v).trim();

// CSS colour for an entity type.
const tcol=t=>`var(${(TYPES[t]||TYPES.task).c})`;

// Coloured pill naming an entity type ("Task", "Host", …).
function badge(t){const T=TYPES[t]||{i:"?",n:t};return el("span",{class:"badge",style:`background:${tcol(t)}`,title:T.n},T.n);}

// Truncate a string to n characters with an ellipsis.
function short(s,n=80){s=String(s??"");return s.length>n?s.slice(0,n-1)+"…":s;}

// Turn any YAML value into a short display string.
function fmt(v){if(v==null)return"null";if(typeof v==="string")return v;return JSON.stringify(v);}

// Render a variable value: code for scalars, <pre> for objects and long text, a pill for redacted / vault values.
function valNode(v){
  if(v!==null&&typeof v==="object"){const s=JSON.stringify(v,null,2);return el("pre",null,s);}
  const s=fmt(v);
  if(typeof v==="string"&&v.startsWith("•••• redacted"))return el("span",{class:"pill warn"},"redacted");
  if(typeof v==="string"&&v.startsWith("<vault encrypted"))return el("span",{class:"pill warn"},"🔒 vault encrypted");
  return s.length>120||s.includes("\n")?el("pre",null,s):el("code",null,s===""?'""':s);
}

// "path:line" for an entity, or "".
function srcText(e){return e&&e.src?(e.src+(e.line?":"+e.line:"")):"";}
/* "path:line" that opens the file in the viewer, scrolled to that line */

// A clickable "path:line" that opens the file in the viewer, scrolled to that line.
function srcLink(src,line,lines){
  if(!src)return null;
  const txt=src+(lines&&lines.length?":"+lines.join(","):(line?":"+line:""));
  if(!ENT["file:"+src])return el("span",{class:"src"},txt);
  return el("a",{class:"src srclink",title:"Open file",onclick:ev=>{ev.stopPropagation();select("file:"+src,{hl:lines&&lines.length?lines:(line?[line]:null)});}},txt);
}

// Link to any entity by id; clicking selects it and reveals it in a map.
function lnk(id,label){const e=ENT[id];if(!e)return el("span",{class:"empty"},label||id);
  return el("a",{class:"lnk",onclick:ev=>{ev.preventDefault();select(id,{reveal:true});}},el("span",{class:"dot",style:`background:${tcol(e.type)}`}),label||e.label);}

// Display name of an inventory id.
function invName(id){return ENT[id]?ENT[id].label:id;}

// One-line context for an entity (used in search results and tooltips).
function ctxOf(e){
  if(!e)return"";
  switch(e.type){
    case"host":case"group":return "inventory "+invName(e.inventory);
    case"task":case"handler":case"block":case"include_tasks":case"import_tasks":case"include_role":case"import_role":
      return (e.role?"role "+e.role+" · ":"")+srcText(e);
    case"play":return "hosts: "+fmt(e.hosts)+" · "+e.src;
    case"role":return e.external?"external":e.path;
    case"var":return `defined ${e.defs.length}× · used ${e.uses.length}×`+(e.builtin?" · built-in/fact":"");
    case"template":return e.path;
    case"file":return (D.files[e.path]?.kind||"file")+" · "+e.path;
    case"script":return e.summary.join("; ");
    default:return e.path||"";
  }
}

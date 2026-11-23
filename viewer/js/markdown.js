/* ==========================================================================
 * Markdown preview (read-only)
 *
 * A small, dependency-free renderer for the Markdown notes in a repo. It builds
 * DOM nodes with el() / text nodes only, so nothing in a note is ever parsed as
 * HTML: raw HTML shows up as plain text and HTML comments are dropped.
 *
 * Links: a link to another file in the repo opens it in the viewer; "#anchor"
 * links scroll within the note. External links (http:, mailto:, …) are shown but
 * NOT clickable, so the page never navigates anywhere. Images show their alt text
 * (the page loads nothing).
 *
 * Supported: headings (ATX and setext), paragraphs, emphasis, strong,
 * strikethrough, `code`, fenced and indented code blocks, block quotes, nested
 * ordered/unordered lists, task lists, tables, horizontal rules, line breaks,
 * inline and reference links, autolinks, YAML front matter.
 * ========================================================================== */

// Join a link target onto the directory of the note it appears in ("a/b.md" + "../c.md" → "c.md").
function mdResolvePath(base,target){
  const parts=target.startsWith("/")?[]:base.split("/").slice(0,-1);
  for(const p of target.replace(/^\//,"").split("/")){
    if(!p||p===".")continue;
    if(p==="..")parts.pop();else parts.push(p);
  }
  return parts.join("/");
}

// Heading text → anchor slug, the way GitHub makes them ("Quick start!" → "quick-start").
const mdSlug=s=>String(s).toLowerCase().trim().replace(/[^\w\- ]+/g,"").replace(/\s+/g,"-");

// Render a link / image target without ever navigating away from the page.
function mdLink(label,url,ctx,title){
  url=(url||"").trim().replace(/^<|>$/g,"");
  if(/^[a-z][a-z0-9+.-]*:/i.test(url)||url.startsWith("//"))
    return el("span",{class:"md-ext",title:`External link, not opened (this page stays offline): ${url}`},...label,el("span",{class:"md-ext-mark"},"↗"));
  if(url.startsWith("#")){
    const id=url.slice(1).toLowerCase();
    return el("a",{class:"md-int",title:title||"Jump to section",onclick:ev=>{
      ev.preventDefault();const root=ev.target.closest(".md");
      const h=root&&[...root.querySelectorAll("[data-anchor]")].find(x=>x.dataset.anchor===id);if(h)h.scrollIntoView({block:"start"});}},...label);
  }
  const path=mdResolvePath(ctx.path,decodeURIComponent(url.split(/[?#]/)[0]));
  if(D.files&&D.files[path])
    return el("a",{class:"md-int",title:title||`Open ${path}`,onclick:ev=>{ev.preventDefault();select("file:"+path,{});}},...label);
  return el("span",{class:"md-ext",title:`Not in this repo: ${url}`},...label);
}

// Inline Markdown → array of DOM nodes / strings.
const MD_INLINE=new RegExp([
  "(`+)([\\s\\S]*?[^`])\\1(?!`)",                                   // 1,2  `code`
  "!\\[([^\\]]*)\\]\\(([^)\\s]*)(?:\\s+\"[^\"]*\")?\\)",              // 3,4  ![alt](src)
  "\\[([^\\]]+)\\]\\(([^)\\s]*)(?:\\s+\"([^\"]*)\")?\\)",             // 5,6,7 [text](url "title")
  "\\[([^\\]]+)\\]\\[([^\\]]*)\\]",                                 // 8,9  [text][ref]
  "<((?:https?|mailto|ftp):[^>\\s]+)>",                            // 10   <https://…>
  "\\*\\*([\\s\\S]+?)\\*\\*",                                        // 11   **strong**
  "__([\\s\\S]+?)__",                                                // 12   __strong__
  "~~([\\s\\S]+?)~~",                                                // 13   ~~strike~~
  "\\*([^*\\s](?:[\\s\\S]*?[^*\\s])?)\\*",                           // 14   *em*
  "_([^_\\s](?:[\\s\\S]*?[^_\\s])?)_(?![\\w])",                      // 15   _em_ (not inside words: see below)
  "\\\\([\\\\`*_{}\\[\\]()#+\\-.!|>~])",                              // 16   \escape
  "( {2,}|\\\\)\\n"                                                  // 17   hard line break
].join("|"));
function mdInline(s,ctx){
  const out=[];
  while(s){
    const m=MD_INLINE.exec(s);
    if(!m){out.push(s);break;}
    if(m[15]&&m.index&&/\w/.test(s[m.index-1])){out.push(s.slice(0,m.index+1));s=s.slice(m.index+1);continue;}  // snake_case_name
    if(m.index)out.push(s.slice(0,m.index));
    if(m[1])out.push(el("code",null,m[2].replace(/^ (.*) $/,"$1")));
    else if(m[3]!==undefined)out.push(el("span",{class:"md-img",title:m[4]?`Image (not loaded): ${m[4]}`:"Image"},"🖼 ",m[3]||"image"));
    else if(m[5])out.push(mdLink(mdInline(m[5],ctx),m[6],ctx,m[7]));
    else if(m[8]){const ref=ctx.refs[(m[9]||m[8]).toLowerCase()];out.push(ref?mdLink(mdInline(m[8],ctx),ref,ctx):`[${m[8]}][${m[9]}]`);}
    else if(m[10])out.push(mdLink([m[10]],m[10],ctx));
    else if(m[11]||m[12])out.push(el("strong",null,...mdInline(m[11]||m[12],ctx)));
    else if(m[13])out.push(el("del",null,...mdInline(m[13],ctx)));
    else if(m[14]||m[15])out.push(el("em",null,...mdInline(m[14]||m[15],ctx)));
    else if(m[16])out.push(m[16]);
    else if(m[17])out.push(el("br"));
    s=s.slice(m.index+m[0].length);
  }
  return out;
}

const MD_FENCE=/^ {0,3}(`{3,}|~{3,})\s*([\w+#.-]*)/;
const MD_HR=/^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const MD_HEAD=/^ {0,3}(#{1,6})(?:\s+(.*?))?(?:\s+#+)?\s*$/;
const MD_LIST=/^( *)([-*+]|\d{1,9}[.)])(\s+|$)(.*)$/;
const MD_TABLE_SEP=/^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;
const MD_REFDEF=/^ {0,3}\[([^\]]+)\]:\s*(\S+)/;

// Split a table row into cells (handles escaped \| inside cells).
function mdCells(line){
  const s=line.trim().replace(/^\|/,"").replace(/\|$/,"");
  return s.replace(/\\\|/g,"\u0000").split("|").map(c=>c.trim().replace(/\u0000/g,"|"));
}

// Block-level parse of lines[from..to) into `host`. `off` is the source line offset (for search highlighting).
function mdBlocks(lines,ctx,host,off=0){
  let i=0;
  const isBlank=l=>!l.trim();
  const tag=(node,a,b)=>{node.dataset.l1=off+a+1;node.dataset.l2=off+b;return node;};
  const startsBlock=l=>MD_FENCE.test(l)||MD_HEAD.test(l)||MD_HR.test(l)||/^ {0,3}>/.test(l)||MD_LIST.test(l);
  while(i<lines.length){
    const line=lines[i];
    if(isBlank(line)){i++;continue;}
    let m;
    if((m=line.match(MD_FENCE))){                                        // fenced code
      const fence=m[1],lang=m[2],a=i;i++;const body=[];
      while(i<lines.length&&!new RegExp("^ {0,3}"+fence[0]+"{"+fence.length+",}\\s*$").test(lines[i]))body.push(lines[i++]);
      i++;
      host.append(tag(el("div",{class:"md-code"},lang?el("div",{class:"md-lang"},lang):null,el("pre",null,body.join("\n"))),a,i));
      continue;
    }
    if(MD_HR.test(line)){host.append(tag(el("hr"),i,i+1));i++;continue;}
    if((m=line.match(MD_HEAD))){                                         // # heading
      const t=m[2]||"";const h=el("h"+m[1].length,{"data-anchor":mdSlug(t)},...mdInline(t,ctx));
      host.append(tag(h,i,i+1));i++;continue;
    }
    if(/^ {0,3}>/.test(line)){                                            // > quote
      const a=i;const body=[];
      while(i<lines.length&&!isBlank(lines[i])&&(/^ {0,3}>/.test(lines[i])||body.length&&!startsBlock(lines[i])))
        body.push(lines[i++].replace(/^ {0,3}> ?/,""));
      const q=el("blockquote");mdBlocks(body,ctx,q,off+a);host.append(tag(q,a,i));continue;
    }
    if((m=line.match(MD_LIST))){                                          // lists (nested by indent)
      const a=i,indent=m[1].length,ordered=/\d/.test(m[2]);
      const list=el(ordered?"ol":"ul");
      if(ordered&&parseInt(m[2],10)!==1)list.setAttribute("start",parseInt(m[2],10));
      while(i<lines.length){
        const mm=lines[i].match(MD_LIST);
        if(!mm||mm[1].length!==indent||/\d/.test(mm[2])!==ordered)break;
        const contentIndent=mm[1].length+mm[2].length+Math.max(1,Math.min(4,mm[3].length||1));
        const body=[mm[4]];const s0=i;i++;
        while(i<lines.length){
          const l=lines[i];
          if(isBlank(l)){
            const next=lines.slice(i+1).find(x=>!isBlank(x));
            if(next!==undefined&&(next.length-next.trimStart().length)>indent&&!(MD_LIST.test(next)&&next.match(MD_LIST)[1].length===indent)){body.push("");i++;continue;}
            break;
          }
          const lead=l.length-l.trimStart().length;
          if(lead>indent){body.push(l.slice(Math.min(lead,contentIndent)));i++;continue;}
          if(MD_LIST.test(l)||startsBlock(l))break;
          body.push(l.trim());i++;                                        // lazy continuation line
        }
        const li=el("li");
        const task=body[0].match(/^\[([ xX])\]\s+(.*)$/);
        if(task){li.classList.add("md-task");body[0]=task[2];li.append(el("span",{class:"md-check"+(task[1]===" "?"":" done")},task[1]===" "?"☐":"☑")," ");}
        const tight=!body.includes("");
        if(tight&&!body.slice(1).some(startsBlock)){li.append(...mdInline(body.join("\n"),ctx));}
        else{const wrap=el("div");mdBlocks(body,ctx,wrap,off+s0);
          if(tight&&wrap.firstChild&&wrap.firstChild.tagName==="P")wrap.firstChild.replaceWith(...wrap.firstChild.childNodes);
          li.append(...wrap.childNodes);}
        list.append(li);
        while(i<lines.length&&isBlank(lines[i])){const next=lines.slice(i).find(x=>!isBlank(x));const nm=next&&next.match(MD_LIST);
          if(nm&&nm[1].length===indent)i++;else break;}
      }
      host.append(tag(list,a,i));continue;
    }
    if(line.includes("|")&&i+1<lines.length&&MD_TABLE_SEP.test(lines[i+1])&&lines[i+1].includes("-")){   // table
      const a=i;const head=mdCells(line);
      const align=mdCells(lines[i+1]).map(c=>c.startsWith(":")&&c.endsWith(":")?"center":c.endsWith(":")?"right":"left");
      i+=2;const rows=[];
      while(i<lines.length&&!isBlank(lines[i])&&lines[i].includes("|"))rows.push(mdCells(lines[i++]));
      const cell=(t,c,j)=>el(t,{style:`text-align:${align[j]||"left"}`},...mdInline(c,ctx));
      host.append(tag(el("div",{class:"md-table"},el("table",null,
        el("thead",null,el("tr",null,head.map((c,j)=>cell("th",c,j)))),
        el("tbody",null,rows.map(r=>el("tr",null,head.map((_,j)=>cell("td",r[j]||"",j))))))),a,i));
      continue;
    }
    if(/^( {4}|\t)/.test(line)){                                          // indented code
      const a=i;const body=[];
      while(i<lines.length&&(/^( {4}|\t)/.test(lines[i])||isBlank(lines[i])))body.push(lines[i++].replace(/^( {4}|\t)/,""));
      while(body.length&&!body[body.length-1].trim())body.pop();
      host.append(tag(el("div",{class:"md-code"},el("pre",null,body.join("\n"))),a,i));continue;
    }
    // paragraph (possibly a setext heading)
    const a=i;const body=[];
    while(i<lines.length&&!isBlank(lines[i])){
      if(body.length&&/^ {0,3}(=+|-+)\s*$/.test(lines[i])){
        const lvl=lines[i].trim()[0]==="="?1:2;i++;
        const t=body.join(" ");host.append(tag(el("h"+lvl,{"data-anchor":mdSlug(t)},...mdInline(t,ctx)),a,i));body.length=0;break;
      }
      if(body.length&&startsBlock(lines[i]))break;
      body.push(lines[i++]);
    }
    if(body.length)host.append(tag(el("p",null,...mdInline(body.join("\n"),ctx)),a,i));
  }
}

// Render a whole note. Returns a <div class="md"> ready to insert.
function renderMarkdown(text,path,opt={}){
  let src=String(text).replace(/\r\n?/g,"\n");
  // Drop HTML comments but keep line numbers stable for search highlighting.
  src=src.replace(/<!--[\s\S]*?-->/g,c=>c.replace(/[^\n]/g,""));
  const lines=src.split("\n");
  const root=el("div",{class:"md"});
  let start=0;
  if(lines[0]==="---"){                                                     // YAML front matter
    const end=lines.indexOf("---",1);
    if(end>0){root.append(el("details",{class:"md-front"},el("summary",null,"Front matter"),el("pre",null,lines.slice(1,end).join("\n"))));start=end+1;}
  }
  const refs={};
  const body=lines.slice(start).map(l=>{const m=l.match(MD_REFDEF);if(m){refs[m[1].toLowerCase()]=m[2];return "";}return l;});
  mdBlocks(body,{path,refs},root,start);
  if(opt.hl&&opt.hl.length){
    const hl=opt.hl;let first=null;
    for(const b of root.querySelectorAll("[data-l1]")){
      if(b.querySelector("[data-l1]"))continue;                              // mark the innermost block only
      const a=+b.dataset.l1,z=+b.dataset.l2;
      if(hl.some(n=>n>=a&&n<=z)){b.classList.add("md-hit");first=first||b;}
    }
    if(first)setTimeout(()=>first.scrollIntoView({block:"center"}),40);
  }
  return root;
}

// Is this repo file a Markdown note?
const isMarkdown=p=>/\.(md|markdown|mdown|mkd)$/i.test(p||"");

// Preview / Source switch for Markdown files (your choice is remembered).
function markdownView(path,opt={}){
  const f=D.files&&D.files[path];
  if(!f||f.text==null)return fileSource(path,opt);
  let mode="preview";try{mode=localStorage.getItem("atlas-md-mode")||"preview";}catch(_){}
  const box=el("div");
  const body=el("div");
  const btn=(m,label)=>el("span",{class:"chip"+(mode===m?" on":""),onclick:()=>{mode=m;try{localStorage.setItem("atlas-md-mode",m);}catch(_){}draw();}},label);
  const bar=el("div",{class:"chips",style:"margin-bottom:8px"});
  function draw(){
    bar.replaceChildren(btn("preview","Preview"),btn("source","Source"));
    body.replaceChildren(mode==="preview"?renderMarkdown(f.text,path,opt):fileSource(path,opt));
  }
  draw();
  box.append(bar,body);
  if(f.truncated)box.append(el("div",{class:"note"},"… truncated (file is very large)"));
  return box;
}

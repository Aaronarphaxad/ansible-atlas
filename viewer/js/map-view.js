/* ==========================================================================
 * Map view: drawing, pan/zoom and selection highlight
 *
 * Rendering is plain SVG: one <g class="node"> per visible node inside <g id="vp">.
 * Pan/zoom is applied through the root <svg>'s viewBox (see applyTransform).
 * ========================================================================== */
// Build the map tab: the SVG canvas plus its toolbar, legend, zoom label and match bar.
function renderGraphView(){
  const V=VIEWS[current];
  const view=$("#view");
  const svg=sv("svg",{id:"graph",preserveAspectRatio:"xMinYMin meet"});
  const vp=sv("g",{id:"vp"});svg.append(vp);
  const menu=el("details",{class:"menu"},el("summary",{title:"More view options"},"⋯"),
    el("div",null,
      el("button",{onclick:()=>{expandAll();menu.open=false;}},"Expand all (or selected)"),
      el("button",{onclick:()=>{collapseAll();menu.open=false;}},"Collapse all"),
      el("hr"),
      ...[1,2,3,4,6].map(i=>el("button",{onclick:()=>{expandDepth(i);menu.open=false;}},`Show ${i} level${i>1?"s":""}`))));
  const tb=el("div",{class:"toolbar"},
    el("button",{title:"Zoom in",onclick:()=>zoomBy(1.25)},"+"),
    el("button",{title:"Zoom out",onclick:()=>zoomBy(0.8)},"−"),
    el("button",{title:"Fit to screen (F)",onclick:()=>fit()},"Fit"),menu);
  const used=new Set(V.nodes.map(n=>ENT[n.e]?.type));
  const legend=el("div",{class:"legend",style:"display:none"},[...used].filter(t=>t&&t!=="root").map(t=>el("span",null,el("span",{class:"dot",style:`background:${tcol(t)}`}),(TYPES[t]||{n:t}).n)),
    el("span",null,"· click a node for details · click its badge to expand · drag to pan · scroll to zoom · press ? for shortcuts"));
  const lbtn=el("button",{class:"btn legend-btn",onclick:()=>{legend.style.display=legend.style.display==="none"?"":"none";}},"Legend");
  const zl=el("div",{class:"zoomlbl",id:"zl"});
  const matchbar=el("div",{class:"matchbar",id:"matchbar",style:"display:none"});   // filled by map-search.js
  const hovercard=el("div",{class:"hovercard",id:"hovercard"});                     // filled by map-hover.js
  matchIdx=-1;
  view.append(svg,tb,legend,lbtn,zl,matchbar,hovercard);
  attachPanZoom(svg,V);
  drawGraph();
  if(!V.fitted){V.fitted=true;fit();}
  if(selected)markSelected();
}

// Re-draw every visible node and edge of the current view (called after any expand/collapse).
function drawGraph(){
  const V=VIEWS[current];if(!V)return;
  layout(V);
  hideHover();                       // the node under the pointer is about to be replaced
  const vp=$("#vp");vp.replaceChildren();
  const edges=sv("g"),nodes=sv("g");vp.append(edges,nodes);
  for(const n of V.laid){
    if(n.parent&&V.expanded.has(n.parent.key)){
      const p=n.parent,x1=p.x+p.w,y1=p.y+NODE_H/2,x2=n.x,y2=n.y+NODE_H/2,mx=(x1+x2)/2;
      edges.append(sv("path",{class:"edge","data-k":n.key,d:`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`}));
    }
    const e=ENT[n.e]||{type:"missing",label:n.e};
    const g=sv("g",{class:"node"+(searchHits.has(n.e)?" match":""),"data-k":n.key,transform:`translate(${n.x},${n.y})`});
    g.append(sv("rect",{class:"box",width:n.w,height:NODE_H,rx:8}));
    g.append(sv("rect",{class:"stripe",x:0,y:0,width:5,height:NODE_H,fill:tcol(e.type)}));
    g.append(sv("text",{x:14,y:17},n.label));
    g.append(sv("text",{x:14,y:32,class:"sub"},n.sub));
    if(n.kids.length){
      const open=V.expanded.has(n.key);
      const tog=sv("g",{class:"tog",transform:`translate(${n.w},${NODE_H/2})`});
      tog.append(sv("circle",{r:10}),sv("text",{y:4},open?"−":String(n.kids.length>99?"99+":n.kids.length)));
      tog.append(sv("title",{},open?"Collapse":"Expand ("+n.kids.length+" children)"));
      tog.addEventListener("click",ev=>{ev.stopPropagation();toggle(n);});
      g.append(tog);
    }
    g.addEventListener("click",ev=>{ev.stopPropagation();select(n.e,{node:n});});
    g.addEventListener("dblclick",ev=>{ev.stopPropagation();toggle(n);});
    attachHover(g,n);                // preview card after a short pause (map-hover.js)
    nodes.append(g);
  }
  applyTransform();
  markSelected();
  updateMatchBar();                  // search match count / "Show all" (map-search.js)
}

// Expand or collapse one node, keeping it in the same place on screen.
function toggle(n){const V=VIEWS[current];if(V.expanded.has(n.key))V.expanded.delete(n.key);else V.expanded.add(n.key);
  const oy=n.y,ox=n.x;drawGraph();V.tx+=(ox-n.x)*V.k;V.ty+=(oy-n.y)*V.k;applyTransform();}

// Expand everything under the selected node (or the whole map), capped so huge repos stay usable.
function expandAll(){const V=VIEWS[current];const start=selectedNode&&V.byEnt.get(selected)?.includes(selectedNode)?selectedNode:V.root;
  let c=0;(function w(n){if(c>4000)return;if(n.kids.length){V.expanded.add(n.key);c+=n.kids.length;}n.kids.forEach(w);})(start);
  drawGraph();if(start===V.root)fit();}

// Collapse back to just the root's children.
function collapseAll(){const V=VIEWS[current];V.expanded.clear();V.expanded.add(V.root.key);drawGraph();fit();}

// Show exactly d levels.
function expandDepth(d){const V=VIEWS[current];if(!d)return;V.expanded.clear();for(const n of V.nodes)if(n.depth<d&&n.kids.length)V.expanded.add(n.key);drawGraph();fit();}

// Apply the current pan/zoom (V.tx, V.ty, V.k) to the canvas.
// Screen point = map point × k + (tx, ty).
function applyTransform(){const V=VIEWS[current];const vp=$("#vp");if(!vp)return;
  // Pan/zoom via the root viewBox rather than a transform on #vp: Safari doesn't fully
  // invalidate the old paint area when a <g> transform's scale changes, leaving ghost trails.
  // Changing the viewBox repaints the whole SVG in every engine.
  const svg=$("#graph");const w=svg.clientWidth,h=svg.clientHeight;
  if(w&&h)svg.setAttribute("viewBox",`${-V.tx/V.k} ${-V.ty/V.k} ${w/V.k} ${h/V.k}`);
  svg.classList.toggle("far",V.k<0.55);svg.classList.toggle("vfar",V.k<0.28);
  const zl=$("#zl");if(zl)zl.textContent=Math.round(V.k*100)+"% · "+V.laid.length+" nodes shown";}

// Zoom by factor f around the screen point (cx, cy); defaults to the centre.
function zoomBy(f,cx,cy){const V=VIEWS[current];const svg=$("#graph");const r=svg.getBoundingClientRect();
  cx=cx??r.width/2;cy=cy??r.height/2;const k=Math.min(3,Math.max(0.05,V.k*f));
  V.tx=cx-(cx-V.tx)*(k/V.k);V.ty=cy-(cy-V.ty)*(k/V.k);V.k=k;applyTransform();}

// Zoom and pan so the whole visible tree fits on screen.
function fit(){const V=VIEWS[current];const svg=$("#graph");if(!svg)return;const r=svg.getBoundingClientRect();
  const w=V.width+60,h=V.height+40;const k=Math.min(1.2,Math.max(0.05,Math.min((r.width-40)/w,(r.height-110)/h)));
  V.k=k;V.tx=(r.width-V.width*k)/2;V.ty=Math.max(60,(r.height-V.height*k)/2);applyTransform();}

// Pan so node n is in the middle of the screen (zooming in a bit if very far out).
function centerOn(n){const V=VIEWS[current];const svg=$("#graph");const r=svg.getBoundingClientRect();
  if(V.k<0.7)V.k=0.9;V.tx=r.width/2-(n.x+n.w/2)*V.k;V.ty=r.height/2-(n.y+NODE_H/2)*V.k;applyTransform();}

// Pan the minimum amount needed to bring node n fully on screen (used by keyboard navigation,
// so the map doesn't jump around on every key press). Too far out to read? Centre and zoom in.
function panIntoView(n){
  const V=VIEWS[current];const svg=$("#graph");if(!svg)return;
  if(V.k<0.5){centerOn(n);return;}
  const W=svg.clientWidth,H=svg.clientHeight,m=40,top=60;   // top margin keeps clear of the toolbar
  const x1=n.x*V.k+V.tx,x2=(n.x+n.w+12)*V.k+V.tx;           // +12: the expand badge sticks out
  const y1=n.y*V.k+V.ty,y2=(n.y+NODE_H)*V.k+V.ty;
  if(x1<m)V.tx+=m-x1;else if(x2>W-m)V.tx-=x2-(W-m);
  if(y1<top)V.ty+=top-y1;else if(y2>H-m)V.ty-=y2-(H-m);
  applyTransform();
}

// Mouse/trackpad: drag to pan, wheel or pinch to zoom, horizontal scroll to pan, double-click to fit.
function attachPanZoom(svg,V){
  let drag=null;
  let justDragged=false;
  svg.addEventListener("pointerdown",e=>{hideHover();if(e.button!==0)return;drag={x:e.clientX,y:e.clientY,tx:V.tx,ty:V.ty,moved:false,id:e.pointerId};});
  svg.addEventListener("pointermove",e=>{if(!drag)return;const dx=e.clientX-drag.x,dy=e.clientY-drag.y;
    if(!drag.moved&&Math.abs(dx)+Math.abs(dy)>4){drag.moved=true;svg.classList.add("drag");try{svg.setPointerCapture(drag.id);}catch(_){}}
    if(drag.moved){V.tx=drag.tx+dx;V.ty=drag.ty+dy;applyTransform();}});
  const end=()=>{if(drag&&drag.moved){justDragged=true;setTimeout(()=>justDragged=false,0);}drag=null;svg.classList.remove("drag");};
  svg.addEventListener("pointerup",end);svg.addEventListener("pointercancel",end);
  svg.addEventListener("dblclick",e=>{if(!e.target.closest(".node"))fit();});
  svg.addEventListener("click",e=>{if(justDragged){e.stopPropagation();e.preventDefault();}},true);
  svg.addEventListener("wheel",e=>{e.preventDefault();hideHover();const r=svg.getBoundingClientRect();
    if(e.ctrlKey||e.metaKey||Math.abs(e.deltaY)>=Math.abs(e.deltaX)&&!e.shiftKey){zoomBy(Math.exp(-e.deltaY*0.0015),e.clientX-r.left,e.clientY-r.top);}
    else{V.tx-=e.deltaX;V.ty-=e.deltaY;applyTransform();}},{passive:false});
}
let selectedNode=null;

// Outline the selected node (solid) and other places the same entity appears (dashed),
// and highlight the edges from the selected node back to the root.
function markSelected(){
  const V=VIEWS[current];if(!V||!$("#vp"))return;
  for(const g of document.querySelectorAll(".node"))g.classList.remove("sel","twin");
  for(const p of document.querySelectorAll(".edge.hl"))p.classList.remove("hl");
  if(!selected)return;
  for(const n of V.byEnt.get(selected)||[]){
    const g=document.querySelector(`.node[data-k="${n.key}"]`);if(!g)continue;
    g.classList.add(n===selectedNode?"sel":"twin");
  }
  let n=selectedNode;
  if(n&&V.byEnt.get(selected)?.includes(n))while(n&&n.parent){const p=document.querySelector(`.edge[data-k="${n.key}"]`);if(p)p.classList.add("hl");n=n.parent;}
}

// Expand the ancestors of an entity's node in a view so it becomes visible. Returns that node.
function revealIn(viewName,eid,prefer){
  const V=VIEWS[viewName];const list=V.byEnt.get(eid);if(!list||!list.length)return null;
  const n=prefer&&list.includes(prefer)?prefer:list[0];
  let p=n.parent;while(p){V.expanded.add(p.key);p=p.parent;}
  return n;
}

// Which map an entity naturally lives in (null for vars, templates and files).
function homeView(e){
  if(!e||["var","template","file","script"].includes(e.type))return null;
  if(["host","group","inventory"].includes(e.type))return"inventory";
  if(e.type==="role")return current==="roles"?"roles":(VIEWS.playbooks.byEnt.has(e.id)&&current==="playbooks"?"playbooks":"roles");
  if(VIEWS.playbooks.byEnt.has(e.id))return"playbooks";
  if(VIEWS.roles.byEnt.has(e.id))return"roles";
  return null;
}

/* ==========================================================================
 * Search matches on the map
 *
 * While a search is active, matching nodes are tinted (see drawGraph). Matches inside
 * collapsed branches can't be seen, so a small bar on the map shows how many there are and
 * lets you step through them (N / Shift+N, or ‹ ›). Stepping expands the branch that holds
 * the match, selects it and centres it. "Show all" expands every branch with a match.
 * ========================================================================== */
let matchIdx=-1;            // index into mapMatches() of the match last stepped to (-1 = none yet)
const REVEAL_ALL_LIMIT=500; // "Show all" opens at most this many matches, so huge maps stay usable

// Nodes in the current map whose entity matches the search, in top-to-bottom tree order.
function mapMatches(){
  const V=VIEWS[current];
  if(!V||!searchHits.size)return[];
  return V.nodes.filter(n=>searchHits.has(n.e));   // V.nodes is in depth-first (display) order
}

// Expand every ancestor of n so it's visible.
function expandTo(n){const V=VIEWS[current];for(let p=n.parent;p;p=p.parent)V.expanded.add(p.key);}

// Redraw the match bar (called at the end of every drawGraph).
function updateMatchBar(){
  const bar=$("#matchbar");if(!bar)return;
  const all=mapMatches();
  if(!all.length){bar.style.display="none";return;}
  const shown=new Set(VIEWS[current].laid);
  const hidden=all.filter(n=>!shown.has(n)).length;
  const where=matchIdx>=0&&matchIdx<all.length?`${matchIdx+1} of ${all.length}`:`${all.length} match${all.length===1?"":"es"}`;
  bar.style.display="";
  bar.replaceChildren(...[             // filter: replaceChildren() would print null as text
    el("span",{class:"mb-count"},where,hidden?el("span",{class:"note"},` · ${hidden} in collapsed branches`):null),
    el("button",{class:"btn",title:"Previous match (Shift+N)","aria-label":"Previous match",onclick:()=>stepMatch(-1)},"‹"),
    el("button",{class:"btn",title:"Next match (N)","aria-label":"Next match",onclick:()=>stepMatch(1)},"›"),
    hidden?el("button",{class:"btn",title:"Expand the branches that contain matches",onclick:revealAllMatches},"Show all"):null,
    el("button",{class:"btn",title:"Clear the search (Esc)","aria-label":"Clear search",onclick:clearSearch},"✕")].filter(Boolean));
}

// Go to the next (d=1) or previous (d=-1) match, wrapping around.
function stepMatch(d){
  const all=mapMatches();if(!all.length)return;
  matchIdx=matchIdx<0?(d>0?0:all.length-1):(matchIdx+d+all.length)%all.length;
  const n=all[matchIdx];
  expandTo(n);
  drawGraph();
  select(n.e,{node:n});
  centerOn(n);
}

// Expand every branch that contains a match, then fit the map.
function revealAllMatches(){
  mapMatches().slice(0,REVEAL_ALL_LIMIT).forEach(expandTo);
  drawGraph();fit();
}

// Empty the search box and remove all match highlighting.
function clearSearch(){const q=$("#q");q.value="";doSearch("");}

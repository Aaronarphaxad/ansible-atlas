/* ==========================================================================
 * Map keyboard navigation
 *
 *   ←          go to the parent node
 *   →          go to the first child (expanding the node first if needed)
 *   ↑ / ↓      previous / next visible node in the same column
 *   Enter/Space expand or collapse the selected node
 *
 * Moving selects the node (so the details panel follows) and pans just enough to keep it
 * on screen. The first key press on a map with nothing selected starts at the root.
 * Wired up from boot.js's keydown handler.
 * ========================================================================== */
const MAP_KEYS=["ArrowLeft","ArrowRight","ArrowUp","ArrowDown","Enter"," "];

// The node keyboard moves start from: the selected node, or its nearest visible ancestor
// if it's inside a collapsed branch. null when nothing in this map is selected.
function keyboardNode(V){
  let n=selectedNode;
  if(!n||!(V.byEnt.get(n.e)||[]).includes(n))return null;   // selection belongs to another map
  const shown=new Set(V.laid);
  while(n&&!shown.has(n))n=n.parent;
  return n;
}

// Select a node from the keyboard and keep it in view.
function keySelect(n){select(n.e,{node:n});panIntoView(n);}

// Handle one keydown on a map tab. Returns true if the key was used.
function handleMapKey(e){
  const V=VIEWS[current];
  if(!V||!$("#vp")||!MAP_KEYS.includes(e.key)||e.altKey||document.querySelector(".overlay"))return false;
  // Enter/Space on a focused button or link should still press it.
  if((e.key==="Enter"||e.key===" ")&&e.target.closest&&e.target.closest("button,a,summary"))return false;
  e.preventDefault();
  const n=keyboardNode(V);
  if(!n){keySelect(V.root);return true;}
  switch(e.key){
    case"ArrowLeft":
      if(n.parent)keySelect(n.parent);
      break;
    case"ArrowRight":
      if(!n.kids.length)break;
      if(!V.expanded.has(n.key))toggle(n);
      keySelect(n.kids[0]);
      break;
    case"ArrowUp":case"ArrowDown":{
      const column=V.laid.filter(m=>m.depth===n.depth).sort((a,b)=>a.y-b.y);
      const next=column[column.indexOf(n)+(e.key==="ArrowUp"?-1:1)];
      if(next)keySelect(next);
      break;
    }
    default:                                                   // Enter / Space
      if(n.kids.length){toggle(n);panIntoView(n);}
  }
  return true;
}

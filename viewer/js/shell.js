/* ==========================================================================
 * Page shell: details panel visibility and the shortcuts overlay
 *
 *
 * ========================================================================== */
// Show or hide the details panel (remembered across visits).
function setDetailHidden(h){
  document.body.classList.toggle("nodetail",h);
  try{localStorage.setItem("atlas-detail-hidden",h?"1":"0");}catch(_){}
  if(VIEWS[current])requestAnimationFrame(()=>applyTransform());
}

// The keyboard shortcuts overlay (?).
function showShortcuts(){
  if(document.querySelector(".overlay"))return;
  const rows=[["/","Search"],["1 – 6","Switch tab (Playbooks, Roles, Inventory, Run plan, Files, Overview)"],
    ["← · →","Map: go to parent · go to first child (expands it)"],["↑ · ↓","Map: previous · next node in the same column"],
    ["Enter · Space","Map: expand / collapse the selected node"],["N · Shift+N","Map: next · previous search match"],
    ["F","Fit the map to the screen"],["Double-click","Fit (on empty map space) · expand/collapse (on a node)"],
    ["Drag · scroll","Pan · zoom the map"],["]","Show / hide the details panel"],["Backspace · Alt+←","Back to the previous item"],
    ["T","Light / dark mode"],["Esc","Close search, menus and this help"],["?","This help"]];
  const ov=el("div",{class:"overlay",onclick:e=>{if(e.target===ov)ov.remove();}},
    el("div",{class:"sheet",role:"dialog","aria-label":"Keyboard shortcuts"},el("h2",null,"Keyboard shortcuts"),
      el("table",null,rows.map(([k,d])=>el("tr",null,el("td",null,...k.split(" · ").map((x,i)=>[i?" · ":"",el("span",{class:"kbd"},x)])),el("td",null,d)))),
      el("p",{class:"note",style:"margin:12px 0 0"},"Read-only explorer: nothing is executed and nothing leaves this page.")));
  document.body.append(ov);
}

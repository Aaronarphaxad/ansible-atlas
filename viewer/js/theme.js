/* ==========================================================================
 * Light / dark theme
 *
 * Applied immediately so the page never flashes the wrong theme.
 * ========================================================================== */
// Saved theme, dark by default.
function getTheme(){try{return localStorage.getItem("atlas-theme")||"dark";}catch(_){return "dark";}}

// Apply and remember a theme.
function setTheme(t){document.documentElement.dataset.theme=t;try{localStorage.setItem("atlas-theme",t);}catch(_){}
  const b=document.getElementById("themeBtn");if(b){b.textContent=t==="dark"?"☀":"☾";b.setAttribute("aria-label",t==="dark"?"Switch to light mode":"Switch to dark mode");}}

// Switch between light and dark.
function toggleTheme(){setTheme(document.documentElement.dataset.theme==="dark"?"light":"dark");}
setTheme(getTheme());

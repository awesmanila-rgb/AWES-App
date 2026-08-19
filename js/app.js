// AWES Service Report App - runtime bundle entry point.
// Source modules live in js/modules-src/. Run build.py to rebuild the bundle.
(function(){
  "use strict";
  const modules = [
    "core.js","auth.js","service-report.js","customers.js","admin.js",
    "email.js","ui.js","pdf.js","history.js","leave.js","dispatch.js",
    "cash-advance.js","home.js"
  ];
  // The generated bundle is used for production so existing behavior and load order stay identical.
  // This file is intentionally tiny; edit source modules, then run build.py.
  const s = document.createElement("script");
  s.src = "js/app.bundle.js";
  s.defer = false;
  document.head.appendChild(s);
})();

const navigate = () => {
  return new Promise((cb) => {
    if (location.pathname.endsWith("/clock.html")) {
      if (location.hash.length > 1) {
        location.replace("./verify.html"+location.hash);
      } else {
        history.replaceState(null, "", location.pathname.slice(0,0-"clock.html".length));
        cb();
      }
    } else if (location.pathname.endsWith("/verify.html")) {
      if (location.hash.length<2) {
        location.replace("./clock.html");
      } else {
        history.replaceState(null, "", location.pathname.slice(0,0-"verify.html".length)+location.hash);
        cb();
      }
    } else {
      if (location.hash.length<2) {
        location.replace("./clock.html");
      } else {
        location.replace("./verify.html"+location.hash);
      }
    }
  });
};
window.addEventListener("hashchange", navigate);
export default navigate();

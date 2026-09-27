// Some constrained Windows hosts fail uv_os_get_passwd even though USERNAME is
// available. tsx only needs a stable per-user temporary-directory suffix.
if (process.platform === "win32" && typeof process.geteuid !== "function") {
  process.geteuid = () => 0;
}

// CLI workers and node:test are server runtimes. The marker package deliberately
// throws outside Next's bundler, so make it a no-op in these Node entry points.
const Module = module.constructor;
const originalLoad = Module._load;
Module._load = function loadForCli(request, parent, isMain) {
  if (request === "server-only") return {};
  return originalLoad.call(this, request, parent, isMain);
};

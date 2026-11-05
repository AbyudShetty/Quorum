// Keep this independent of dependencies: an old runtime must get an actionable error before
// loading native modules or syntax/APIs it cannot support. Odd majors and prereleases are valid.
export const runtimeError = (version, napi) => {
  const parts = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (parts && Number(napi) >= 10) {
    const major = Number(parts[1]);
    const minor = Number(parts[2]);
    if (major > 23 || (major === 23 && minor >= 6) || (major === 22 && minor >= 14))
      return undefined;
  }
  return `Quorum requires Node-API 10: Node.js 22.14+, 23.6+, or any newer major. Found Node ${version} (Node-API ${napi ?? 'unavailable'}). Update your existing Node line; Node 24 specifically is not required.`;
};

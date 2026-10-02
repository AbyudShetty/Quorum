// Windows ACL checks for the private data directory (INV-25). Works with security identifiers
// (SIDs), not account names, so it behaves the same on every Windows language.
// Note: a fresh folder under %LOCALAPPDATA% can inherit read access for other local groups
// (seen in practice: "CodexSandboxUsers"), so Quorum sets the ACL itself instead of trusting defaults.
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

// Full paths: with Git for Windows on PATH, a bare "whoami" can resolve to Git's Unix whoami.
const system32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
const WHOAMI = join(system32, 'whoami.exe');
const ICACLS = join(system32, 'icacls.exe');
const POWERSHELL = join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe');

export const SYSTEM_SID = 'S-1-5-18';
export const ADMINISTRATORS_SID = 'S-1-5-32-544';

let userSid: Promise<string> | undefined;

/** The SID of the user running this process (looked up once). */
export const currentUserSid = (): Promise<string> => {
  userSid ??= run(WHOAMI, ['/user', '/fo', 'csv', '/nh'], { windowsHide: true }).then(
    ({ stdout }) => {
      const sid = /"(S-1-[0-9-]+)"/.exec(stdout)?.[1];
      if (!sid) throw new Error('could not determine the current Windows user SID');
      return sid;
    },
  );
  return userSid;
};

/**
 * Environment for Windows PowerShell 5.1: no PSModulePath, because one inherited from
 * PowerShell 7 (e.g. a pwsh terminal or GitHub Actions) breaks 5.1's module loading.
 */
const powershellEnv = (extra: Record<string, string>): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'PSMODULEPATH'),
  ),
  ...extra,
});

export interface AllowEntry {
  sid: string;
  /** Inherited from the parent folder (removed by /inheritance:r) rather than set on this one. */
  inherited: boolean;
}

/**
 * The "allow" entries on `path`. The path is passed through the environment, never spliced into
 * the script, so unusual folder names cannot inject PowerShell.
 */
export const allowEntries = async (path: string): Promise<AllowEntry[]> => {
  // Plain .NET (no Get-Acl), so no PowerShell module has to load; rules come back as SIDs.
  const script = [
    "$ErrorActionPreference='Stop';",
    '$acl = [System.IO.Directory]::GetAccessControl($env:QUORUM_ACL_PATH);',
    '$acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) |',
    " Where-Object { $_.AccessControlType -eq 'Allow' } |",
    " ForEach-Object { $_.IdentityReference.Value + '|' + $_.IsInherited }",
  ].join('');
  const { stdout } = await run(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: powershellEnv({ QUORUM_ACL_PATH: path }),
    windowsHide: true,
  });
  const entries = new Map<string, AllowEntry>();
  for (const line of stdout.split(/\r?\n/)) {
    const [sid, inherited] = line.trim().split('|');
    if (!sid) continue;
    const entry = { sid, inherited: inherited === 'True' };
    // A SID with both an explicit and an inherited entry counts as explicit: it survives /inheritance:r.
    if (!entries.has(sid) || !entry.inherited) entries.set(sid, entry);
  }
  return [...entries.values()];
};

/** The SIDs allowed on a private directory. */
export const privateSids = (userSid: string): string[] => [userSid, SYSTEM_SID, ADMINISTRATORS_SID];

/** Entries for anyone other than the private SIDs. */
export const otherEntries = async (path: string, userSid: string): Promise<AllowEntry[]> =>
  (await allowEntries(path)).filter((entry) => !privateSids(userSid).includes(entry.sid));

/**
 * The icacls argument lists that make `path` private: stop inheriting and grant only the private
 * SIDs, then remove explicit grants to anyone else (inherited ones are gone after the first step).
 */
export const lockDownCommands = (
  path: string,
  userSid: string,
  explicitOthers: readonly string[],
): string[][] => [
  [path, '/inheritance:r', '/grant:r', ...privateSids(userSid).map((sid) => `*${sid}:(OI)(CI)F`)],
  ...explicitOthers.map((sid) => [path, '/remove:g', `*${sid}`]),
];

/** Restrict `path` (and everything created inside it) to the current user, SYSTEM and Administrators. */
export const lockDown = async (path: string, userSid: string): Promise<void> => {
  const explicit = (await otherEntries(path, userSid))
    .filter((e) => !e.inherited)
    .map((e) => e.sid);
  for (const args of lockDownCommands(path, userSid, explicit)) {
    await run(ICACLS, args, { windowsHide: true });
  }
};

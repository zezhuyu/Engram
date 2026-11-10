import * as fs from 'node:fs/promises';
import path from 'node:path';

export const MANAGED_SHIM_HEADER = '# engram-managed-shim v1';

export function shimSource(): string {
  return `#!/bin/sh\n${MANAGED_SHIM_HEADER}\nset -eu\n\nfind_app() {\n  for app_name in "Engram Server.app" "Engram Client.app"; do\n    for root in "${'${ENGRAM_APP_SEARCH_ROOT:-/Applications}'}" "${'${HOME}'}/Applications"; do\n      app="$root/$app_name"\n      if [ -x "$app/Contents/Resources/backend/runtime/bin/node" ] && [ -f "$app/Contents/Resources/backend/app/bin/mdb.js" ]; then\n        printf '%s\\n' "$app"\n        return 0\n      fi\n    done\n  done\n  return 1\n}\n\nAPP="$(find_app)" || { echo 'mdb: no Engram Server or Client app found in /Applications or ~/Applications' >&2; exit 127; }\nNODE="$APP/Contents/Resources/backend/runtime/bin/node"\nMDB="$APP/Contents/Resources/backend/app/bin/mdb.js"\ncase "$APP" in\n  */Engram\\ Server.app)\n    if [ -z "\${ENGRAM_DATA_DIR:-}" ]; then\n      CONFIG="\${XDG_CONFIG_HOME:-$HOME/.config}/engram/server.env"\n      if [ -r "$CONFIG" ]; then\n        VALUE="$(awk -F= '/^[[:space:]]*(export[[:space:]]+)?ENGRAM_DATA_DIR[[:space:]]*=/ { sub(/^[^=]*=/, ""); gsub(/^[ \t]+|[ \t]+$/, ""); print; exit }' "$CONFIG")"\n        VALUE="${'${VALUE#\\"}'}"; VALUE="${'${VALUE%\\"}'}"; VALUE="${'${VALUE#\\\'}'}"; VALUE="${'${VALUE%\\\'}'}"\n        if [ -n "$VALUE" ]; then ENGRAM_DATA_DIR="$VALUE"; else ENGRAM_DATA_DIR="$HOME/.Engram"; fi\n      else ENGRAM_DATA_DIR="$HOME/.Engram"; fi\n      export ENGRAM_DATA_DIR\n    fi\n    ;;\nesac\nexec "$NODE" "$MDB" "$@"\n`;
}

export interface ShimOptions { action: 'install' | 'status' | 'remove'; home?: string; dir?: string; pathValue?: string; dryRun?: boolean; json?: boolean }

export async function manageShim(options: ShimOptions): Promise<unknown> {
  const home = path.resolve(options.home ?? process.env.HOME ?? '');
  if (!home || home === '.') throw new Error('HOME is unavailable');
  const directory = path.resolve(options.dir ?? path.join(home, '.local/bin'));
  const file = path.join(directory, 'mdb');
  const pathValue = options.pathValue ?? process.env.PATH ?? '';
  const onPath = pathValue.split(path.delimiter).some(item => path.resolve(item || '.') === directory);
  const current = await fs.readFile(file, 'utf8').catch(() => undefined);
  const managed = current?.split(/\r?\n/).slice(0, 2).includes(MANAGED_SHIM_HEADER) ?? false;
  const suggestion = `export PATH="${directory}:$PATH"`;
  const result = (state: string, reason?: string) => ({ action: options.action, path: file, installed: state === 'installed', managed, onPath, pathSuggestion: onPath ? null : suggestion, ...(reason ? { reason } : {}) });
  if (options.action === 'status') return result(managed ? 'installed' : current === undefined ? 'missing' : 'foreign', current !== undefined && !managed ? 'existing mdb is not Engram-managed' : undefined);
  if (options.action === 'remove') {
    if (!managed) return result(current === undefined ? 'missing' : 'foreign', current === undefined ? undefined : 'existing mdb is not Engram-managed; left untouched');
    if (!options.dryRun) await fs.rm(file);
    return result(options.dryRun ? 'installed' : 'missing', options.dryRun ? 'dry run; managed shim would be removed' : undefined);
  }
  if (current !== undefined && !managed) return result('foreign', 'existing mdb is not Engram-managed; left untouched');
  const source = shimSource();
  if (current === source) return result('installed');
  if (options.dryRun) return result('installed', 'dry run; shim would be installed or refreshed');
  await fs.mkdir(directory, { recursive: true, mode: 0o755 });
  const temp = path.join(directory, `.mdb.${process.pid}.${Date.now()}.tmp`);
  try {
    await fs.writeFile(temp, source, { mode: 0o755, flag: 'wx' });
    await fs.chmod(temp, 0o755);
    const latest = await fs.readFile(file, 'utf8').catch(() => undefined);
    if (latest !== undefined && !latest.split(/\r?\n/).slice(0, 2).includes(MANAGED_SHIM_HEADER)) {
      await fs.rm(temp, { force: true });
      return result('foreign', 'existing mdb is not Engram-managed; left untouched');
    }
    await fs.rename(temp, file);
  } catch (error) {
    await fs.rm(temp, { force: true });
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`Could not create temporary shim in ${directory}`);
    throw error;
  }
  return result('installed');
}

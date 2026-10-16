export function toKey(path: string): string {
  return path.normalize('NFC').toLowerCase();
}

export function toRemotePath(root: string, path: string): string {
  const cleanRoot = root.replace(/^\/+|\/+$/g, '').normalize('NFC');
  const cleanPath = path.replace(/^\/+|\/+$/g, '').normalize('NFC');
  if (!cleanRoot) {
    return cleanPath ? `/${cleanPath}` : '';
  }
  return cleanPath ? `/${cleanRoot}/${cleanPath}` : `/${cleanRoot}`;
}

export function fromRemotePath(root: string, pathDisplay: string): string | null {
  const cleanRoot = root.replace(/^\/+|\/+$/g, '').normalize('NFC');
  const normDisplay = pathDisplay.normalize('NFC');
  if (!cleanRoot) {
    const stripped = normDisplay.replace(/^\/+/, '');
    return stripped.length > 0 ? stripped : null;
  }
  const expectedPrefix = `/${cleanRoot}/`;
  if (normDisplay.length <= expectedPrefix.length) {
    return null;
  }
  const actualPrefix = normDisplay.slice(0, expectedPrefix.length);
  if (toKey(actualPrefix) !== toKey(expectedPrefix)) {
    return null;
  }
  const remainder = normDisplay.slice(expectedPrefix.length);
  return remainder.length > 0 ? remainder : null;
}

export function conflictName(path: string, when: Date, device: string): string {
  const slashIdx = path.lastIndexOf('/');
  const dir = slashIdx === -1 ? '' : path.slice(0, slashIdx + 1);
  const base = slashIdx === -1 ? path : path.slice(slashIdx + 1);

  const dotIdx = base.lastIndexOf('.');
  const stem = dotIdx > 0 ? base.slice(0, dotIdx) : base;
  const ext = dotIdx > 0 ? base.slice(dotIdx) : '';

  const yyyy = String(when.getFullYear()).padStart(4, '0');
  const mm = String(when.getMonth() + 1).padStart(2, '0');
  const dd = String(when.getDate()).padStart(2, '0');
  const hh = String(when.getHours()).padStart(2, '0');
  const min = String(when.getMinutes()).padStart(2, '0');

  return `${dir}${stem} (conflict ${yyyy}-${mm}-${dd} ${hh}${min} ${device})${ext}`;
}

export function isMarkdown(path: string): boolean {
  return path.toLowerCase().endsWith('.md');
}

export function parentDir(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? '' : path.slice(0, idx);
}

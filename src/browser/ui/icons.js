const paths = {
  folder: '<path d="M3 7.5h6l2-2h3.5A2.5 2.5 0 0 1 17 8v8.5A2.5 2.5 0 0 1 14.5 19h-11A2.5 2.5 0 0 1 1 16.5V10a2.5 2.5 0 0 1 2-2.5Z"/><path d="M1.5 10h17"/>',
  save: '<path d="M4 2h10l4 4v12H2V2h2Z"/><path d="M6 2v5h8V3.5M6 18v-6h8v6"/>',
  print: '<path d="M5 8V2h10v6M5 16H3a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-2"/><path d="M5 13h10v6H5z"/>',
  undo: '<path d="m7 6-4 4 4 4"/><path d="M4 10h8a5 5 0 0 1 5 5v1"/>',
  redo: '<path d="m13 6 4 4-4 4"/><path d="M16 10H8a5 5 0 0 0-5 5v1"/>',
  cursor: '<path d="M5 2 16 11l-5 .8L8 17 5 2Z"/>',
  hand: '<path d="M6 10V6a1.5 1.5 0 0 1 3 0v3-5a1.5 1.5 0 0 1 3 0v5-3a1.5 1.5 0 0 1 3 0v5-2a1.5 1.5 0 0 1 3 0v4c0 4-2.5 6-6.5 6H10c-2 0-3.2-.7-4.4-2.2L2.4 13a1.6 1.6 0 0 1 2.4-2.1L6 12"/>',
  comment: '<path d="M3 3h14v11H8l-5 4V3Z"/><path d="M6 7h8M6 10h5"/>',
  pen: '<path d="m4 16 1-4L14 3l3 3-9 9-4 1Z"/><path d="m12 5 3 3M3 19h14"/>',
  image: '<rect x="2" y="3" width="16" height="14" rx="1"/><circle cx="7" cy="8" r="1.5"/><path d="m3 15 4-4 3 3 2-2 5 5"/>',
  link: '<path d="m8 12 4-4"/><path d="M6.5 14.5 4 17a3 3 0 0 1-4-4l3-3a3 3 0 0 1 4 0M13.5 5.5 16 3a3 3 0 0 1 4 4l-3 3a3 3 0 0 1-4 0"/>',
  export: '<path d="M11 3h6v6"/><path d="m17 3-8 8M15 12v6H2V5h6"/>',
  share: '<path d="M10 13V2m0 0L6 6m4-4 4 4"/><path d="M4 9H2v10h16V9h-2"/>',
  search: '<circle cx="9" cy="9" r="6"/><path d="m14 14 5 5"/>',
  pages: '<path d="M5 1h10v18H5z"/><path d="M8 5h4M8 9h4M8 13h4"/>',
  bookmark: '<path d="M5 2h10v17l-5-3-5 3V2Z"/>',
  layers: '<path d="m10 2 8 4-8 4-8-4 8-4Z"/><path d="m2 10 8 4 8-4M2 14l8 4 8-4"/>',
  grid: '<path d="M2 2h6v6H2zM12 2h6v6h-6zM2 12h6v6H2zM12 12h6v6h-6z"/>',
  stamp: '<path d="M7 12V8a3 3 0 1 1 6 0v4l3 2v2H4v-2l3-2Z"/><path d="M3 19h14"/>',
  settings: '<circle cx="10" cy="10" r="3"/><path d="M10 1v3m0 12v3M1 10h3m12 0h3M3.6 3.6l2.1 2.1m8.6 8.6 2.1 2.1m0-12.8-2.1 2.1m-8.6 8.6-2.1 2.1"/>',
  plugin: '<path d="M8 2h4v4a2 2 0 1 0 4 0V2h2v6h-4v4h4v6h-6v-4H8v4H2v-6h4V8H2V2h6v4a2 2 0 1 0 0-4Z"/>',
  help: '<circle cx="10" cy="10" r="9"/><path d="M7.7 7a2.5 2.5 0 1 1 3.1 2.4c-.8.3-.8.9-.8 1.6M10 15h.01"/>',
  plus: '<path d="M10 3v14M3 10h14"/>',
  minus: '<path d="M3 10h14"/>',
  rotate: '<path d="M16 7V2l-2 2a7 7 0 1 0 2 9"/><path d="M11 2h5v5"/>',
  fullscreen: '<path d="M7 2H2v5M13 2h5v5M7 18H2v-5M13 18h5v-5"/>',
  chevronDown: '<path d="m5 8 5 5 5-5"/>',
  close: '<path d="m4 4 12 12M16 4 4 16"/>',
  warning: '<path d="M10 2 1 18h18L10 2Z"/><path d="M10 7v5m0 3h.01"/>',
  check: '<circle cx="10" cy="10" r="8"/><path d="m6 10 2.5 2.5L14 7"/>',
  file: '<path d="M4 1h8l4 4v14H4V1Z"/><path d="M12 1v5h4"/>',
  lock: '<rect x="3" y="9" width="14" height="10" rx="1"/><path d="M6 9V6a4 4 0 0 1 8 0v3"/>',
  eye: '<path d="M1 10s3-5 9-5 9 5 9 5-3 5-9 5-9-5-9-5Z"/><circle cx="10" cy="10" r="2.5"/>',
  trash: '<path d="M3 5h14M8 2h4l1 3H7l1-3ZM5 5l1 13h8l1-13"/>',
};

function ownPath(name) {
  return Object.getOwnPropertyDescriptor(paths, name)?.value;
}

function escapeAttribute(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

export function icon(name, label = '') {
  const path = ownPath(name) ?? paths.help;
  const aria = label ? `role="img" aria-label="${escapeAttribute(label)}"` : 'aria-hidden="true"';
  return `<svg class="icon" viewBox="0 0 20 20" ${aria} fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
}

import { icon } from '../icons.js';

export function inspectorShell(document, content) {
  return `<aside class="inspector" aria-label="Document details">
    <div class="panel-header"><span>Document</span>${document.isOpen ? `<button class="icon-button" data-action="close-file" aria-label="Close document">${icon('close')}</button>` : ''}</div>
    <div class="panel-content">${content}</div>
  </aside>`;
}

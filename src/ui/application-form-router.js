import { createApplicationChangeHandler } from './application-form-change-handler.js';
import { createApplicationInputHandler } from './application-form-input-handler.js';

export function bindApplicationFormEvents({
  root,
  state,
  controllers,
  document: documentApi = globalThis.document,
  render,
}) {
  if (!root || !state || !controllers || !documentApi || typeof render !== 'function') {
    throw new TypeError('Application form router requires UI roots, controllers, and render.');
  }

  const handleChange = createApplicationChangeHandler({ state, controllers, render });
  const handleInput = createApplicationInputHandler({
    state,
    ocr: controllers.ocr,
    viewer: controllers.viewer,
    documentApi,
    render,
  });
  root.addEventListener('change', handleChange);
  root.addEventListener('input', handleInput);

  return () => {
    root.removeEventListener('change', handleChange);
    root.removeEventListener('input', handleInput);
  };
}

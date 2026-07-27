import { HostError } from '../host-error.mjs';
import {
  AUTOMATION_INSPECT_PRESET,
  AUTOMATION_OCR_PRESET,
  AUTOMATION_OUTPUT_INTENT_PRESET,
} from './automation-operation-contract.mjs';

function selection(kind, id) {
  return Object.freeze({ kind, id, pages: null });
}

function step(id, operation) {
  return Object.freeze({ id, operation });
}

function descriptor(id, steps) {
  return Object.freeze({ schemaVersion: 1, id, version: 1, steps: Object.freeze(steps) });
}

const RECIPES = new Map([
  ['inspect-document-v1', descriptor('inspect-document-v1', [
    step('inspect', selection('preset', AUTOMATION_INSPECT_PRESET)),
  ])],
  ['ocr-english-document-v1', descriptor('ocr-english-document-v1', [
    step('ocr', selection('preset', AUTOMATION_OCR_PRESET)),
  ])],
  ['assign-cmyk-output-intent-v1', descriptor('assign-cmyk-output-intent-v1', [
    step('output-intent', selection('preset', AUTOMATION_OUTPUT_INTENT_PRESET)),
  ])],
]);

export const AUTOMATION_JS_RECIPE_IDS = Object.freeze([...RECIPES.keys()].sort());

export class AutomationJsRecipeRegistry {
  descriptor(id, version = 1) {
    const value = RECIPES.get(id);
    if (!value || version !== 1) {
      throw new HostError('AUTOMATION_JS_RECIPE_DENIED', 'Declarative recipe is not allowlisted.', 403);
    }
    return value;
  }

  list() {
    return Object.freeze(AUTOMATION_JS_RECIPE_IDS.map((id) => {
      const value = RECIPES.get(id);
      return Object.freeze({ id: value.id, version: value.version, stepCount: value.steps.length });
    }));
  }
}

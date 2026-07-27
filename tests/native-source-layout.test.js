import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const sourceRoot = join(root, 'native/pdfkit-helper/Sources/PDFKitInspector');
const responsibilityFiles = [
  'CommandDispatch.swift',
  'ProtocolModels.swift',
  'ProtocolRequestModels.swift',
  'ProtocolResponseModels.swift',
  'InspectionModels.swift',
  'RequestValidation.swift',
  'ValidationPrimitives.swift',
  'StandardMutationValidation.swift',
  'TargetedAnnotationValidation.swift',
  'NavigationOutlineRequestValidation.swift',
  'DrawingAnnotationRequestValidation.swift',
  'ProtectionMetadataValidation.swift',
  'AecValidation.swift',
  'WorkspaceIO.swift',
  'Inspection.swift',
  'PageInspection.swift',
  'NavigationInspection.swift',
  'ResponseEncoding.swift',
  'StandardMutation.swift',
  'PageMutationSupport.swift',
  'RawDocumentSafety.swift',
  'DocumentActionSafety.swift',
  'RawNavigationSafety.swift',
  'RawMarkupSafety.swift',
  'SafetySnapshots.swift',
  'Protection.swift',
  'Deprotection.swift',
  'MetadataSanitization.swift',
  'MetadataInfoDictionaryScrubber.swift',
  'TargetedMutation.swift',
  'TargetedAnnotationResolution.swift',
  'FormWidgetSupport.swift',
  'RawPdfDictionaryValues.swift',
  'CheckboxWidgetSupport.swift',
  'ChoiceWidgetSupport.swift',
  'AnnotationSanitization.swift',
  'RadioMutation.swift',
  'AecMutation.swift',
  'AecGeometry.swift',
  'NavigationAnnotationMutation.swift',
  'NavigationAnnotationRemoval.swift',
  'OutlineBookmarkMutation.swift',
  'OutlineBookmarkRemovalModels.swift',
  'OutlineBookmarkRemovalBlueprint.swift',
  'OutlineBookmarkRemovalSnapshot.swift',
  'OutlineBookmarkRemoval.swift',
  'LineAnnotationMutation.swift',
  'InkAnnotationMutation.swift',
];

function source(name) {
  return readFileSync(join(sourceRoot, name), 'utf8');
}

function lineCount(value) {
  return value.split(/\r?\n/u).length;
}

test('native PDFKit helper stays decomposed by trust responsibility', () => {
  const main = source('main.swift');
  assert.ok(lineCount(main) <= 10, `main.swift must remain an entry point only; found ${lineCount(main)} lines`);
  assert.match(main, /^dispatchCommand\(\)\s*$/u);
  for (const name of responsibilityFiles) {
    const value = source(name);
    assert.ok(lineCount(value) <= 400, `${name} exceeded the 400-line responsibility-file bound`);
    assert.doesNotMatch(value, /^\s*public\s/mu, `${name} must not add a public package API`);
  }
});

test('native protection removal remains owner-gated and fresh-copy only', () => {
  const dispatch = source('CommandDispatch.swift');
  const deprotection = source('Deprotection.swift');
  assert.match(dispatch, /--protect-stdin/u);
  assert.match(dispatch, /--remove-protection-stdin/u);
  const ownerGate = deprotection.indexOf('source.permissionsStatus == .owner');
  const freshDocument = deprotection.indexOf('let target = PDFDocument()');
  assert.ok(ownerGate >= 0 && freshDocument > ownerGate, 'owner authorization must precede target construction');
  assert.doesNotMatch(deprotection, /source\.dataRepresentation\s*\(/u);
  assert.match(deprotection, /target\.dataRepresentation\s*\(\)/u);
  assert.match(deprotection, /allowed: allowingVersion \? \["Type", "Pages", "Outlines", "Version"\]/u);
  assert.match(deprotection, /allowed: allowingVersion \?[^:]+: \["Type", "Pages", "Outlines"\]/su);
});

test('native metadata sanitization blanks only a strict PDFKit-injected Info dictionary', () => {
  const dispatch = source('CommandDispatch.swift');
  const sanitization = source('MetadataSanitization.swift');
  const scrubber = source('MetadataInfoDictionaryScrubber.swift');
  assert.match(dispatch, /--sanitize-metadata-stdin/u);
  assert.match(sanitization, /let target = PDFDocument\(\)/u);
  assert.doesNotMatch(sanitization, /source\.dataRepresentation\s*\(/u);
  assert.match(sanitization, /removeInjectedInfoDictionary\(from: written\)/u);
  assert.match(scrubber, /func removeInjectedInfoDictionary\(from data: Data\)/u);
  assert.match(sanitization, /metadataAbsent\(reopened\)/u);
  assert.match(sanitization, /outputSnapshot == sourceSnapshot/u);
});

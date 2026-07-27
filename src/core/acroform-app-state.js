export function acroFormAppState() {
  return {
    acroFormTextFieldName: 'text-1',
    acroFormTextFieldPage: '1',
    acroFormTextFieldRect: { x: 36, y: 36, width: 180, height: 24 },
    acroFormCheckboxFieldName: 'check-1',
    acroFormCheckboxPage: '1',
    acroFormCheckboxRect: { x: 36, y: 36, width: 18, height: 18 },
    acroFormRadioGroupName: 'choice-1',
    acroFormRadioOptions: [
      { label: 'Option 1', page: '1', rect: { x: 36, y: 36, width: 18, height: 18 } },
      { label: 'Option 2', page: '1', rect: { x: 36, y: 64, width: 18, height: 18 } },
    ],
    acroFormChoiceFieldName: 'list-1',
    acroFormChoicePage: '1',
    acroFormChoiceRect: { x: 36, y: 100, width: 180, height: 24 },
    acroFormChoiceOptions: [{ label: 'Option 1' }, { label: 'Option 2' }],
    acroFormStatus: 'idle',
    acroFormError: null,
    acroFormResult: null,
  };
}

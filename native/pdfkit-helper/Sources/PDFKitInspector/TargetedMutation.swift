import Foundation
import PDFKit
import Darwin
private func targetedMutationCanApply(_ mutation: TargetedMutation, document: PDFDocument, sourceDigest: String) -> Bool {
    guard !targetedDocumentContainsUnsafeContent(document) else { return false }
    if let edit = mutation.formFill {
        guard !document.isLocked, document.allowsFormFieldEntry,
              let target = resolveTargetedAnnotation(
                  document: document, sourceDigest: sourceDigest, page: edit.page, annotationIndex: edit.annotationIndex,
                  fingerprint: edit.fingerprint, expectedSubtype: "widget", expectedWidgetType: edit.fieldType
              ), !target.annotation.isPasswordField,
              !annotationHasActionOrAdditionalActions(target.annotation)
        else { return false }
        if edit.fieldType == "button", widgetControlKind(target.annotation, fieldType: "button") == "radio" {
            guard edit.value == "select",
                  radioSelectionCanApply(
                      document: document, page: edit.page, annotationIndex: edit.annotationIndex, annotation: target.annotation
                  )
            else { return false }
            return true
        }
        guard let fieldName = resolvedFieldName(target.annotation),
              !target.annotation.isReadOnly,
              rawTerminalWidgetMatches(
                  document: document, page: edit.page, annotationIndex: edit.annotationIndex,
                  expectedFieldType: edit.fieldType, expectedFieldName: fieldName,
                  requireDirectObject: true
              ), !hasAmbiguousFieldName(fieldName, target: target.annotation, in: document)
        else { return false }
        if edit.fieldType == "text" {
            guard target.annotation.widgetStringValue != edit.value,
                  widgetFlags(target.annotation) & (textFileSelectFlag | textRichTextFlag) == 0 else { return false }
            return target.annotation.maximumLength == 0 || edit.value.count <= target.annotation.maximumLength
        }
        if edit.fieldType == "button" {
            guard let states = checkboxAppearanceStates(
                document: document, page: edit.page, annotationIndex: edit.annotationIndex, annotation: target.annotation
            ), states.flags == 0 else { return false }
            let desiredState = edit.value == "on" ? states.on : "Off"
            return states.appearance != desiredState && states.value != desiredState
        }
        guard let rawFlags = choiceWidgetFlags(document: document, page: edit.page, annotationIndex: edit.annotationIndex),
              let currentValue = target.annotation.widgetStringValue,
              currentValue != edit.value,
              choicesAreUnambiguous(target.annotation) else { return false }
        if edit.value.isEmpty {
            return !currentValue.isEmpty && choiceContains(currentValue, annotation: target.annotation)
                && rawFlags & (readOnlyFieldFlag | requiredFieldFlag | choiceEditableFlag | choiceMultiSelectFlag) == 0
        }
        guard rawFlags & (readOnlyFieldFlag | choiceEditableFlag | choiceMultiSelectFlag) == 0 else { return false }
        return choiceContains(edit.value, annotation: target.annotation)
    }
    if let edit = mutation.annotationUpdate {
        guard !document.isLocked, document.allowsCommenting,
              let target = resolveTargetedAnnotation(
                  document: document, sourceDigest: sourceDigest, page: edit.page, annotationIndex: edit.annotationIndex,
                  fingerprint: edit.fingerprint, expectedSubtype: edit.subtype
              ), annotationIsInertTarget(target.annotation)
        else { return false }
        return target.annotation.contents != edit.contents || !closeEnough(target.annotation.bounds, cgRect(edit.rect))
    }
    if let edit = mutation.annotationProperties {
        return annotationPropertiesCanApply(edit, document: document, sourceDigest: sourceDigest)
    }
    guard let edit = mutation.annotationRemove,
          !document.isLocked, document.allowsCommenting,
          let target = resolveTargetedAnnotation(
              document: document, sourceDigest: sourceDigest, page: edit.page, annotationIndex: edit.annotationIndex,
              fingerprint: edit.fingerprint, expectedSubtype: edit.subtype
          )
    else { return false }
    return annotationIsInertTarget(target.annotation)
}
private struct TargetedMutationSnapshot {
    let annotationCounts: [Int]
    let fieldName: String?
    let checkboxOnState: String?
    let checkboxRenderSHA256: String?
    let choiceRenderSHA256: String?
    let radio: RadioMutationSnapshot?
    let annotationSanitization: AnnotationSanitizationSnapshot?
    var annotationProperties: AnnotationPropertiesSnapshot? = nil
}
private func targetedMutationSnapshot(
    _ mutation: TargetedMutation,
    document: PDFDocument,
    sourceDigest: String,
    limits: Limits
) -> TargetedMutationSnapshot? {
    var annotationCounts: [Int] = []
    annotationCounts.reserveCapacity(document.pageCount)
    for pageIndex in 0..<document.pageCount {
        guard let page = document.page(at: pageIndex) else { return nil }
        annotationCounts.append(page.annotations.count)
    }
    if let edit = mutation.formFill {
        guard let target = resolveTargetedAnnotation(
            document: document, sourceDigest: sourceDigest, page: edit.page, annotationIndex: edit.annotationIndex,
            fingerprint: edit.fingerprint, expectedSubtype: "widget", expectedWidgetType: edit.fieldType
        ) else { return nil }
        if edit.fieldType == "button", widgetControlKind(target.annotation, fieldType: "button") == "radio" {
            guard let radio = radioSelectionSnapshot(
                document: document, page: edit.page, annotationIndex: edit.annotationIndex, annotation: target.annotation
            ) else { return nil }
            return TargetedMutationSnapshot(
                annotationCounts: annotationCounts, fieldName: nil,
                checkboxOnState: nil, checkboxRenderSHA256: nil, choiceRenderSHA256: nil,
                radio: radio, annotationSanitization: nil
            )
        }
        guard let fieldName = resolvedFieldName(target.annotation) else { return nil }
        if edit.fieldType == "button" {
            guard let states = checkboxAppearanceStates(
                document: document, page: edit.page, annotationIndex: edit.annotationIndex, annotation: target.annotation
            ), let renderHash = checkboxRenderSHA256(document, page: edit.page) else { return nil }
            return TargetedMutationSnapshot(
                annotationCounts: annotationCounts, fieldName: fieldName,
                checkboxOnState: states.on, checkboxRenderSHA256: renderHash, choiceRenderSHA256: nil,
                radio: nil, annotationSanitization: nil
            )
        }
        if edit.fieldType == "choice", edit.value.isEmpty {
            guard let renderHash = checkboxRenderSHA256(document, page: edit.page) else { return nil }
            return TargetedMutationSnapshot(
                annotationCounts: annotationCounts, fieldName: fieldName,
                checkboxOnState: nil, checkboxRenderSHA256: nil, choiceRenderSHA256: renderHash,
                radio: nil, annotationSanitization: nil
            )
        }
        return TargetedMutationSnapshot(
            annotationCounts: annotationCounts, fieldName: fieldName,
            checkboxOnState: nil, checkboxRenderSHA256: nil, choiceRenderSHA256: nil,
            radio: nil, annotationSanitization: nil
        )
    }
    if let edit = mutation.annotationRemove {
        guard let annotationSanitization = annotationSanitizationSnapshot(edit, document: document, limits: limits) else {
            return nil
        }
        return TargetedMutationSnapshot(
            annotationCounts: annotationCounts, fieldName: nil,
            checkboxOnState: nil, checkboxRenderSHA256: nil, choiceRenderSHA256: nil,
            radio: nil, annotationSanitization: annotationSanitization
        )
    }
    if let edit = mutation.annotationProperties {
        guard let annotationProperties = annotationPropertiesSnapshot(edit, document: document, limits: limits) else { return nil }
        var snapshot = TargetedMutationSnapshot(
            annotationCounts: annotationCounts, fieldName: nil, checkboxOnState: nil,
            checkboxRenderSHA256: nil, choiceRenderSHA256: nil, radio: nil,
            annotationSanitization: nil
        )
        snapshot.annotationProperties = annotationProperties
        return snapshot
    }
    return TargetedMutationSnapshot(
        annotationCounts: annotationCounts, fieldName: nil,
        checkboxOnState: nil, checkboxRenderSHA256: nil, choiceRenderSHA256: nil,
        radio: nil, annotationSanitization: nil
    )
}
private func appliesTargetedMutation(_ mutation: TargetedMutation, document: PDFDocument, sourceDigest: String) -> Bool {
    if let edit = mutation.formFill,
        let target = resolveTargetedAnnotation(
           document: document, sourceDigest: sourceDigest, page: edit.page, annotationIndex: edit.annotationIndex,
           fingerprint: edit.fingerprint, expectedSubtype: "widget", expectedWidgetType: edit.fieldType
        ) {
        if edit.fieldType == "button" {
            target.annotation.buttonWidgetState = PDFWidgetCellState(rawValue: edit.value == "off" ? 0 : 1)!
            return true
        }
        target.annotation.widgetStringValue = edit.value
        return true
    }
    if let edit = mutation.annotationUpdate,
       let target = resolveTargetedAnnotation(
           document: document, sourceDigest: sourceDigest, page: edit.page, annotationIndex: edit.annotationIndex,
           fingerprint: edit.fingerprint, expectedSubtype: edit.subtype
       ) {
        target.annotation.contents = edit.contents
        target.annotation.bounds = cgRect(edit.rect)
        target.annotation.removeValue(forAnnotationKey: .appearanceDictionary)
        return true
    }
    if let edit = mutation.annotationProperties {
        return applyAnnotationProperties(edit, document: document, sourceDigest: sourceDigest)
    }
    if let edit = mutation.annotationRemove,
       let target = resolveTargetedAnnotation(
           document: document, sourceDigest: sourceDigest, page: edit.page, annotationIndex: edit.annotationIndex,
           fingerprint: edit.fingerprint, expectedSubtype: edit.subtype
       ) {
        target.page.removeAnnotation(target.annotation)
        return true
    }
    return false
}
private func verifiesTargetedMutation(
    _ mutation: TargetedMutation,
    document: PDFDocument,
    snapshot: TargetedMutationSnapshot,
    limits: Limits
) -> Bool {
    guard document.pageCount == snapshot.annotationCounts.count,
          !targetedDocumentContainsUnsafeContent(document) else { return false }
    let removedPageIndex = mutation.annotationRemove.map { $0.page - 1 }
    for pageIndex in 0..<document.pageCount {
        guard let page = document.page(at: pageIndex) else { return false }
        let removesFromPage = removedPageIndex.map { $0 == pageIndex } ?? false
        let expectedCount = snapshot.annotationCounts[pageIndex] - (removesFromPage ? 1 : 0)
        guard page.annotations.count == expectedCount else { return false }
    }
    if let edit = mutation.formFill {
        guard edit.page <= document.pageCount, let page = document.page(at: edit.page - 1),
              edit.annotationIndex < page.annotations.count else { return false }
        let annotation = page.annotations[edit.annotationIndex]
        guard annotationSubtype(annotation) == "widget",
              widgetType(annotation.value(forAnnotationKey: .widgetFieldType)) == edit.fieldType
        else { return false }
        if edit.fieldType == "button", edit.value == "select" {
            guard let radio = snapshot.radio else { return false }
            return verifiesRadioSelection(
                document: document, page: edit.page, annotationIndex: edit.annotationIndex,
                annotation: annotation, snapshot: radio
            )
        }
        guard let fieldName = resolvedFieldName(annotation), fieldName == snapshot.fieldName else { return false }
        guard rawTerminalWidgetMatches(
            document: document, page: edit.page, annotationIndex: edit.annotationIndex,
            expectedFieldType: edit.fieldType, expectedFieldName: fieldName,
            requireDirectObject: false
        ) else { return false }
        if edit.fieldType == "button" {
            guard let onState = snapshot.checkboxOnState,
                  let initialRenderHash = snapshot.checkboxRenderSHA256,
                  let states = checkboxAppearanceStates(
                      document: document, page: edit.page, annotationIndex: edit.annotationIndex, annotation: annotation
                  ), let renderHash = checkboxRenderSHA256(document, page: edit.page)
            else { return false }
            let expectedState = edit.value == "on" ? onState : "Off"
            return states.on == onState && states.appearance == expectedState && states.value == expectedState
                && annotation.buttonWidgetState.rawValue == (edit.value == "on" ? 1 : 0)
                && renderHash != initialRenderHash
        }
        if edit.fieldType == "choice", edit.value.isEmpty {
            guard let initialRenderHash = snapshot.choiceRenderSHA256,
                  let renderHash = checkboxRenderSHA256(document, page: edit.page)
            else { return false }
            return annotation.widgetStringValue == ""
                && renderHash != initialRenderHash
        }
        return annotation.widgetStringValue == edit.value
    }
    if let edit = mutation.annotationUpdate {
        guard edit.page <= document.pageCount, let page = document.page(at: edit.page - 1),
              edit.annotationIndex < page.annotations.count else { return false }
        let annotation = page.annotations[edit.annotationIndex]
        return annotationSubtype(annotation) == edit.subtype && annotation.contents == edit.contents
            && closeEnough(annotation.bounds, cgRect(edit.rect))
    }
    if let edit = mutation.annotationProperties {
        guard let annotationProperties = snapshot.annotationProperties else { return false }
        return verifiesAnnotationProperties(edit, document: document, snapshot: annotationProperties, limits: limits)
    }
    guard mutation.annotationRemove != nil, let annotationSanitization = snapshot.annotationSanitization else { return false }
    return verifiesAnnotationSanitization(annotationSanitization, document: document, limits: limits)
}
func targetedMutate(
    _ request: TargetedMutationRequest,
    workspace: URL,
    inputData: Data
) throws -> TargetedMutationReceipt {
    let sourceDigest = sha256Hex(inputData)
    guard request.sourceSha256 == sourceDigest,
          let document = PDFDocument(data: inputData),
          targetedMutationCanApply(request.mutation, document: document, sourceDigest: sourceDigest),
          let snapshot = targetedMutationSnapshot(
              request.mutation, document: document, sourceDigest: sourceDigest, limits: request.limits
          ),
          appliesTargetedMutation(request.mutation, document: document, sourceDigest: sourceDigest),
          let outputData = document.dataRepresentation(), outputData.count <= maxOutputBytes
    else { throw InspectionFailure.mutationFailed }
    let output = workspace.appendingPathComponent(request.outputFilename)
    try writePrivateOutput(outputData, to: output)
    let reopenedData = try readPrivateInput(output)
    guard let reopened = PDFDocument(data: reopenedData), reopened.pageCount == document.pageCount,
          verifiesTargetedMutation(request.mutation, document: reopened, snapshot: snapshot, limits: request.limits)
    else { throw InspectionFailure.outputInvalid }
    let annotationPropertiesVerified = request.mutation.annotationProperties != nil
    return TargetedMutationReceipt(
        category: annotationPropertiesVerified ? "annotation-properties" : "targeted-mutation",
        sourceSha256: sourceDigest, outputSha256: sha256Hex(reopenedData), pageCount: reopened.pageCount,
        annotationPropertiesGeometryVerified: annotationPropertiesVerified,
        annotationPropertiesColorVerified: annotationPropertiesVerified,
        rawAnnotationColorVerified: annotationPropertiesVerified,
        nonTargetAnnotationsVerified: annotationPropertiesVerified,
        targetAnnotationPreservationVerified: annotationPropertiesVerified
    )
}

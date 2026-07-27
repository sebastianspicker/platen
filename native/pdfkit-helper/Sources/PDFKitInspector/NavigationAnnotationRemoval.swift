import Foundation
import PDFKit
import CoreGraphics

private struct LocalGoToRemovalSnapshot {
    let pageCount: Int
    let pageBoxes: [PageBoxes]
    let pageRotations: [Int]
    let annotationDescriptors: [[CropAnnotationDescriptor]]
    let targetPageIndex: Int
    let targetAnnotationIndex: Int
}

private let rawRemovalPassiveSubtypes: Set<String> = [
    "Text", "Link", "FreeText", "Line", "Square", "Circle", "Polygon", "PolyLine",
    "Highlight", "Underline", "Squiggly", "StrikeOut", "Stamp", "Caret", "Ink",
]

private let rawFirstPartyLocalGoToKeys: Set<String> = [
    "Type", "Subtype", "Rect", "A", "AP", "Border", "DA", "Dest", "F", "M",
]

private func rawRemovalTargetDestination(
    _ document: PDFDocument, page: Int, annotationIndex: Int
) -> RawLocalGoToDestination? {
    guard let documentRef = document.documentRef,
          let pageDictionary = documentRef.page(at: page)?.dictionary else { return nil }
    var annotations: CGPDFArrayRef?; var annotation: CGPDFDictionaryRef?
    guard CGPDFDictionaryGetArray(pageDictionary, "Annots", &annotations), let annotations,
          annotationIndex >= 0, annotationIndex < CGPDFArrayGetCount(annotations),
          CGPDFArrayGetDictionary(annotations, annotationIndex, &annotation), let annotation,
          dictionaryContainsOnlyKeys(annotation, allowed: rawFirstPartyLocalGoToKeys.union(["BS"]))
    else { return nil }
    var observedKeys: Set<String> = []
    CGPDFDictionaryApplyBlock(annotation, { key, _, _ in
        observedKeys.insert(String(cString: key)); return true
    }, nil)
    guard observedKeys == rawFirstPartyLocalGoToKeys || observedKeys == rawFirstPartyLocalGoToKeys.union(["BS"]),
          pdfName(annotation, key: "Type") == "Annot",
          pdfName(annotation, key: "Subtype") == "Link" else { return nil }
    var destinationArray: CGPDFArrayRef?
    guard CGPDFDictionaryGetArray(annotation, "Dest", &destinationArray), let destinationArray,
          let destination = rawLocalGoToDestination(destinationArray, document: documentRef),
          rawLocalGoToAnnotationMatches(annotation, document: documentRef, expected: destination)
    else { return nil }
    return destination
}

private func rawRemovalAnnotationIsPassive(_ annotation: CGPDFDictionaryRef) -> Bool {
    guard let subtype = pdfName(annotation, key: "Subtype"), rawRemovalPassiveSubtypes.contains(subtype),
          rawExistingLocalGoToAnnotationIsSafe(annotation),
          !["Dest", "Popup", "Parent", "StructParent", "OC"].contains(where: {
              dictionaryContainsObject(annotation, key: $0)
          })
    else { return false }
    return true
}

private func rawRemovalGraphIsSafe(
    _ document: PDFDocument, limits: Limits, target: LocalGoToRemovalTarget?, destination: RawLocalGoToDestination?
) -> Bool {
    let allowed = target.flatMap { target in
        destination.map { AllowedRawLocalGoTo(page: target.page, annotationIndex: target.annotationIndex, destination: $0) }
    }
    guard (target == nil) == (destination == nil),
          rawLocalGoToGraphIsSafe(document, limits: limits, allowing: allowed),
          let documentRef = document.documentRef else { return false }
    var identities: Set<UInt> = []; var foundTarget = false
    for pageNumber in 1...document.pageCount {
        guard let page = document.page(at: pageNumber - 1),
              let pageDictionary = documentRef.page(at: pageNumber)?.dictionary else { return false }
        var annotations: CGPDFArrayRef?
        guard CGPDFDictionaryGetArray(pageDictionary, "Annots", &annotations) else {
            if !page.annotations.isEmpty { return false }; continue
        }
        guard let annotations, CGPDFArrayGetCount(annotations) == page.annotations.count else { return false }
        for annotationIndex in 0..<CGPDFArrayGetCount(annotations) {
            var annotation: CGPDFDictionaryRef?
            guard CGPDFArrayGetDictionary(annotations, annotationIndex, &annotation), let annotation,
                  identities.insert(UInt(bitPattern: unsafeBitCast(annotation, to: UnsafeRawPointer.self))).inserted
            else { return false }
            if target?.page == pageNumber, target?.annotationIndex == annotationIndex {
                guard !foundTarget, let destination,
                      rawRemovalTargetDestination(document, page: pageNumber, annotationIndex: annotationIndex) == destination
                else { return false }
                foundTarget = true
            } else if !rawRemovalAnnotationIsPassive(annotation) { return false }
        }
    }
    return foundTarget == (target != nil)
}

private func localGoToRemovalSnapshot(
    _ request: LocalGoToRemovalRequest, document: PDFDocument, inputData: Data, sourceDigest: String
) -> LocalGoToRemovalSnapshot? {
    guard !document.isEncrypted, !document.isLocked, document.allowsCommenting, document.allowsDocumentChanges,
          document.pageCount >= 1, document.pageCount <= request.limits.maxPages,
          request.link.page <= document.pageCount,
          inputData.range(of: Data("/ByteRange".utf8)) == nil,
          let page = document.page(at: request.link.page - 1),
          request.link.annotationIndex < page.annotations.count,
          annotationSubtype(page.annotations[request.link.annotationIndex]) == "link",
          request.link.fingerprint == annotationFingerprint(
              sourceDigest: sourceDigest, page: request.link.page, annotationIndex: request.link.annotationIndex,
              subtype: "link", widgetType: nil
          ),
          let destination = rawRemovalTargetDestination(
              document, page: request.link.page, annotationIndex: request.link.annotationIndex
          ),
          rawRemovalGraphIsSafe(document, limits: request.limits, target: request.link, destination: destination)
    else { return nil }
    var boxes: [PageBoxes] = []; var rotations: [Int] = []; var descriptors: [[CropAnnotationDescriptor]] = []
    let descriptorBudget = RawDescriptorTraversalBudget()
    for pageIndex in 0..<document.pageCount {
        guard let observedPage = document.page(at: pageIndex),
              observedPage.annotations.count <= request.limits.maxAnnotationsPerPage,
              let observedDescriptors = cropAnnotationDescriptors(document, pageIndex: pageIndex, budget: descriptorBudget)
        else { return nil }
        boxes.append(localGoToPageBoxes(observedPage)); rotations.append(observedPage.rotation)
        descriptors.append(observedDescriptors)
    }
    return LocalGoToRemovalSnapshot(
        pageCount: document.pageCount, pageBoxes: boxes, pageRotations: rotations,
        annotationDescriptors: descriptors, targetPageIndex: request.link.page - 1,
        targetAnnotationIndex: request.link.annotationIndex
    )
}

private func verifiesLocalGoToRemoval(
    _ request: LocalGoToRemovalRequest, document: PDFDocument, snapshot: LocalGoToRemovalSnapshot
) -> Bool {
    guard !document.isEncrypted, !document.isLocked, document.pageCount == snapshot.pageCount,
          rawRemovalGraphIsSafe(document, limits: request.limits, target: nil, destination: nil)
    else { return false }
    let descriptorBudget = RawDescriptorTraversalBudget()
    for pageIndex in 0..<document.pageCount {
        guard let page = document.page(at: pageIndex),
              localGoToPageBoxes(page) == snapshot.pageBoxes[pageIndex],
              page.rotation == snapshot.pageRotations[pageIndex],
              let observed = cropAnnotationDescriptors(document, pageIndex: pageIndex, budget: descriptorBudget)
        else { return false }
        var expected = snapshot.annotationDescriptors[pageIndex]
        if pageIndex == snapshot.targetPageIndex {
            guard snapshot.targetAnnotationIndex < expected.count else { return false }
            expected.remove(at: snapshot.targetAnnotationIndex)
        }
        guard observed == expected else { return false }
    }
    return true
}

func removeLocalGoToLink(
    _ request: LocalGoToRemovalRequest, workspace: URL, inputData: Data
) throws -> LocalGoToRemovalReceipt {
    let sourceDigest = sha256Hex(inputData)
    guard request.sourceSha256 == sourceDigest, let document = PDFDocument(data: inputData),
          let snapshot = localGoToRemovalSnapshot(
              request, document: document, inputData: inputData, sourceDigest: sourceDigest
          ), let page = document.page(at: request.link.page - 1),
          request.link.annotationIndex < page.annotations.count
    else { throw InspectionFailure.mutationFailed }
    page.removeAnnotation(page.annotations[request.link.annotationIndex])
    guard let outputData = document.dataRepresentation(), outputData.count <= maxOutputBytes,
          outputData != inputData, let candidate = PDFDocument(data: outputData),
          verifiesLocalGoToRemoval(request, document: candidate, snapshot: snapshot)
    else { throw InspectionFailure.mutationFailed }
    let output = workspace.appendingPathComponent(request.outputFilename)
    try writePrivateOutput(outputData, to: output)
    let unchangedInput = try readPrivateInput(workspace.appendingPathComponent(request.inputFilename))
    let reopenedData = try readPrivateInput(output)
    guard unchangedInput == inputData, reopenedData == outputData, let reopened = PDFDocument(data: reopenedData),
          verifiesLocalGoToRemoval(request, document: reopened, snapshot: snapshot)
    else { throw InspectionFailure.outputInvalid }
    let outputDigest = sha256Hex(reopenedData)
    guard outputDigest != sourceDigest else { throw InspectionFailure.outputInvalid }
    return LocalGoToRemovalReceipt(
        sourceSha256: sourceDigest, outputSha256: outputDigest, page: request.link.page,
        annotationIndex: request.link.annotationIndex, pageCount: reopened.pageCount
    )
}

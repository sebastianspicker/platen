import Foundation
import PDFKit
import CoreGraphics

struct AnnotationSanitizationSnapshot {
    let descriptors: [[CropAnnotationDescriptor]]
    let targetPageIndex: Int
    let targetAnnotationIndex: Int
}

private let rawPassiveAnnotationSubtypes: Set<String> = [
    "Text", "Link", "FreeText", "Line", "Square", "Circle", "Polygon", "PolyLine",
    "Highlight", "Underline", "Squiggly", "StrikeOut", "Stamp", "Caret", "Ink",
]

private func rawAnnotationSanitizationGraphIsSafe(
    _ document: PDFDocument,
    pageIndex: Int,
    expectedAnnotationCount: Int,
    identities: inout Set<UInt>,
    allowedSubtypes: Set<String>? = nil
) -> Bool {
    guard let documentRef = document.documentRef,
          let pageDictionary = documentRef.page(at: pageIndex + 1)?.dictionary
    else { return false }
    var annotations: CGPDFArrayRef?
    guard CGPDFDictionaryGetArray(pageDictionary, "Annots", &annotations) else {
        return expectedAnnotationCount == 0
    }
    guard let annotations,
          CGPDFArrayGetCount(annotations) == expectedAnnotationCount,
          CGPDFArrayGetCount(annotations) <= maximumAnnotationsPerPage
    else { return false }
    for annotationIndex in 0..<CGPDFArrayGetCount(annotations) {
        var annotation: CGPDFDictionaryRef?
        guard CGPDFArrayGetDictionary(annotations, annotationIndex, &annotation), let annotation,
              identities.insert(UInt(bitPattern: unsafeBitCast(annotation, to: UnsafeRawPointer.self))).inserted,
              pdfName(annotation, key: "Subtype").map({ subtype in
                  allowedSubtypes?.contains(subtype) ?? true
              }) ?? false,
              allowedSubtypes == nil || !["StructParent", "OC"].contains(where: {
                  dictionaryContainsObject(annotation, key: $0)
              }),
              !["A", "AA", "PA", "URI", "Dest", "Popup", "Parent"].contains(where: {
                  dictionaryContainsObject(annotation, key: $0)
              }),
              !rawLocalGoToAnnotationContainsProhibitedPayload(annotation)
        else { return false }
    }
    return true
}

func passiveAnnotationDescriptors(
    _ document: PDFDocument,
    limits: Limits
) -> [[CropAnnotationDescriptor]]? {
    guard isWithin(document.pageCount, 1, limits.maxPages) else { return nil }
    var descriptors: [[CropAnnotationDescriptor]] = []
    descriptors.reserveCapacity(document.pageCount)
    let descriptorBudget = RawDescriptorTraversalBudget()
    var identities: Set<UInt> = []
    for pageIndex in 0..<document.pageCount {
        guard let page = document.page(at: pageIndex),
              page.annotations.count <= limits.maxAnnotationsPerPage,
              page.annotations.count <= maximumAnnotationsPerPage,
              rawAnnotationSanitizationGraphIsSafe(
                  document, pageIndex: pageIndex, expectedAnnotationCount: page.annotations.count,
                  identities: &identities, allowedSubtypes: rawPassiveAnnotationSubtypes
              ),
              let pageDescriptors = cropAnnotationDescriptors(document, pageIndex: pageIndex, budget: descriptorBudget)
        else { return nil }
        descriptors.append(pageDescriptors)
    }
    return descriptors
}

private func rawTargetedAnnotationSubtype(_ subtype: String) -> String? {
    switch subtype {
    case "freeText": return "FreeText"
    case "square": return "Square"
    case "circle": return "Circle"
    case "highlight": return "Highlight"
    default: return nil
    }
}

func annotationSanitizationSnapshot(
    _ edit: AnnotationRemoveEdit,
    document: PDFDocument,
    limits: Limits
) -> AnnotationSanitizationSnapshot? {
    guard document.pageCount >= 1, document.pageCount <= limits.maxPages,
          edit.page <= document.pageCount,
          let rawTargetSubtype = rawTargetedAnnotationSubtype(edit.subtype)
    else { return nil }
    var descriptors: [[CropAnnotationDescriptor]] = []
    descriptors.reserveCapacity(document.pageCount)
    let descriptorBudget = RawDescriptorTraversalBudget()
    var rawAnnotationIdentities: Set<UInt> = []
    for pageIndex in 0..<document.pageCount {
        guard let page = document.page(at: pageIndex),
              page.annotations.count <= limits.maxAnnotationsPerPage,
              page.annotations.count <= maximumAnnotationsPerPage,
              let pageDescriptors = cropAnnotationDescriptors(document, pageIndex: pageIndex, budget: descriptorBudget),
              rawAnnotationSanitizationGraphIsSafe(
                  document, pageIndex: pageIndex, expectedAnnotationCount: page.annotations.count,
                  identities: &rawAnnotationIdentities
              )
        else { return nil }
        descriptors.append(pageDescriptors)
    }
    let targetPageIndex = edit.page - 1
    guard edit.annotationIndex < descriptors[targetPageIndex].count else { return nil }
    let target = descriptors[targetPageIndex][edit.annotationIndex]
    guard target.publicSubtype == edit.subtype, target.rawSubtype == rawTargetSubtype else { return nil }
    return AnnotationSanitizationSnapshot(
        descriptors: descriptors,
        targetPageIndex: targetPageIndex,
        targetAnnotationIndex: edit.annotationIndex
    )
}

func verifiesAnnotationSanitization(
    _ snapshot: AnnotationSanitizationSnapshot,
    document: PDFDocument,
    limits: Limits
) -> Bool {
    guard document.pageCount == snapshot.descriptors.count,
          document.pageCount >= 1, document.pageCount <= limits.maxPages,
          !targetedDocumentContainsUnsafeContent(document)
    else { return false }
    var rawAnnotationIdentities: Set<UInt> = []
    let descriptorBudget = RawDescriptorTraversalBudget()
    for pageIndex in 0..<document.pageCount {
        guard let page = document.page(at: pageIndex),
              page.annotations.count <= limits.maxAnnotationsPerPage,
              page.annotations.count <= maximumAnnotationsPerPage,
              let observed = cropAnnotationDescriptors(document, pageIndex: pageIndex, budget: descriptorBudget),
              rawAnnotationSanitizationGraphIsSafe(
                  document, pageIndex: pageIndex, expectedAnnotationCount: page.annotations.count,
                  identities: &rawAnnotationIdentities
              )
        else { return false }
        var expected = snapshot.descriptors[pageIndex]
        if pageIndex == snapshot.targetPageIndex {
            guard snapshot.targetAnnotationIndex < expected.count else { return false }
            expected.remove(at: snapshot.targetAnnotationIndex)
        }
        guard observed == expected else { return false }
    }
    return true
}

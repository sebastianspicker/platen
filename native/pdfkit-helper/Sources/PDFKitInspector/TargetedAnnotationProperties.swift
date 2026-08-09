import Foundation
import PDFKit
import AppKit
import CoreGraphics

struct TargetedMutationSuccessResponse: Encodable {
    let version = protocolVersion
    let ok = true
    let result: TargetedMutationReceipt
}

struct TargetedMutationReceipt: Encodable {
    let schema = "pdfkit-targeted-mutation-receipt-v1"
    let version = protocolVersion
    let operation = "targetedMutate"
    let category: String
    let sourceSha256: String
    let outputSha256: String
    let pageCount: Int
    let appliedEdits = 1
    let reopenVerified = true
    let annotationPropertiesGeometryVerified: Bool
    let annotationPropertiesColorVerified: Bool
    let rawAnnotationColorVerified: Bool
    let nonTargetAnnotationsVerified: Bool
    let targetAnnotationPreservationVerified: Bool
}

struct AnnotationPropertiesSnapshot {
    let descriptors: [[CropAnnotationDescriptor]]
    let targetPageIndex: Int
    let targetAnnotationIndex: Int
}

func annotationPropertiesRGB(_ value: String) -> (Double, Double, Double)? {
    let bytes = Array(value.utf8)
    guard bytes.count == 7, bytes[0] == 35,
          bytes.dropFirst().allSatisfy({ (48...57).contains($0) || (97...102).contains($0) })
    else { return nil }
    func component(_ offset: Int) -> Double? {
        Int(String(decoding: bytes[offset..<(offset + 2)], as: UTF8.self), radix: 16).map { Double($0) / 255.0 }
    }
    guard let red = component(1), let green = component(3), let blue = component(5) else { return nil }
    return (red, green, blue)
}

private func rawAnnotationBorderColor(_ annotation: CGPDFDictionaryRef) -> (Double, Double, Double)? {
    var values: CGPDFArrayRef?
    guard CGPDFDictionaryGetArray(annotation, "C", &values), let values, CGPDFArrayGetCount(values) == 3 else { return nil }
    var components = Array(repeating: CGPDFReal(0), count: 3)
    for index in components.indices {
        guard CGPDFArrayGetNumber(values, index, &components[index]), components[index].isFinite,
              (0...1).contains(Double(components[index])) else { return nil }
    }
    return (Double(components[0]), Double(components[1]), Double(components[2]))
}

private func closeEnoughColor(_ lhs: (Double, Double, Double), _ rhs: (Double, Double, Double)) -> Bool {
    [abs(lhs.0 - rhs.0), abs(lhs.1 - rhs.1), abs(lhs.2 - rhs.2)].allSatisfy { $0 <= 0.001 }
}

private func annotationBorderColorMatches(_ annotation: PDFAnnotation, rgb: (Double, Double, Double)) -> Bool {
    guard let color = annotation.color.usingColorSpace(.deviceRGB) else { return false }
    var red: CGFloat = 0; var green: CGFloat = 0; var blue: CGFloat = 0; var alpha: CGFloat = 0
    color.getRed(&red, green: &green, blue: &blue, alpha: &alpha)
    return closeEnoughColor((Double(red), Double(green), Double(blue)), rgb)
}

private func allAnnotationAppearancesPresent(_ document: PDFDocument) -> Bool {
    guard let documentRef = document.documentRef else { return false }
    for pageIndex in 0..<document.pageCount {
        guard let page = document.page(at: pageIndex), let rawPage = documentRef.page(at: pageIndex + 1)?.dictionary else { return false }
        var annotations: CGPDFArrayRef?
        if !CGPDFDictionaryGetArray(rawPage, "Annots", &annotations) {
            guard page.annotations.isEmpty else { return false }
            continue
        }
        guard let annotations, CGPDFArrayGetCount(annotations) == page.annotations.count else { return false }
        for index in 0..<CGPDFArrayGetCount(annotations) {
            var annotation: CGPDFDictionaryRef?
            guard CGPDFArrayGetDictionary(annotations, index, &annotation), let annotation,
                  dictionaryContainsObject(annotation, key: "AP") else { return false }
        }
    }
    return true
}

func annotationPropertiesCanApply(
    _ edit: AnnotationPropertiesEdit, document: PDFDocument, sourceDigest: String
) -> Bool {
    guard !document.isLocked, document.allowsCommenting,
          let rgb = annotationPropertiesRGB(edit.strokeColor),
          let target = resolveTargetedAnnotation(
              document: document, sourceDigest: sourceDigest, page: edit.page, annotationIndex: edit.annotationIndex,
              fingerprint: edit.fingerprint, expectedSubtype: "square"
          ), annotationIsInertTarget(target.annotation), containedInMediaBox(cgRect(edit.rect), page: target.page)
    else { return false }
    return !closeEnough(target.annotation.bounds, cgRect(edit.rect)) || !annotationBorderColorMatches(target.annotation, rgb: rgb)
}

func annotationPropertiesSnapshot(
    _ edit: AnnotationPropertiesEdit, document: PDFDocument, limits: Limits
) -> AnnotationPropertiesSnapshot? {
    guard edit.page <= document.pageCount,
          let descriptors = passiveAnnotationDescriptors(document, limits: limits),
          edit.annotationIndex < descriptors[edit.page - 1].count,
          allAnnotationAppearancesPresent(document)
    else { return nil }
    let target = descriptors[edit.page - 1][edit.annotationIndex]
    guard target.publicSubtype == "square", target.rawSubtype == "Square" else { return nil }
    return AnnotationPropertiesSnapshot(
        descriptors: descriptors, targetPageIndex: edit.page - 1, targetAnnotationIndex: edit.annotationIndex
    )
}

func applyAnnotationProperties(
    _ edit: AnnotationPropertiesEdit, document: PDFDocument, sourceDigest: String
) -> Bool {
    guard let rgb = annotationPropertiesRGB(edit.strokeColor),
          let target = resolveTargetedAnnotation(
              document: document, sourceDigest: sourceDigest, page: edit.page, annotationIndex: edit.annotationIndex,
              fingerprint: edit.fingerprint, expectedSubtype: "square"
          ) else { return false }
    target.annotation.bounds = cgRect(edit.rect)
    target.annotation.color = NSColor(deviceRed: rgb.0, green: rgb.1, blue: rgb.2, alpha: 1)
    return true
}

func verifiesAnnotationProperties(
    _ edit: AnnotationPropertiesEdit, document: PDFDocument, snapshot: AnnotationPropertiesSnapshot, limits: Limits
) -> Bool {
    guard document.pageCount == snapshot.descriptors.count, edit.page <= document.pageCount,
          let page = document.page(at: edit.page - 1), edit.annotationIndex < page.annotations.count,
          let rgb = annotationPropertiesRGB(edit.strokeColor), let rawDocument = document.documentRef,
          let rawPage = rawDocument.page(at: edit.page), let rawPageDictionary = rawPage.dictionary,
          let observed = passiveAnnotationDescriptors(document, limits: limits)
    else { return false }
    let annotation = page.annotations[edit.annotationIndex]
    var rawAnnotations: CGPDFArrayRef?
    guard annotationSubtype(annotation) == "square", closeEnough(annotation.bounds, cgRect(edit.rect)),
          annotationBorderColorMatches(annotation, rgb: rgb),
          CGPDFDictionaryGetArray(rawPageDictionary, "Annots", &rawAnnotations), let rawAnnotations,
          CGPDFArrayGetCount(rawAnnotations) == page.annotations.count
    else { return false }
    var rawAnnotation: CGPDFDictionaryRef?
    guard CGPDFArrayGetDictionary(rawAnnotations, edit.annotationIndex, &rawAnnotation), let rawAnnotation,
          rawAnnotationBorderColor(rawAnnotation).map({ closeEnoughColor($0, rgb) }) == true
    else { return false }
    for pageIndex in observed.indices {
        guard observed[pageIndex].count == snapshot.descriptors[pageIndex].count else { return false }
        for index in observed[pageIndex].indices {
            let before = snapshot.descriptors[pageIndex][index]; let after = observed[pageIndex][index]
            if pageIndex == snapshot.targetPageIndex && index == snapshot.targetAnnotationIndex {
                guard before.publicSubtype == after.publicSubtype, before.contentsDigest == after.contentsDigest,
                      before.publicFlags == after.publicFlags, before.rawSubtype == after.rawSubtype,
                      before.rawFlags == after.rawFlags,
                      before.rawSensitiveShapeDigest == after.rawSensitiveShapeDigest,
                      closeEnough(CGRect(x: after.rawBounds.x, y: after.rawBounds.y, width: after.rawBounds.width, height: after.rawBounds.height), cgRect(edit.rect))
                else { return false }
            } else if before != after { return false }
        }
    }
    return true
}

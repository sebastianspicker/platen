import Foundation
import PDFKit

func annotationIsInertTarget(_ annotation: PDFAnnotation) -> Bool {
    annotation.value(forAnnotationKey: .popup) == nil
        && !annotationHasActionOrAdditionalActions(annotation)
}

func resolveTargetedAnnotation(
    document: PDFDocument,
    sourceDigest: String,
    page: Int,
    annotationIndex: Int,
    fingerprint: String,
    expectedSubtype: String,
    expectedWidgetType: String? = nil
) -> (page: PDFPage, annotation: PDFAnnotation)? {
    guard page <= document.pageCount,
          let targetPage = document.page(at: page - 1)
    else { return nil }
    let annotations = targetPage.annotations
    guard annotationIndex < annotations.count else { return nil }
    let annotation = annotations[annotationIndex]
    let subtype = annotationSubtype(annotation)
    guard subtype == expectedSubtype else { return nil }
    let actualWidgetType = subtype == "widget"
        ? widgetType(annotation.value(forAnnotationKey: .widgetFieldType))
        : nil
    guard actualWidgetType == expectedWidgetType,
          annotationFingerprint(
              sourceDigest: sourceDigest,
              page: page,
              annotationIndex: annotationIndex,
              subtype: subtype,
              widgetType: actualWidgetType
          ) == fingerprint
    else { return nil }
    return (targetPage, annotation)
}

func targetedRenderSHA256(_ document: PDFDocument, page: Int) -> String? {
    checkboxRenderSHA256(document, page: page)
}

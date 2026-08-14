import Foundation
import PDFKit
import CoreGraphics

let textFileSelectFlag = 1 << 20
let textRichTextFlag = 1 << 25
let readOnlyFieldFlag = 1 << 0
let requiredFieldFlag = 1 << 1
let choiceEditableFlag = 1 << 18
let choiceMultiSelectFlag = 1 << 21

func widgetFlags(_ annotation: PDFAnnotation) -> Int {
    (annotation.value(forAnnotationKey: .widgetFieldFlags) as? NSNumber)?.intValue ?? 0
}

func rawFieldSemanticallyMatches(
    _ field: CGPDFDictionaryRef,
    widget: CGPDFDictionaryRef,
    rawFieldType: String,
    expectedFieldName: String
) -> Bool {
    guard !dictionaryContainsObject(field, key: "Parent"),
          !dictionaryContainsObject(field, key: "Kids"),
          pdfName(field, key: "Subtype") == "Widget",
          pdfName(field, key: "FT") == rawFieldType,
          pdfTextString(field, key: "T") == expectedFieldName,
          pdfIntegerOrZero(field, key: "Ff") == pdfIntegerOrZero(widget, key: "Ff"),
          pdfScalarValue(field, key: "V") == pdfScalarValue(widget, key: "V"),
          pdfScalarValue(field, key: "AS") == pdfScalarValue(widget, key: "AS"),
          dictionaryContainsObject(field, key: "AP")
              == dictionaryContainsObject(widget, key: "AP")
    else { return false }
    return true
}

func rawTerminalWidgetMatches(
    document: PDFDocument,
    page: Int,
    annotationIndex: Int,
    expectedFieldType: String,
    expectedFieldName: String,
    requireDirectObject: Bool
) -> Bool {
    let rawFieldType: String
    switch expectedFieldType {
    case "text": rawFieldType = "Tx"
    case "choice": rawFieldType = "Ch"
    case "button": rawFieldType = "Btn"
    default: return false
    }
    guard let documentRef = document.documentRef,
          let pageDictionary = documentRef.page(at: page)?.dictionary
    else { return false }
    var annotations: CGPDFArrayRef?
    guard CGPDFDictionaryGetArray(pageDictionary, "Annots", &annotations),
          let annotations,
          annotationIndex < CGPDFArrayGetCount(annotations)
    else { return false }
    var targetObject: CGPDFObjectRef?
    var widget: CGPDFDictionaryRef?
    guard CGPDFArrayGetObject(annotations, annotationIndex, &targetObject),
          let targetObject,
          CGPDFArrayGetDictionary(annotations, annotationIndex, &widget),
          let widget,
          !dictionaryContainsObject(widget, key: "Parent"),
          !dictionaryContainsObject(widget, key: "Kids"),
          pdfName(widget, key: "FT") == rawFieldType,
          pdfTextString(widget, key: "T") == expectedFieldName
    else { return false }
    guard let catalog = documentRef.catalog else { return false }
    var acroForm: CGPDFDictionaryRef?
    var fields: CGPDFArrayRef?
    guard CGPDFDictionaryGetDictionary(catalog, "AcroForm", &acroForm),
          let acroForm,
          CGPDFDictionaryGetArray(acroForm, "Fields", &fields),
          let fields,
          isWithin(CGPDFArrayGetCount(fields), 1, maximumPages * maximumAnnotationsPerPage)
    else { return false }
    var directMatches = 0
    var semanticMatches = 0
    for fieldIndex in 0..<CGPDFArrayGetCount(fields) {
        var fieldObject: CGPDFObjectRef?
        var field: CGPDFDictionaryRef?
        guard CGPDFArrayGetObject(fields, fieldIndex, &fieldObject),
              let fieldObject,
              CGPDFArrayGetDictionary(fields, fieldIndex, &field),
              field != nil
        else { return false }
        if fieldObject == targetObject { directMatches += 1 }
        if let field,
           rawFieldSemanticallyMatches(
               field,
               widget: widget,
               rawFieldType: rawFieldType,
               expectedFieldName: expectedFieldName
           ) {
            semanticMatches += 1
        }
    }
    return semanticMatches == 1 && (!requireDirectObject || directMatches == 1)
}

func resolvedFieldName(_ annotation: PDFAnnotation) -> String? {
    guard let fieldName = annotation.fieldName,
          !fieldName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    else { return nil }
    return fieldName
}

func hasAmbiguousFieldName(
    _ fieldName: String,
    target: PDFAnnotation,
    in document: PDFDocument
) -> Bool {
    for pageIndex in 0..<document.pageCount {
        guard let page = document.page(at: pageIndex) else { return true }
        for annotation in page.annotations
            where annotation !== target && annotationSubtype(annotation) == "widget" {
            if resolvedFieldName(annotation) == fieldName { return true }
        }
    }
    return false
}

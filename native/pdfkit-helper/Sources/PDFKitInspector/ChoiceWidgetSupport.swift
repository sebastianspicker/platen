import Foundation
import PDFKit
import CoreGraphics

func choiceContains(_ value: String, annotation: PDFAnnotation) -> Bool {
    guard choicesAreUnambiguous(annotation) else { return false }
    return exposedChoices(annotation.values)?.contains(value) == true
        || exposedChoices(annotation.choices)?.contains(value) == true
}

func choiceWidgetFlags(document: PDFDocument, page: Int, annotationIndex: Int) -> Int? {
    guard let documentRef = document.documentRef,
          let rawPage = documentRef.page(at: page),
          let pageDictionary = rawPage.dictionary
    else { return nil }
    var annotations: CGPDFArrayRef?
    guard CGPDFDictionaryGetArray(pageDictionary, "Annots", &annotations),
          let annotations,
          annotationIndex < CGPDFArrayGetCount(annotations)
    else { return nil }
    var widget: CGPDFDictionaryRef?
    guard CGPDFArrayGetDictionary(annotations, annotationIndex, &widget),
          let widget,
          !dictionaryContainsObject(widget, key: "Parent"),
          !dictionaryContainsObject(widget, key: "Kids"),
          pdfName(widget, key: "FT") == "Ch",
          pdfTextString(widget, key: "T") != nil
    else { return nil }
    var rawFlags: CGPDFInteger = 0
    return CGPDFDictionaryGetInteger(widget, "Ff", &rawFlags) ? Int(rawFlags) : 0
}

func boundedUniqueChoices(_ values: [String]?) -> Bool {
    guard let values else { return true }
    guard !values.isEmpty,
          values.count <= maximumChoiceOptions,
          values.allSatisfy({ !$0.isEmpty && $0.utf8.count <= maximumStringLength })
    else { return false }
    return Set(values).count == values.count
}

func exposedChoices(_ values: [String]?) -> [String]? {
    guard let values, !values.isEmpty else { return nil }
    return values
}

func choicesAreUnambiguous(_ annotation: PDFAnnotation) -> Bool {
    let values = exposedChoices(annotation.values)
    let choices = exposedChoices(annotation.choices)
    guard values != nil || choices != nil,
          boundedUniqueChoices(values),
          boundedUniqueChoices(choices)
    else { return false }
    if let values, let choices { return values.count == choices.count }
    return true
}

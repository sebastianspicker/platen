import Foundation
import PDFKit
import AppKit
import CoreGraphics

struct CheckboxAppearanceStates {
    let on: String
    let appearance: String
    let value: String
    let flags: Int
}

func validCheckboxAppearanceName(_ value: String) -> Bool {
    let bytes = Array(value.utf8)
    return isWithin(bytes.count, 1, 127)
        && bytes.allSatisfy { byte in
            byte >= 0x21 && byte <= 0x7e
                && ![35, 37, 40, 41, 47, 60, 62, 91, 93, 123, 125].contains(byte)
        }
}

func checkboxAppearanceStates(
    document: PDFDocument,
    page: Int,
    annotationIndex: Int,
    annotation: PDFAnnotation
) -> CheckboxAppearanceStates? {
    guard widgetControlKind(annotation, fieldType: "button") == "checkbox",
          let documentRef = document.documentRef,
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
          pdfName(widget, key: "FT") == "Btn",
          let appearance = pdfName(widget, key: "AS"),
          let value = pdfName(widget, key: "V")
    else { return nil }
    var appearanceDictionary: CGPDFDictionaryRef?
    var normalAppearances: CGPDFDictionaryRef?
    guard CGPDFDictionaryGetDictionary(widget, "AP", &appearanceDictionary),
          let appearanceDictionary,
          CGPDFDictionaryGetDictionary(appearanceDictionary, "N", &normalAppearances),
          let normalAppearances
    else { return nil }
    var names: [String] = []
    CGPDFDictionaryApplyBlock(normalAppearances, { key, _, _ in
        names.append(String(cString: key))
        return names.count < 3
    }, nil)
    var rawFlags: CGPDFInteger = 0
    let hasFlags = CGPDFDictionaryGetInteger(widget, "Ff", &rawFlags)
    guard names.count == 2,
          names.contains("Off"),
          let on = names.first(where: { $0 != "Off" }),
          validCheckboxAppearanceName(on),
          ["Off", on].contains(appearance),
          appearance == value,
          annotation.buttonWidgetStateString == on,
          annotation.buttonWidgetState.rawValue == (appearance == on ? 1 : 0)
    else { return nil }
    return CheckboxAppearanceStates(
        on: on,
        appearance: appearance,
        value: value,
        flags: hasFlags ? Int(rawFlags) : 0
    )
}

func checkboxRenderSHA256(_ document: PDFDocument, page: Int) -> String? {
    guard let pdfPage = document.page(at: page - 1),
          let bitmap = NSBitmapImageRep(
              data: pdfPage.thumbnail(
                  of: CGSize(width: 256, height: 256),
                  for: .mediaBox
              ).tiffRepresentation ?? Data()
          ),
          let bytes = bitmap.bitmapData
    else { return nil }
    return sha256Hex(Data(bytes: bytes, count: bitmap.bytesPerRow * bitmap.pixelsHigh))
}

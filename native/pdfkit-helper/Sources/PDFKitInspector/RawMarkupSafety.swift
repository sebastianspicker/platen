import PDFKit
import CoreGraphics

func rawLineAnnotationMatches(
    _ document: PDFDocument,
    page: Int,
    annotationIndex: Int,
    start: CGPoint,
    end: CGPoint
) -> Bool {
    guard let documentRef = document.documentRef,
          let pageDictionary = documentRef.page(at: page)?.dictionary
    else { return false }
    var annotations: CGPDFArrayRef?
    guard CGPDFDictionaryGetArray(pageDictionary, "Annots", &annotations), let annotations,
          annotationIndex >= 0, annotationIndex < CGPDFArrayGetCount(annotations)
    else { return false }
    var annotation: CGPDFDictionaryRef?
    guard CGPDFArrayGetDictionary(annotations, annotationIndex, &annotation), let annotation,
          pdfName(annotation, key: "Subtype") == "Line",
          !["A", "AA", "PA", "URI", "Dest"].contains(where: {
              dictionaryContainsObject(annotation, key: $0)
          }),
          !rawLocalGoToAnnotationContainsProhibitedPayload(annotation)
    else { return false }

    var line: CGPDFArrayRef?
    guard CGPDFDictionaryGetArray(annotation, "L", &line), let line,
          CGPDFArrayGetCount(line) == 4
    else { return false }
    var coordinates = Array(repeating: CGPDFReal(0), count: 4)
    for index in coordinates.indices {
        guard CGPDFArrayGetNumber(line, index, &coordinates[index]) else { return false }
    }
    let expected = [start.x, start.y, end.x, end.y]
    guard zip(coordinates, expected).allSatisfy({ abs(Double($0.0) - Double($0.1)) <= 0.001 })
    else { return false }

    var lineEndings: CGPDFArrayRef?
    guard CGPDFDictionaryGetArray(annotation, "LE", &lineEndings), let lineEndings,
          CGPDFArrayGetCount(lineEndings) == 2
    else { return false }
    for index in 0..<2 {
        var style: UnsafePointer<CChar>?
        guard CGPDFArrayGetName(lineEndings, index, &style), let style,
              String(cString: style) == "None"
        else { return false }
    }
    return true
}

func rawInkAnnotationMatches(
    _ document: PDFDocument,
    page: Int,
    annotationIndex: Int,
    points: [CGPoint]
) -> Bool {
    guard let documentRef = document.documentRef,
          let pageDictionary = documentRef.page(at: page)?.dictionary
    else { return false }
    var annotations: CGPDFArrayRef?
    guard CGPDFDictionaryGetArray(pageDictionary, "Annots", &annotations), let annotations,
          annotationIndex >= 0, annotationIndex < CGPDFArrayGetCount(annotations)
    else { return false }
    var annotation: CGPDFDictionaryRef?
    guard CGPDFArrayGetDictionary(annotations, annotationIndex, &annotation), let annotation,
          pdfName(annotation, key: "Subtype") == "Ink",
          !["A", "AA", "PA", "URI", "Dest", "Popup"].contains(where: {
              dictionaryContainsObject(annotation, key: $0)
          }),
          !rawLocalGoToAnnotationContainsProhibitedPayload(annotation)
    else { return false }

    var inkList: CGPDFArrayRef?
    guard CGPDFDictionaryGetArray(annotation, "InkList", &inkList), let inkList,
          CGPDFArrayGetCount(inkList) == 1
    else { return false }
    var stroke: CGPDFArrayRef?
    guard CGPDFArrayGetArray(inkList, 0, &stroke), let stroke,
          CGPDFArrayGetCount(stroke) == points.count * 2
    else { return false }
    for (index, point) in points.enumerated() {
        var x: CGPDFReal = 0
        var y: CGPDFReal = 0
        guard CGPDFArrayGetNumber(stroke, index * 2, &x),
              CGPDFArrayGetNumber(stroke, index * 2 + 1, &y),
              x.isFinite, y.isFinite,
              closeEnough(CGPoint(x: x, y: y), point)
        else { return false }
    }
    return true
}

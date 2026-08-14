import Foundation
import PDFKit
import AppKit
import CoreGraphics

private let textFieldAllowedAnnotationSubtypes: Set<String> = [
    "Text", "Link", "FreeText", "Line", "Square", "Circle", "Polygon", "PolyLine",
    "Highlight", "Underline", "Squiggly", "StrikeOut", "Stamp", "Caret", "Ink",
]

private let textFieldProhibitedDictionaryKeys: Set<String> = [
    "A", "AA", "PA", "URI", "Dest", "JS", "JavaScript", "Parent", "Kids",
    "Popup", "AF", "FS", "EF", "Sound", "Movie", "RichMediaContent",
    "RichMediaSettings", "3DD", "3DA", "3DV", "3DI", "ExData", "OC",
]

private struct TextFieldWidgetSnapshot {
    let pageBoxes: [PageBoxes]
    let rotations: [Int]
    let annotationDescriptors: [[CropAnnotationDescriptor]]
    let textSHA256: [String]
    let renderRGBA256SHA256: [Data]
    let targetPage: Int
    let targetRect: CGRect
}

private func renderRGBA256(_ document: PDFDocument, pageIndex: Int) -> Data? {
    guard let documentRef = document.documentRef,
          let page = documentRef.page(at: pageIndex + 1),
          let context = CGContext(
              data: nil, width: 256, height: 256, bitsPerComponent: 8,
              bytesPerRow: 256 * 4, space: CGColorSpaceCreateDeviceRGB(),
              bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
          )
    else { return nil }
    let target = CGRect(x: 0, y: 0, width: 256, height: 256)
    context.setFillColor(CGColor(gray: 1, alpha: 1))
    context.fill(target)
    context.concatenate(page.getDrawingTransform(.mediaBox, rect: target, rotate: 0, preserveAspectRatio: true))
    context.drawPDFPage(page)
    guard let bytes = context.data else { return nil }
    return Data(bytes: bytes, count: 256 * 256 * 4)
}

private func digestOptionalText(_ value: String?) -> String {
    var data = Data(value == nil ? [0] : [1])
    if let value { data.append(contentsOf: value.utf8) }
    return sha256Hex(data)
}

private func digestRect(_ value: MutationRectangle) -> String {
    sha256Hex(Data("\(value.x)|\(value.y)|\(value.width)|\(value.height)".utf8))
}

private func attachDirectAcroForm(_ data: Data, fieldName: String) -> Data? {
    let text = String(decoding: data, as: UTF8.self)
    let objectPattern = "(?ms)^(\\d+)\\s+0\\s+obj\\s*(.*?)\\s*endobj"
    guard let objectRegex = try? NSRegularExpression(pattern: objectPattern),
          let rootMatch = (try? NSRegularExpression(pattern: "/Root\\s+(\\d+)\\s+0\\s+R"))?
              .firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
          let rootNumberRange = Range(rootMatch.range(at: 1), in: text),
          let rootNumber = Int(text[rootNumberRange]),
          let sizeRegex = try? NSRegularExpression(pattern: "/Size\\s+(\\d+)"),
          let sizeMatch = sizeRegex.matches(in: text, range: NSRange(text.startIndex..., in: text)).last,
          let sizeRange = Range(sizeMatch.range(at: 1), in: text),
          let size = Int(text[sizeRange]),
          let startxrefRegex = try? NSRegularExpression(pattern: "(?ms)startxref\\s+(\\d+)"),
          let startxrefMatch = startxrefRegex.matches(in: text, range: NSRange(text.startIndex..., in: text)).last,
          let startxrefRange = Range(startxrefMatch.range(at: 1), in: text),
          let startxref = Int(text[startxrefRange])
    else { return nil }

    var widgetObjectNumber: Int?
    var rootBody: String?
    for match in objectRegex.matches(in: text, range: NSRange(text.startIndex..., in: text)) {
        guard let numberRange = Range(match.range(at: 1), in: text),
              let bodyRange = Range(match.range(at: 2), in: text)
        else { return nil }
        let number = Int(text[numberRange]) ?? -1
        let body = String(text[bodyRange])
        if number == rootNumber {
            rootBody = body
        }
        if body.range(of: "/Subtype\\s*/Widget", options: .regularExpression) != nil,
           body.range(of: "/T\\s*\\(\(NSRegularExpression.escapedPattern(for: fieldName))\\)", options: .regularExpression) != nil {
            guard widgetObjectNumber == nil else { return nil }
            widgetObjectNumber = number
        }
    }
    guard let widgetObjectNumber, let rootBody,
          rootBody.range(of: "/AcroForm", options: .regularExpression) == nil,
          let insertion = rootBody.range(of: ">>", options: .backwards),
          insertion.lowerBound > rootBody.startIndex
    else { return nil }
    var updatedRoot = rootBody
    updatedRoot.insert(contentsOf: " /AcroForm << /Fields [\(widgetObjectNumber) 0 R] >>", at: insertion.lowerBound)
    let rootOffset = data.count
    let rootRevision = "\n\(rootNumber) 0 obj\n\(updatedRoot)\nendobj\n"
    let xrefOffset = rootOffset + rootRevision.utf8.count
    let revision = "\(rootRevision)xref\n\(rootNumber) 1\n\(String(format: "%010d", rootOffset)) 00000 n \ntrailer\n<< /Size \(size) /Root \(rootNumber) 0 R /Prev \(startxref) >>\nstartxref\n\(xrefOffset)\n%%EOF\n"
    var output = data
    output.append(contentsOf: revision.utf8)
    return output
}

private func pageHasUnsafeRawContent(_ pageDictionary: CGPDFDictionaryRef) -> Bool {
    ["AA", "AF", "PresSteps", "Dur", "Trans"].contains(where: {
        dictionaryContainsObject(pageDictionary, key: $0)
    })
}

private func textFieldRawGraphIsSafe(_ document: PDFDocument, limits: Limits) -> Bool {
    guard !document.isEncrypted, !document.isLocked, document.allowsDocumentChanges,
          document.pageCount >= 1, document.pageCount <= limits.maxPages,
          let documentRef = document.documentRef, let catalog = documentRef.catalog
    else { return false }
    if [
        "AcroForm", "OpenAction", "AA", "AF", "Perms", "StructTreeRoot",
        "OCProperties", "PieceInfo", "Collection", "SpiderInfo",
    ].contains(where: { dictionaryContainsObject(catalog, key: $0) }) { return false }
    if dictionaryContainsObject(catalog, key: "Names") || dictionaryContainsObject(catalog, key: "MarkInfo") {
        return false
    }
    for pageNumber in 1...document.pageCount {
        guard let page = document.page(at: pageNumber - 1),
              page.annotations.count <= limits.maxAnnotationsPerPage,
              page.annotations.count <= maximumAnnotationsPerPage,
              let rawPage = documentRef.page(at: pageNumber)?.dictionary,
              !pageHasUnsafeRawContent(rawPage)
        else { return false }
        var rawAnnotations: CGPDFArrayRef?
        let hasRawAnnotations = CGPDFDictionaryGetArray(rawPage, "Annots", &rawAnnotations)
        guard hasRawAnnotations || page.annotations.isEmpty else { return false }
        guard let rawAnnotations else { continue }
        guard CGPDFArrayGetCount(rawAnnotations) == page.annotations.count,
              CGPDFArrayGetCount(rawAnnotations) <= limits.maxAnnotationsPerPage,
              CGPDFArrayGetCount(rawAnnotations) <= maximumAnnotationsPerPage
        else { return false }
        for index in 0..<CGPDFArrayGetCount(rawAnnotations) {
            var annotation: CGPDFDictionaryRef?
            guard CGPDFArrayGetDictionary(rawAnnotations, index, &annotation), let annotation,
                  let subtype = pdfName(annotation, key: "Subtype"),
                  textFieldAllowedAnnotationSubtypes.contains(subtype),
                  !textFieldProhibitedDictionaryKeys.contains(where: {
                      dictionaryContainsObject(annotation, key: $0)
                  })
            else { return false }
        }
    }
    return true
}

private func textFieldSnapshot(_ request: TextFieldWidgetRequest, document: PDFDocument) -> TextFieldWidgetSnapshot? {
    let fieldRect = cgRect(request.field.rect)
    guard textFieldRawGraphIsSafe(document, limits: request.limits),
          request.field.page <= document.pageCount,
          let targetPage = document.page(at: request.field.page - 1),
          targetPage.annotations.count < request.limits.maxAnnotationsPerPage,
          targetPage.annotations.count < maximumAnnotationsPerPage,
          targetPage.bounds(for: .cropBox).contains(fieldRect),
          !documentHasWidgets(document)
    else { return nil }
    var boxes: [PageBoxes] = []
    var rotations: [Int] = []
    var descriptors: [[CropAnnotationDescriptor]] = []
    var texts: [String] = []
    var renders: [Data] = []
    let descriptorBudget = RawDescriptorTraversalBudget()
    for pageIndex in 0..<document.pageCount {
        guard let page = document.page(at: pageIndex),
              let observed = cropAnnotationDescriptors(document, pageIndex: pageIndex, budget: descriptorBudget),
              let text = page.string, let render = renderRGBA256(document, pageIndex: pageIndex)
        else { return nil }
        boxes.append(PageBoxes(
            media: rectangle(page.bounds(for: .mediaBox)), crop: rectangle(page.bounds(for: .cropBox)),
            bleed: rectangle(page.bounds(for: .bleedBox)), trim: rectangle(page.bounds(for: .trimBox)),
            art: rectangle(page.bounds(for: .artBox))
        ))
        rotations.append(page.rotation)
        descriptors.append(observed)
        texts.append(sha256Hex(Data(text.utf8)))
        renders.append(render)
    }
    return TextFieldWidgetSnapshot(
        pageBoxes: boxes, rotations: rotations, annotationDescriptors: descriptors,
        textSHA256: texts, renderRGBA256SHA256: renders,
        targetPage: request.field.page, targetRect: fieldRect
    )
}

private func applyTextFieldWidget(_ field: TextFieldWidgetEdit, document: PDFDocument) -> Bool {
    guard let page = document.page(at: field.page - 1) else { return false }
    let widget = PDFAnnotation(bounds: cgRect(field.rect), forType: .widget, withProperties: nil)
    widget.setValue("Tx", forAnnotationKey: .widgetFieldType)
    widget.fieldName = field.name
    if let defaultValue = field.defaultValue { widget.widgetStringValue = defaultValue }
    page.addAnnotation(widget)
    return page.annotations.last === widget
}

private func rawTextFieldWidgetMatches(
    _ document: PDFDocument,
    page: Int,
    annotationIndex: Int,
    expectedName: String,
    expectedValue: String?,
    expectedRect: CGRect
) -> Bool {
    guard let documentRef = document.documentRef,
          let pageDictionary = documentRef.page(at: page)?.dictionary
    else { return false }
    var annotations: CGPDFArrayRef?
    guard CGPDFDictionaryGetArray(pageDictionary, "Annots", &annotations), let annotations,
          annotationIndex < CGPDFArrayGetCount(annotations)
    else { return false }
    var targetObject: CGPDFObjectRef?
    var widget: CGPDFDictionaryRef?
    guard CGPDFArrayGetObject(annotations, annotationIndex, &targetObject), let targetObject,
          CGPDFArrayGetDictionary(annotations, annotationIndex, &widget), let widget,
          pdfName(widget, key: "Subtype") == "Widget",
                  pdfName(widget, key: "FT") == "Tx",
                  !dictionaryContainsObject(widget, key: "Parent"),
                  !dictionaryContainsObject(widget, key: "Kids"),
                  pdfTextString(widget, key: "T") == expectedName,
          rawAnnotationBounds(widget).map({
              closeEnough(CGRect(x: $0.x, y: $0.y, width: $0.width, height: $0.height), expectedRect)
          }) == true,
          !textFieldProhibitedDictionaryKeys.contains(where: { dictionaryContainsObject(widget, key: $0) })
    else { return false }
    if let expectedValue {
        guard pdfTextString(widget, key: "V") == expectedValue else { return false }
    } else if dictionaryContainsObject(widget, key: "V") {
        guard pdfTextString(widget, key: "V") == "" else { return false }
    }
    guard let catalog = documentRef.catalog else { return false }
    var acroForm: CGPDFDictionaryRef?
    var fields: CGPDFArrayRef?
    guard CGPDFDictionaryGetDictionary(catalog, "AcroForm", &acroForm), let acroForm,
          CGPDFDictionaryGetArray(acroForm, "Fields", &fields), let fields,
          CGPDFArrayGetCount(fields) == 1
    else { return false }
    var fieldObject: CGPDFObjectRef?
    var field: CGPDFDictionaryRef?
    guard CGPDFArrayGetObject(fields, 0, &fieldObject), fieldObject == targetObject,
          CGPDFArrayGetDictionary(fields, 0, &field), let field,
          rawFieldSemanticallyMatches(
              field, widget: widget, rawFieldType: "Tx", expectedFieldName: expectedName
          )
    else { return false }
    return true
}

private func verifiesTextFieldWidget(
    _ request: TextFieldWidgetRequest,
    document: PDFDocument,
    snapshot: TextFieldWidgetSnapshot
) -> Bool {
    guard document.pageCount == snapshot.pageBoxes.count,
          document.pageCount == snapshot.annotationDescriptors.count,
          !document.isEncrypted, !document.isLocked,
          document.pageCount <= request.limits.maxPages,
          !documentHasWidgets(document) || document.page(at: request.field.page - 1)?.annotations.contains(where: {
              annotationSubtype($0) == "widget"
          }) == true
    else { return false }
    let targetIndex = snapshot.annotationDescriptors[snapshot.targetPage - 1].count
    let descriptorBudget = RawDescriptorTraversalBudget()
    for pageIndex in 0..<document.pageCount {
        guard let page = document.page(at: pageIndex),
              closeEnough(page.bounds(for: .mediaBox), CGRect(
                  x: snapshot.pageBoxes[pageIndex].media.x, y: snapshot.pageBoxes[pageIndex].media.y,
                  width: snapshot.pageBoxes[pageIndex].media.width, height: snapshot.pageBoxes[pageIndex].media.height
              )),
              closeEnough(page.bounds(for: .cropBox), CGRect(
                  x: snapshot.pageBoxes[pageIndex].crop.x, y: snapshot.pageBoxes[pageIndex].crop.y,
                  width: snapshot.pageBoxes[pageIndex].crop.width, height: snapshot.pageBoxes[pageIndex].crop.height
              )),
              page.rotation == snapshot.rotations[pageIndex],
              let text = page.string,
              sha256Hex(Data(text.utf8)) == snapshot.textSHA256[pageIndex],
              let observed = cropAnnotationDescriptors(document, pageIndex: pageIndex, budget: descriptorBudget)
        else { return false }
        var expected = snapshot.annotationDescriptors[pageIndex]
        if pageIndex == snapshot.targetPage - 1 {
            guard page.annotations.count == expected.count + 1,
                  annotationSubtype(page.annotations[targetIndex]) == "widget",
                  widgetType(page.annotations[targetIndex].value(forAnnotationKey: .widgetFieldType)) == "text",
                  closeEnough(page.annotations[targetIndex].bounds, snapshot.targetRect)
            else { return false }
            guard observed.count == expected.count + 1 else { return false }
            expected = Array(observed.dropLast())
            guard expected == snapshot.annotationDescriptors[pageIndex] else { return false }
            guard rawTextFieldWidgetMatches(
                document, page: snapshot.targetPage, annotationIndex: targetIndex,
                expectedName: request.field.name, expectedValue: request.field.defaultValue,
                expectedRect: snapshot.targetRect
            ) else { return false }
            // The widget is the only allowed raster change. Compare every target-page
            // pixel outside its transformed, bounded rectangle.
            guard let after = renderRGBA256(document, pageIndex: pageIndex),
                  let pdfPage = document.documentRef?.page(at: pageIndex + 1)
            else { return false }
            let before = snapshot.renderRGBA256SHA256[pageIndex]
            let transform = pdfPage.getDrawingTransform(
                .mediaBox, rect: CGRect(x: 0, y: 0, width: 256, height: 256),
                rotate: 0, preserveAspectRatio: true
            )
            let rasterRect = snapshot.targetRect.applying(transform).insetBy(dx: -1, dy: -1)
            for y in 0..<256 {
                for x in 0..<256 {
                    guard !rasterRect.contains(CGPoint(x: Double(x) + 0.5, y: Double(y) + 0.5)) else { continue }
                    let offset = (y * 256 + x) * 4
                    guard before[offset..<(offset + 4)] == after[offset..<(offset + 4)] else { return false }
                }
            }
        } else {
            guard observed == expected, snapshot.renderRGBA256SHA256[pageIndex] == renderRGBA256(document, pageIndex: pageIndex)
            else { return false }
        }
    }
    return true
}

func addTextFieldWidget(
    _ request: TextFieldWidgetRequest,
    workspace: URL,
    inputData: Data
) throws -> TextFieldWidgetReceipt {
    let sourceDigest = sha256Hex(inputData)
    guard sourceDigest == request.sourceSha256,
          let document = PDFDocument(data: inputData),
          let snapshot = textFieldSnapshot(request, document: document),
          applyTextFieldWidget(request.field, document: document),
          let serializedData = document.dataRepresentation(),
          let outputData = attachDirectAcroForm(serializedData, fieldName: request.field.name),
          outputData.count <= maxOutputBytes,
          let candidate = PDFDocument(data: outputData),
          verifiesTextFieldWidget(request, document: candidate, snapshot: snapshot)
    else { throw InspectionFailure.mutationFailed }
    let output = workspace.appendingPathComponent(request.outputFilename)
    try writePrivateOutput(outputData, to: output)
    let reopenedData = try readPrivateInput(output)
    guard let reopened = PDFDocument(data: reopenedData),
          verifiesTextFieldWidget(request, document: reopened, snapshot: snapshot)
    else { throw InspectionFailure.outputInvalid }
    let outputDigest = sha256Hex(reopenedData)
    guard outputDigest != sourceDigest else { throw InspectionFailure.outputInvalid }
    return TextFieldWidgetReceipt(
        sourceSha256: sourceDigest, outputSha256: outputDigest,
        fieldNameSha256: sha256Hex(Data(request.field.name.utf8)),
        defaultValueSha256: digestOptionalText(request.field.defaultValue),
        rectSha256: digestRect(request.field.rect), page: request.field.page,
        pageCount: reopened.pageCount
    )
}
